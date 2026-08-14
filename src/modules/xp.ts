const XP_PER_MINUTE = 10;

// XP é função pura do tempo de call que já está no banco: nada de tabela ou
// contador paralelo pra sair de sincronia com voice_sessions.
export function xpFor(seconds: number): number {
  return Math.floor(seconds / 60) * XP_PER_MINUTE;
}

// Custo acumulado do nível L: 50·L·(L−1). Nível 2 sai com 10 min de call e o
// 20 com ~31 h — sobe rápido no começo e vira maratona depois.
function xpAtLevel(level: number): number {
  return 50 * level * (level - 1);
}

function levelFor(xp: number): number {
  return Math.floor((1 + Math.sqrt(1 + xp / 12.5)) / 2);
}

export interface Progress {
  xp: number;
  level: number;
  into: number;
  span: number;
  toNext: number;
}

export function progressFor(seconds: number): Progress {
  const xp = xpFor(seconds);
  const level = levelFor(xp);
  const base = xpAtLevel(level);
  const next = xpAtLevel(level + 1);
  return { xp, level, into: xp - base, span: next - base, toNext: next - xp };
}

export function progressBar(progress: Progress, width = 12): string {
  const filled = Math.min(width, Math.round((progress.into / progress.span) * width));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
