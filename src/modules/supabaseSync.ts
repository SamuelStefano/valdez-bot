import { Client } from 'discord.js';
import { dbStatements } from '../utils/database';
import { getSettings } from './guildSettings';
import { saveLicense, getLicense, Plan, LicenseStatus, PLANS } from './licensing';
import { clearExpiredNotice } from './billingNotice';
import { isConnected, listConnections, evaluatePresence } from './voiceManager';
import { isBuffering } from './replayBuffer';
import { config } from '../config';
import { logger } from '../utils/logger';

const BATCH = 200;
const INTERVAL_MS = 60_000;
const RETENTION_DAYS = 30;
const HEARTBEAT_RETENTION_DAYS = 7;

let lastPruneAt = 0;

function enabled(): boolean {
  return !!(config.supabaseUrl && config.supabaseServiceKey);
}

// O service_role ignora RLS, então ele nunca pode sair daqui: só o bot fala com
// o Supabase, o painel lê com a chave anon e as policies de admin.
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: config.supabaseServiceKey,
    Authorization: `Bearer ${config.supabaseServiceKey}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'valdez',
    'Content-Profile': 'valdez',
    ...extra,
  };
}

async function request(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`${init.method} ${path} → ${res.status} ${await res.text()}`);
  }
  return res;
}

async function upsert(table: string, rows: unknown[], onConflict?: string): Promise<void> {
  if (rows.length === 0) return;
  const qs = onConflict ? `?on_conflict=${onConflict}` : '';
  await request(`${table}${qs}`, {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
}

function iso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

async function pushGuilds(client: Client): Promise<void> {
  const rows = client.guilds.cache.map((guild) => {
    const settings = getSettings(guild.id);
    return {
      guild_id: guild.id,
      name: guild.name,
      icon_url: guild.iconURL({ size: 128 }),
      member_count: guild.memberCount,
      owner_id: guild.ownerId,
      voice_channel_id: settings.voiceChannelId,
      clips_channel_id: settings.clipsChannelId,
      last_seen_at: new Date().toISOString(),
    };
  });
  await upsert('guilds', rows, 'guild_id');

  // A licença tem FK pra guilds, então só sobe depois — e price_cents vem da
  // tabela de planos pra o painel somar receita sem repetir a regra de preço.
  const licenses = client.guilds.cache.map((guild) => {
    const l = getLicense(guild.id);
    return {
      guild_id: l.guildId,
      plan: l.plan,
      status: l.status,
      price_cents: l.founder && l.plan !== 'trial' ? 1000 : PLANS[l.plan].priceCents,
      founder: l.founder,
      started_at: iso(l.startedAt),
      expires_at: iso(l.expiresAt),
      updated_at: new Date().toISOString(),
    };
  });
  await upsert('licenses', licenses, 'guild_id');
}

async function pushEvents(): Promise<void> {
  const rows = dbStatements.pendingEvents.all(BATCH) as any[];
  if (rows.length === 0) return;

  await upsert(
    'events',
    rows.map((r) => ({
      guild_id: r.guild_id,
      kind: r.kind,
      user_id: r.user_id,
      seconds: r.seconds,
      bytes: r.bytes,
      detail: r.detail,
      created_at: iso(r.created_at),
    }))
  );
  dbStatements.markEventsSynced.run(rows[rows.length - 1].id);
}

async function pushFeedback(): Promise<void> {
  const rows = dbStatements.pendingFeedback.all(BATCH) as any[];
  if (rows.length === 0) return;

  await upsert(
    'feedback',
    rows.map((r) => ({
      guild_id: r.guild_id,
      guild_name: r.guild_name,
      user_id: r.user_id,
      username: r.username,
      rating: r.rating,
      message: r.message,
      created_at: iso(r.created_at),
    }))
  );
  dbStatements.markFeedbackSynced.run(rows[rows.length - 1].id);
}

async function pushHeartbeat(client: Client): Promise<void> {
  const connections = listConnections();
  await upsert('heartbeats', [
    {
      guilds: client.guilds.cache.size,
      connected: connections.length,
      buffering: connections.filter(([guildId]) => isBuffering(guildId)).length,
      uptime_seconds: Math.floor(process.uptime()),
    },
  ]);
}

// Pagamento entra pelo painel, não pelo bot: o Supabase é a fonte da verdade do
// que foi pago e o SQLite local só espelha.
async function pullLicenses(client: Client): Promise<void> {
  const res = await request('licenses?select=guild_id,plan,status,founder,started_at,expires_at', {
    method: 'GET',
    headers: headers(),
  });
  const remote = (await res.json()) as any[];

  for (const row of remote) {
    if (!client.guilds.cache.has(row.guild_id)) continue;

    const local = getLicense(row.guild_id);
    const expiresAt = row.expires_at ? Math.floor(new Date(row.expires_at).getTime() / 1000) : null;
    const plan = (row.plan as Plan) in PLANS ? (row.plan as Plan) : local.plan;
    const status = row.status as LicenseStatus;

    const changed =
      local.plan !== plan ||
      local.status !== status ||
      local.founder !== !!row.founder ||
      local.expiresAt !== expiresAt;
    if (!changed) continue;

    saveLicense({
      guildId: row.guild_id,
      plan,
      status,
      founder: !!row.founder,
      startedAt: Math.floor(new Date(row.started_at).getTime() / 1000),
      expiresAt,
    });

    // Renovou: o bot precisa poder avisar de novo no próximo vencimento e voltar
    // pra call sem esperar alguém entrar.
    if (status === 'active') {
      clearExpiredNotice(row.guild_id);
      if (!isConnected(row.guild_id)) evaluatePresence(client, row.guild_id);
    }
    logger.info(`[SYNC] ${row.guild_id}: licença atualizada → ${plan}/${status}`);
  }
}

// Um heartbeat por minuto vira meio milhão de linhas por ano. O painel só usa o
// mais recente, então o resto é lixo pago.
async function pruneHeartbeats(): Promise<void> {
  const cutoff = new Date(Date.now() - HEARTBEAT_RETENTION_DAYS * 86400_000).toISOString();
  await request(`heartbeats?at=lt.${cutoff}`, {
    method: 'DELETE',
    headers: headers({ Prefer: 'return=minimal' }),
  });
}

async function runOnce(client: Client): Promise<void> {
  await pushGuilds(client);
  await pushEvents();
  await pushFeedback();
  await pushHeartbeat(client);
  await pullLicenses(client);
  dbStatements.pruneEvents.run(Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400);

  if (Date.now() - lastPruneAt > 6 * 3600_000) {
    lastPruneAt = Date.now();
    await pruneHeartbeats();
  }
}

export function startSupabaseSync(client: Client): void {
  if (!enabled()) {
    logger.warn('[SYNC] SUPABASE_URL/SERVICE_ROLE_KEY ausentes — painel não recebe dados');
    return;
  }

  const tick = () => {
    runOnce(client).catch((err: any) => {
      // Falha de sync não pode derrubar o bot: o SQLite segura os eventos até a
      // próxima rodada.
      logger.warn(`[SYNC] falhou: ${err?.message}`);
    });
  };

  setTimeout(tick, 10_000);
  setInterval(tick, INTERVAL_MS);
  logger.info(`[SYNC] Supabase a cada ${INTERVAL_MS / 1000}s`);
}
