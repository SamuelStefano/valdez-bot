import { config } from '../config';
import { logger } from './logger';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

export interface SpotifyTrack {
  name: string;
  artists: string[];
  durationMs: number;
  thumbnail?: string;
  url: string;
}

export interface SpotifyCollection {
  name: string;
  type: 'playlist' | 'album';
  tracks: SpotifyTrack[];
}

function hasCredentials(): boolean {
  return Boolean(
    config.spotify.clientId && config.spotify.clientSecret && config.spotify.refreshToken,
  );
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const basic = Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString(
    'base64',
  );

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.spotify.refreshToken,
    }),
  });

  if (!res.ok) {
    throw new Error(`Spotify token refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.accessToken;
}

function extractId(url: string, kind: 'playlist' | 'album' | 'track'): string | null {
  const m = url.match(new RegExp(`spotify\\.com/(?:intl-[a-z]+/)?${kind}/([a-zA-Z0-9]+)`));
  return m ? m[1] : null;
}

async function spotifyFetch<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Spotify API ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// Schema atual (2026): /playlists/{id} retorna `items.items[].item.track-data`
// e o endpoint paginado é `/playlists/{id}/items` (o velho `/tracks` agora dá 403).
// /albums/{id}/tracks ainda funciona normalmente.
type RawSpotifyTrack = {
  name?: string;
  artists?: { name: string }[];
  duration_ms?: number;
  album?: { images?: { url: string }[] };
  external_urls?: { spotify?: string };
};
type RawPlaylistItem = { item?: RawSpotifyTrack | null; track?: RawSpotifyTrack | null };

function mapTrack(t: RawSpotifyTrack | null | undefined, fallbackThumb?: string): SpotifyTrack | null {
  if (!t || !t.name) return null;
  return {
    name: t.name,
    artists: (t.artists || []).map((a) => a.name),
    durationMs: t.duration_ms || 0,
    thumbnail: t.album?.images?.[0]?.url || fallbackThumb,
    url: t.external_urls?.spotify || '',
  };
}

export async function fetchSpotifyPlaylist(url: string): Promise<SpotifyCollection | null> {
  if (!hasCredentials()) return null;
  const id = extractId(url, 'playlist');
  if (!id) return null;

  // /playlists/{id} já vem com até 100 tracks embutidos em `items.items`
  const head = await spotifyFetch<{
    name: string;
    items: { total: number; items: RawPlaylistItem[]; next: string | null };
  }>(`/playlists/${id}?market=${config.spotify.market}`);

  const collected: SpotifyTrack[] = [];
  for (const it of head.items.items) {
    const track = mapTrack(it.item || it.track);
    if (track) collected.push(track);
  }

  // Paginação pra playlists com mais de 100 tracks — usa /items (NÃO /tracks)
  let offset = collected.length;
  const limit = 100;
  while (offset < head.items.total) {
    const page = await spotifyFetch<{ items: RawPlaylistItem[]; next: string | null }>(
      `/playlists/${id}/items?limit=${limit}&offset=${offset}&market=${config.spotify.market}`,
    );
    if (page.items.length === 0) break;
    for (const it of page.items) {
      const track = mapTrack(it.item || it.track);
      if (track) collected.push(track);
    }
    offset += page.items.length;
  }

  return { name: head.name, type: 'playlist', tracks: collected };
}

export async function fetchSpotifyAlbum(url: string): Promise<SpotifyCollection | null> {
  if (!hasCredentials()) return null;
  const id = extractId(url, 'album');
  if (!id) return null;

  const meta = await spotifyFetch<{ name: string; images?: { url: string }[] }>(
    `/albums/${id}?market=${config.spotify.market}`,
  );
  const albumThumb = meta.images?.[0]?.url;

  const tracks: SpotifyTrack[] = [];
  let offset = 0;
  const limit = 50;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await spotifyFetch<{ items: RawSpotifyTrack[]; next: string | null }>(
      `/albums/${id}/tracks?limit=${limit}&offset=${offset}&market=${config.spotify.market}`,
    );
    for (const t of page.items) {
      const track = mapTrack(t, albumThumb);
      if (track) tracks.push(track);
    }
    if (!page.next || page.items.length < limit) break;
    offset += limit;
  }

  return { name: meta.name, type: 'album', tracks };
}

export async function fetchSpotifyTrack(url: string): Promise<SpotifyTrack | null> {
  if (!hasCredentials()) return null;
  const id = extractId(url, 'track');
  if (!id) return null;
  const t = await spotifyFetch<{
    name: string;
    artists: { name: string }[];
    duration_ms: number;
    album?: { images?: { url: string }[] };
    external_urls?: { spotify?: string };
  }>(`/tracks/${id}?market=${config.spotify.market}`);
  return {
    name: t.name,
    artists: t.artists.map((a) => a.name),
    durationMs: t.duration_ms,
    thumbnail: t.album?.images?.[0]?.url,
    url: t.external_urls?.spotify || '',
  };
}

export function logSpotifyStatus() {
  if (hasCredentials()) {
    logger.info('Spotify API client configurado (chamadas diretas, sem play-dl).');
  } else {
    logger.warn('Spotify creds ausentes — playlists/álbuns indisponíveis.');
  }
}
