import { Client, VoiceState } from 'discord.js';
import { dbStatements } from '../utils/database';
import { logger } from '../utils/logger';

// Chaveado por guild+user: o mesmo usuário pode estar em call de dois servidores
// ao mesmo tempo, e chavear só por userId fundia as duas sessões.
const activeSessions = new Map<string, number>(); // `${guildId}:${userId}` -> joinedAt (unix seconds)

function sessionKey(guildId: string, userId: string) {
  return `${guildId}:${userId}`;
}

export function setupVoiceTracker(client: Client) {
  // Close any stale sessions on startup
  const now = Math.floor(Date.now() / 1000);
  dbStatements.closeAllSessions.run(now, now);

  client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
    const userId = newState.member?.id || oldState.member?.id;
    const username = newState.member?.displayName || oldState.member?.displayName || 'Unknown';
    const guildId = newState.guild.id;

    if (!userId) return;
    // Ignore bots
    if (newState.member?.user.bot || oldState.member?.user.bot) return;

    const wasInChannel = oldState.channelId;
    const isInChannel = newState.channelId;

    // User joined a voice channel
    if (!wasInChannel && isInChannel) {
      const joinedAt = Math.floor(Date.now() / 1000);
      activeSessions.set(sessionKey(guildId, userId), joinedAt);
      dbStatements.startSession.run(userId, username, guildId, isInChannel, joinedAt);
      logger.info(`${username} joined voice channel`);
    }

    // User left a voice channel
    if (wasInChannel && !isInChannel) {
      const leftAt = Math.floor(Date.now() / 1000);
      dbStatements.endSession.run(leftAt, leftAt, userId, guildId);
      activeSessions.delete(sessionKey(guildId, userId));
      logger.info(`${username} left voice channel`);
    }

    // User switched channels
    if (wasInChannel && isInChannel && wasInChannel !== isInChannel) {
      const now = Math.floor(Date.now() / 1000);
      // Close old session
      dbStatements.endSession.run(now, now, userId, guildId);
      // Start new session
      activeSessions.set(sessionKey(guildId, userId), now);
      dbStatements.startSession.run(userId, username, guildId, isInChannel, now);
      logger.info(`${username} switched voice channel`);
    }
  });

  logger.info('Voice tracker initialized');
}

export function getActiveSession(guildId: string, userId: string): number | undefined {
  return activeSessions.get(sessionKey(guildId, userId));
}

export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
