import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env: ${key}`);
  return value;
}

// GUILD_ID/VOICE_CHANNEL_ID viraram semente do servidor de origem: o bot agora
// atende qualquer servidor e cada um configura o seu por /config.
export const config = {
  token: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  seedGuildId: process.env.GUILD_ID || null,
  seedVoiceChannelId: process.env.VOICE_CHANNEL_ID || null,
  seedClipsChannelId: process.env.LOG_CHANNEL_ID || null,
  replayBufferSeconds: 900, // 15 minutes — buffer capacity (max clip duration)
  defaultClipSeconds: 120, // default duration for /replay clip
  startLookbackSeconds: 120, // lookback at /replay start
  maxRecordingSeconds: 900, // 15 minutes max recording
  siteUrl: process.env.SITE_URL || null,
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  resendApiKey: process.env.RESEND_API_KEY || '',
  feedbackEmailTo: process.env.FEEDBACK_EMAIL_TO || '',
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN || '',
    market: process.env.SPOTIFY_MARKET || 'BR',
  },
};

// A landing vende; quem já decidiu precisa cair direto no checkout. O SITE_URL
// termina com barra no GitHub Pages e sem barra na Vercel — normalizar aqui
// evita o //assinar que o roteador do site trata como rota desconhecida.
export function checkoutUrl(): string {
  return `${(config.siteUrl ?? '').replace(/\/+$/, '')}/assinar`;
}
