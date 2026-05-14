import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
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

  // Log ALL state transitions for debugging
  let lastLogTime = 0;
  connection.on('stateChange', (oldState, newState) => {
    const now = Date.now();
    // Rate-limit non-important logs to every 30s
    const isImportant = newState.status === VoiceConnectionStatus.Ready
      || newState.status === VoiceConnectionStatus.Disconnected
      || newState.status === VoiceConnectionStatus.Destroyed;

    if (isImportant || now - lastLogTime > 30_000) {
      logger.info(`[VOICE] ${oldState.status} -> ${newState.status}`);
      lastLogTime = now;
    }

    if (newState.status === VoiceConnectionStatus.Ready) {
      logger.info('[VOICE] Connected (ready)');
      startBuffering(connection!);
    } else if (newState.status === VoiceConnectionStatus.Destroyed) {
      logger.warn('[VOICE] Connection destroyed');
      connection = null;
      scheduleReconnect(client, 30_000);
    }
  });

  connection.on('error', (err) => {
    logger.error(`Voice connection error: ${err.message}`);
  });

  // Don't use entersState with timeout — let the connection try forever
  // It will eventually reach Ready or Destroyed
  logger.info(`[VOICE] Joining ${channel.name}... (waiting for DAVE handshake)`);

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
  reconnectTimeout = setTimeout(() => {
    logger.info('Attempting scheduled reconnect...');
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
