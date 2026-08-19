import { appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../utils/logger';

// O YouTube bloqueia o IP do datacenter e só libera com cookies de uma conta
// logada. Manter esses cookies é trabalho manual que não vale a pena, então o
// bloqueio fica registrado no log e o usuário recebe a explicação no /play —
// avisar no canal só enchia o chat com um pedido que ninguém ia atender.
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

export function reportBlocked(detail: string): void {
  const now = Date.now();
  const isNew = !blocked;
  if (!isNew && now - lastAlertAt < REMIND_INTERVAL_MS) return;

  blocked = true;
  lastAlertAt = now;

  logger.warn(`[YT] bloqueado pelo YouTube (esperado, sem cookies): ${detail.slice(0, 120)}`);
  writeLog(`BLOQUEADO ${isNew ? '(novo)' : '(persiste)'} — ${detail.slice(0, 300)}`);
}

export function reportWorking(): void {
  if (!blocked) return;
  blocked = false;
  lastAlertAt = 0;
  logger.info('[YT] voltou a funcionar — cookies válidos');
  writeLog('OK — voltou a funcionar');
}

export function startYtHealthWatchdog(): void {
  const check = async () => {
    try {
      // O import fica dentro do try: uma falha ao carregar o módulo derrubava o
      // próprio watchdog, que é justamente quem deveria avisar do problema.
      const { ytInfo } = await import('../utils/ytdlp');
      await ytInfo(CANARY_URL);
      reportWorking();
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (isBlockError(msg)) reportBlocked(msg);
      else logger.warn(`[YT] canário falhou por outro motivo: ${msg.slice(0, 200)}`);
    }
  };

  void check();
  setInterval(() => void check(), CHECK_INTERVAL_MS).unref();
}
