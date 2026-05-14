import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} from '@discordjs/voice';
import { Client, ChannelType, VoiceState } from 'discord.js';
import { config } from '../config';
import { logger } from '../utils/logger';

let connection: VoiceConnection | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;
let isReconnecting = false;
let clientRef: Client | null = null;

export function getConnection(): VoiceConnection | null {
  return connection;
}

export async function joinChannel(client: Client): Promise<VoiceConnection | null> {
  if (isReconnecting) return null;
  isReconnecting = true;
  clientRef = client;

  try {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
      logger.error(`Guild ${config.guildId} not found`);
      return null;
    }

    if (guild.channels.cache.size === 0) {
      await guild.channels.fetch();
    }

    const channel = guild.channels.cache.get(config.voiceChannelId);
    if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
      logger.error(`Voice channel ${config.voiceChannelId} not found or wrong type`);
      return null;
    }

    const existing = getVoiceConnection(config.guildId);
    if (existing) {
      existing.removeAllListeners();
      existing.destroy();
    }

    connection = joinVoiceChannel({
      channelId: config.voiceChannelId,
      guildId: config.guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (!connection) return;
      logger.warn('Disconnected, attempting reconnect...');
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        logger.info('Reconnected successfully');
      } catch {
        logger.warn('Reconnect failed, rejoining...');
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

    // Setup anti-AFK: if bot gets moved to another channel, rejoin original
    setupAntiMove(client);

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

/**
 * Watches for the bot being moved to a different channel (AFK, manual move)
 * and immediately rejoins the configured channel.
 */
function setupAntiMove(client: Client) {
  // Remove previous listener if any
  client.removeAllListeners('voiceStateUpdate_antiMove');

  const handler = (oldState: VoiceState, newState: VoiceState) => {
    // Only care about the bot itself
    if (newState.member?.id !== client.user?.id) return;

    // Bot was moved to a different channel
    if (newState.channelId && newState.channelId !== config.voiceChannelId) {
      logger.info(`Bot was moved to ${newState.channelId}, rejoining ${config.voiceChannelId}...`);
      // Rejoin the correct channel immediately
      if (connection) {
        connection.rejoin({
          channelId: config.voiceChannelId,
          selfDeaf: false,
          selfMute: true,
        });
      }
    }

    // Bot was disconnected entirely
    if (oldState.channelId && !newState.channelId) {
      logger.info('Bot was disconnected from voice, rejoining...');
      if (connection) {
        connection.removeAllListeners();
        connection.destroy();
        connection = null;
      }
      scheduleReconnect(client, 2_000);
    }
  };

  client.on('voiceStateUpdate', handler);
}

function scheduleReconnect(client: Client, delay = 10_000) {
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
