// Guarda o clip recém-postado para que os botões de formato possam entregar a
// outra versão sem regravar nada. O que fica na memória é a timeline (poucos KB)
// e o caminho do mp3 — os pacotes de áudio, que são o volume de verdade, morrem
// junto com a exportação.
import fs from 'fs';
import { Timeline } from '../utils/videoExporter';
import { logger } from '../utils/logger';

const TTL_MS = 10 * 60_000;
const MAX_PER_GUILD = 6;

// O upload do anexo acontece depois do storeClip. Sem esta carência, uma rajada
// de clips apagava do disco o mp3 que ainda estava subindo — em outro servidor.
const EVICTION_GRACE_MS = 90_000;

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
  // O teto é por servidor: quando era global, uma rajada de /clip num servidor
  // expulsava o clip de outro e os botões dele passavam a responder "expirou".
  const byGuild = new Map<string, PendingClip[]>();
  for (const clip of clips.values()) {
    const list = byGuild.get(clip.guildId) ?? [];
    list.push(clip);
    byGuild.set(clip.guildId, list);
  }
  const grace = Date.now() - EVICTION_GRACE_MS;
  for (const list of byGuild.values()) {
    const evictable = list.filter((c) => c.createdAt < grace);
    while (list.length > MAX_PER_GUILD && evictable.length > 0) {
      const oldest = evictable.shift()!;
      list.splice(list.indexOf(oldest), 1);
      clips.delete(oldest.id);
      discard(oldest);
    }
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
