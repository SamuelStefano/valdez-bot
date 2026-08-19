import { dbStatements } from '../utils/database';
import { hasOptedOut } from './guildSettings';
import { logger } from '../utils/logger';

export type EventKind =
  | 'guild_join'
  | 'guild_leave'
  | 'clip'
  | 'replay'
  | 'music'
  | 'clear'
  | 'optout'
  | 'optin'
  | 'license_expired'
  | 'export_error'
  | 'role_reward'
  | 'recap'
  | 'weekly_recap'
  | 'highlight';

interface EventDetail {
  userId?: string;
  seconds?: number;
  bytes?: number;
  detail?: string;
}

// Métrica vai pro SQLite primeiro e sobe pro Supabase depois: se a internet
// cair, o painel atrasa mas nenhum evento se perde.
export function track(guildId: string, kind: EventKind, extra: EventDetail = {}): void {
  try {
    // Opt-out vale pro painel também: o evento continua sendo contado, mas sem o
    // id — senão quem pediu pra sair da gravação ainda subia identificado.
    const userId = extra.userId && !hasOptedOut(guildId, extra.userId) ? extra.userId : null;
    dbStatements.addEvent.run({
      guild_id: guildId,
      kind,
      user_id: userId,
      seconds: extra.seconds ?? null,
      bytes: extra.bytes ?? null,
      detail: extra.detail ?? null,
      created_at: Math.floor(Date.now() / 1000),
    });
  } catch (err: any) {
    logger.warn(`[TELEMETRY] falha ao registrar ${kind}: ${err?.message}`);
  }
}
