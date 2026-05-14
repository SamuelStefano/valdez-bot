import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} from '@discordjs/voice';
import { Client, VoiceChannel } from 'discord.js';
import { config } from '../config';
import { logger } from '../utils/logger';

let connection: VoiceConnection | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;

export function getConnection(): VoiceConnection | null {
  return connection;
}

export async function joinChannel(client: Client): Promise<VoiceConnection | null> {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) {
    logger.error(`Guild ${config.guildId} not found`);
    return null;
  }

  const channel = guild.channels.cache.get(config.voiceChannelId);
  if (!channel || !(channel instanceof VoiceChannel)) {
    logger.error(`Voice channel ${config.voiceChannelId} not found`);
    return null;
  }

  // Destroy existing connection if any
  const existing = getVoiceConnection(config.guildId);
  if (existing) existing.destroy();

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // Must be false to receive audio
    selfMute: true,
  });

  setupReconnect(client);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    logger.info(`Joined voice channel: ${channel.name}`);
    return connection;
  } catch (err) {
    logger.error('Failed to join voice channel', err);
    connection.destroy();
    connection = null;
    scheduleReconnect(client);
    return null;
  }
}

function setupReconnect(client: Client) {
  if (!connection) return;

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    logger.warn('Voice connection disconnected, attempting reconnect...');
    try {
      await Promise.race([
        entersState(connection!, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection!, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      logger.info('Reconnecting automatically...');
    } catch {
      logger.warn('Could not reconnect automatically, rejoining...');
      connection?.destroy();
      connection = null;
      scheduleReconnect(client);
    }
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    logger.warn('Voice connection destroyed');
    connection = null;
  });
}

function scheduleReconnect(client: Client) {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  reconnectTimeout = setTimeout(() => {
    logger.info('Attempting scheduled reconnect...');
    joinChannel(client);
  }, 5_000);
}

export function unmute() {
  if (connection) {
    connection.rejoin({
      ...connection.joinConfig,
      selfMute: false,
    });
  }
}

export function mute() {
  if (connection) {
    connection.rejoin({
      ...connection.joinConfig,
      selfMute: true,
    });
  }
}
