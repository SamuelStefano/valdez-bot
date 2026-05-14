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
      logger.error(`Voice channel ${config.voiceChannelId} not found`);
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

    // Handle Disconnected state — this is where we should reconnect
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (!connection) return;
      logger.warn('[VOICE] Disconnected — waiting 5s for natural recovery');
      try {
        // Wait up to 5s for it to reconnect naturally (DAVE rotation)
        await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
        logger.info('[VOICE] Reconnecting naturally after disconnect');
      } catch {
        // Didn't reconnect — destroy and schedule fresh join
        logger.warn('[VOICE] No recovery — destroying and scheduling rejoin');
        if (connection) {
          connection.removeAllListeners();
          connection.destroy();
          connection = null;
        }
        scheduleReconnect(client, 3_000);
      }
    });

    // Suppress errors on the connection to prevent crashes
    connection.on('error', (err) => {
      logger.error(`Voice connection error: ${err.message}`);
    });

    // Log state changes (reduced to only important ones)
    connection.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        const important = newState.status === VoiceConnectionStatus.Ready
          || newState.status === VoiceConnectionStatus.Disconnected
          || oldState.status === VoiceConnectionStatus.Ready;
        if (important) {
          logger.info(`[VOICE] ${oldState.status} -> ${newState.status}`);
        }
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

    // Bot fully disconnected (kicked/moved out)
    // IMPORTANT: Do NOT destroy connection here — let the Disconnected handler deal with it
    // During DAVE key rotation, voiceStateUpdate may briefly show no channel
    if (oldState.channelId && !newState.channelId) {
      logger.info('[VOICE] voiceStateUpdate: bot left channel');
      // Only act if the connection is already destroyed or null
      if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
        logger.info('[VOICE] Connection already gone, scheduling rejoin');
        scheduleReconnect(client, 3_000);
      } else {
        logger.info(`[VOICE] Connection still alive (${connection.state.status}), letting it handle reconnect`);
      }
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
