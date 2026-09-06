/**
 * Живой слой: ESPN Site API (публичный, без ключа).
 *   https://site.api.espn.com/apis/site/v2/sports/soccer/<лига>/scoreboard
 *
 * Отдаёт текущий счёт, минуту, статус и состав события.
 * Требует исходящего интернета; если его нет — инжест пропускает шаг,
 * а сайт показывает данные из базы (реальные, но на момент последнего снимка).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getDb, setMeta } from '../server/db.js';
import { upsertTeam } from './teams.js';
import { teamAliases } from '../lib/matcher.js';
import { deriveStatus } from '../lib/time.js';

const SOURCE = 'espn';
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

export const ESPN_LEAGUES = [
  { slug: 'rus.1', name: 'Russian Premier League', ru: 'Российская Премьер-лига', tz: 'Europe/Moscow', accent: '#1a2f6b' },
  { slug: 'eng.1', name: 'English Premier League', ru: 'Английская Премьер-лига', tz: 'Europe/London', accent: '#3d195b' },
  { slug: 'eng.2', name: 'English Championship', ru: 'Чемпионшип', tz: 'Europe/London', accent: '#2b2b2b' },
  { slug: 'esp.1', name: 'Spanish LaLiga', ru: 'Ла Лига', tz: 'Europe/Madrid', accent: '#ff4b44' },
  { slug: 'ita.1', name: 'Italian Serie A', ru: 'Серия А', tz: 'Europe/Rome', accent: '#008fd7' },
  { slug: 'ger.1', name: 'German Bundesliga', ru: 'Бундеслига', tz: 'Europe/Berlin', accent: '#d20515' },
  { slug: 'fra.1', name: 'French Ligue 1', ru: 'Лига 1', tz: 'Europe/Paris', accent: '#091c3e' },
  { slug: 'uefa.champions', name: 'UEFA Champions League', ru: 'Лига чемпионов', tz: 'Europe/Berlin', accent: '#00204a', kind: 'international' },
  { slug: 'uefa.europa', name: 'UEFA Europa League', ru: 'Лига Европы', tz: 'Europe/Berlin', accent: '#ff6a00', kind: 'international' },
];

function getJson(url) {
  const script = `
    fetch(${JSON.stringify(url)}, { headers: { 'user-agent': 'Mozilla/5.0 (football-tv ingest)', accept: 'application/json' } })
      .then(async r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(t => process.stdout.write(t))
      .catch(e => { process.stderr.write(String(e)); process.exit(1); });
  `;
  let out;
  try {
    out = execFileSync(process.execPath, ['--input-type=commonjs', '-e', script], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30000,
      // без интернета дочерний процесс печатает «TypeError: fetch failed» на каждую
      // лигу — молчим, вызывающий код возьмёт снимок и сам об этом сообщит
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8');
  } catch (err) {
    throw new Error(`нет доступа к ESPN (${err.code || 'offline'})`);
  }
  return JSON.parse(out);
}

function ensureCompetition(league) {
  const db = getDb();
  const id = `${SOURCE}:${league.slug}`;
  db.prepare(
    `INSERT INTO competitions (id, name, name_ru, country, country_ru, kind, tier, accent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_ru = excluded.name_ru, accent = excluded.accent`,
  ).run(id, league.name, league.ru, null, null, league.kind || 'league', 1, league.accent || null);
  return id;
}

function findExistingMatch(homeId, awayId, kickoffUtc) {
  if (!kickoffUtc) return null;
  const day = kickoffUtc.slice(0, 10);
  const row = getDb()
    .prepare(
      `SELECT id FROM matches
        WHERE ((home_team_id = ? AND away_team_id = ?) OR (home_team_id = ? AND away_team_id = ?))
          AND source != '${SOURCE}'
          AND kickoff_utc BETWEEN ? AND ?
        ORDER BY ABS(strftime('%s', kickoff_utc) - strftime('%s', ?))
        LIMIT 1`,
    )
    .get(
      homeId, awayId, awayId, homeId,
      new Date(Date.parse(kickoffUtc) - 36 * 3600_000).toISOString(),
      new Date(Date.parse(kickoffUtc) + 36 * 3600_000).toISOString(),
      kickoffUtc,
    );
  if (!row) return null;
  const m = getDb().prepare('SELECT kickoff_utc FROM matches WHERE id = ?').get(row.id);
  return m && m.kickoff_utc?.slice(0, 10) === day ? row.id : null;
}


/** Названия статистики ESPN → наши ключи (их знает фронтенд через STAT_LABELS). */
const STAT_MAP = {
  possessionPct: 'possession_pct',
  totalShots: 'shots',
  shotsOnTarget: 'shots_on_target',
  wonCorners: 'corners',
  foulsCommitted: 'fouls_committed',
  goalAssists: 'goal_assists',
  totalGoals: 'goals',
  totalPasses: 'passes_attempted',
  passesCompleted: 'passes_completed',
  offsides: 'offsides',
  saves: 'saves',
  tackles: 'tackles',
};

/** Тип события ESPN → наш тип. */
function eventKind(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('penalty')) return 'penalty';
  if (t.includes('own goal')) return 'own_goal';
  if (t.includes('goal')) return 'goal';
  if (t.includes('second yellow')) return 'red';
  if (t.includes('red card')) return 'red';
  if (t.includes('yellow')) return 'yellow';
  if (t.includes('substitution')) return 'substitution';
  return t || 'event';
}

function upsertPlayer(a) {
  if (!a?.id) return null;
  const db = getDb();
  const id = `espn:${a.id}`;
  db.prepare(
    `INSERT INTO players (id, name, nickname, position) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, position = COALESCE(excluded.position, players.position)`,
  ).run(id, a.fullName || a.displayName || String(a.id), a.shortName || null, a.position || null);
  return id;
}

/**
 * Глубина матча из ответа ESPN: поминутные события (голы, карточки, замены)
 * и командная статистика. Именно этого не хватает календарным матчам openfootball.
 */
function upsertMatchDepth(matchId, comp, homeId, awayId) {
  const db = getDb();
  const teamIdByEspn = new Map();
  for (const c of comp.competitors || []) {
    if (c.id != null) teamIdByEspn.set(String(c.id), c.homeAway === 'home' ? homeId : awayId);
  }
  const row = db.prepare('SELECT competition_id, season_id FROM matches WHERE id = ?').get(matchId);
  if (!row) return;

  // события перезаписываем целиком, иначе повторный инжест их удвоит
  db.prepare("DELETE FROM match_events WHERE match_id = ? AND player_id LIKE 'espn:%'").run(matchId);
  const insEv = db.prepare(
    `INSERT INTO match_events (match_id, minute, extra_minute, period, type, team_id, player_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insStat = db.prepare(
    `INSERT INTO match_stats (match_id, team_id, stat, value) VALUES (?, ?, ?, ?)
     ON CONFLICT(match_id, team_id, stat) DO UPDATE SET value = excluded.value`,
  );

  let events = 0;
  let goals = 0;
  for (const d of comp.details || []) {
    const kind = eventKind(d.type?.text);
    const teamId = teamIdByEspn.get(String(d.team?.id)) || null;
    const a = d.athletesInvolved?.[0];
    const playerId = upsertPlayer(a);
    const display = d.clock?.displayValue || null;
    const minute = display ? Number.parseInt(display, 10) : null;
    const extra = display && display.includes('+') ? Number.parseInt(display.split('+')[1], 10) : null;
    const isGoal = kind === 'goal' || kind === 'penalty' || kind === 'own_goal';
    insEv.run(
      matchId,
      Number.isFinite(minute) ? minute : null,
      Number.isFinite(extra) ? extra : null,
      d.period || null,
      kind,
      teamId,
      playerId,
      d.type?.text || null,
    );
    events += 1;
    if (isGoal && playerId && d.scoringPlay) goals += 1;
  }

  let stats = 0;
  for (const c of comp.competitors || []) {
    const teamId = teamIdByEspn.get(String(c.id));
    if (!teamId) continue;
    for (const st of c.statistics || []) {
      const key = STAT_MAP[st.name];
      const value = Number.parseFloat(st.displayValue ?? st.value);
      if (!key || !Number.isFinite(value)) continue;
      insStat.run(matchId, teamId, key, value);
      stats += 1;
    }
  }

  db.prepare(
    `UPDATE matches SET has_events = ?, has_stats = ? WHERE id = ?`,
  ).run(events ? 1 : 0, stats ? 1 : 0, matchId);

  return { events, stats, goals };
}

function upsertEvent(ev, league) {
  const db = getDb();
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const competitors = comp.competitors || [];
  const home = competitors.find((c) => c.homeAway === 'home') || competitors[0];
  const away = competitors.find((c) => c.homeAway === 'away') || competitors[1];
  if (!home || !away) return null;

  const homeId = upsertTeam(home.team.displayName, { short: home.team.abbreviation, crest: home.team.logo });
  const awayId = upsertTeam(away.team.displayName, { short: away.team.abbreviation, crest: away.team.logo });

  const kickoffUtc = ev.date;
  const state = comp.status?.type?.state;
  const hasScore = home.score != null && away.score != null && state !== 'pre';
  let status = state === 'in' ? 'live' : state === 'post' ? 'finished' : 'scheduled';
  if (state === 'pre' && !hasScore) status = deriveStatus(kickoffUtc, false);

  /*
   * Минута матча. `status.clock` у ESPN — сквозные секунды матча (на 90-й
   * минуте это 5400), поэтому прибавлять (period-1)*45 нельзя: выходило
   * 90 + 45 = «135-я минута». Берём минуту из displayClock («90'+7'» → 90),
   * а clock оставляем запасным вариантом. У не-идущего матча минуты нет.
   */
  let minute = null;
  if (state === 'in') {
    const display = Number.parseInt(comp.status?.displayClock ?? '', 10);
    if (Number.isFinite(display)) minute = Math.max(0, Math.min(display, 120));
    else if (comp.status?.clock != null) minute = Math.max(0, Math.min(Math.round(Number(comp.status.clock) / 60), 120));
  }

  const espnId = `${SOURCE}:${league.slug}:${ev.id}`;
  const existing = findExistingMatch(homeId, awayId, kickoffUtc);
  const id = existing || espnId;

  // сезон создаём до матча — на него ссылается внешний ключ
  const seasonId = `${SOURCE}:${league.slug}:${new Date(kickoffUtc).getFullYear()}`;
  const competitionId = ensureCompetition(league);
  db.prepare(
    `INSERT INTO seasons (id, competition_id, name, source) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(seasonId, competitionId, String(new Date(kickoffUtc).getFullYear()), SOURCE);

  db.prepare(
    `INSERT INTO matches (
       id, competition_id, season_id, round, kickoff_utc, timezone, status, minute,
       home_team_id, away_team_id, home_score, away_score, venue, city, country, attendance,
       source, source_match_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       minute = excluded.minute,
       home_score = excluded.home_score,
       away_score = excluded.away_score,
       venue = COALESCE(excluded.venue, matches.venue),
       city = COALESCE(excluded.city, matches.city),
       country = COALESCE(excluded.country, matches.country),
       attendance = COALESCE(excluded.attendance, matches.attendance),
       updated_at = excluded.updated_at`,
  ).run(
    id,
    competitionId,
    seasonId,
    comp.groupings?.[0]?.groupings?.[0]?.description || null,
    kickoffUtc, league.tz, status, minute,
    homeId, awayId,
    hasScore ? Number(home.score) : null,
    hasScore ? Number(away.score) : null,
    comp.venue?.fullName || null,
    comp.venue?.address?.city || null,
    comp.venue?.address?.country || null,
    comp.attendance || null,
    existing ? getDb().prepare('SELECT source FROM matches WHERE id = ?').get(existing)?.source || SOURCE : SOURCE,
    String(ev.id),
    new Date().toISOString(),
  );

  const depth = upsertMatchDepth(id, comp, homeId, awayId);
  if (depth && (depth.events || depth.stats)) {
    logDepth?.(`${homeId} — ${awayId}: событий ${depth.events}, статистики ${depth.stats}, голов ${depth.goals}`);
  }

  return id;
}

let logDepth = null;


/**
 * Бомбардиры live-слоя. Считаются заново из match_events каждый проход — иначе
 * повторный инжест добавлял бы по голу за каждый запуск.
 */
function rebuildEspnScorers({ log = () => {} } = {}) {
  const db = getDb();
  db.prepare("DELETE FROM scorers WHERE player_id LIKE 'espn:%'").run();
  const info = db
    .prepare(
      `INSERT INTO scorers (competition_id, season_id, player_id, team_id, goals, assists, minutes)
         SELECT m.competition_id, m.season_id, e.player_id, e.team_id, COUNT(*), 0, 0
           FROM match_events e
           JOIN matches m ON m.id = e.match_id
          WHERE e.player_id LIKE 'espn:%'
            AND e.type IN ('goal', 'penalty')
            AND m.competition_id IS NOT NULL AND m.season_id IS NOT NULL
          GROUP BY m.competition_id, m.season_id, e.player_id, e.team_id`,
    )
    .run();
  if (info.changes) log(`    бомбардиры live-слоя: ${info.changes}`);
}

function snapshotPath(snapshotsDir, slug) {
  const files = fs
    .readdirSync(snapshotsDir)
    .filter((f) => f.startsWith(`espn-${slug}-`) && f.endsWith('.json'))
    .sort();
  return files.length ? path.join(snapshotsDir, files[files.length - 1]) : null;
}

export function ingestEspn({ log = console.log, leagues = ESPN_LEAGUES, snapshotsDir = null, live = true } = {}) {
  const db = getDb();
  logDepth = (msg) => log(`    протокол · ${msg}`);
  let updated = 0;
  let mode = 'none';
  for (const league of leagues) {
    let data = null;
    if (live) {
      try {
        data = getJson(`${BASE}/${league.slug}/scoreboard`);
        mode = 'live';
        if (snapshotsDir) {
          fs.mkdirSync(snapshotsDir, { recursive: true });
          fs.writeFileSync(
            path.join(snapshotsDir, `espn-${league.slug}-${new Date().toISOString().slice(0, 10)}.json`),
            JSON.stringify(
              {
                captured_at: new Date().toISOString(),
                league: league.slug,
                league_name: league.name,
                source_url: `${BASE}/${league.slug}/scoreboard`,
                events: data.events || [],
              },
              null,
              2,
            ),
          );
        }
      } catch (err) {
        log(`  ESPN ${league.slug}: сеть недоступна (${err.message.split('\n')[0]})`);
      }
    }
    if (!data && snapshotsDir && fs.existsSync(snapshotsDir)) {
      const file = snapshotPath(snapshotsDir, league.slug);
      if (file) {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
        mode = 'snapshot';
        log(`  ESPN ${league.slug}: беру снимок ${path.basename(file)}`);
      }
    }
    if (!data) continue;
    for (const ev of data.events || []) {
      if (upsertEvent(ev, league)) updated += 1;
    }
  }
  rebuildEspnScorers({ log });
  setMeta('ingest.espn', new Date().toISOString());
  setMeta('ingest.espn.mode', mode);
  const liveCount = db.prepare("SELECT COUNT(*) AS n FROM matches WHERE status = 'live'").get().n;
  log(`  ESPN: обновлено ${updated} матчей (${mode}), в эфире ${liveCount}`);
  return { updated, live: liveCount, mode };
}
