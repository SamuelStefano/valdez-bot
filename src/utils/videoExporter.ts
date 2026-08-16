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

// A sala é quase estática: o que muda entre frames é um retângulo acendendo. Por
// isso dá pra entregar 720p — o custo real está em quantos frames existem, e 12
// fps é o piso em que o realce ainda parece instantâneo.
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 12;
const TOP_PAD = 64; // faixa do título
const FLOOR_H = 90;

const BG = '0x14151c';
const FLOOR = '0x1e2029';
const IDLE = '0x3d4152';
const GLOW = '0x1f5f45';
const SPEAKING = '0x3ddc84';
const NAME = '0xc8cbd9';
const TITLE = '0x6b7086';

// Cada participante custa ~10 filtros e mais uma entrada de imagem no ffmpeg.
// Numa call de 20 pessoas o grafo fica impossível de renderizar e ninguém
// enxerga avatar de 40px — mostrar quem mais falou entrega o mesmo clip.
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

// Segmento curto demais vira piscada: o avatar acende e apaga no mesmo frame e o
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
export function speakingTimeline(packets: Map<string, OpusPacket[]>): Map<string, Segment[]> {
  let minTs = Infinity;
  for (const userPackets of packets.values()) {
    for (const p of userPackets) if (p.timestamp < minTs) minTs = p.timestamp;
  }
  if (!Number.isFinite(minTs)) return new Map();

  const timeline = new Map<string, Segment[]>();

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

interface Slot {
  cx: number;
  top: number;
}

// Tronco + braços + pernas, proporcionais ao avatar (a cabeça).
function bodyMetrics(size: number) {
  const torso = Math.round(size * 0.46);
  const legs = Math.round(size * 0.3);
  return { torso, legs, arm: Math.round(size * 0.48), bar: Math.max(4, Math.round(size * 0.05)), height: torso + legs };
}

// Até 4 pessoas cabem numa fileira só, e uma fileira só é o que faz a call de
// dois ou três — a que mais vira clip — ocupar a tela em vez de virar dois
// ícones perdidos. Acima disso o grid fecha em 3 colunas.
function grid(n: number): { cols: number; rows: number } {
  const cols = n <= 4 ? n : 3;
  return { cols, rows: Math.ceil(n / cols) };
}

// O avatar é derivado do espaço que sobra, não de uma tabela fixa: com altura
// chumbada uma call de 9 transbordava pro chão e a de 2 ficava minúscula.
function layout(n: number): { slots: Slot[]; size: number } {
  const { cols, rows } = grid(n);
  const cellW = WIDTH / cols;
  const cellH = (HEIGHT - TOP_PAD - FLOOR_H) / rows;
  // figureH = size + pescoço(10) + corpo(0,76·size) + nome(30). Os 24 extras são
  // respiro entre fileiras: sem eles o nome de quem está em cima encosta na
  // cabeça de quem está embaixo.
  const size = Math.min(176, Math.floor((cellH - 64) / 1.76), Math.floor(cellW * 0.6));
  const figureH = size + 10 + bodyMetrics(size).height + 30;

  const slots: Slot[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const inRow = Math.min(cols, n - r * cols);
    const rowW = inRow * cellW;
    slots.push({
      cx: Math.round((WIDTH - rowW) / 2 + c * cellW + cellW / 2),
      top: Math.round(TOP_PAD + r * cellH + (cellH - figureH) / 2),
    });
  }

  // Desce o conjunto até a última fileira encostar no chão: centralizado na
  // vertical, o boneco fica flutuando acima da linha do piso e a sala perde o
  // sentido de sala.
  const lowest = Math.max(...slots.map((s) => s.top)) + figureH;
  const drop = HEIGHT - FLOOR_H - 16 - lowest;
  if (drop > 0) for (const s of slots) s.top += drop;

  return { slots, size };
}

// O boneco é desenhado duas vezes — uma apagada, uma acesa por cima só enquanto a
// pessoa fala — porque trocar a cor de um mesmo drawbox ao longo do tempo não
// existe no ffmpeg.
function figure(cx: number, top: number, size: number, color: string, enable: string | null): string[] {
  const { torso, legs, arm, bar } = bodyMetrics(size);
  const on = enable ? `:enable='${enable}'` : '';
  const t = `:color=${color}@1:t=fill${on}`;
  const neck = top + size + 10;
  return [
    `drawbox=x=${cx - Math.round(bar / 2)}:y=${neck}:w=${bar}:h=${torso}${t}`,
    `drawbox=x=${cx - Math.round(arm / 2)}:y=${neck + Math.round(torso * 0.25)}:w=${arm}:h=${bar}${t}`,
    `drawbox=x=${cx - Math.round(size * 0.14)}:y=${neck + torso}:w=${bar}:h=${legs}${t}`,
    `drawbox=x=${cx + Math.round(size * 0.14) - bar}:y=${neck + torso}:w=${bar}:h=${legs}${t}`,
  ];
}

function buildFilters(
  participants: Participant[],
  timeline: Map<string, Segment[]>,
  duration: number,
  title: string
): string {
  const { slots, size } = layout(participants.length);
  const { height: bodyH } = bodyMetrics(size);
  const ring = Math.max(5, Math.round(size * 0.055));

  const chain: string[] = [
    `color=c=${BG}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${duration.toFixed(2)}[bg]`,
  ];
  const draws: string[] = [`drawbox=x=0:y=${HEIGHT - FLOOR_H}:w=${WIDTH}:h=${FLOOR_H}:color=${FLOOR}@1:t=fill`];
  const overlays: { label: string; x: number; y: number }[] = [];
  let imageIdx = 0;

  participants.forEach((p, i) => {
    const { cx, top } = slots[i];
    const x = cx - Math.round(size / 2);
    const segments = timeline.get(p.userId) ?? [];
    const enable = segments.length > 0 ? enableExpr(segments) : null;

    // Placas concêntricas atrás do avatar: a de fora é o brilho, a de dentro é o
    // anel. Sobram como moldura porque o avatar entra por cima depois.
    const plate = (pad: number, color: string, on: string | null) =>
      `drawbox=x=${x - pad}:y=${top - pad}:w=${size + pad * 2}:h=${size + pad * 2}:color=${color}@1:t=fill${on ? `:enable='${on}'` : ''}`;

    draws.push(plate(ring, IDLE, null));
    draws.push(...figure(cx, top, size, IDLE, null));
    if (enable) {
      draws.push(plate(ring * 3, GLOW, enable));
      draws.push(plate(ring, SPEAKING, enable));
      draws.push(...figure(cx, top, size, SPEAKING, enable));
    }

    if (p.avatarUrl) {
      imageIdx++;
      chain.push(`[${imageIdx}:v]scale=${size}:${size},setsar=1[av${i}]`);
      overlays.push({ label: `av${i}`, x, y: top });
    }
  });

  let last = 'bg';
  chain.push(`[${last}]${draws.join(',')}[drawn]`);
  last = 'drawn';

  overlays.forEach((o, i) => {
    const out = `ov${i}`;
    chain.push(`[${last}][${o.label}]overlay=x=${o.x}:y=${o.y}:eof_action=repeat[${out}]`);
    last = out;
  });

  const text: string[] = [];
  if (FONT) {
    text.push(
      `drawtext=fontfile=${FONT}:text='${safeText(title, 40)}':fontcolor=${TITLE}:fontsize=22:x=(w-text_w)/2:y=26`
    );
    participants.forEach((p, i) => {
      const { cx, top } = slots[i];
      const fontSize = size >= 130 ? 24 : size >= 100 ? 20 : 17;
      text.push(
        `drawtext=fontfile=${FONT}:text='${safeText(p.name, 14)}':fontcolor=${NAME}:fontsize=${fontSize}:x=${cx}-text_w/2:y=${top + size + 10 + bodyH + 14}`
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

async function downloadAvatar(participant: Participant, filename: string, i: number): Promise<string | null> {
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

/**
 * Monta o vídeo da sala a partir do mp3 já exportado: fundo, avatar de cada
 * participante e o realce verde acendendo exatamente enquanto a pessoa fala.
 */
export async function exportRoomVideo(
  packets: Map<string, OpusPacket[]>,
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
    const timeline = speakingTimeline(packets);
    let duration = 0;
    for (const segments of timeline.values()) {
      for (const s of segments) if (s.end > duration) duration = s.end;
    }
    duration = Math.min(Math.max(duration, 1), MAX_VIDEO_SECONDS);

    const spoken = (userId: string) =>
      (timeline.get(userId) ?? []).reduce((total, s) => total + (s.end - s.start), 0);
    const shown = [...participants].sort((a, b) => spoken(b.userId) - spoken(a.userId)).slice(0, MAX_PEOPLE);

    const withAvatars: Participant[] = [];
    for (let i = 0; i < shown.length; i++) {
      const local = await downloadAvatar(shown[i], filename, i);
      if (local) temps.push(local);
      withAvatars.push({ ...shown[i], avatarUrl: local });
    }

    const args = ['-y', '-i', audioPath];
    for (const p of withAvatars) if (p.avatarUrl) args.push('-i', p.avatarUrl);

    args.push(
      '-filter_complex', buildFilters(withAvatars, timeline, duration, title),
      '-map', '[v]',
      '-map', '0:a',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'stillimage',
      '-crf', '30',
      '-r', String(FPS),
      // Dois núcleos, não os três: a call continua rodando enquanto o vídeo
      // renderiza, e mixagem de voz que atrasa é falha que todo mundo ouve.
      '-threads', '2',
      '-filter_threads', '1',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-movflags', '+faststart',
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
      } catch {}
    }
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args);
    let stderrLog = '';

    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      reject(new Error('ffmpeg timed out after 120s'));
    }, 120_000);

    ffmpeg.stderr.on('data', (data: Buffer) => {
      stderrLog += data.toString();
    });
    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderrLog.slice(-600)}`));
    });
    ffmpeg.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
