import { dbStatements } from '../utils/database';
import { logger } from '../utils/logger';

export type Plan = 'trial' | 'basic' | 'pro' | 'max' | 'lifetime' | 'owner';
export type LicenseStatus = 'active' | 'expired' | 'canceled';

export type SupportChannel = 'site' | 'discord' | 'whatsapp';

// Música é o degrau que faltava entre o Básico e o Pro: pedir uma faixa por link
// resolve a call de amigos, montar fila de playlist é o que servidor grande usa.
export type MusicTier = 'none' | 'link' | 'playlist';

export interface PlanLimits {
  label: string;
  priceCents: number;
  bufferSeconds: number;
  maxClipSeconds: number;
  music: MusicTier;
  replay: boolean;
  clipsChannel: boolean;
  stats: boolean;
  isolatedClip: boolean;
  weeklyRecap: boolean;
  support: SupportChannel;
}

// Os limites são o produto. Antes o único degrau real era a janela do buffer, e
// quem olhava Básico e Pro lado a lado via o mesmo bot com um número diferente —
// então escolhia pelo preço. Cada plano agora ganha ou perde um recurso que a
// pessoa consegue nomear sem ler tabela.
// O teste é uma cópia do Pro de propósito: quem provou o plano do meio não
// aceita descer pro básico depois.
export const PLANS: Record<Plan, PlanLimits> = {
  trial: {
    label: 'Teste do Pro (3 dias)',
    priceCents: 0,
    bufferSeconds: 900,
    maxClipSeconds: 900,
    music: 'playlist',
    replay: true,
    clipsChannel: true,
    stats: true,
    isolatedClip: false,
    weeklyRecap: false,
    support: 'discord',
  },
  basic: {
    label: 'Básico',
    priceCents: 1000,
    bufferSeconds: 90,
    maxClipSeconds: 90,
    music: 'link',
    replay: false,
    clipsChannel: false,
    stats: false,
    isolatedClip: false,
    weeklyRecap: false,
    support: 'site',
  },
  pro: {
    label: 'Pro',
    priceCents: 3000,
    bufferSeconds: 900,
    maxClipSeconds: 900,
    music: 'playlist',
    replay: true,
    clipsChannel: true,
    stats: true,
    isolatedClip: false,
    weeklyRecap: false,
    support: 'discord',
  },
  max: {
    label: 'Máximo',
    priceCents: 5000,
    bufferSeconds: 1800,
    maxClipSeconds: 1800,
    music: 'playlist',
    replay: true,
    clipsChannel: true,
    stats: true,
    isolatedClip: true,
    weeklyRecap: true,
    support: 'whatsapp',
  },
  // Pagamento único: entrega o Pro, não o Máximo. Manter o topo fora do vitalício
  // é o que impede o Máximo mensal de virar produto morto.
  lifetime: {
    label: 'Vitalício',
    priceCents: 15000,
    bufferSeconds: 900,
    maxClipSeconds: 900,
    music: 'playlist',
    replay: true,
    clipsChannel: true,
    stats: true,
    isolatedClip: false,
    weeklyRecap: false,
    support: 'discord',
  },
  // O bot é meu: o meu servidor usa tudo e não paga nada. Antes ele era marcado
  // como Máximo + fundador, e fundador congela a mensalidade em R$ 10 — então a
  // minha própria call entrava no painel como assinatura ativa de R$ 10 e virava
  // MRR. Plano próprio, de preço zero, é o que impede o dono de aparecer como
  // cliente na métrica que decide se o negócio se paga.
  owner: {
    label: 'Dono',
    priceCents: 0,
    bufferSeconds: 1800,
    maxClipSeconds: 1800,
    music: 'playlist',
    replay: true,
    clipsChannel: true,
    stats: true,
    isolatedClip: true,
    weeklyRecap: true,
    support: 'whatsapp',
  },
};

// O gratuito não é um plano que alguém assina: é o que sobra quando não há
// licença ativa. Guardar como limite em vez de linha no banco evita migração,
// CHECK novo no Supabase e um plano fantasma no cálculo de MRR.
// 30s é escolhido pra frustrar na hora certa — a pérola boa quase sempre precisa
// do contexto de antes, e é exatamente essa falta que vende o Básico.
export const FREE_LIMITS: PlanLimits = {
  label: 'Grátis',
  priceCents: 0,
  bufferSeconds: 30,
  maxClipSeconds: 30,
  music: 'none',
  replay: false,
  clipsChannel: false,
  stats: false,
  isolatedClip: false,
  weeklyRecap: false,
  support: 'site',
};

export const SUPPORT_LABEL: Record<SupportChannel, string> = {
  site: 'Ticket pelo site',
  discord: 'Direto no Discord',
  whatsapp: 'WhatsApp',
};

export const TRIAL_DAYS = 3;
export const FOUNDER_SLOTS = 100;
export const FOUNDER_PRICE_CENTS = 1000;
export const CYCLE_DAYS = 30;
// Vitalício sem teto quebraria a receita recorrente: cada venda é caixa hoje e
// custo pra sempre. 50 é o que dá pra bancar como oferta de largada.
export const LIFETIME_SLOTS = 50;

export interface License {
  guildId: string;
  plan: Plan;
  status: LicenseStatus;
  founder: boolean;
  startedAt: number;
  expiresAt: number | null;
  ownerId?: string | null;
}

interface Row {
  guild_id: string;
  plan: string;
  status: string;
  founder: number;
  started_at: number;
  expires_at: number | null;
  owner_id: string | null;
}

// Quem é o dono do servidor só o Client sabe. Injetado no boot pra este módulo
// não importar discord.js e virar dependência circular do index.
let resolveOwner: (guildId: string) => string | null = () => null;

export function setOwnerResolver(fn: (guildId: string) => string | null): void {
  resolveOwner = fn;
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
    ownerId: row.owner_id,
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
    owner_id: license.ownerId ?? null,
  });
  cache.set(license.guildId, license);
  return license;
}

// O teste é ancorado no dono, não no servidor: criar servidor novo é grátis e
// instantâneo, então cota por guild não segura ninguém. Isso encarece a burla —
// só fecha de vez com cartão.
export function startTrial(guildId: string): License {
  const startedAt = now();
  const ownerId = resolveOwner(guildId);

  if (ownerId) {
    const { n } = dbStatements.countTrialsByOwner.get(ownerId, guildId) as { n: number };
    if (n > 0) {
      logger.info(`[LICENSE] ${guildId}: dono ${ownerId} já usou o teste — entra bloqueado`);
      return saveLicense({
        guildId,
        plan: 'trial',
        status: 'expired',
        founder: false,
        startedAt,
        expiresAt: startedAt,
        ownerId,
      });
    }
  }

  return saveLicense({
    guildId,
    plan: 'trial',
    status: 'active',
    founder: false,
    startedAt,
    expiresAt: startedAt + TRIAL_DAYS * 86400,
    ownerId,
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

// Ponto único de degradação: sem licença ativa o servidor cai no gratuito em vez
// de perder o bot. Todo consumidor de limites herda isso de graça.
export function limits(guildId: string): PlanLimits {
  if (!isActive(guildId)) return FREE_LIMITS;
  return PLANS[getLicense(guildId).plan];
}

export function founderSlotsLeft(): number {
  const { n } = dbStatements.countFounders.get() as { n: number };
  return Math.max(0, FOUNDER_SLOTS - n);
}

export function lifetimeSlotsLeft(): number {
  const { n } = dbStatements.countLifetime.get() as { n: number };
  return Math.max(0, LIFETIME_SLOTS - n);
}

export function daysLeft(license: License): number | null {
  if (license.expiresAt === null) return null;
  return Math.max(0, Math.ceil((license.expiresAt - now()) / 86400));
}

// O servidor de origem é meu: sem isso ele cairia no teste de 14 dias e o bot
// sairia da call de casa por falta de pagamento.
// `founder: false` é obrigatório — fundador é quem PAGOU R$ 10 nas 100 primeiras
// vagas, e me marcar como um consumia uma vaga real: a landing anunciava 99
// restantes antes de existir o primeiro cliente.
export function ensureOwnerLicense(guildId: string): void {
  const license = getLicense(guildId);
  if (license.plan === 'owner' && license.status === 'active' && license.expiresAt === null) return;
  saveLicense({ ...license, plan: 'owner', status: 'active', founder: false, expiresAt: null });
  logger.info(`[LICENSE] ${guildId}: licença do dono aplicada`);
}

const UPSELL_LADDER: Plan[] = ['basic', 'pro', 'max'];

function brl(cents: number): string {
  return `R$ ${Math.round(cents / 100)}`;
}

// Mensagem única de bloqueio: se cada comando escrevesse a sua, o dono do
// servidor aprenderia um texto diferente por recurso. O plano mínimo é
// argumento porque nem todo bloqueio vende o Pro — música por link começa no
// Básico, e mandar quem quer ouvir uma faixa direto pro R$ 30 perde a venda.
export function upsell(feature: string, minPlan: Plan = 'pro'): string {
  const from = UPSELL_LADDER.indexOf(minPlan);
  const names = UPSELL_LADDER.slice(from === -1 ? 1 : from)
    .map((p) => `${PLANS[p].label} (${brl(PLANS[p].priceCents)})`)
    .join(', ');
  return `🔒 **${feature}** está no ${names}.\nUse \`/assinatura\` para ver os planos.`;
}

// O preço de fundador congela a mensalidade em qualquer plano mensal — é
// exatamente o que foi prometido nas 100 primeiras vagas, então subir de plano
// não pode custar mais caro pra quem entrou cedo. O vitalício fica de fora: R$
// 150 já é pagamento único, aplicar o desconto ali venderia o produto a R$ 10.
// `owner` fora do desconto junto do teste e do vitalício: o preço dele é zero e
// aplicar o piso de fundador cobraria R$ 10 de mim mesmo — que foi exatamente o
// bug que colocou a minha call no MRR.
export function priceCents(plan: Plan, founder: boolean): number {
  if (founder && plan !== 'trial' && plan !== 'lifetime' && plan !== 'owner') return FOUNDER_PRICE_CENTS;
  return PLANS[plan].priceCents;
}

export interface UpgradeQuote {
  to: Plan;
  fullCents: number;
  dueCents: number;
  daysLeft: number;
  keepsExpiry: boolean;
}

// Quem já pagou o mês não paga de novo pra subir: o que sobrou do plano atual
// vira crédito e ele completa só a diferença pelos dias que faltam. Cobrar cheio
// faria o dono esperar o vencimento — e nesse meio tempo ele desiste.
// Devolve null quando não existe caminho de upgrade (mesmo plano, plano abaixo,
// vitalício, que já pagou pra sempre, ou o meu próprio servidor).
export function quoteUpgrade(guildId: string, to: Plan): UpgradeQuote | null {
  if (to === 'trial' || to === 'owner') return null;

  const license = getLicense(guildId);
  const active = isActive(guildId);
  if (license.plan === 'lifetime' && active) return null;
  if (license.plan === 'owner') return null;

  const fullCents = priceCents(to, license.founder);
  if (to === 'lifetime') return { to, fullCents, dueCents: fullCents, daysLeft: 0, keepsExpiry: false };

  const toIdx = UPSELL_LADDER.indexOf(to);
  const fromIdx = UPSELL_LADDER.indexOf(license.plan);
  if (toIdx === -1 || (fromIdx !== -1 && fromIdx >= toIdx)) return null;

  // O crédito só existe pra quem pagou o ciclo corrente. No teste ninguém pagou
  // nada, então lá é preço cheio e o mês começa do zero — senão quem assina no
  // último dia do teste levaria o plano por trocado.
  if (fromIdx === -1 || !active) {
    return { to, fullCents, dueCents: fullCents, daysLeft: 0, keepsExpiry: false };
  }

  const left = Math.min(daysLeft(license) ?? 0, CYCLE_DAYS);
  const credit = priceCents(license.plan, license.founder);
  const dueCents = Math.max(0, Math.round(((fullCents - credit) * left) / CYCLE_DAYS));
  return { to, fullCents, dueCents, daysLeft: left, keepsExpiry: true };
}

export function dropLicenseCache(guildId: string): void {
  cache.delete(guildId);
}
