import { dbStatements } from '../utils/database';
import { logger } from '../utils/logger';

export type Plan = 'trial' | 'basic' | 'pro' | 'max';
export type LicenseStatus = 'active' | 'expired' | 'canceled';

export interface PlanLimits {
  label: string;
  priceCents: number;
  bufferSeconds: number;
  maxClipSeconds: number;
  replay: boolean;
  clipsChannel: boolean;
  stats: boolean;
}

// Os limites são o produto: o que separa um plano do outro é quanto tempo de
// call o bot segura na memória e se dá pra gravar contínuo.
export const PLANS: Record<Plan, PlanLimits> = {
  trial: {
    label: 'Teste (14 dias)',
    priceCents: 0,
    bufferSeconds: 900,
    maxClipSeconds: 900,
    replay: true,
    clipsChannel: true,
    stats: true,
  },
  basic: {
    label: 'Básico',
    priceCents: 1000,
    bufferSeconds: 300,
    maxClipSeconds: 120,
    replay: false,
    clipsChannel: false,
    stats: false,
  },
  pro: {
    label: 'Pro',
    priceCents: 3000,
    bufferSeconds: 900,
    maxClipSeconds: 900,
    replay: true,
    clipsChannel: true,
    stats: true,
  },
  max: {
    label: 'Máximo',
    priceCents: 5000,
    bufferSeconds: 1800,
    maxClipSeconds: 1800,
    replay: true,
    clipsChannel: true,
    stats: true,
  },
};

export const TRIAL_DAYS = 14;
export const FOUNDER_SLOTS = 100;

export interface License {
  guildId: string;
  plan: Plan;
  status: LicenseStatus;
  founder: boolean;
  startedAt: number;
  expiresAt: number | null;
}

interface Row {
  guild_id: string;
  plan: string;
  status: string;
  founder: number;
  started_at: number;
  expires_at: number | null;
}

// Cache em memória porque todo pacote de voz consulta a janela do buffer.
const cache = new Map<string, License>();

function toLicense(row: Row): License {
  return {
    guildId: row.guild_id,
    plan: (row.plan as Plan) in PLANS ? (row.plan as Plan) : 'basic',
    status: row.status as LicenseStatus,
    founder: row.founder === 1,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
  };
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function loadLicenses(): void {
  cache.clear();
  for (const row of dbStatements.listLicenses.all() as Row[]) {
    cache.set(row.guild_id, toLicense(row));
  }
  logger.info(`[LICENSE] ${cache.size} licenças carregadas`);
}

export function getLicense(guildId: string): License {
  const cached = cache.get(guildId);
  if (cached) return cached;

  const row = dbStatements.getLicense.get(guildId) as Row | undefined;
  const license = row ? toLicense(row) : startTrial(guildId);
  cache.set(guildId, license);
  return license;
}

export function saveLicense(license: License): License {
  dbStatements.upsertLicense.run({
    guild_id: license.guildId,
    plan: license.plan,
    status: license.status,
    founder: license.founder ? 1 : 0,
    started_at: license.startedAt,
    expires_at: license.expiresAt,
    updated_at: now(),
  });
  cache.set(license.guildId, license);
  return license;
}

export function startTrial(guildId: string): License {
  const startedAt = now();
  return saveLicense({
    guildId,
    plan: 'trial',
    status: 'active',
    founder: false,
    startedAt,
    expiresAt: startedAt + TRIAL_DAYS * 86400,
  });
}

// Vencimento é decidido na leitura: sem isso uma licença expirada só cairia no
// próximo sync com o Supabase, e o servidor seguiria usando de graça.
export function isActive(guildId: string): boolean {
  const license = getLicense(guildId);
  if (license.status !== 'active') return false;
  if (license.expiresAt !== null && license.expiresAt < now()) {
    saveLicense({ ...license, status: 'expired' });
    logger.info(`[LICENSE] ${guildId}: licença expirada (${license.plan})`);
    return false;
  }
  return true;
}

export function limits(guildId: string): PlanLimits {
  return PLANS[getLicense(guildId).plan];
}

export function founderSlotsLeft(): number {
  const { n } = dbStatements.countFounders.get() as { n: number };
  return Math.max(0, FOUNDER_SLOTS - n);
}

export function daysLeft(license: License): number | null {
  if (license.expiresAt === null) return null;
  return Math.max(0, Math.ceil((license.expiresAt - now()) / 86400));
}

// O servidor de origem é meu: sem isso ele cairia no teste de 14 dias e o bot
// sairia da call de casa por falta de pagamento.
export function ensureOwnerLicense(guildId: string): void {
  const license = getLicense(guildId);
  if (license.plan === 'max' && license.status === 'active' && license.expiresAt === null) return;
  saveLicense({ ...license, plan: 'max', status: 'active', founder: true, expiresAt: null });
  logger.info(`[LICENSE] ${guildId}: licença vitalícia do dono aplicada`);
}

// Mensagem única de bloqueio: se cada comando escrevesse a sua, o dono do
// servidor aprenderia um texto diferente por recurso.
export function upsell(feature: string): string {
  return (
    `🔒 **${feature}** está no ${PLANS.pro.label} (R$ 30) e no ${PLANS.max.label} (R$ 50).\n` +
    'Use `/assinatura` para ver os planos.'
  );
}

export function dropLicenseCache(guildId: string): void {
  cache.delete(guildId);
}
