import { dbStatements } from '../utils/database';
import { logger } from '../utils/logger';

export type EventKind =
  | 'guild_join'
  | 'guild_leave'
  | 'clip'
  | 'replay'
  | 'music'
  | 'optout'
  | 'optin'
  | 'license_expired'
  | 'export_error';

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
    dbStatements.addEvent.run({
      guild_id: guildId,
      kind,
      user_id: extra.userId ?? null,
      seconds: extra.seconds ?? null,
      bytes: extra.bytes ?? null,
      detail: extra.detail ?? null,
      created_at: Math.floor(Date.now() / 1000),
    });
  } catch (err: any) {
    logger.warn(`[TELEMETRY] falha ao registrar ${kind}: ${err?.message}`);
  }
}
