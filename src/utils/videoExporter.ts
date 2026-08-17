import { OpusPacket } from '../modules/replayBuffer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { logger } from './logger';

const RECORDINGS_DIR = path.join(process.cwd(), 'recordings');

// Mesmos números do mixToPcm. Se divergirem, a bolinha acende fora da hora em que
// a voz sai — que é o único jeito de esse vídeo ficar pior que o mp3.
const FRAME_MS = 20;
const PAUSE_GAP_MS = 100;

// A sala é quase estática: o que muda entre frames é um anel acendendo. Por isso
// dá pra entregar 720p — o custo real está em quantos frames existem, e 12 fps é
// o piso em que o realce ainda parece instantâneo.
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 12;
const TOP_PAD = 56;
const BOTTOM_PAD = 28;

const BG_CENTER = '0x2a3048';
const BG_EDGE = '0x090a0e';
const CARD = '0x181b25';
const CARD_EDGE = '0x262a39';
const IDLE_RING = '0x353a4d';
const ACCENT = '0x3ddc84';
const NAME = '0xd4d7e3';
const TITLE = '0x767c93';

// Cada participante custa uma imagem de entrada e alguns filtros. Numa call de 20
// o grafo fica impossível de renderizar e ninguém enxerga avatar de 40px —
// mostrar quem mais falou entrega o mesmo clip.
const MAX_PEOPLE = 9;

// O drawtext exige um arquivo .ttf e uma imagem base sem fontes derruba o ffmpeg
// inteiro. Resolver na subida e desligar só os nomes é o que garante que o vídeo
// sai mesmo numa imagem onde alguém esqueceu de instalar a fonte.
const FONT = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
].find((f) => fs.existsSync(f)) ?? null;

if (!FONT) logger.warn('[VIDEO] nenhuma fonte encontrada — o vídeo da sala sai sem os nomes');

export interface Segment {
  start: number;
  end: number;
}

export interface Participant {
  userId: string;
  name: string;
  avatarUrl: string | null;
}

export type Timeline = Map<string, Segment[]>;

// Segmento curto demais vira piscada: o anel acende e apaga no mesmo frame e o
// vídeo parece quebrado. Costurar o que está perto e dar um piso de duração é o
// que faz a luz acompanhar a fala em vez de tremer.
const MERGE_GAP_MS = 250;
const MIN_SEGMENT_MS = 220;

/**
 * Deriva quem falou e quando a partir dos timestamps que o buffer já guarda.
 * A régua é a mesma do mixToPcm: dentro de uma sequência os frames são contíguos
 * (20ms cada) e só um intervalo grande conta como pausa real — por isso o vídeo
 * cai em cima do áudio sem precisar de captura nova.
 */
export function speakingTimeline(packets: Map<string, OpusPacket[]>): Timeline {
  let minTs = Infinity;
  for (const userPackets of packets.values()) {
    for (const p of userPackets) if (p.timestamp < minTs) minTs = p.timestamp;
  }
  if (!Number.isFinite(minTs)) return new Map();

  const timeline: Timeline = new Map();

  for (const [userId, userPackets] of packets) {
    if (userPackets.length === 0) continue;

    const raw: Segment[] = [];
    let offsetMs = 0;
    let runStartMs = 0;
    let prevTs: number | null = null;

    for (const packet of userPackets) {
      if (prevTs === null) {
        offsetMs = packet.timestamp - minTs;
        runStartMs = offsetMs;
      } else if (packet.timestamp - prevTs > PAUSE_GAP_MS) {
        raw.push({ start: runStartMs, end: offsetMs });
        offsetMs += packet.timestamp - prevTs;
        runStartMs = offsetMs;
      }
      prevTs = packet.timestamp;
      offsetMs += FRAME_MS;
    }
    raw.push({ start: runStartMs, end: offsetMs });

    const merged: Segment[] = [];
    for (const seg of raw) {
      const last = merged[merged.length - 1];
      if (last && seg.start - last.end <= MERGE_GAP_MS) last.end = seg.end;
      else merged.push({ ...seg });
    }

    timeline.set(
      userId,
      merged.map((s) => ({
        start: s.start / 1000,
        end: Math.max(s.end, s.start + MIN_SEGMENT_MS) / 1000,
      }))
    );
  }
  return timeline;
}

export function timelineDuration(timeline: Timeline): number {
  let end = 0;
  for (const segments of timeline.values()) {
    for (const s of segments) if (s.end > end) end = s.end;
  }
  return end;
}

// `+` no ffmpeg é OR lógico: uma expressão só liga e desliga o realce nos
// instantes certos, e o filtro inteiro roda sem nenhum frame desenhado à mão.
function enableExpr(segments: Segment[]): string {
  return segments.map((s) => `between(t,${s.start.toFixed(2)},${s.end.toFixed(2)})`).join('+');
}

// O texto vai direto pro grafo de filtros do ffmpeg, onde `:`, `'` e `\` são
// sintaxe. Escapar é frágil demais para um campo que o usuário controla — apelido
// é texto livre no Discord. Reduzir ao conjunto seguro fecha o buraco sem depender
// de escape, e o apelido continua legível.
function safeText(value: string, max: number): string {
  const clean = value.replace(/[^\p{L}\p{N} _.\-]/gu, '').trim();
  return (clean.length > 0 ? clean : 'usuario').slice(0, max);
}

interface Card {
  x: number;
  y: number;
  w: number;
  h: number;
  avatarX: number;
  avatarY: number;
  nameY: number;
}

interface Layout {
  cards: Card[];
  size: number;
  ring: number;
  glow: number;
  fontSize: number;
}

// Uma call de dois ou três é a que mais vira clip: deixar essas em fileira única é
// o que faz elas ocuparem a tela em vez de virarem ícones perdidos. De quatro em
// diante o grid fecha para não achatar ninguém.
function grid(n: number): { cols: number; rows: number } {
  if (n <= 3) return { cols: n, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  return { cols: 3, rows: 3 };
}

// O avatar é derivado do espaço que sobra, não de uma tabela fixa: com tamanho
// chumbado a call de 9 transborda e a de 2 fica minúscula.
function layout(n: number): Layout {
  const { cols, rows } = grid(n);
  const cellW = WIDTH / cols;
  const cellH = (HEIGHT - TOP_PAD - BOTTOM_PAD) / rows;

  // Teto por lotação: com pouca gente o avatar pode crescer, com muita ele precisa
  // caber sem encostar no card do lado.
  const cap = n === 1 ? 360 : n <= 3 ? 320 : n <= 4 ? 212 : 158;
  // cardW = size·1,28 e cardH = size·1,58 (ver pad e nameH abaixo). As folgas de 76
  // e 34 são o respiro entre cards — sem elas eles encostam na borda do quadro.
  const size = Math.max(64, Math.floor(Math.min(cap, (cellW - 76) / 1.28, (cellH - 34) / 1.58)));

  const pad = Math.round(size * 0.14);
  const nameH = Math.round(size * 0.3);
  const w = size + pad * 2;
  const h = size + pad * 2 + nameH;

  const cards: Card[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const inRow = Math.min(cols, n - r * cols);
    const rowW = inRow * cellW;
    const x = Math.round((WIDTH - rowW) / 2 + c * cellW + (cellW - w) / 2);
    const y = Math.round(TOP_PAD + r * cellH + (cellH - h) / 2);
    cards.push({
      x,
      y,
      w,
      h,
      avatarX: x + pad,
      avatarY: y + pad,
      nameY: y + pad + size + Math.round(pad * 0.95),
    });
  }

  return {
    cards,
    size,
    ring: Math.max(4, Math.round(size * 0.05)),
    glow: Math.round(size * 0.24),
    fontSize: Math.min(26, Math.max(13, Math.round(size * 0.15))),
  };
}

// Um disco desenhado por equação: o alpha zera fora do raio. É como o avatar fica
// redondo sem máscara em arquivo, e como o anel de fala existe — drawbox só sabe
// desenhar retângulo.
//
// `margin` é o que o desfoque tem pra vazar: o gblur não pinta fora da tela do
// filtro, então sem folga o brilho é cortado num quadrado visível em volta de quem
// está falando.
function disc(
  diameter: number,
  color: string,
  alpha: number,
  blur = 0,
  margin = 0,
  scaleTo = 0
): Disc {
  const drawn = diameter + margin * 2;
  const c = (drawn / 2).toFixed(1);
  const r = (diameter / 2).toFixed(1);
  const a = Math.round(alpha * 255);
  const src = `color=c=${color}:s=${drawn}x${drawn}:r=1:d=1,format=rgba`;
  const mask = `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-${c},Y-${c}),${r}),${a},0)'`;
  const parts = [src, mask];
  if (blur > 0) parts.push(`gblur=sigma=${blur}`);
  // Desfoque grande é caro por pixel. Borrar pequeno e ampliar depois entrega a
  // mesma mancha suave por uma fração do custo — a ampliação ainda suaviza mais.
  if (scaleTo > 0) parts.push(`scale=${scaleTo}:${scaleTo}`);
  return { filter: parts.join(','), canvas: scaleTo > 0 ? scaleTo : drawn };
}

interface Disc {
  filter: string;
  canvas: number;
}

// Um stream de filtro só pode ser consumido uma vez. O split é o que deixa o mesmo
// disco servir as nove pessoas sem gerar nove vezes o mesmo pixel.
function fanOut(chain: string[], source: string, name: string, count: number): string[] {
  if (count === 0) return [];
  if (count === 1) {
    chain.push(`${source}[${name}0]`);
    return [`${name}0`];
  }
  const labels = Array.from({ length: count }, (_, i) => `${name}${i}`);
  chain.push(`${source}[${name}_src]`);
  chain.push(`[${name}_src]split=${count}${labels.map((l) => `[${l}]`).join('')}`);
  return labels;
}

// Tudo que entra por overlay é posicionado pelo centro: o brilho, o anel e o
// avatar têm telas de tamanhos diferentes e só ficam concêntricos assim.
interface Placed {
  label: string;
  cx: number;
  cy: number;
  canvas: number;
  enable: string | null;
}

function buildFilters(
  participants: Participant[],
  timeline: Timeline,
  duration: number,
  title: string
): string {
  const l = layout(participants.length);
  const chain: string[] = [];

  // Foco de luz no meio da sala em vez de fundo chapado: dá profundidade e puxa o
  // olho pro grupo. O filtro `gradients` faria isso, mas o raio dele no modo radial
  // não acompanha as coordenadas — um disco borrado é previsível.
  const cx = Math.round(WIDTH / 2);
  const cy = Math.round(TOP_PAD + (HEIGHT - TOP_PAD - BOTTOM_PAD) / 2);
  const spot = disc(190, BG_CENTER, 0.85, 30, 90, 1180);
  chain.push(`color=c=${BG_EDGE}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${duration.toFixed(2)}[base]`);
  chain.push(`${spot.filter}[spot]`);
  chain.push(
    `[base][spot]overlay=x=${cx - spot.canvas / 2}:y=${cy - spot.canvas / 2}:eof_action=repeat[bg]`
  );

  const speaking = participants.map((p) => {
    const segments = timeline.get(p.userId) ?? [];
    return segments.length > 0 ? enableExpr(segments) : null;
  });

  const withAvatar = participants.filter((p) => p.avatarUrl).length;
  const talkers = speaking.filter((e) => e !== null).length;

  const ringD = l.size + l.ring * 2;
  const glow = disc(ringD + l.glow, ACCENT, 0.55, l.glow / 2, l.glow);
  const ring = disc(ringD, ACCENT, 1);
  const idle = disc(ringD, IDLE_RING, 1);
  const blank = disc(l.size, CARD_EDGE, 1);

  const glowLabels = fanOut(chain, glow.filter, 'glow', talkers);
  const ringLabels = fanOut(chain, ring.filter, 'ring', talkers);
  const idleLabels = fanOut(chain, idle.filter, 'idle', participants.length);
  const blankLabels = fanOut(chain, blank.filter, 'blank', participants.length - withAvatar);

  // Os cards são retângulo puro, então saem todos numa passada só de drawbox — bem
  // mais barato que um overlay por pessoa. A lavagem verde de quem fala entra aqui
  // porque o avatar é desenhado depois e cobre o miolo.
  const boxes: string[] = [];
  participants.forEach((_, i) => {
    const c = l.cards[i];
    const box = `x=${c.x}:y=${c.y}:w=${c.w}:h=${c.h}`;
    boxes.push(`drawbox=${box}:color=${CARD}@1:t=fill`);
    boxes.push(`drawbox=${box}:color=${CARD_EDGE}@1:t=2`);
    if (speaking[i]) {
      boxes.push(`drawbox=${box}:color=${ACCENT}@0.07:t=fill:enable='${speaking[i]}'`);
      boxes.push(`drawbox=${box}:color=${ACCENT}@0.8:t=2:enable='${speaking[i]}'`);
    }
  });
  chain.push(`[bg]${boxes.join(',')}[room]`);

  // A ordem aqui é a pilha de trás pra frente: brilho, anel, avatar. O avatar é
  // redondo, então o anel aparece como borda em vez de sumir embaixo dele.
  const stack: Placed[] = [];
  let glowN = 0;
  let ringN = 0;
  let blankN = 0;
  let inputIdx = 0;

  participants.forEach((p, i) => {
    const c = l.cards[i];
    const cx = c.avatarX + l.size / 2;
    const cy = c.avatarY + l.size / 2;
    const on = speaking[i];

    if (on) stack.push({ label: glowLabels[glowN++], cx, cy, canvas: glow.canvas, enable: on });
    stack.push({ label: idleLabels[i], cx, cy, canvas: idle.canvas, enable: null });
    if (on) stack.push({ label: ringLabels[ringN++], cx, cy, canvas: ring.canvas, enable: on });

    if (p.avatarUrl) {
      inputIdx++;
      const label = `av${i}`;
      const r = (l.size / 2).toFixed(1);
      chain.push(
        `[${inputIdx}:v]scale=${l.size}:${l.size},setsar=1,format=rgba,` +
          `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-${r},Y-${r}),${r}),255,0)'[${label}]`
      );
      stack.push({ label, cx, cy, canvas: l.size, enable: null });
    } else {
      stack.push({ label: blankLabels[blankN++], cx, cy, canvas: blank.canvas, enable: null });
    }
  });

  let last = 'room';
  stack.forEach((s, i) => {
    const out = `ov${i}`;
    const on = s.enable ? `:enable='${s.enable}'` : '';
    const x = Math.round(s.cx - s.canvas / 2);
    const y = Math.round(s.cy - s.canvas / 2);
    chain.push(`[${last}][${s.label}]overlay=x=${x}:y=${y}:eof_action=repeat${on}[${out}]`);
    last = out;
  });

  const text: string[] = [];
  if (FONT) {
    text.push(
      `drawtext=fontfile=${FONT}:text='${safeText(title, 40)}':fontcolor=${TITLE}:fontsize=20:x=(w-text_w)/2:y=22`
    );
    participants.forEach((p, i) => {
      const c = l.cards[i];
      text.push(
        `drawtext=fontfile=${FONT}:text='${safeText(p.name, 14)}':fontcolor=${NAME}:` +
          `fontsize=${l.fontSize}:x=${c.x + c.w / 2}-text_w/2:y=${c.nameY}`
      );
    });
  }

  chain.push(`[${last}]${[...text, 'format=yuv420p'].join(',')}[v]`);
  return chain.join(';');
}

// Só a CDN do Discord: a URL vem do displayAvatarURL, mas deixar host livre aqui
// transformaria o export num buscador de URL arbitrária rodando no servidor.
function isDiscordAvatar(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /(^|\.)discordapp\.com$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

async function downloadAvatar(
  participant: Participant,
  filename: string,
  i: number
): Promise<string | null> {
  if (!participant.avatarUrl || !isDiscordAvatar(participant.avatarUrl)) return null;
  const target = path.join(RECORDINGS_DIR, `${filename}_av${i}.png`);
  try {
    const res = await fetch(participant.avatarUrl, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 2 * 1024 * 1024) return null;
    fs.writeFileSync(target, buf);
    return target;
  } catch (err: any) {
    logger.warn(`[VIDEO] avatar de ${participant.userId} falhou: ${err?.message}`);
    return null;
  }
}

// Um render por vez. São 3 núcleos dividindo com a mixagem de voz das calls
// abertas: dois x264 simultâneos fazem o bot gaguejar em quem nem pediu clip.
let rendering = false;

export function renderBusy(): boolean {
  return rendering;
}

export const MAX_VIDEO_SECONDS = 300;

export async function exportRoomVideo(
  timeline: Timeline,
  participants: Participant[],
  audioPath: string,
  filename: string,
  title: string
): Promise<string> {
  if (rendering) throw new Error('busy');
  if (participants.length === 0) throw new Error('No participants to render');

  rendering = true;
  const outputPath = path.join(RECORDINGS_DIR, `${filename}.mp4`);
  const temps: string[] = [];

  try {
    const duration = Math.min(Math.max(timelineDuration(timeline), 1), MAX_VIDEO_SECONDS);

    const spoken = (userId: string) =>
      (timeline.get(userId) ?? []).reduce((total, s) => total + (s.end - s.start), 0);
    const shown = [...participants]
      .sort((a, b) => spoken(b.userId) - spoken(a.userId))
      .slice(0, MAX_PEOPLE);

    const withAvatars: Participant[] = [];
    for (let i = 0; i < shown.length; i++) {
      const local = await downloadAvatar(shown[i], filename, i);
      if (local) temps.push(local);
      withAvatars.push({ ...shown[i], avatarUrl: local });
    }

    const args = ['-y', '-i', audioPath];
    for (const p of withAvatars) if (p.avatarUrl) args.push('-i', p.avatarUrl);

    args.push(
      '-filter_complex',
      buildFilters(withAvatars, timeline, duration, title),
      '-map',
      '[v]',
      '-map',
      '0:a',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'stillimage',
      '-crf',
      '30',
      '-r',
      String(FPS),
      // Dois núcleos, não os três: a call continua rodando enquanto o vídeo
      // renderiza, e mixagem de voz que atrasa é falha que todo mundo ouve.
      '-threads',
      '2',
      '-filter_threads',
      '1',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-movflags',
      '+faststart',
      '-shortest',
      outputPath
    );

    const startedAt = Date.now();
    await runFfmpeg(args);
    const size = fs.statSync(outputPath).size;
    logger.info(
      `[VIDEO] ${outputPath}: ${duration.toFixed(1)}s, ${withAvatars.length} pessoas, ` +
        `${(size / 1024 / 1024).toFixed(2)}MB em ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    );
    return outputPath;
  } finally {
    rendering = false;
    for (const t of temps) {
      try {
        fs.unlinkSync(t);
      } catch {
        /* já removido */
      }
    }
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });

    const timer = setTimeout(() => proc.kill('SIGKILL'), 120_000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg saiu com ${code}: ${stderr.slice(-600)}`));
    });
  });
}
