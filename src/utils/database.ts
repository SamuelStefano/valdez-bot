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
    plan TEXT NOT NULL DEFAULT 'trial',
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
`);

// SQLite não tem ADD COLUMN IF NOT EXISTS e o banco em produção já existe, então
// a checagem é feita na mão a cada boot.
function addColumn(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn('guild_settings', 'live_counter', 'INTEGER NOT NULL DEFAULT 0');
addColumn('licenses', 'owner_id', 'TEXT');

db.exec(`CREATE INDEX IF NOT EXISTS idx_licenses_owner ON licenses(owner_id)`);

export const dbStatements: Record<string, Statement> = {
  startSession: db.prepare(`
    INSERT INTO voice_sessions (user_id, username, guild_id, channel_id, joined_at)
    VALUES (?, ?, ?, ?, ?)
  `),

  endSession: db.prepare(`
    UPDATE voice_sessions
    SET left_at = ?, duration_seconds = ? - joined_at
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

  getLeaderboardMonth: db.prepare(`
    SELECT user_id, username, SUM(duration_seconds) as total_seconds
    FROM voice_sessions
    WHERE guild_id = ? AND duration_seconds IS NOT NULL AND joined_at >= ?
    GROUP BY user_id
    ORDER BY total_seconds DESC
    LIMIT 10
  `),

  getOpenSessions: db.prepare(`
    SELECT * FROM voice_sessions WHERE left_at IS NULL AND guild_id = ?
  `),

  closeAllSessions: db.prepare(`
    UPDATE voice_sessions
    SET left_at = ?, duration_seconds = ? - joined_at
    WHERE left_at IS NULL
  `),

  getGuildSettings: db.prepare(`SELECT * FROM guild_settings WHERE guild_id = ?`),

  listGuildSettings: db.prepare(`SELECT * FROM guild_settings`),

  upsertGuildSettings: db.prepare(`
    INSERT INTO guild_settings (guild_id, voice_channel_id, clips_channel_id, auto_join, live_counter, joined_at)
    VALUES (@guild_id, @voice_channel_id, @clips_channel_id, @auto_join, @live_counter, @joined_at)
    ON CONFLICT(guild_id) DO UPDATE SET
      voice_channel_id = excluded.voice_channel_id,
      clips_channel_id = excluded.clips_channel_id,
      auto_join = excluded.auto_join,
      live_counter = excluded.live_counter
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

  countTrialsByOwner: db.prepare(`
    SELECT COUNT(*) as n FROM licenses
    WHERE owner_id = ? AND guild_id != ? AND plan = 'trial'
  `),

  countFounders: db.prepare(`SELECT COUNT(*) as n FROM licenses WHERE founder = 1`),

  countLifetime: db.prepare(`SELECT COUNT(*) as n FROM licenses WHERE plan = 'lifetime'`),

  addEvent: db.prepare(`
    INSERT INTO events (guild_id, kind, user_id, seconds, bytes, detail, created_at)
    VALUES (@guild_id, @kind, @user_id, @seconds, @bytes, @detail, @created_at)
  `),

  pendingEvents: db.prepare(`SELECT * FROM events WHERE synced = 0 ORDER BY id LIMIT ?`),

  markEventsSynced: db.prepare(`UPDATE events SET synced = 1 WHERE id <= ? AND synced = 0`),

  pruneEvents: db.prepare(`DELETE FROM events WHERE synced = 1 AND created_at < ?`),

  addFeedback: db.prepare(`
    INSERT INTO feedback (guild_id, guild_name, user_id, username, rating, message, created_at)
    VALUES (@guild_id, @guild_name, @user_id, @username, @rating, @message, @created_at)
  `),

  pendingFeedback: db.prepare(`SELECT * FROM feedback WHERE synced = 0 ORDER BY id LIMIT ?`),

  markFeedbackSynced: db.prepare(`UPDATE feedback SET synced = 1 WHERE id <= ? AND synced = 0`),

  recentFeedbackByUser: db.prepare(`
    SELECT COUNT(*) as n FROM feedback WHERE user_id = ? AND created_at > ?
  `),
};

export { db };
