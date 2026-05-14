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
let stuckCheckTimeout: NodeJS.Timeout | null = null;
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

    // Clean up any existing connection
    const existing = getVoiceConnection(config.guildId);
    if (existing) {
      existing.removeAllListeners();
      existing.destroy();
      // Small delay to let Discord process the disconnect
      await new Promise(r => setTimeout(r, 2000));
    }

    connection = joinVoiceChannel({
      channelId: config.voiceChannelId,
      guildId: config.guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    // Track when connection leaves Ready state — detect stuck DAVE rotation
    connection.on('stateChange', (oldState, newState) => {
      // Log important transitions
      if (newState.status === VoiceConnectionStatus.Ready) {
        logger.info('[VOICE] Connected (ready)');
        clearStuckCheck();
      } else if (oldState.status === VoiceConnectionStatus.Ready) {
        logger.info(`[VOICE] Left ready -> ${newState.status}`);
        // Start a timer: if we don't get back to ready in 15s, force rejoin
        startStuckCheck(client);
      }
    });

    // Suppress errors on the connection to prevent crashes
    connection.on('error', (err) => {
      logger.error(`Voice connection error: ${err.message}`);
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
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

function startStuckCheck(client: Client) {
  clearStuckCheck();
  stuckCheckTimeout = setTimeout(() => {
    if (!connection) return;
    if (connection.state.status !== VoiceConnectionStatus.Ready) {
      logger.warn(`[VOICE] Stuck in ${connection.state.status} for 15s — forcing rejoin`);
      connection.removeAllListeners();
      connection.destroy();
      connection = null;
      scheduleReconnect(client, 3_000);
    }
  }, 15_000);
}

function clearStuckCheck() {
  if (stuckCheckTimeout) {
    clearTimeout(stuckCheckTimeout);
    stuckCheckTimeout = null;
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
