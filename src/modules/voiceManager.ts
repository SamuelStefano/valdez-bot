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
import { startBuffering, resetBuffering } from './replayBuffer';

let connection: VoiceConnection | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;

export function getConnection(): VoiceConnection | null {
  return connection;
}

export async function joinChannel(client: Client): Promise<void> {
  // Clean up any existing connection
  const existing = getVoiceConnection(config.guildId);
  if (existing) {
    existing.removeAllListeners();
    existing.destroy();
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
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  logger.info(`[VOICE] Scheduling reconnect in ${delay / 1000}s`);
  reconnectTimeout = setTimeout(() => {
    logger.info('[VOICE] Attempting reconnect...');
    joinChannel(client);
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
