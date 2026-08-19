import { Guild, GuildMember, PermissionFlagsBits, Role } from 'discord.js';
import { dbStatements } from '../utils/database';
import { limits, isActive } from './licensing';
import { resolveNoticeChannel } from './noticeChannel';
import { progressFor } from './xp';
import { track } from './telemetry';
import { logger } from '../utils/logger';

export const MAX_REWARDS = 10;
export const MAX_LEVEL = 100;

export interface RoleReward {
  level: number;
  roleId: string;
}

const cache = new Map<string, RoleReward[]>();
// O erro de hierarquia/permissão só aparece quando o bot tenta entregar o cargo,
// longe de qualquer comando. Sem guardar o último motivo, o admin veria membros
// no nível certo e cargo nenhum, sem nada pra investigar.
const issues = new Map<string, string>();

export function listRewards(guildId: string): RoleReward[] {
  let list = cache.get(guildId);
  if (!list) {
    const rows = dbStatements.listRoleRewards.all(guildId) as { level: number; role_id: string }[];
    list = rows.map((r) => ({ level: r.level, roleId: r.role_id }));
    cache.set(guildId, list);
  }
  return list;
}

export function setReward(guildId: string, level: number, roleId: string): void {
  dbStatements.upsertRoleReward.run(guildId, level, roleId, Math.floor(Date.now() / 1000));
  cache.delete(guildId);
  issues.delete(guildId);
}

export function removeReward(guildId: string, level: number): boolean {
  const info = dbStatements.deleteRoleReward.run(guildId, level);
  cache.delete(guildId);
  return info.changes > 0;
}

export function rewardIssue(guildId: string): string | null {
  return issues.get(guildId) ?? null;
}

export function levelOf(guildId: string, userId: string): number {
  const row = dbStatements.getUserTime.get(userId, guildId) as { total_seconds: number } | undefined;
  return progressFor(row?.total_seconds ?? 0).level;
}

async function announce(guild: Guild, member: GuildMember, level: number, roles: Role[]): Promise<void> {
  const channel = resolveNoticeChannel(guild);
  if (!channel) return;

  // Nome do cargo em negrito e não menção: mencionar cargo notifica todo mundo
  // que já tem ele, e a premiação viraria motivo pra desligar o bot.
  const names = roles.map((r) => `**${r.name}**`).join(', ');
  try {
    await channel.send(
      `🎖️ **${member.displayName}** bateu o **nível ${level}** só de ficar em call e levou ${names}. Respeita.`
    );
  } catch (err: any) {
    logger.warn(`[CARGOS] ${guild.id}: falha ao anunciar: ${err?.message}`);
  }
}

async function grant(guild: Guild, userId: string): Promise<void> {
  const rewards = listRewards(guild.id);
  if (rewards.length === 0) return;
  if (!limits(guild.id).stats || !isActive(guild.id)) return;

  const level = levelOf(guild.id, userId);
  const earned = rewards.filter((r) => r.level <= level);
  if (earned.length === 0) return;

  const me = guild.members.me;
  if (!me) return;
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    issues.set(guild.id, 'falta a permissão **Gerenciar Cargos** — nenhum cargo é entregue sem ela');
    return;
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  const granted: Role[] = [];
  let failed = false;

  for (const reward of earned) {
    if (member.roles.cache.has(reward.roleId)) continue;

    const role = guild.roles.cache.get(reward.roleId);
    if (!role) {
      failed = true;
      issues.set(guild.id, `o cargo do nível ${reward.level} foi apagado — refaça com \`/config cargos add\``);
      continue;
    }
    if (role.position >= me.roles.highest.position) {
      failed = true;
      issues.set(
        guild.id,
        `o cargo **${role.name}** está acima do Valdez na lista de cargos — arraste o cargo do bot pra cima dele`
      );
      continue;
    }

    try {
      await member.roles.add(role, `Valdez: nível ${reward.level} em call`);
      granted.push(role);
      track(guild.id, 'role_reward', { userId, detail: `nv${reward.level}:${role.id}` });
    } catch (err: any) {
      failed = true;
      issues.set(guild.id, `não consegui entregar **${role.name}** (${err?.message})`);
      logger.warn(`[CARGOS] ${guild.id}: falha ao dar ${role.id} para ${userId}: ${err?.message}`);
    }
  }

  if (!failed) issues.delete(guild.id);
  if (granted.length > 0) await announce(guild, member, level, granted);
}

export function dropGuildRewards(guildId: string): void {
  cache.delete(guildId);
  issues.delete(guildId);
}

export function applyRoleRewards(guild: Guild, userId: string): void {
  grant(guild, userId).catch((err: any) => {
    logger.warn(`[CARGOS] ${guild.id}: ${err?.message}`);
  });
}
