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
let isReconnecting = false;

export function getConnection(): VoiceConnection | null {
  return connection;
}

export async function joinChannel(client: Client): Promise<VoiceConnection | null> {
  if (isReconnecting) return null;
  isReconnecting = true;

  try {
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
    if (existing) {
      existing.removeAllListeners();
      existing.destroy();
    }

    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    // Setup disconnect handler (only once per connection)
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (!connection) return;
      logger.warn('Disconnected, waiting for auto-reconnect...');
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        logger.info('Auto-reconnecting...');
      } catch {
        logger.warn('Auto-reconnect failed, rejoining in 10s...');
        if (connection) {
          connection.removeAllListeners();
          connection.destroy();
          connection = null;
        }
        scheduleReconnect(client);
      }
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    logger.info(`Joined voice channel: ${channel.name}`);
    return connection;
  } catch (err) {
    logger.error('Failed to join voice channel', err);
    if (connection) {
      connection.removeAllListeners();
      connection.destroy();
      connection = null;
    }
    scheduleReconnect(client);
    return null;
  } finally {
    isReconnecting = false;
  }
}

function scheduleReconnect(client: Client) {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  reconnectTimeout = setTimeout(() => {
    logger.info('Attempting scheduled reconnect...');
    joinChannel(client);
  }, 10_000); // 10s delay to avoid rapid loop
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
