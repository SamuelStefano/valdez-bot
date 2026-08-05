import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  entersState,
  getVoiceConnection,
} from '@discordjs/voice';
import { Client, ChannelType, VoiceState } from 'discord.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { startBuffering, resetBuffering, getLastActivityAt } from './replayBuffer';

let connection: VoiceConnection | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;
let autoJoinEnabled = true;
let watchdogInterval: NodeJS.Timeout | null = null;
let musicActive = false;

const WATCHDOG_TICK_MS = 60_000;
// Force a rejoin if we are connected with people present but no audio has
// arrived for this long — the receiver died silently (no Disconnected event).
// Generous so ordinary quiet stretches don't churn the connection.
const AUDIO_STALE_MS = 12 * 60_000;

// While the bot is playing music it is actively transmitting, which proves the
// connection is alive and must not be torn down — silence on the receive side
// is expected (listeners are quiet), so the watchdog leaves it alone.
export function setMusicActive(active: boolean): void {
  musicActive = active;
}

export function getConnection(): VoiceConnection | null {
  return connection;
}

export function isPresenceEnabled(): boolean {
  return autoJoinEnabled;
}

export function isConnected(): boolean {
  return !!connection && connection.state.status !== VoiceConnectionStatus.Destroyed;
}

export async function setPresence(client: Client, enabled: boolean): Promise<void> {
  autoJoinEnabled = enabled;
  if (enabled) {
    evaluatePresence(client);
  } else {
    leaveChannel();
  }
}

export function leaveChannel(): void {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (connection) {
    connection.removeAllListeners();
    connection.destroy();
    connection = null;
  }
  resetBuffering();
  logger.info('[VOICE] Left channel');
}

function countHumans(client: Client): number {
  const guild = client.guilds.cache.get(config.guildId);
  const channel = guild?.channels.cache.get(config.voiceChannelId);
  if (!channel || !channel.isVoiceBased()) return 0;
  return channel.members.filter(m => !m.user.bot).size;
}

// Join when there are humans in the channel, leave when it empties.
export function evaluatePresence(client: Client): void {
  if (!autoJoinEnabled) return;
  const humans = countHumans(client);
  if (humans > 0 && !isConnected()) {
    joinChannel(client);
  } else if (humans === 0 && isConnected()) {
    logger.info('[VOICE] Channel empty — leaving');
    leaveChannel();
  }
}

export function setupAutoPresence(client: Client): void {
  client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
    if (oldState.member?.user.bot || newState.member?.user.bot) return;
    if (oldState.channelId !== config.voiceChannelId && newState.channelId !== config.voiceChannelId) return;
    evaluatePresence(client);
  });
}

// Discord can stop delivering audio without ever firing Disconnected — the
// connection stays Ready while the receiver is dead. Poll for that: if humans
// are present but no audio arrived for AUDIO_STALE_MS, tear down and rejoin to
// rebuild the receiver. Also a safety net for a missed empty-channel event.
export function startVoiceWatchdog(client: Client): void {
  if (watchdogInterval) return;
  watchdogInterval = setInterval(() => {
    if (!autoJoinEnabled) return;

    const humans = countHumans(client);
    if (humans === 0) {
      if (isConnected()) {
        logger.info('[VOICE] Watchdog: channel empty — leaving');
        leaveChannel();
      }
      return;
    }

    if (!isConnected()) {
      logger.info('[VOICE] Watchdog: humans present but not connected — joining');
      joinChannel(client);
      return;
    }

    if (musicActive) return; // transmitting proves liveness; never cut playback
    const last = getLastActivityAt();
    if (last === 0) return; // buffering not yet (re)started — nothing to judge
    const idleMs = Date.now() - last;
    if (idleMs > AUDIO_STALE_MS) {
      logger.warn(`[VOICE] Watchdog: no audio for ${Math.round(idleMs / 1000)}s with ${humans} present — forcing rejoin`);
      leaveChannel();
      joinChannel(client);
    }
  }, WATCHDOG_TICK_MS);
}

export async function joinChannel(client: Client): Promise<void> {
  if (!autoJoinEnabled) return;

  // Clean up any existing connection
  const existing = getVoiceConnection(config.guildId);
  if (existing) {
    existing.removeAllListeners();
    existing.destroy();
    resetBuffering();
    await new Promise(r => setTimeout(r, 1000));
  }

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) {
    logger.error(`Guild ${config.guildId} not found`);
    return;
  }

  if (guild.channels.cache.size === 0) {
    await guild.channels.fetch();
  }

  const channel = guild.channels.cache.get(config.voiceChannelId);
  if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
    logger.error(`Voice channel ${config.voiceChannelId} not found`);
    return;
  }

  connection = joinVoiceChannel({
    channelId: config.voiceChannelId,
    guildId: config.guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  // Correct disconnect handler from discord.js docs:
  // If it transitions to Signalling or Connecting within 5s, it's recovering.
  // Otherwise, force rejoin.
  connection.on(VoiceConnectionStatus.Disconnected, async (_old, newState: any) => {
    if (!connection) return;
    const reason = newState?.reason;
    const reasonName = VoiceConnectionDisconnectReason[reason] ?? reason ?? 'unknown';
    const closeCode = newState?.closeCode;
    logger.warn(`[VOICE] Disconnected (reason=${reasonName}${closeCode !== undefined ? ` closeCode=${closeCode}` : ''})`);
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      logger.info('[VOICE] Recovering from disconnect...');
    } catch {
      // Real disconnect — rejoin
      logger.warn('[VOICE] Cannot recover — destroying and rejoining');
      if (connection) {
        connection.removeAllListeners();
        connection.destroy();
        connection = null;
      }
      resetBuffering();
      scheduleReconnect(client, 5_000);
    }
  });

  // When ready, start buffering
  connection.on(VoiceConnectionStatus.Ready, () => {
    logger.info('[VOICE] Connected (ready)');
    startBuffering(connection!);
  });

  // If destroyed externally
  connection.on('stateChange', (oldState, newState) => {
    if (newState.status === VoiceConnectionStatus.Destroyed && oldState.status !== VoiceConnectionStatus.Destroyed) {
      logger.warn('[VOICE] Connection destroyed externally');
      connection = null;
      resetBuffering();
      scheduleReconnect(client, 10_000);
    }
  });

  connection.on('error', (err) => {
    logger.error(`Voice connection error: ${err.message}`);
  });

  // Wait for Ready with timeout
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
  } catch {
    logger.error('[VOICE] Initial join timed out (60s)');
    if (connection) {
      connection.removeAllListeners();
      connection.destroy();
      connection = null;
    }
    scheduleReconnect(client, 30_000);
  }

  setupAntiMove(client);
}

function setupAntiMove(client: Client) {
  if ((client as any)._antiMoveSetup) return;
  (client as any)._antiMoveSetup = true;

  client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
    if (newState.member?.id !== client.user?.id) return;

    // Bot moved to wrong channel → rejoin target
    if (newState.channelId && newState.channelId !== config.voiceChannelId) {
      logger.info(`Bot moved to ${newState.channelId}, rejoining target channel`);
      if (connection) {
        connection.rejoin({
          channelId: config.voiceChannelId,
          selfDeaf: false,
          selfMute: true,
        });
      }
    }

    // Bot fully disconnected (kicked)
    if (oldState.channelId && !newState.channelId) {
      logger.info('[VOICE] Bot left channel (voiceStateUpdate)');
      if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
        scheduleReconnect(client, 5_000);
      }
    }
  });
}

function scheduleReconnect(client: Client, delay = 30_000) {
  if (!autoJoinEnabled) return;
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  logger.info(`[VOICE] Scheduling reconnect in ${delay / 1000}s`);
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    logger.info('[VOICE] Re-evaluating presence...');
    evaluatePresence(client);
  }, delay);
}

export function unmute() {
  if (connection) {
    connection.rejoin({ ...connection.joinConfig, selfMute: false });
  }
}

export function mute() {
  if (connection) {
    connection.rejoin({ ...connection.joinConfig, selfMute: true });
  }
}
