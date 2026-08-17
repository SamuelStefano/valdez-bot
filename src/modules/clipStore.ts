// Guarda o clip recém-postado para que os botões de formato possam entregar a
// outra versão sem regravar nada. O que fica na memória é a timeline (poucos KB)
// e o caminho do mp3 — os pacotes de áudio, que são o volume de verdade, morrem
// junto com a exportação.
import fs from 'fs';
import { Timeline } from '../utils/videoExporter';
import { logger } from '../utils/logger';

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 6;

export interface PendingClip {
  id: string;
  guildId: string;
  kind: 'clip' | 'replay';
  seconds: number;
  label: string;
  audioPath: string;
  videoPath: string | null;
  timeline: Timeline;
  userIds: string[];
  channelName: string | null;
  authorId: string;
  authorName: string;
  authorIcon: string;
  createdAt: number;
}

const clips = new Map<string, PendingClip>();

function discard(clip: PendingClip): void {
  for (const p of [clip.audioPath, clip.videoPath]) {
    if (!p) continue;
    try {
      fs.unlinkSync(p);
    } catch {
      /* já removido */
    }
  }
}

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, clip] of clips) {
    if (clip.createdAt < cutoff) {
      clips.delete(id);
      discard(clip);
    }
  }
  // A VPS é compartilhada com as calls ao vivo: um teto duro de entradas impede
  // que uma rajada de /clip encha o disco antes do TTL vencer.
  while (clips.size > MAX_ENTRIES) {
    const oldest = clips.keys().next().value!;
    const clip = clips.get(oldest)!;
    clips.delete(oldest);
    discard(clip);
  }
}

export function storeClip(
  data: Omit<PendingClip, 'id' | 'createdAt' | 'videoPath'>
): PendingClip {
  const clip: PendingClip = {
    ...data,
    id: Math.random().toString(36).slice(2, 10),
    videoPath: null,
    createdAt: Date.now(),
  };
  clips.set(clip.id, clip);
  sweep();
  return clip;
}

export function getClip(id: string): PendingClip | null {
  sweep();
  return clips.get(id) ?? null;
}

export function attachVideo(id: string, videoPath: string): void {
  const clip = clips.get(id);
  if (clip) clip.videoPath = videoPath;
}

export function dropAllClips(): void {
  for (const clip of clips.values()) discard(clip);
  clips.clear();
  logger.info('[CLIP] cache de clips limpo');
}
