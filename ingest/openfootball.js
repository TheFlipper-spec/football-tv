/**
 * Инжест openfootball (https://github.com/openfootball).
 * Два формата:
 *   1) football.json/<сезон>/<лига>.json  — JSON с матчами;
 *   2) europe/<страна>/<сезон>_<лига>.txt — текстовый формат.
 * Все данные берутся как есть: даты, время, тур, счёт (в т.ч. перерыв).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb, setMeta } from '../server/db.js';
import { LEAGUES, EURO_TEXT_LEAGUES } from './competitions.js';
import { upsertTeam } from './teams.js';
import { zonedToUtcIso, deriveStatus } from '../lib/time.js';
import { slug } from '../lib/names.js';

const SOURCE = 'openfootball';

function competitionIdFor(leagueKey) {
  return `${SOURCE}:${leagueKey}`;
}

function seasonIdFor(leagueKey, season) {
  return `${SOURCE}:${leagueKey}:${season}`;
}

export function upsertCompetition(leagueKey, meta, seasonName) {
  const db = getDb();
  const id = competitionIdFor(leagueKey);
  db.prepare(
    `INSERT INTO competitions (id, name, name_ru, country, country_ru, kind, tier, accent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, name_ru = excluded.name_ru,
       country = excluded.country, country_ru = excluded.country_ru,
       kind = excluded.kind, tier = excluded.tier, accent = excluded.accent`,
  ).run(
    id,
    meta.name,
    meta.ru,
    meta.country,
    meta.countryRu,
    meta.kind || 'league',
    meta.tier || 1,
    meta.accent || null,
  );
  return id;
}

export function upsertSeason(leagueKey, season, label, source) {
  const db = getDb();
  const id = seasonIdFor(leagueKey, season);
  const competitionId = competitionIdFor(leagueKey);
  db.prepare(
    `INSERT INTO seasons (id, competition_id, name, label_ru, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, label_ru = excluded.label_ru`,
  ).run(id, competitionId, season, label || null, source || SOURCE);
  return id;
}

function parseScore(score) {
  if (!score) return { home: null, away: null, htHome: null, htAway: null };
  const ft = score.ft || score.score || null;
  const ht = score.ht || null;
  return {
    home: ft ? Number(ft[0]) : null,
    away: ft ? Number(ft[1]) : null,
    htHome: ht ? Number(ht[0]) : null,
    htAway: ht ? Number(ht[1]) : null,
  };
}

const matchInsert = `
INSERT INTO matches (
  id, competition_id, season_id, stage, round, matchday, kickoff_utc, kickoff_local, timezone,
  status, home_team_id, away_team_id, home_score, away_score, ht_home, ht_away,
  source, source_match_id, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  round = COALESCE(excluded.round, matches.round),
  matchday = COALESCE(excluded.matchday, matches.matchday),
  kickoff_utc = COALESCE(excluded.kickoff_utc, matches.kickoff_utc),
  kickoff_local = COALESCE(excluded.kickoff_local, matches.kickoff_local),
  status = excluded.status,
  home_score = excluded.home_score,
  away_score = excluded.away_score,
  ht_home = excluded.ht_home,
  ht_away = excluded.ht_away,
  updated_at = excluded.updated_at`;

function insertMatch(row) {
  const db = getDb();
  db.prepare(matchInsert).run(
    row.id,
    row.competitionId,
    row.seasonId,
    row.stage || null,
    row.round || null,
    row.matchday ?? null,
    row.kickoffUtc || null,
    row.kickoffLocal || null,
    row.timezone || null,
    row.status,
    row.homeId,
    row.awayId,
    row.homeScore,
    row.awayScore,
    row.htHome,
    row.htAway,
    row.source,
    row.sourceMatchId,
    new Date().toISOString(),
  );
}

function matchdayOf(round) {
  if (!round) return null;
  const m = String(round).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function ingestJsonFile(file, leagueKey, seasonDir) {
  const meta = LEAGUES[leagueKey];
  if (!meta) return { matches: 0, skipped: true };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const competitionId = upsertCompetition(leagueKey, meta);
  const seasonName = raw.name || `${leagueKey} ${seasonDir}`;
  const seasonId = upsertSeason(leagueKey, seasonDir, seasonName);

  let count = 0;
  for (const m of raw.matches || []) {
    if (!m.team1 || !m.team2) continue;
    const homeId = upsertTeam(m.team1);
    const awayId = upsertTeam(m.team2);
    const { home, away, htHome, htAway } = parseScore(m.score);
    const kickoffLocal = m.date && m.time ? `${m.date} ${m.time}` : m.date || null;
    const kickoffUtc = zonedToUtcIso(m.date, m.time, meta.tz);
    const hasScore = home !== null && away !== null;
    insertMatch({
      id: `${SOURCE}:${leagueKey}:${seasonDir}:${m.date}:${slug(m.team1)}-${slug(m.team2)}`,
      competitionId,
      seasonId,
      round: m.round || null,
      matchday: matchdayOf(m.round),
      kickoffUtc,
      kickoffLocal,
      timezone: meta.tz,
      status: deriveStatus(kickoffUtc, hasScore),
      homeId,
      awayId,
      homeScore: home,
      awayScore: away,
      htHome,
      htAway,
      source: SOURCE,
      sourceMatchId: `${leagueKey}/${seasonDir}/${m.date}/${m.team1}-${m.team2}`,
    });
    count += 1;
  }
  return { matches: count };
}

const TEXT_MATCH_RE =
  /^\s*(?:(\d{1,2}:\d{2})\s+)?(.+?)\s+(?:v|vs\.?|-)\s+(.+?)\s+(\d+)\s*-\s*(\d+)(?:\s*\((\d+)\s*-\s*(\d+)\))?\s*$/;
const TEXT_MATCH_NOSCORE_RE = /^\s*(?:(\d{1,2}:\d{2})\s+)?(.+?)\s+(?:v|vs\.?)\s+(.+?)\s*$/;
const TEXT_DATE_RE = /^\s{2,}(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]{3})\s+(\d{1,2})(?:\s+(\d{4}))?\s*$/;
const TEXT_ROUND_RE = /^\s*[▪•*]?\s*(?:Matchday|Round|Jornada|Spieltag|Giornata|Tour|J\.|MD)\s*(\d+)/i;

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function cleanTeamName(name) {
  return name
    .replace(/\s+/g, ' ')
    .replace(/[?!]+$/, '')
    .trim();
}

/** Парсер текстового формата openfootball. Экспортируется для тестов. */
export function parseOpenfootballText(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let round = null;
  let currentDate = null;
  let currentYear = null;

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const roundMatch = rawLine.match(TEXT_ROUND_RE);
    if (roundMatch && /^\s*[▪•*]/.test(rawLine)) {
      round = `Matchday ${roundMatch[1]}`;
      continue;
    }
    const dateMatch = rawLine.match(TEXT_DATE_RE);
    if (dateMatch) {
      const mon = MONTHS[dateMatch[2]];
      const day = Number(dateMatch[3]);
      const year = dateMatch[4] ? Number(dateMatch[4]) : currentYear;
      if (mon !== undefined && day && year) {
        currentDate = `${year}-${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        currentYear = year;
      }
      continue;
    }
    const withScore = rawLine.match(TEXT_MATCH_RE);
    const noScore = !withScore ? rawLine.match(TEXT_MATCH_NOSCORE_RE) : null;
    if (!withScore && !noScore) continue;
    const hit = withScore || noScore;
    const time = hit[1] || null;
    const t1 = hit[2];
    const t2 = hit[3];
    if (!t1 || !t2) continue;
    const home = withScore ? Number(hit[4]) : null;
    const away = withScore ? Number(hit[5]) : null;
    const htH = withScore ? hit[6] : null;
    const htA = withScore ? hit[7] : null;
    out.push({
      round,
      date: currentDate,
      time,
      team1: cleanTeamName(t1),
      team2: cleanTeamName(t2),
      score: withScore ? { ft: [home, away], ht: htH != null ? [Number(htH), Number(htA)] : null } : null,
    });
  }
  return out;
}

function ingestTextFile(file, leagueMeta, seasonDir) {
  const text = fs.readFileSync(file, 'utf8');
  const competitionId = upsertCompetition(leagueMeta.key, leagueMeta);
  const title = (text.match(/^=\s*(.+?)\s*$/m) || [])[1];
  const seasonId = upsertSeason(leagueMeta.key, seasonDir, title || `${leagueMeta.name} ${seasonDir}`);

  let count = 0;
  for (const m of parseOpenfootballText(text)) {
    if (!m.team1 || !m.team2 || !m.date) continue;
    const homeId = upsertTeam(m.team1);
    const awayId = upsertTeam(m.team2);
    const { home, away, htHome, htAway } = parseScore(m.score);
    const kickoffLocal = m.time ? `${m.date} ${m.time}` : m.date;
    const kickoffUtc = zonedToUtcIso(m.date, m.time, leagueMeta.tz);
    const hasScore = home !== null && away !== null;
    insertMatch({
      id: `${SOURCE}:${leagueMeta.key}:${seasonDir}:${m.date}:${slug(m.team1)}-${slug(m.team2)}`,
      competitionId,
      seasonId,
      round: m.round,
      matchday: matchdayOf(m.round),
      kickoffUtc,
      kickoffLocal,
      timezone: leagueMeta.tz,
      status: deriveStatus(kickoffUtc, hasScore),
      homeId,
      awayId,
      homeScore: home,
      awayScore: away,
      htHome,
      htAway,
      source: SOURCE,
      sourceMatchId: `${leagueMeta.key}/${seasonDir}/${m.date}/${m.team1}-${m.team2}`,
    });
    count += 1;
  }
  return { matches: count };
}

export function ingestOpenfootball({ cacheDir, log = console.log }) {
  const jsonRoot = path.join(cacheDir, 'openfootball-json');
  const europeRoot = path.join(cacheDir, 'openfootball-europe');
  if (!fs.existsSync(jsonRoot) && !fs.existsSync(europeRoot)) {
    throw new Error(`Не найден кэш openfootball в ${cacheDir}. Запустите: npm run ingest (требуется доступ к github.com)`);
  }

  let total = 0;
  const leagues = new Set();
  const db = getDb();
  db.prepare('BEGIN').run();

  if (fs.existsSync(jsonRoot)) {
    for (const seasonDir of fs.readdirSync(jsonRoot).sort()) {
      const dir = path.join(jsonRoot, seasonDir);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        if (file.endsWith('-full.json')) continue; // дубликат обычного файла
        const leagueKey = file.replace(/\.json$/, '');
        const res = ingestJsonFile(path.join(dir, file), leagueKey, seasonDir);
        if (res.skipped) continue;
        total += res.matches;
        leagues.add(leagueKey);
      }
    }
  }

  if (fs.existsSync(europeRoot)) {
    for (const country of fs.readdirSync(europeRoot).sort()) {
      const dir = path.join(europeRoot, country);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        const m = file.match(/^(\d{4}(?:-\d{2})?)_([a-z0-9]+)\.txt$/);
        if (!m) continue;
        const leagueMeta = EURO_TEXT_LEAGUES[m[2]];
        if (!leagueMeta) continue;
        // JSON-файлы приоритетнее: пропускаем сезон, если он уже загружен из football.json
        const res = ingestTextFile(path.join(dir, file), leagueMeta, m[1]);
        total += res.matches;
        leagues.add(leagueMeta.key);
      }
    }
  }

  db.prepare('COMMIT').run();
  db.prepare('VACUUM').run();
  setMeta('ingest.openfootball', new Date().toISOString());
  log(`  openfootball: ${total} матчей, ${leagues.size} лиг`);
  return { matches: total, leagues: [...leagues] };
}
