import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} from '@discordjs/voice';
import { Client, ChannelType, Guild } from 'discord.js';
import { config } from '../config';
import { logger } from '../utils/logger';

let connection: VoiceConnection | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;
let isReconnecting = false;

export function getConnection(): VoiceConnection | null {
  return connection;
}

/**
 * Wraps the guild's voice adapter creator to log VOICE_STATE_UPDATE
 * and VOICE_SERVER_UPDATE events for debugging.
 */
function createDebugAdapter(guild: Guild) {
  return (methods: any) => {
    const adapter = guild.voiceAdapterCreator(methods);
    const originalOnVoiceStateUpdate = methods.onVoiceStateUpdate;
    const originalOnVoiceServerUpdate = methods.onVoiceServerUpdate;

    methods.onVoiceStateUpdate = (data: any) => {
      logger.info(`[ADAPTER] VOICE_STATE_UPDATE received: session_id=${data.session_id}, channel_id=${data.channel_id}`);
      return originalOnVoiceStateUpdate(data);
    };

    methods.onVoiceServerUpdate = (data: any) => {
      logger.info(`[ADAPTER] VOICE_SERVER_UPDATE received: endpoint=${data.endpoint}, token=${data.token ? 'present' : 'missing'}`);
      return originalOnVoiceServerUpdate(data);
    };

    return adapter;
  };
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
    logger.info(`Channel lookup: ${config.voiceChannelId} -> ${channel ? `${channel.name} (type: ${channel.type})` : 'NOT FOUND'}`);

    if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
      logger.error(`Voice channel not found or wrong type`);
      return null;
    }

    const me = guild.members.me;
    if (me) {
      const perms = channel.permissionsFor(me);
      logger.info(`Permissions: Connect=${perms?.has('Connect')}, Speak=${perms?.has('Speak')}`);
    }

    // Log intents
    logger.info(`Client intents bitfield: ${client.options.intents}`);

    const existing = getVoiceConnection(config.guildId);
    if (existing) {
      existing.removeAllListeners();
      existing.destroy();
    }

    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: createDebugAdapter(guild),
      selfDeaf: false,
      selfMute: true,
      debug: true,
    });

    connection.on('stateChange', (oldState, newState) => {
      logger.info(`Voice state: ${oldState.status} -> ${newState.status}`);
    });

    connection.on('debug', (message) => {
      logger.info(`[VOICE DEBUG] ${message}`);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (!connection) return;
      logger.warn('Disconnected, waiting for auto-reconnect...');
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
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
  }, 30_000);
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
