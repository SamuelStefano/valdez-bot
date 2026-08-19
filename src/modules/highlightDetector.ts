import { AttachmentBuilder, Client, EmbedBuilder, Guild, TextChannel } from 'discord.js';
import fs from 'fs';
import { getSettings } from './guildSettings';
import { limits, isActive } from './licensing';
import { getBufferSnapshot, setSpeakingObserver } from './replayBuffer';
import { storeClip } from './clipStore';
import { track } from './telemetry';
import { exportClip, maxUploadBytes } from '../utils/audioExporter';
import { speakingTimeline } from '../utils/videoExporter';
import { logger } from '../utils/logger';

// Quando três pessoas começam a falar juntas em poucos segundos, alguém disse
// alguma coisa: é risada, é grito, é reação. Falar sozinho é conversa; falar por
// cima é o momento. Esse é o sinal inteiro — não precisa entender o áudio.
const WINDOW_MS = 6_000;
const MIN_SPEAKERS = 3;

// A reação continua depois do estouro. Cortar no instante da detecção entrega o
// clipe sem o desfecho, que é justamente a parte engraçada.
const TAIL_MS = 5_000;

const CLIP_SECONDS = 25;

// Sem teto o bot vira spam numa call animada e o admin desliga o recurso inteiro.
const COOLDOWN_MS = 10 * 60_000;
const MAX_PER_CALL = 3;

interface GuildState {
  recent: { userId: string; at: number }[];
  lastFiredAt: number;
  firedThisCall: number;
  capturing: boolean;
}

const states = new Map<string, GuildState>();

function state(guildId: string): GuildState {
  let s = states.get(guildId);
  if (!s) {
    s = { recent: [], lastFiredAt: 0, firedThisCall: 0, capturing: false };
    states.set(guildId, s);
  }
  return s;
}

function enabled(guildId: string): boolean {
  return getSettings(guildId).highlights && limits(guildId).clipsChannel && isActive(guildId);
}

function clipsChannel(guild: Guild): TextChannel | null {
  const id = getSettings(guild.id).clipsChannelId;
  if (!id) return null;
  const channel = guild.channels.cache.get(id);
  return channel?.isTextBased() ? (channel as TextChannel) : null;
}

// Uma call nova zera a cota: o teto é por sessão, não por dia, senão a call da
// noite herda o silêncio da call da tarde.
export function resetHighlights(guildId: string): void {
  const s = states.get(guildId);
  if (!s) return;
  s.recent = [];
  s.firedThisCall = 0;
}

export function dropGuildHighlights(guildId: string): void {
  states.delete(guildId);
}

async function capture(client: Client, guildId: string): Promise<void> {
  const guild = client.guilds.cache.get(guildId);
  const channel = guild ? clipsChannel(guild) : null;
  const s = state(guildId);
  if (!guild || !channel) {
    s.capturing = false;
    return;
  }

  const packets = getBufferSnapshot(guildId, CLIP_SECONDS);
  if (packets.size < MIN_SPEAKERS) {
    s.capturing = false;
    return;
  }

  const limitBytes = maxUploadBytes(Number(guild.premiumTier ?? 0));
  let audioPath: string;
  try {
    audioPath = await exportClip(packets, `momento_${guildId}_${Date.now()}`, CLIP_SECONDS, limitBytes);
  } catch (err: any) {
    logger.error(`[MOMENTO] ${guildId}: export falhou: ${err?.message}`);
    s.capturing = false;
    return;
  }

  const names = [...packets.keys()].map((id) => guild.members.cache.get(id)?.displayName ?? `<@${id}>`);

  const clip = storeClip({
    guildId,
    kind: 'clip',
    seconds: CLIP_SECONDS,
    label: `${CLIP_SECONDS}s`,
    audioPath,
    timeline: speakingTimeline(packets),
    userIds: [...packets.keys()],
    channelName: guild.members.me?.voice.channel?.name ?? null,
    authorId: client.user!.id,
    authorName: 'Valdez',
    authorIcon: client.user!.displayAvatarURL(),
  });

  const embed = new EmbedBuilder()
    .setColor(0xffb020)
    .setTitle('🔥 Momento da call')
    .setDescription('Todo mundo falou junto agora — peguei os últimos 25 segundos.')
    .addFields({ name: 'Quem estava falando', value: names.slice(0, 8).join(', ') || '—' })
    .setFooter({ text: 'Valdez • detectado sozinho · /config momentos para desligar' })
    .setTimestamp();

  try {
    await channel.send({
      embeds: [embed],
      files: [new AttachmentBuilder(audioPath, { name: `momento-${clip.id}.mp3` })],
    });
    track(guildId, 'highlight', { seconds: CLIP_SECONDS });
    logger.info(`[MOMENTO] ${guildId}: momento postado (${packets.size} pessoas)`);
  } catch (err: any) {
    logger.warn(`[MOMENTO] ${guildId}: não consegui postar: ${err?.message}`);
    try {
      fs.unlinkSync(audioPath);
    } catch {
      /* já removido */
    }
  } finally {
    s.capturing = false;
  }
}

export function setupHighlightDetector(client: Client): void {
  setSpeakingObserver((guildId, userId) => {
    if (!enabled(guildId)) return;

    const s = state(guildId);
    const now = Date.now();
    s.recent = s.recent.filter((e) => now - e.at < WINDOW_MS && e.userId !== userId);
    s.recent.push({ userId, at: now });

    if (s.capturing) return;
    if (s.recent.length < MIN_SPEAKERS) return;
    if (s.firedThisCall >= MAX_PER_CALL) return;
    if (now - s.lastFiredAt < COOLDOWN_MS) return;

    s.lastFiredAt = now;
    s.firedThisCall++;
    s.capturing = true;
    s.recent = [];
    setTimeout(() => void capture(client, guildId), TAIL_MS).unref();
  });

  logger.info('[MOMENTO] detector de momentos ativo');
}
