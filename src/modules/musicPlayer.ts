import {
  AudioPlayer,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import play from 'play-dl';
import { logger } from '../utils/logger';
import { getConnection, unmute, mute } from './voiceManager';

export interface Track {
  title: string;
  url: string;
  duration: string;
  requestedBy: string;
  thumbnail?: string;
}

interface GuildQueue {
  tracks: Track[];
  current: Track | null;
  player: AudioPlayer;
  loop: boolean;
  volume: number;
}

const queues = new Map<string, GuildQueue>();

function getOrCreateQueue(guildId: string): GuildQueue {
  if (!queues.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    player.on(AudioPlayerStatus.Idle, () => {
      const queue = queues.get(guildId);
      if (!queue) return;

      if (queue.loop && queue.current) {
        // Re-add current track to front
        queue.tracks.unshift(queue.current);
      }

      queue.current = null;
      playNext(guildId);
    });

    player.on('error', (err) => {
      logger.error('Audio player error:', err);
      const queue = queues.get(guildId);
      if (queue) {
        queue.current = null;
        playNext(guildId);
      }
    });

    queues.set(guildId, {
      tracks: [],
      current: null,
      player,
      loop: false,
      volume: 100,
    });
  }
  return queues.get(guildId)!;
}

export async function addTrack(guildId: string, query: string, requestedBy: string): Promise<Track | null> {
  const queue = getOrCreateQueue(guildId);

  try {
    let info: Track | null = null;

    // Check if it's a URL
    const urlType = await play.validate(query);

    if (urlType === 'yt_video') {
      const videoInfo = await play.video_info(query);
      info = {
        title: videoInfo.video_details.title || 'Unknown',
        url: videoInfo.video_details.url,
        duration: formatSeconds(videoInfo.video_details.durationInSec),
        requestedBy,
        thumbnail: videoInfo.video_details.thumbnails[0]?.url,
      };
    } else if (urlType === 'sp_track') {
      // Spotify track — search on YouTube
      const sp = await play.spotify(query) as any;
      if (sp.type === 'track') {
        const searched = await play.search(`${sp.name} ${sp.artists?.[0]?.name || ''}`, { limit: 1 });
        if (searched[0]) {
          info = {
            title: sp.name,
            url: searched[0].url,
            duration: formatSeconds(searched[0].durationInSec),
            requestedBy,
            thumbnail: sp.thumbnail?.url,
          };
        }
      }
    } else {
      // Search YouTube
      const results = await play.search(query, { limit: 1 });
      if (results[0]) {
        info = {
          title: results[0].title || 'Unknown',
          url: results[0].url,
          duration: formatSeconds(results[0].durationInSec),
          requestedBy,
          thumbnail: results[0].thumbnails[0]?.url,
        };
      }
    }

    if (!info) return null;

    queue.tracks.push(info);

    // If nothing is playing, start
    if (!queue.current) {
      playNext(guildId);
    }

    return info;
  } catch (err) {
    logger.error('Error adding track:', err);
    return null;
  }
}

async function playNext(guildId: string) {
  const queue = getOrCreateQueue(guildId);

  if (queue.tracks.length === 0) {
    queue.current = null;
    // Mute when not playing
    mute();
    return;
  }

  const track = queue.tracks.shift()!;
  queue.current = track;

  try {
    const stream = await play.stream(track.url);
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
    });

    // Unmute to play
    unmute();

    const connection = getConnection();
    if (connection) {
      connection.subscribe(queue.player);
    }

    queue.player.play(resource);
    logger.info(`Now playing: ${track.title}`);
  } catch (err) {
    logger.error(`Error playing ${track.title}:`, err);
    queue.current = null;
    playNext(guildId);
  }
}

export function skip(guildId: string): Track | null {
  const queue = queues.get(guildId);
  if (!queue || !queue.current) return null;
  const skipped = queue.current;
  queue.player.stop();
  return skipped;
}

export function stop(guildId: string) {
  const queue = queues.get(guildId);
  if (!queue) return;
  queue.tracks = [];
  queue.current = null;
  queue.loop = false;
  queue.player.stop();
  mute();
}

export function pause(guildId: string): boolean {
  const queue = queues.get(guildId);
  if (!queue) return false;
  return queue.player.pause();
}

export function resume(guildId: string): boolean {
  const queue = queues.get(guildId);
  if (!queue) return false;
  return queue.player.unpause();
}

export function toggleLoop(guildId: string): boolean {
  const queue = getOrCreateQueue(guildId);
  queue.loop = !queue.loop;
  return queue.loop;
}

export function getQueue(guildId: string): { current: Track | null; tracks: Track[]; loop: boolean } {
  const queue = queues.get(guildId);
  if (!queue) return { current: null, tracks: [], loop: false };
  return { current: queue.current, tracks: [...queue.tracks], loop: queue.loop };
}

export function nowPlaying(guildId: string): Track | null {
  return queues.get(guildId)?.current || null;
}

function formatSeconds(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
