import { spawn } from 'child_process';
import { Readable } from 'stream';
import { logger } from './logger';

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const COOKIES_PATH = process.env.YT_COOKIES_PATH || '';

function commonArgs(): string[] {
  const a: string[] = [];
  if (COOKIES_PATH) a.push('--cookies', COOKIES_PATH);
  return a;
}

export interface YtInfo {
  id: string;
  title: string;
  url: string;
  durationSec: number;
  thumbnail?: string;
}

function runJson(args: string[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp exited ${code}: ${stderr.trim().slice(0, 300)}`));
      }
      const out = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((x) => x !== null);
      resolve(out);
    });
  });
}

function toInfo(j: any): YtInfo {
  return {
    id: j.id,
    title: j.title,
    url: j.webpage_url || `https://www.youtube.com/watch?v=${j.id}`,
    durationSec: Math.floor(j.duration || 0),
    thumbnail: j.thumbnail,
  };
}

export async function ytSearch(query: string, limit = 1): Promise<YtInfo[]> {
  const term = `ytsearch${limit}:${query}`;
  const items = await runJson([
    term,
    '--dump-json',
    '--no-warnings',
    '--no-playlist',
    '--skip-download',
    ...commonArgs(),
  ]);
  return items.map(toInfo);
}

export async function ytInfo(url: string): Promise<YtInfo | null> {
  const items = await runJson([
    url,
    '--dump-json',
    '--no-warnings',
    '--no-playlist',
    '--skip-download',
    ...commonArgs(),
  ]);
  return items[0] ? toInfo(items[0]) : null;
}

export async function ytPlaylist(url: string): Promise<{ title: string; videos: YtInfo[] }> {
  const items = await runJson([
    url,
    '--dump-json',
    '--no-warnings',
    '--flat-playlist',
    '--skip-download',
    ...commonArgs(),
  ]);
  // flat-playlist não traz duration / thumbnail; isso é OK pra fila
  return {
    title: items[0]?.playlist || items[0]?.playlist_title || 'YouTube Playlist',
    videos: items.map((j) => ({
      id: j.id,
      title: j.title || 'Unknown',
      url: j.url?.startsWith('http') ? j.url : `https://www.youtube.com/watch?v=${j.id}`,
      durationSec: Math.floor(j.duration || 0),
      thumbnail: j.thumbnails?.[0]?.url || j.thumbnail,
    })),
  };
}

/**
 * Spawns yt-dlp piping the audio to stdout. Returns a Readable.
 * Caller deve passar pra createAudioResource com inputType=Arbitrary
 * (ffmpeg do @discordjs/voice cuida da decodificação).
 */
export function ytStream(url: string): Readable {
  const proc = spawn(
    YTDLP,
    [
      url,
      '-f', 'bestaudio[ext=webm]/bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      '-o', '-',
      '--quiet',
      ...commonArgs(),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  proc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) logger.warn(`yt-dlp stderr: ${msg.slice(0, 200)}`);
  });
  proc.on('error', (err) => {
    logger.error(`yt-dlp spawn error: ${err.message}`);
  });

  // Quando o consumidor destruir o stream, mata o processo.
  proc.stdout.on('close', () => {
    if (!proc.killed) proc.kill('SIGKILL');
  });

  return proc.stdout;
}
