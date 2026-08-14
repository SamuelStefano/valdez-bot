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
`);

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
    INSERT INTO guild_settings (guild_id, voice_channel_id, clips_channel_id, auto_join, joined_at)
    VALUES (@guild_id, @voice_channel_id, @clips_channel_id, @auto_join, @joined_at)
    ON CONFLICT(guild_id) DO UPDATE SET
      voice_channel_id = excluded.voice_channel_id,
      clips_channel_id = excluded.clips_channel_id,
      auto_join = excluded.auto_join
  `),

  deleteGuildSettings: db.prepare(`DELETE FROM guild_settings WHERE guild_id = ?`),

  addOptOut: db.prepare(`
    INSERT OR IGNORE INTO clip_optouts (guild_id, user_id, created_at) VALUES (?, ?, ?)
  `),

  removeOptOut: db.prepare(`DELETE FROM clip_optouts WHERE guild_id = ? AND user_id = ?`),

  listOptOuts: db.prepare(`SELECT user_id FROM clip_optouts WHERE guild_id = ?`),
};

export { db };
