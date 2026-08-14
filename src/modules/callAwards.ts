import { formatDuration } from './voiceTracker';

export interface Participant {
  userId: string;
  username: string;
  seconds: number;
  firstJoin: number;
  lastLeft: number;
}

export interface AwardInput {
  participants: Participant[];
  durationSeconds: number;
  clipsByUser: Map<string, number>;
}

const MAX_AWARDS = 4;
const GRUDADO_RATIO = 0.7;
const OI_MAX_SECONDS = 180;
const OI_MIN_CALL_SECONDS = 1800;
const MADRUGADA_START = 3;
const MADRUGADA_END = 6;

// O container roda em UTC e o público é brasileiro: sem o deslocamento fixo, o
// prêmio de madrugada cairia sempre no horário errado. O Brasil não tem mais
// horário de verão, então -3 é constante.
const BRT_OFFSET_SECONDS = -3 * 3600;

function hourInBrt(unixSeconds: number): number {
  const local = unixSeconds + BRT_OFFSET_SECONDS;
  return Math.floor((((local % 86400) + 86400) % 86400) / 3600);
}

// Prêmio inventado é prêmio que ninguém acredita: cada um só entra quando o dado
// da call justifica sozinho.
export function pickAwards({ participants, durationSeconds, clipsByUser }: AwardInput): string[] {
  if (participants.length === 0) return [];

  const awards: string[] = [];
  const byTime = [...participants].sort((a, b) => b.seconds - a.seconds);
  const top = byTime[0];

  const grudado = participants.length >= 2 && top.seconds >= durationSeconds * GRUDADO_RATIO ? top : null;
  if (grudado) {
    awards.push(
      `🪑 **Móvel da call** — ${grudado.username} ficou ${formatDuration(grudado.seconds)} sem arredar o bumbum.`
    );
  }

  if (durationSeconds >= OI_MIN_CALL_SECONDS && participants.length >= 2) {
    const rapidinha = byTime[byTime.length - 1];
    if (rapidinha.seconds <= OI_MAX_SECONDS && rapidinha.userId !== top.userId) {
      awards.push(
        `💨 **Passou só pra dar oi** — ${rapidinha.username} apareceu por ${formatDuration(rapidinha.seconds)} e sumiu.`
      );
    }
  }

  const vampiro = [...participants]
    .filter((p) => {
      const hour = hourInBrt(p.lastLeft);
      return hour >= MADRUGADA_START && hour < MADRUGADA_END;
    })
    .sort((a, b) => b.lastLeft - a.lastLeft)[0];
  if (vampiro) {
    awards.push(
      `🧛 **Vampiro** — ${vampiro.username} ainda estava aqui às ${hourInBrt(vampiro.lastLeft)}h da manhã. Dorme, meu filho.`
    );
  }

  const [diretorId, clips] = [...clipsByUser.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const diretor = diretorId ? participants.find((p) => p.userId === diretorId) : undefined;
  if (diretor && clips >= 2) {
    awards.push(`🎬 **Diretor de cortes** — ${diretor.username} salvou ${clips} clips dessa call.`);
  }

  if (participants.length >= 3) {
    const primeiro = [...participants].sort((a, b) => a.firstJoin - b.firstJoin)[0];
    const ultimo = [...participants].sort((a, b) => b.lastLeft - a.lastLeft)[0];
    if (primeiro.userId === ultimo.userId && primeiro.userId !== grudado?.userId) {
      awards.push(`🔑 **Chaveiro** — ${primeiro.username} abriu a call e apagou a luz no fim.`);
    }
  }

  return awards.slice(0, MAX_AWARDS);
}
