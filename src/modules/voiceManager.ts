import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  entersState,
  getVoiceConnection,
} from '@discordjs/voice';
import { Client, ChannelType, VoiceState } from 'discord.js';
import { logger } from '../utils/logger';
import { startBuffering, resetBuffering, getLastActivityAt, dropGuild } from './replayBuffer';
import { getSettings, saveSettings, isConfigured } from './guildSettings';
import { showRecordingIndicator, clearRecordingIndicator, announceBuffering } from './consent';
import { isActive } from './licensing';
import { announceExpired } from './billingNotice';
import { beginCall, endCall, dropCall } from './callRecap';

// Estado de voz por servidor. Antes eram variáveis de módulo: com dois
// servidores, o segundo join sobrescrevia a conexão do primeiro.
interface GuildVoice {
  connection: VoiceConnection | null;
  reconnectTimeout: NodeJS.Timeout | null;
  musicActive: boolean;
  announced: boolean;
}

const voices = new Map<string, GuildVoice>();
let watchdogInterval: NodeJS.Timeout | null = null;
let listenersBound = false;

// O musicPlayer importa este módulo, então a chamada de volta tem que ser
// injetada — importar de lá fecharia o ciclo.
let musicStopper: ((guildId: string) => void) | null = null;

export function setMusicStopper(fn: (guildId: string) => void): void {
  musicStopper = fn;
}

// Sem isso a flag fica presa em true depois de uma saída com música tocando, e
// o watchdog nunca mais checa se o áudio daquele servidor morreu.
function stopMusic(guildId: string): void {
  const v = voices.get(guildId);
  if (v) v.musicActive = false;
  try {
    musicStopper?.(guildId);
  } catch (err: any) {
    logger.error(`[VOICE] ${guildId}: falha ao parar música: ${err?.message}`);
  }
}

const WATCHDOG_TICK_MS = 60_000;
// Force a rejoin if we are connected with people present but no audio has
// arrived for this long — the receiver died silently (no Disconnected event).
// Generous so ordinary quiet stretches don't churn the connection.
const AUDIO_STALE_MS = 12 * 60_000;

function state(guildId: string): GuildVoice {
  let v = voices.get(guildId);
  if (!v) {
    v = { connection: null, reconnectTimeout: null, musicActive: false, announced: false };
    voices.set(guildId, v);
  }
  return v;
}

// While the bot is playing music it is actively transmitting, which proves the
// connection is alive and must not be torn down — silence on the receive side
// is expected (listeners are quiet), so the watchdog leaves it alone.
export function setMusicActive(guildId: string, active: boolean): void {
  state(guildId).musicActive = active;
}

export function getConnection(guildId: string): VoiceConnection | null {
  return voices.get(guildId)?.connection ?? null;
}

export function listConnections(): [string, VoiceConnection][] {
  const out: [string, VoiceConnection][] = [];
  for (const [guildId, v] of voices) if (v.connection) out.push([guildId, v.connection]);
  return out;
}

export function isPresenceEnabled(guildId: string): boolean {
  return getSettings(guildId).autoJoin;
}

export function isConnected(guildId: string): boolean {
  const c = voices.get(guildId)?.connection;
  return !!c && c.state.status !== VoiceConnectionStatus.Destroyed;
}

export async function setPresence(client: Client, guildId: string, enabled: boolean): Promise<void> {
  saveSettings({ guildId, autoJoin: enabled });
  if (enabled) {
    evaluatePresence(client, guildId);
  } else {
    await leaveChannel(client, guildId);
  }
}

export async function leaveChannel(client: Client, guildId: string): Promise<void> {
  const v = state(guildId);
  stopMusic(guildId);
  if (v.reconnectTimeout) {
    clearTimeout(v.reconnectTimeout);
    v.reconnectTimeout = null;
  }
  if (v.connection) {
    v.connection.removeAllListeners();
    v.connection.destroy();
    v.connection = null;
  }
  resetBuffering(guildId);
  dropCall(guildId);
  v.announced = false;
  await clearRecordingIndicator(client, guildId);
  logger.info(`[VOICE] ${guildId}: left channel`);
}

function countHumans(client: Client, guildId: string): number {
  const channelId = getSettings(guildId).voiceChannelId;
  if (!channelId) return 0;
  const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
  if (!channel || !channel.isVoiceBased()) return 0;
  return channel.members.filter((m) => !m.user.bot).size;
}

// Join when there are humans in the channel, leave when it empties.
export function evaluatePresence(client: Client, guildId: string): void {
  if (!isConfigured(guildId) || !isPresenceEnabled(guildId)) return;

  // Licença vencida não tira mais o bot da call: ele continua no gratuito, com
  // 30s de buffer. Bot que some é bot que o dono remove do servidor, e aí não
  // sobra nada pra vender. O aviso é uma vez por vencimento, não a cada
  // avaliação de presença.
  if (!isActive(guildId)) void announceExpired(client, guildId);

  const humans = countHumans(client, guildId);
  if (humans > 0 && !isConnected(guildId)) {
    joinChannel(client, guildId);
  } else if (humans === 0 && isConnected(guildId)) {
    logger.info(`[VOICE] ${guildId}: channel empty — leaving`);
    endCall(client, guildId);
    void leaveChannel(client, guildId);
  }
}

export function evaluateAllGuilds(client: Client): void {
  for (const guildId of client.guilds.cache.keys()) evaluatePresence(client, guildId);
}

export function setupAutoPresence(client: Client): void {
  if (listenersBound) return;
  listenersBound = true;

  client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
    const guildId = newState.guild.id;

    // Bot movido pra outro canal → volta pro canal configurado.
    if (newState.member?.id === client.user?.id) {
      const target = getSettings(guildId).voiceChannelId;
      const v = voices.get(guildId);
      if (target && newState.channelId && newState.channelId !== target && v?.connection) {
        logger.info(`[VOICE] ${guildId}: bot moved to ${newState.channelId}, rejoining target`);
        v.connection.rejoin({ channelId: target, selfDeaf: false, selfMute: true });
      }
      if (oldState.channelId && !newState.channelId) {
        logger.info(`[VOICE] ${guildId}: bot left channel (voiceStateUpdate)`);
        if (!v?.connection || v.connection.state.status === VoiceConnectionStatus.Destroyed) {
          scheduleReconnect(client, guildId, 5_000);
        }
      }
      return;
    }

    if (oldState.member?.user.bot || newState.member?.user.bot) return;

    const target = getSettings(guildId).voiceChannelId;
    if (!target) return;
    if (oldState.channelId !== target && newState.channelId !== target) return;
    evaluatePresence(client, guildId);
  });
}

// Discord can stop delivering audio without ever firing Disconnected — the
// connection stays Ready while the receiver is dead. Poll for that: if humans
// are present but no audio arrived for AUDIO_STALE_MS, tear down and rejoin to
// rebuild the receiver. Also a safety net for a missed empty-channel event.
export function startVoiceWatchdog(client: Client): void {
  if (watchdogInterval) return;
  watchdogInterval = setInterval(() => {
    for (const guildId of client.guilds.cache.keys()) {
      if (!isConfigured(guildId) || !isPresenceEnabled(guildId)) continue;

      const humans = countHumans(client, guildId);
      if (humans === 0) {
        if (isConnected(guildId)) {
          logger.info(`[VOICE] ${guildId}: watchdog — channel empty, leaving`);
          endCall(client, guildId);
          void leaveChannel(client, guildId);
        }
        continue;
      }

      if (!isConnected(guildId)) {
        logger.info(`[VOICE] ${guildId}: watchdog — humans present, joining`);
        void joinChannel(client, guildId);
        continue;
      }

      if (voices.get(guildId)?.musicActive) continue; // transmitting proves liveness
      const last = getLastActivityAt(guildId);
      if (last === 0) continue; // buffering not yet (re)started — nothing to judge
      const idleMs = Date.now() - last;
      if (idleMs > AUDIO_STALE_MS) {
        logger.warn(
          `[VOICE] ${guildId}: watchdog — no audio for ${Math.round(idleMs / 1000)}s with ${humans} present, forcing rejoin`
        );
        void leaveChannel(client, guildId).then(() => joinChannel(client, guildId));
      }
    }
  }, WATCHDOG_TICK_MS);
}

export async function joinChannel(client: Client, guildId: string): Promise<void> {
  const settings = getSettings(guildId);
  if (!settings.voiceChannelId || !settings.autoJoin) return;

  beginCall(guildId, settings.voiceChannelId);
  const v = state(guildId);

  // Clean up any existing connection
  const existing = getVoiceConnection(guildId);
  if (existing) {
    existing.removeAllListeners();
    existing.destroy();
    resetBuffering(guildId);
    await new Promise((r) => setTimeout(r, 1000));
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    logger.error(`[VOICE] guild ${guildId} not found`);
    return;
  }

  if (guild.channels.cache.size === 0) {
    await guild.channels.fetch();
  }

  const channel = guild.channels.cache.get(settings.voiceChannelId);
  if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
    logger.error(`[VOICE] ${guildId}: voice channel ${settings.voiceChannelId} not found`);
    return;
  }

  const connection = joinVoiceChannel({
    channelId: settings.voiceChannelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });
  v.connection = connection;

  // Correct disconnect handler from discord.js docs:
  // If it transitions to Signalling or Connecting within 5s, it's recovering.
  // Otherwise, force rejoin.
  connection.on(VoiceConnectionStatus.Disconnected, async (_old, newState: any) => {
    if (!v.connection) return;
    const reason = newState?.reason;
    const reasonName = VoiceConnectionDisconnectReason[reason] ?? reason ?? 'unknown';
    const closeCode = newState?.closeCode;
    logger.warn(
      `[VOICE] ${guildId}: disconnected (reason=${reasonName}${closeCode !== undefined ? ` closeCode=${closeCode}` : ''})`
    );
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      logger.info(`[VOICE] ${guildId}: recovering from disconnect...`);
    } catch {
      logger.warn(`[VOICE] ${guildId}: cannot recover — destroying and rejoining`);
      if (v.connection) {
        v.connection.removeAllListeners();
        v.connection.destroy();
        v.connection = null;
      }
      resetBuffering(guildId);
      scheduleReconnect(client, guildId, 5_000);
    }
  });

  connection.on(VoiceConnectionStatus.Ready, () => {
    logger.info(`[VOICE] ${guildId}: connected (ready)`);
    void beginCapture(client, guildId, connection, settings.voiceChannelId!);
  });

  connection.on('stateChange', (oldState, newState) => {
    if (newState.status === VoiceConnectionStatus.Destroyed && oldState.status !== VoiceConnectionStatus.Destroyed) {
      logger.warn(`[VOICE] ${guildId}: connection destroyed externally`);
      v.connection = null;
      resetBuffering(guildId);
      scheduleReconnect(client, guildId, 10_000);
    }
  });

  connection.on('error', (err) => {
    logger.error(`[VOICE] ${guildId}: connection error: ${err.message}`);
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
  } catch {
    logger.error(`[VOICE] ${guildId}: initial join timed out (60s)`);
    if (v.connection) {
      v.connection.removeAllListeners();
      v.connection.destroy();
      v.connection = null;
    }
    scheduleReconnect(client, guildId, 30_000);
  }
}

// O buffer só liga depois que o indicador visível está no ar. Sem ele o bot
// fica na call como ouvinte mudo e ninguém é capturado.
async function beginCapture(
  client: Client,
  guildId: string,
  connection: VoiceConnection,
  voiceChannelId: string
): Promise<void> {
  const marked = await showRecordingIndicator(client, guildId);
  if (!marked) {
    logger.warn(`[VOICE] ${guildId}: sem indicador de gravação — buffer NÃO ligado`);
    return;
  }

  startBuffering(guildId, connection);

  const v = state(guildId);
  if (!v.announced) {
    v.announced = true;
    await announceBuffering(client, guildId, voiceChannelId);
  }
}

function scheduleReconnect(client: Client, guildId: string, delay = 30_000) {
  if (!isPresenceEnabled(guildId)) return;
  const v = state(guildId);
  if (v.reconnectTimeout) clearTimeout(v.reconnectTimeout);
  logger.info(`[VOICE] ${guildId}: scheduling reconnect in ${delay / 1000}s`);
  v.reconnectTimeout = setTimeout(() => {
    v.reconnectTimeout = null;
    evaluatePresence(client, guildId);
  }, delay);
}

export function dropGuildVoice(guildId: string): void {
  const v = voices.get(guildId);
  stopMusic(guildId);
  if (v?.reconnectTimeout) clearTimeout(v.reconnectTimeout);
  if (v?.connection) {
    v.connection.removeAllListeners();
    v.connection.destroy();
  }
  voices.delete(guildId);
  dropCall(guildId);
  dropGuild(guildId);
}

export function unmute(guildId: string) {
  const c = voices.get(guildId)?.connection;
  if (c) c.rejoin({ ...c.joinConfig, selfMute: false });
}

export function mute(guildId: string) {
  const c = voices.get(guildId)?.connection;
  if (c) c.rejoin({ ...c.joinConfig, selfMute: true });
}
