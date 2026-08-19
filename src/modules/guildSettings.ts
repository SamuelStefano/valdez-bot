import { dbStatements } from '../utils/database';
import { config } from '../config';

export interface GuildSettings {
  guildId: string;
  voiceChannelId: string | null;
  clipsChannelId: string | null;
  autoJoin: boolean;
  liveCounter: boolean;
  announce: boolean;
  highlights: boolean;
}

interface Row {
  guild_id: string;
  voice_channel_id: string | null;
  clips_channel_id: string | null;
  auto_join: number;
  live_counter: number;
  announce: number;
  highlights: number;
}

// Cache em memória: cada pacote de voz consulta o opt-out e cada tick do
// watchdog consulta o canal monitorado — ir ao SQLite nesse caminho quente
// custaria caro com muitos servidores.
const cache = new Map<string, GuildSettings>();
const optOuts = new Map<string, Set<string>>();

function toSettings(row: Row): GuildSettings {
  return {
    guildId: row.guild_id,
    voiceChannelId: row.voice_channel_id,
    clipsChannelId: row.clips_channel_id,
    autoJoin: row.auto_join === 1,
    liveCounter: row.live_counter === 1,
    announce: row.announce === 1,
    highlights: row.highlights === 1,
  };
}

export function loadAllSettings(): void {
  cache.clear();
  optOuts.clear();
  for (const row of dbStatements.listGuildSettings.all() as Row[]) {
    cache.set(row.guild_id, toSettings(row));
  }
  seedFromEnv();
}

// Migração do servidor original, que era configurado por env e não tem linha no
// banco. Só semeia uma vez: depois disso o /config manda.
function seedFromEnv(): void {
  const { seedGuildId, seedVoiceChannelId, seedClipsChannelId } = config;
  if (!seedGuildId || !seedVoiceChannelId || cache.has(seedGuildId)) return;
  saveSettings({
    guildId: seedGuildId,
    voiceChannelId: seedVoiceChannelId,
    clipsChannelId: seedClipsChannelId,
    autoJoin: true,
    liveCounter: false,
    announce: false,
    highlights: false,
  });
}

export function getSettings(guildId: string): GuildSettings {
  const cached = cache.get(guildId);
  if (cached) return cached;

  const row = dbStatements.getGuildSettings.get(guildId) as Row | undefined;
  const settings = row
    ? toSettings(row)
    : { guildId, voiceChannelId: null, clipsChannelId: null, autoJoin: true, liveCounter: false, announce: false, highlights: false };
  cache.set(guildId, settings);
  return settings;
}

export function saveSettings(patch: Partial<GuildSettings> & { guildId: string }): GuildSettings {
  const next = { ...getSettings(patch.guildId), ...patch };
  dbStatements.upsertGuildSettings.run({
    guild_id: next.guildId,
    voice_channel_id: next.voiceChannelId,
    clips_channel_id: next.clipsChannelId,
    auto_join: next.autoJoin ? 1 : 0,
    live_counter: next.liveCounter ? 1 : 0,
    announce: next.announce ? 1 : 0,
    highlights: next.highlights ? 1 : 0,
    joined_at: Math.floor(Date.now() / 1000),
  });
  cache.set(next.guildId, next);
  return next;
}

export function forgetGuild(guildId: string): void {
  dbStatements.deleteGuildSettings.run(guildId);
  cache.delete(guildId);
  optOuts.delete(guildId);
}

// Configurado = o admin já apontou um canal de voz. Sem isso o bot não entra
// em lugar nenhum: entrar sozinho num servidor novo e começar a bufferizar voz
// sem ninguém ter pedido é exatamente o que não pode acontecer.
export function isConfigured(guildId: string): boolean {
  return !!getSettings(guildId).voiceChannelId;
}

function optOutSet(guildId: string): Set<string> {
  let set = optOuts.get(guildId);
  if (!set) {
    const rows = dbStatements.listOptOuts.all(guildId) as { user_id: string }[];
    set = new Set(rows.map((r) => r.user_id));
    optOuts.set(guildId, set);
  }
  return set;
}

export function hasOptedOut(guildId: string, userId: string): boolean {
  return optOutSet(guildId).has(userId);
}

export function setOptOut(guildId: string, userId: string, optedOut: boolean): void {
  if (optedOut) {
    dbStatements.addOptOut.run(guildId, userId, Math.floor(Date.now() / 1000));
    optOutSet(guildId).add(userId);
  } else {
    dbStatements.removeOptOut.run(guildId, userId);
    optOutSet(guildId).delete(userId);
  }
}

export function optOutCount(guildId: string): number {
  return optOutSet(guildId).size;
}
