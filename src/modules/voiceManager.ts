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

    // Handle ONLY true disconnects (kicked, server issue)
    // Do NOT handle signalling transitions — those are normal DAVE key rotations
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (!connection) return;
      logger.warn('Disconnected, waiting for natural reconnect...');
      try {
        // Give it plenty of time to reconnect naturally
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        logger.info('Reconnected after disconnect');
      } catch {
        logger.warn('Natural reconnect failed, destroying and rejoining...');
        if (connection) {
          connection.removeAllListeners();
          connection.destroy();
          connection = null;
        }
        scheduleReconnect(client, 5_000);
      }
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    logger.info(`Joined voice channel: ${channel.name}`);

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

function setupAntiMove(client: Client) {
  // Only add once
  if ((client as any)._antiMoveSetup) return;
  (client as any)._antiMoveSetup = true;

  client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
    if (newState.member?.id !== client.user?.id) return;

    // Bot was moved to a different channel
    if (newState.channelId && newState.channelId !== config.voiceChannelId) {
      logger.info(`Bot moved to ${newState.channelId}, rejoining ${config.voiceChannelId}`);
      if (connection) {
        connection.rejoin({
          channelId: config.voiceChannelId,
          selfDeaf: false,
          selfMute: true,
        });
      }
    }

    // Bot was fully disconnected
    if (oldState.channelId && !newState.channelId) {
      logger.info('Bot kicked from voice, rejoining...');
      if (connection) {
        connection.removeAllListeners();
        connection.destroy();
        connection = null;
      }
      scheduleReconnect(client, 2_000);
    }
  });
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
