import { appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { config } from '../config';
import { logger } from '../utils/logger';

// O YouTube bloqueia o IP do datacenter e só libera com cookies de uma conta
// logada. Esses cookies caem sozinhos (expiram ou a conta é sinalizada), e a
// falha chega ao usuário como "não encontrei nada" — sem isso aqui, ninguém
// descobre que o motivo é a conta até alguém reclamar.
const BLOCK_PATTERNS = [
  /sign in to confirm/i,
  /cookies are no longer valid/i,
  /confirm you.{0,3}re not a bot/i,
  /use --cookies/i,
  /HTTP Error 429/i,
];

const CANARY_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REMIND_INTERVAL_MS = 12 * 60 * 60 * 1000;

const LOG_PATH = join(dirname(process.env.YT_COOKIES_PATH || '/app/data/x'), 'yt-health.log');

let blocked = false;
let lastAlertAt = 0;
let client: Client | null = null;

export function isBlockError(message: string): boolean {
  return BLOCK_PATTERNS.some((p) => p.test(message));
}

export function youtubeBlocked(): boolean {
  return blocked;
}

function writeLog(line: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch (err: any) {
    logger.warn(`[YT] não consegui escrever ${LOG_PATH}: ${err?.message}`);
  }
}

async function alertOwner(detail: string): Promise<void> {
  const channelId = config.seedClipsChannelId;
  if (!client || !channelId) return;

  const channel = client.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel?.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('🍪 Cookies do YouTube caíram')
    .setDescription(
      'A música parou de funcionar: o YouTube está recusando o bot sem uma conta logada.\n' +
        'Gere um `cookies.txt` novo de uma conta descartável e substitua ' +
        `\`${process.env.YT_COOKIES_PATH || 'data/youtube-cookies.txt'}\`, depois reinicie o container.`
    )
    .addFields({ name: 'Erro do yt-dlp', value: `\`\`\`${detail.slice(0, 400)}\`\`\`` })
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
  } catch (err: any) {
    logger.warn(`[YT] falha ao avisar no canal: ${err?.message}`);
  }
}

export function reportBlocked(detail: string): void {
  const now = Date.now();
  const isNew = !blocked;
  if (!isNew && now - lastAlertAt < REMIND_INTERVAL_MS) return;

  blocked = true;
  lastAlertAt = now;

  logger.error(`[YT] BLOQUEADO — cookies do YouTube inválidos ou expirados: ${detail.slice(0, 200)}`);
  writeLog(`BLOQUEADO ${isNew ? '(novo)' : '(persiste)'} — ${detail.slice(0, 300)}`);
  void alertOwner(detail);
}

export function reportWorking(): void {
  if (!blocked) return;
  blocked = false;
  lastAlertAt = 0;
  logger.info('[YT] voltou a funcionar — cookies válidos');
  writeLog('OK — voltou a funcionar');
}

export function startYtHealthWatchdog(discordClient: Client): void {
  client = discordClient;

  const check = async () => {
    const { ytInfo } = await import('../utils/ytdlp');
    try {
      await ytInfo(CANARY_URL);
      reportWorking();
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (isBlockError(msg)) reportBlocked(msg);
      else logger.warn(`[YT] canário falhou por outro motivo: ${msg.slice(0, 200)}`);
    }
  };

  void check();
  setInterval(check, CHECK_INTERVAL_MS).unref();
}
