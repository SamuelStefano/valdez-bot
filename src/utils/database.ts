import Database, { Database as DatabaseType, Statement } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.VALDEZ_DB_PATH || path.join(process.cwd(), 'valdez.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db: DatabaseType = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS voice_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    duration_seconds INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_voice_sessions_user ON voice_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_voice_sessions_guild ON voice_sessions(guild_id);

  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    voice_channel_id TEXT,
    clips_channel_id TEXT,
    auto_join INTEGER NOT NULL DEFAULT 1,
    joined_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS clip_optouts (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS licenses (
    guild_id TEXT PRIMARY KEY,
    plan TEXT NOT NULL DEFAULT 'basic',
    status TEXT NOT NULL DEFAULT 'active',
    founder INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    expires_at INTEGER,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    user_id TEXT,
    seconds INTEGER,
    bytes INTEGER,
    detail TEXT,
    created_at INTEGER NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_events_unsynced ON events(synced);

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    guild_name TEXT,
    user_id TEXT NOT NULL,
    username TEXT,
    rating INTEGER,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_feedback_unsynced ON feedback(synced);

  CREATE TABLE IF NOT EXISTS bot_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS role_rewards (
    guild_id TEXT NOT NULL,
    level INTEGER NOT NULL,
    role_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, level)
  );
`);

// SQLite não tem ADD COLUMN IF NOT EXISTS e o banco em produção já existe, então
// a checagem é feita na mão a cada boot.
function addColumn(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn('guild_settings', 'live_counter', 'INTEGER NOT NULL DEFAULT 0');
addColumn('guild_settings', 'announce', 'INTEGER NOT NULL DEFAULT 0');
addColumn('guild_settings', 'highlights', 'INTEGER NOT NULL DEFAULT 0');
addColumn('guild_settings', 'clip_format', `TEXT NOT NULL DEFAULT 'mp3'`);
addColumn('guild_settings', 'notices_channel_id', 'TEXT');
addColumn('guild_settings', 'recap', 'INTEGER NOT NULL DEFAULT 0');
addColumn('guild_settings', 'weekly_recap', 'INTEGER NOT NULL DEFAULT 0');
addColumn('licenses', 'owner_id', 'TEXT');
addColumn('feedback', 'can_publish', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`CREATE INDEX IF NOT EXISTS idx_licenses_owner ON licenses(owner_id)`);

export const dbStatements: Record<string, Statement> = {
  startSession: db.prepare(`
    INSERT INTO voice_sessions (user_id, username, guild_id, channel_id, joined_at)
    VALUES (?, ?, ?, ?, ?)
  `),

  endSession: db.prepare(`
    UPDATE voice_sessions
    SET left_at = MAX(?, joined_at), duration_seconds = MAX(?, joined_at) - joined_at
    WHERE user_id = ? AND guild_id = ? AND left_at IS NULL
  `),

  getUserTime: db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) as total_seconds
    FROM voice_sessions
    WHERE user_id = ? AND guild_id = ?
  `),

  getUserTimeMonth: db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) as total_seconds
    FROM voice_sessions
    WHERE user_id = ? AND guild_id = ? AND joined_at >= ?
  `),

  getLeaderboard: db.prepare(`
    SELECT user_id, username, SUM(duration_seconds) as total_seconds
    FROM voice_sessions
    WHERE guild_id = ? AND duration_seconds IS NOT NULL
    GROUP BY user_id
    ORDER BY total_seconds DESC
    LIMIT 10
  `),

  getLeaderboardSince: db.prepare(`
    SELECT user_id, username, SUM(duration_seconds) as total_seconds
    FROM voice_sessions
    WHERE guild_id = ? AND duration_seconds IS NOT NULL AND joined_at >= ?
    GROUP BY user_id
    ORDER BY total_seconds DESC
    LIMIT 10
  `),

  // A retrospectiva fecha uma semana inteira, então precisa de janela com fim —
  // com `>= since` o recap de segunda somaria também as horas da manhã seguinte.
  getLeaderboardBetween: db.prepare(`
    SELECT user_id, username, SUM(duration_seconds) as total_seconds
    FROM voice_sessions
    WHERE guild_id = ? AND duration_seconds IS NOT NULL
      AND joined_at >= ? AND joined_at < ?
    GROUP BY user_id
    ORDER BY total_seconds DESC
    LIMIT 10
  `),

  weekTotals: db.prepare(`
    SELECT COUNT(DISTINCT user_id) as people,
           COUNT(*) as sessions,
           COALESCE(SUM(duration_seconds), 0) as seconds
    FROM voice_sessions
    WHERE guild_id = ? AND duration_seconds IS NOT NULL
      AND joined_at >= ? AND joined_at < ?
  `),

  countEventsSince: db.prepare(`
    SELECT COUNT(*) as n FROM events
    WHERE guild_id = ? AND kind = ? AND created_at >= ?
  `),

  weekEvents: db.prepare(`
    SELECT kind, COUNT(*) as n
    FROM events
    WHERE guild_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY kind
  `),

  // Só o pedaço da sessão que cai dentro da call conta. Somando duration_seconds
  // cru, quem já estava no canal horas antes do rolê começar aparecia no recap
  // com um tempo que não foi passado ali — e ganhava os prêmios por isso.
  sessionParticipants: db.prepare(`
    SELECT user_id, username,
           SUM(MIN(left_at, @ended) - MAX(joined_at, @started)) as total_seconds,
           MAX(MIN(joined_at), @started) as first_join,
           MIN(MAX(left_at), @ended) as last_left
    FROM voice_sessions
    WHERE guild_id = @guild AND channel_id = @channel
      AND left_at IS NOT NULL AND left_at >= @started AND joined_at <= @ended
    GROUP BY user_id
    HAVING total_seconds > 0
    ORDER BY total_seconds DESC
  `),

  sessionClips: db.prepare(`
    SELECT user_id, COUNT(*) as n
    FROM events
    WHERE guild_id = ? AND kind IN ('clip', 'replay') AND created_at >= ?
    GROUP BY user_id
    ORDER BY n DESC
  `),

  getOpenSessions: db.prepare(`
    SELECT * FROM voice_sessions WHERE left_at IS NULL AND guild_id = ?
  `),

  // MAX(?, joined_at): o horário de fechamento vem do heartbeat, que pode ser
  // anterior ao início da sessão se o bot subiu, alguém entrou e ele caiu antes
  // do primeiro batimento. Sem o MAX isso vira duração negativa.
  closeAllSessions: db.prepare(`
    UPDATE voice_sessions
    SET left_at = MAX(?, joined_at), duration_seconds = MAX(?, joined_at) - joined_at
    WHERE left_at IS NULL
  `),

  getMeta: db.prepare(`SELECT value FROM bot_meta WHERE key = ?`),

  setMeta: db.prepare(`
    INSERT INTO bot_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),

  getGuildSettings: db.prepare(`SELECT * FROM guild_settings WHERE guild_id = ?`),

  listGuildSettings: db.prepare(`SELECT * FROM guild_settings`),

  upsertGuildSettings: db.prepare(`
    INSERT INTO guild_settings (guild_id, voice_channel_id, clips_channel_id, notices_channel_id, auto_join, live_counter, announce, highlights, recap, weekly_recap, clip_format, joined_at)
    VALUES (@guild_id, @voice_channel_id, @clips_channel_id, @notices_channel_id, @auto_join, @live_counter, @announce, @highlights, @recap, @weekly_recap, @clip_format, @joined_at)
    ON CONFLICT(guild_id) DO UPDATE SET
      voice_channel_id = excluded.voice_channel_id,
      clips_channel_id = excluded.clips_channel_id,
      notices_channel_id = excluded.notices_channel_id,
      auto_join = excluded.auto_join,
      live_counter = excluded.live_counter,
      announce = excluded.announce,
      highlights = excluded.highlights,
      recap = excluded.recap,
      weekly_recap = excluded.weekly_recap,
      clip_format = excluded.clip_format
  `),

  deleteGuildSettings: db.prepare(`DELETE FROM guild_settings WHERE guild_id = ?`),

  addOptOut: db.prepare(`
    INSERT OR IGNORE INTO clip_optouts (guild_id, user_id, created_at) VALUES (?, ?, ?)
  `),

  removeOptOut: db.prepare(`DELETE FROM clip_optouts WHERE guild_id = ? AND user_id = ?`),

  listOptOuts: db.prepare(`SELECT user_id FROM clip_optouts WHERE guild_id = ?`),

  getLicense: db.prepare(`SELECT * FROM licenses WHERE guild_id = ?`),

  listLicenses: db.prepare(`SELECT * FROM licenses`),

  upsertLicense: db.prepare(`
    INSERT INTO licenses (guild_id, plan, status, founder, started_at, expires_at, updated_at, owner_id)
    VALUES (@guild_id, @plan, @status, @founder, @started_at, @expires_at, @updated_at, @owner_id)
    ON CONFLICT(guild_id) DO UPDATE SET
      plan = excluded.plan,
      status = excluded.status,
      founder = excluded.founder,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at,
      owner_id = COALESCE(excluded.owner_id, licenses.owner_id)
  `),

  countFounders: db.prepare(`SELECT COUNT(*) as n FROM licenses WHERE founder = 1`),

  countLifetime: db.prepare(`SELECT COUNT(*) as n FROM licenses WHERE plan = 'lifetime'`),

  listRoleRewards: db.prepare(`
    SELECT level, role_id FROM role_rewards WHERE guild_id = ? ORDER BY level
  `),

  upsertRoleReward: db.prepare(`
    INSERT INTO role_rewards (guild_id, level, role_id, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, level) DO UPDATE SET role_id = excluded.role_id
  `),

  deleteRoleReward: db.prepare(`DELETE FROM role_rewards WHERE guild_id = ? AND level = ?`),

  addEvent: db.prepare(`
    INSERT INTO events (guild_id, kind, user_id, seconds, bytes, detail, created_at)
    VALUES (@guild_id, @kind, @user_id, @seconds, @bytes, @detail, @created_at)
  `),

  pendingEvents: db.prepare(`SELECT * FROM events WHERE synced = 0 ORDER BY id LIMIT ?`),

  markEventsSynced: db.prepare(`UPDATE events SET synced = 1 WHERE id <= ? AND synced = 0`),

  pruneEvents: db.prepare(`DELETE FROM events WHERE synced = 1 AND created_at < ?`),

  addFeedback: db.prepare(`
    INSERT INTO feedback (guild_id, guild_name, user_id, username, rating, message, created_at, can_publish)
    VALUES (@guild_id, @guild_name, @user_id, @username, @rating, @message, @created_at, @can_publish)
  `),

  pendingFeedback: db.prepare(`SELECT * FROM feedback WHERE synced = 0 ORDER BY id LIMIT ?`),

  markFeedbackSynced: db.prepare(`UPDATE feedback SET synced = 1 WHERE id <= ? AND synced = 0`),

  recentFeedbackByUser: db.prepare(`
    SELECT COUNT(*) as n FROM feedback WHERE user_id = ? AND created_at > ?
  `),
};

export { db };
