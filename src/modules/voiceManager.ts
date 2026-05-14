import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} from '@discordjs/voice';
import { Client, ChannelType } from 'discord.js';
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
      logger.error(`Guild ${config.guildId} not found. Available guilds: ${client.guilds.cache.map(g => `${g.name}(${g.id})`).join(', ')}`);
      return null;
    }

    // Fetch channels if cache is empty
    if (guild.channels.cache.size === 0) {
      logger.info('Channel cache empty, fetching...');
      await guild.channels.fetch();
    }

    const channel = guild.channels.cache.get(config.voiceChannelId);
    logger.info(`Channel lookup: ${config.voiceChannelId} -> ${channel ? `${channel.name} (type: ${channel.type})` : 'NOT FOUND'}`);

    if (!channel) {
      logger.error(`Voice channel ${config.voiceChannelId} not found`);
      return null;
    }

    // Accept both Voice and Stage channels
    if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
      logger.error(`Channel ${config.voiceChannelId} is not a voice channel (type: ${channel.type})`);
      return null;
    }

    // Check bot permissions
    const me = guild.members.me;
    if (me) {
      const perms = channel.permissionsFor(me);
      logger.info(`Bot permissions in channel: Connect=${perms?.has('Connect')}, Speak=${perms?.has('Speak')}, ViewChannel=${perms?.has('ViewChannel')}`);
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

    // Log every state change for debugging
    connection.on('stateChange', (oldState, newState) => {
      logger.info(`Voice state: ${oldState.status} -> ${newState.status}`);
    });

    // Setup disconnect handler
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
        logger.warn('Auto-reconnect failed, rejoining in 30s...');
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
  }, 30_000); // 30s to avoid spam
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
