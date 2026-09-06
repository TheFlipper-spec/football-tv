import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DB_PATH = process.env.FOOTBALL_DB || path.join(ROOT, 'data', 'football.db');

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS competitions (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  name_ru       TEXT,
  country       TEXT,
  country_ru    TEXT,
  kind          TEXT NOT NULL DEFAULT 'league',   -- league | cup | international
  tier          INTEGER DEFAULT 1,
  accent        TEXT,
  logo_url      TEXT,
  default_season_id TEXT
);

CREATE TABLE IF NOT EXISTS seasons (
  id            TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  label_ru      TEXT,
  start_date    TEXT,
  end_date      TEXT,
  source        TEXT
);

CREATE TABLE IF NOT EXISTS teams (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  name_ru       TEXT,
  short_name    TEXT,
  country       TEXT,
  crest_url     TEXT,
  primary_color TEXT,
  statsbomb_id  INTEGER,
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS team_aliases (
  alias         TEXT PRIMARY KEY,
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  nickname      TEXT,
  position      TEXT,
  country       TEXT,
  dob           TEXT,
  height_cm     INTEGER,
  statsbomb_id  INTEGER
);

CREATE TABLE IF NOT EXISTS matches (
  id              TEXT PRIMARY KEY,
  competition_id  TEXT REFERENCES competitions(id) ON DELETE SET NULL,
  season_id       TEXT REFERENCES seasons(id) ON DELETE SET NULL,
  stage           TEXT,
  round           TEXT,
  matchday        INTEGER,
  group_name      TEXT,
  kickoff_utc     TEXT,
  kickoff_local   TEXT,
  timezone        TEXT,
  status          TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | live | finished | postponed
  minute          INTEGER,
  home_team_id    TEXT REFERENCES teams(id),
  away_team_id    TEXT REFERENCES teams(id),
  home_score      INTEGER,
  away_score      INTEGER,
  ht_home         INTEGER,
  ht_away         INTEGER,
  venue           TEXT,
  city            TEXT,
  country         TEXT,
  attendance      INTEGER,
  referee         TEXT,
  source          TEXT NOT NULL,
  source_match_id TEXT,
  has_lineups     INTEGER NOT NULL DEFAULT 0,
  has_stats       INTEGER NOT NULL DEFAULT 0,
  has_events      INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT,
  UNIQUE (source, source_match_id)
);

CREATE INDEX IF NOT EXISTS idx_matches_kickoff ON matches(kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_matches_season  ON matches(season_id);
CREATE INDEX IF NOT EXISTS idx_matches_teams   ON matches(home_team_id, away_team_id);

CREATE TABLE IF NOT EXISTS lineups (
  match_id     TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  jersey       INTEGER,
  position     TEXT,
  side         TEXT NOT NULL DEFAULT 'starting',   -- starting | bench
  on_minute    INTEGER,
  off_minute   INTEGER,
  captain      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, team_id, player_id)
);

CREATE TABLE IF NOT EXISTS match_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id      TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  minute        INTEGER,
  extra_minute  INTEGER,
  period        INTEGER,
  type          TEXT NOT NULL,       -- goal | own_goal | penalty | yellow | red | substitution | shot ...
  team_id       TEXT REFERENCES teams(id) ON DELETE CASCADE,
  player_id     TEXT REFERENCES players(id) ON DELETE CASCADE,
  related_player_id TEXT REFERENCES players(id) ON DELETE CASCADE,
  detail        TEXT,
  x             REAL,
  y             REAL
);

CREATE INDEX IF NOT EXISTS idx_events_match ON match_events(match_id, minute);

CREATE TABLE IF NOT EXISTS match_stats (
  match_id  TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  stat      TEXT NOT NULL,
  value     REAL,
  PRIMARY KEY (match_id, team_id, stat)
);

CREATE TABLE IF NOT EXISTS standings (
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  season_id      TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  stage          TEXT NOT NULL DEFAULT 'total',
  position       INTEGER NOT NULL,
  team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  played         INTEGER DEFAULT 0,
  won            INTEGER DEFAULT 0,
  drawn          INTEGER DEFAULT 0,
  lost           INTEGER DEFAULT 0,
  goals_for      INTEGER DEFAULT 0,
  goals_against  INTEGER DEFAULT 0,
  goal_diff      INTEGER DEFAULT 0,
  points         INTEGER DEFAULT 0,
  form           TEXT,
  PRIMARY KEY (competition_id, season_id, stage, team_id)
);

CREATE TABLE IF NOT EXISTS scorers (
  competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  season_id      TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  player_id      TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id        TEXT REFERENCES teams(id) ON DELETE CASCADE,
  goals          INTEGER NOT NULL DEFAULT 0,
  assists        INTEGER NOT NULL DEFAULT 0,
  minutes        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (competition_id, season_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_scorers_season ON scorers(season_id, goals DESC);

CREATE TABLE IF NOT EXISTS streams (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL,        -- vk | ok | youtube | tv
  category      TEXT,
  title         TEXT NOT NULL,
  channel       TEXT,
  channel_url   TEXT,
  url           TEXT NOT NULL UNIQUE,
  embed_url     TEXT,
  thumbnail     TEXT,
  viewers       INTEGER DEFAULT 0,
  is_live       INTEGER NOT NULL DEFAULT 1,
  captured_at   TEXT NOT NULL,
  snapshot_id   TEXT
);

CREATE TABLE IF NOT EXISTS match_streams (
  stream_id  TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  match_id   TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  score      REAL NOT NULL DEFAULT 0,
  method     TEXT,
  PRIMARY KEY (stream_id, match_id)
);

CREATE INDEX IF NOT EXISTS idx_ms_match ON match_streams(match_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

let db;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  return db;
}

export function setMeta(key, value) {
  getDb()
    .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function allMeta() {
  const rows = getDb().prepare('SELECT key, value FROM meta').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Массовая вставка в транзакции. */
export function bulkInsert(sql, rows) {
  const stmt = getDb().prepare(sql);
  const tx = getDb().prepare('BEGIN');
  const commit = getDb().prepare('COMMIT');
  const rollback = getDb().prepare('ROLLBACK');
  tx.run();
  let n = 0;
  try {
    for (const row of rows) {
      stmt.run(...row);
      n += 1;
    }
    commit.run();
  } catch (err) {
    rollback.run();
    throw err;
  }
  return n;
}

export function tableCount(table) {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return row.n;
}
