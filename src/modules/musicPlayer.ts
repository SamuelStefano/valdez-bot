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

export interface AddResult {
  tracks: Track[];
  source: 'youtube' | 'spotify' | 'search';
  playlistName?: string;
}

interface GuildQueue {
  tracks: Track[];
  history: Track[];
  current: Track | null;
  player: AudioPlayer;
  loop: boolean;
  volume: number;
}

const queues = new Map<string, GuildQueue>();
const HISTORY_MAX = 25;

export type PlayerUpdateEvent =
  | 'trackStart'
  | 'trackEnd'
  | 'paused'
  | 'resumed'
  | 'queueChanged'
  | 'stopped';

let onUpdate: ((guildId: string, event: PlayerUpdateEvent) => void) | null = null;

export function setOnPlayerUpdate(cb: (guildId: string, event: PlayerUpdateEvent) => void) {
  onUpdate = cb;
}

function emit(guildId: string, event: PlayerUpdateEvent) {
  try {
    onUpdate?.(guildId, event);
  } catch (err) {
    logger.error(`Player update callback failed: ${(err as Error).message}`);
  }
}

function getOrCreateQueue(guildId: string): GuildQueue {
  if (!queues.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    player.on(AudioPlayerStatus.Idle, () => {
      const queue = queues.get(guildId);
      if (!queue) return;

      if (queue.current) {
        if (queue.loop) {
          queue.tracks.unshift(queue.current);
        } else {
          queue.history.unshift(queue.current);
          if (queue.history.length > HISTORY_MAX) queue.history.pop();
        }
      }

      queue.current = null;
      emit(guildId, 'trackEnd');
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
      history: [],
      current: null,
      player,
      loop: false,
      volume: 100,
    });
  }
  return queues.get(guildId)!;
}

async function ensureSpotifyToken(): Promise<boolean> {
  try {
    if (play.is_expired()) {
      await play.refreshToken();
    }
    return true;
  } catch (err) {
    logger.warn(`Spotify token refresh failed: ${(err as Error).message}`);
    return false;
  }
}

async function buildTrackFromYouTube(url: string, requestedBy: string): Promise<Track | null> {
  const info = await play.video_info(url);
  return {
    title: info.video_details.title || 'Unknown',
    url: info.video_details.url,
    duration: formatSeconds(info.video_details.durationInSec),
    requestedBy,
    thumbnail: info.video_details.thumbnails[0]?.url,
  };
}

async function buildTrackFromSpotifySearch(
  name: string,
  artist: string,
  requestedBy: string,
  thumbnail?: string,
): Promise<Track | null> {
  const q = `${name} ${artist}`.trim();
  const results = await play.search(q, { limit: 1, source: { youtube: 'video' } });
  if (!results[0]) return null;
  return {
    title: name || results[0].title || 'Unknown',
    url: results[0].url,
    duration: formatSeconds(results[0].durationInSec),
    requestedBy,
    thumbnail: thumbnail || results[0].thumbnails[0]?.url,
  };
}

export async function addTracks(
  guildId: string,
  query: string,
  requestedBy: string,
): Promise<AddResult | null> {
  const queue = getOrCreateQueue(guildId);

  try {
    const urlType = await play.validate(query);

    // YouTube single video
    if (urlType === 'yt_video') {
      const track = await buildTrackFromYouTube(query, requestedBy);
      if (!track) return null;
      queue.tracks.push(track);
      if (!queue.current) playNext(guildId);
      return { tracks: [track], source: 'youtube' };
    }

    // YouTube playlist
    if (urlType === 'yt_playlist') {
      const pl = await play.playlist_info(query, { incomplete: true });
      const videos = await pl.all_videos();
      const tracks: Track[] = videos.map((v) => ({
        title: v.title || 'Unknown',
        url: v.url,
        duration: formatSeconds(v.durationInSec),
        requestedBy,
        thumbnail: v.thumbnails[0]?.url,
      }));
      if (tracks.length === 0) return null;
      queue.tracks.push(...tracks);
      if (!queue.current) playNext(guildId);
      return { tracks, source: 'youtube', playlistName: pl.title || 'Playlist' };
    }

    // Spotify (track / playlist / album)
    if (urlType === 'sp_track' || urlType === 'sp_playlist' || urlType === 'sp_album') {
      const ok = await ensureSpotifyToken();
      if (!ok && urlType !== 'sp_track') {
        logger.error('Spotify token not configured — cannot fetch playlist/album');
        return null;
      }

      const sp: any = await play.spotify(query);

      if (sp.type === 'track') {
        const track = await buildTrackFromSpotifySearch(
          sp.name,
          sp.artists?.[0]?.name || '',
          requestedBy,
          sp.thumbnail?.url,
        );
        if (!track) return null;
        queue.tracks.push(track);
        if (!queue.current) playNext(guildId);
        return { tracks: [track], source: 'spotify' };
      }

      if (sp.type === 'playlist' || sp.type === 'album') {
        const allTracks: any[] =
          typeof sp.all_tracks === 'function' ? await sp.all_tracks() : sp.fetched_tracks?.get('1') || [];

        if (allTracks.length === 0) return null;

        // Resolve first track immediately so playback starts
        const first = allTracks[0];
        const firstTrack = await buildTrackFromSpotifySearch(
          first.name,
          first.artists?.[0]?.name || '',
          requestedBy,
          first.thumbnail?.url,
        );

        const resolved: Track[] = [];
        if (firstTrack) {
          resolved.push(firstTrack);
          queue.tracks.push(firstTrack);
          if (!queue.current) playNext(guildId);
        }

        // Resolve the rest in background — don't block /play response
        (async () => {
          for (let i = 1; i < allTracks.length; i++) {
            const t = allTracks[i];
            try {
              const track = await buildTrackFromSpotifySearch(
                t.name,
                t.artists?.[0]?.name || '',
                requestedBy,
                t.thumbnail?.url,
              );
              if (track) {
                queue.tracks.push(track);
                resolved.push(track);
              }
            } catch (err) {
              logger.warn(`Failed to resolve spotify track "${t.name}": ${(err as Error).message}`);
            }
          }
          logger.info(`Spotify ${sp.type} fully resolved: ${resolved.length}/${allTracks.length} tracks`);
        })();

        return {
          tracks: resolved,
          source: 'spotify',
          playlistName: sp.name || (sp.type === 'album' ? 'Album' : 'Playlist'),
        };
      }

      return null;
    }

    // Free-text search → YouTube
    const results = await play.search(query, { limit: 1 });
    if (!results[0]) return null;
    const track: Track = {
      title: results[0].title || 'Unknown',
      url: results[0].url,
      duration: formatSeconds(results[0].durationInSec),
      requestedBy,
      thumbnail: results[0].thumbnails[0]?.url,
    };
    queue.tracks.push(track);
    if (!queue.current) playNext(guildId);
    return { tracks: [track], source: 'search' };
  } catch (err) {
    logger.error(`Error adding track "${query}": ${(err as Error).message}`);
    return null;
  }
}

async function playNext(guildId: string) {
  const queue = getOrCreateQueue(guildId);

  if (queue.tracks.length === 0) {
    queue.current = null;
    mute();
    emit(guildId, 'stopped');
    return;
  }

  const track = queue.tracks.shift()!;
  queue.current = track;

  try {
    const stream = await play.stream(track.url);
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
    });

    unmute();

    const connection = getConnection();
    if (connection) {
      connection.subscribe(queue.player);
    }

    queue.player.play(resource);
    logger.info(`Now playing: ${track.title}`);
    emit(guildId, 'trackStart');
  } catch (err) {
    logger.error(`Error playing ${track.title}: ${(err as Error).message}`);
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

export function previous(guildId: string): Track | null {
  const queue = queues.get(guildId);
  if (!queue) return null;
  const prev = queue.history.shift();
  if (!prev) return null;
  // Put current track back at the front so we don't lose it
  if (queue.current) queue.tracks.unshift(queue.current);
  queue.tracks.unshift(prev);
  queue.current = null;
  queue.player.stop();
  return prev;
}

export function stop(guildId: string) {
  const queue = queues.get(guildId);
  if (!queue) return;
  queue.tracks = [];
  queue.history = [];
  queue.current = null;
  queue.loop = false;
  queue.player.stop();
  mute();
  emit(guildId, 'stopped');
}

export function pause(guildId: string): boolean {
  const queue = queues.get(guildId);
  if (!queue) return false;
  const ok = queue.player.pause();
  if (ok) emit(guildId, 'paused');
  return ok;
}

export function resume(guildId: string): boolean {
  const queue = queues.get(guildId);
  if (!queue) return false;
  const ok = queue.player.unpause();
  if (ok) emit(guildId, 'resumed');
  return ok;
}

export function isPaused(guildId: string): boolean {
  const queue = queues.get(guildId);
  if (!queue) return false;
  return queue.player.state.status === AudioPlayerStatus.Paused;
}

export function toggleLoop(guildId: string): boolean {
  const queue = getOrCreateQueue(guildId);
  queue.loop = !queue.loop;
  emit(guildId, 'queueChanged');
  return queue.loop;
}

export function getQueue(guildId: string): {
  current: Track | null;
  tracks: Track[];
  history: Track[];
  loop: boolean;
} {
  const queue = queues.get(guildId);
  if (!queue) return { current: null, tracks: [], history: [], loop: false };
  return {
    current: queue.current,
    tracks: [...queue.tracks],
    history: [...queue.history],
    loop: queue.loop,
  };
}

export function nowPlaying(guildId: string): Track | null {
  return queues.get(guildId)?.current || null;
}

export function getPlayer(guildId: string): AudioPlayer {
  return getOrCreateQueue(guildId).player;
}

function formatSeconds(sec: number): string {
  if (!sec || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
