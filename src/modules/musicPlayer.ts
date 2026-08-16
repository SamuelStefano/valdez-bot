import {
  AudioPlayer,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  StreamType,
} from '@discordjs/voice';
import { logger } from '../utils/logger';
import { getConnection, unmute, mute, setMusicActive } from './voiceManager';
import { fetchSpotifyAlbum, fetchSpotifyPlaylist, fetchSpotifyTrack, SpotifyTrack } from '../utils/spotifyApi';
import { ytInfo, ytPlaylist, ytSearch, ytStream } from '../utils/ytdlp';

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

type UrlType = 'yt_video' | 'yt_playlist' | 'sp_track' | 'sp_playlist' | 'sp_album' | 'search';

function detectUrlType(input: string): UrlType {
  const u = input.trim();
  if (/^https?:\/\/(?:www\.)?youtube\.com\/.*[?&]list=/i.test(u) || /^https?:\/\/(?:www\.)?youtube\.com\/playlist\?/i.test(u)) {
    return 'yt_playlist';
  }
  if (/^https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)/i.test(u)) {
    return 'yt_video';
  }
  if (/spotify\.com\/(?:intl-[a-z]+\/)?track\//i.test(u)) return 'sp_track';
  if (/spotify\.com\/(?:intl-[a-z]+\/)?playlist\//i.test(u)) return 'sp_playlist';
  if (/spotify\.com\/(?:intl-[a-z]+\/)?album\//i.test(u)) return 'sp_album';
  return 'search';
}

// Playlist e álbum entram numa faixa de plano diferente da faixa avulsa, e quem
// decide isso é o comando — daí a detecção precisar ser pública.
export function isCollection(input: string): boolean {
  const t = detectUrlType(input);
  return t === 'yt_playlist' || t === 'sp_playlist' || t === 'sp_album';
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

async function buildTrackFromYouTubeUrl(url: string, requestedBy: string): Promise<Track | null> {
  const info = await ytInfo(url);
  if (!info) return null;
  return {
    title: info.title || 'Unknown',
    url: info.url,
    duration: formatSeconds(info.durationSec),
    requestedBy,
    thumbnail: info.thumbnail,
  };
}

async function buildTrackFromSpotifySearch(
  name: string,
  artist: string,
  requestedBy: string,
  thumbnail?: string,
): Promise<Track | null> {
  const q = `${name} ${artist}`.trim();
  const results = await ytSearch(q, 1);
  if (!results[0]) return null;
  return {
    title: name || results[0].title,
    url: results[0].url,
    duration: formatSeconds(results[0].durationSec),
    requestedBy,
    thumbnail: thumbnail || results[0].thumbnail,
  };
}

export async function addTracks(
  guildId: string,
  query: string,
  requestedBy: string,
): Promise<AddResult | null> {
  const queue = getOrCreateQueue(guildId);

  try {
    const urlType = detectUrlType(query);

    if (urlType === 'yt_video') {
      const track = await buildTrackFromYouTubeUrl(query, requestedBy);
      if (!track) return null;
      queue.tracks.push(track);
      if (!queue.current) playNext(guildId);
      return { tracks: [track], source: 'youtube' };
    }

    if (urlType === 'yt_playlist') {
      const pl = await ytPlaylist(query);
      const tracks: Track[] = pl.videos.map((v) => ({
        title: v.title,
        url: v.url,
        duration: formatSeconds(v.durationSec),
        requestedBy,
        thumbnail: v.thumbnail,
      }));
      if (tracks.length === 0) return null;
      queue.tracks.push(...tracks);
      if (!queue.current) playNext(guildId);
      return { tracks, source: 'youtube', playlistName: pl.title };
    }

    if (urlType === 'sp_track') {
      const t = await fetchSpotifyTrack(query);
      if (!t) return null;
      const track = await buildTrackFromSpotifySearch(t.name, t.artists[0] || '', requestedBy, t.thumbnail);
      if (!track) return null;
      queue.tracks.push(track);
      if (!queue.current) playNext(guildId);
      return { tracks: [track], source: 'spotify' };
    }

    if (urlType === 'sp_playlist' || urlType === 'sp_album') {
      const collection =
        urlType === 'sp_playlist' ? await fetchSpotifyPlaylist(query) : await fetchSpotifyAlbum(query);

      if (!collection) {
        logger.error('Spotify creds não configuradas ou URL inválida — playlist/álbum indisponível');
        return null;
      }
      if (collection.tracks.length === 0) return null;

      const resolveOne = (t: SpotifyTrack) =>
        buildTrackFromSpotifySearch(t.name, t.artists[0] || '', requestedBy, t.thumbnail);

      const firstTrack = await resolveOne(collection.tracks[0]);
      const resolved: Track[] = [];
      if (firstTrack) {
        resolved.push(firstTrack);
        queue.tracks.push(firstTrack);
        if (!queue.current) playNext(guildId);
      }

      (async () => {
        for (let i = 1; i < collection.tracks.length; i++) {
          const t = collection.tracks[i];
          try {
            const track = await resolveOne(t);
            if (track) {
              queue.tracks.push(track);
              resolved.push(track);
            }
          } catch (err) {
            logger.warn(`Falha resolvendo "${t.name}": ${(err as Error).message}`);
          }
        }
        logger.info(
          `Spotify ${collection.type} "${collection.name}" resolvida: ${resolved.length}/${collection.tracks.length}`,
        );
      })();

      return { tracks: resolved, source: 'spotify', playlistName: collection.name };
    }

    // Texto livre → busca YouTube
    const results = await ytSearch(query, 1);
    if (!results[0]) return null;
    const track: Track = {
      title: results[0].title,
      url: results[0].url,
      duration: formatSeconds(results[0].durationSec),
      requestedBy,
      thumbnail: results[0].thumbnail,
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
    setMusicActive(guildId, false);
    mute(guildId);
    emit(guildId, 'stopped');
    return;
  }

  const track = queue.tracks.shift()!;
  queue.current = track;

  try {
    const stream = ytStream(track.url);
    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });

    unmute(guildId);

    const connection = getConnection(guildId);
    if (connection) {
      connection.subscribe(queue.player);
    }

    queue.player.play(resource);
    setMusicActive(guildId, true);
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
  mute(guildId);
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
