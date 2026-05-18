import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env: ${key}`);
  return value;
}

export const config = {
  token: required('DISCORD_TOKEN'),
  guildId: required('GUILD_ID'),
  voiceChannelId: required('VOICE_CHANNEL_ID'),
  clientId: required('CLIENT_ID'),
  logChannelId: process.env.LOG_CHANNEL_ID || null,
  replayBufferSeconds: 120, // 2 minutes
  maxRecordingSeconds: 600, // 10 minutes max recording
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN || '',
    market: process.env.SPOTIFY_MARKET || 'BR',
  },
};
