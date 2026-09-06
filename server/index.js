import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getDb, allMeta } from './db.js';
import { refreshState, refreshNow, startAutoRefresh } from './refresh.js';
import { minuteFromKickoff } from '../lib/time.js';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DIST = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const db = () => getDb();
const all = (sql, params = []) => db().prepare(sql).all(...params);
const one = (sql, params = []) => db().prepare(sql).get(...params) || null;

const MATCH_SELECT = `
  SELECT m.id, m.kickoff_utc, m.kickoff_local, m.timezone, m.status, m.minute, m.round, m.stage,
         m.matchday, m.home_score, m.away_score, m.ht_home, m.ht_away, m.venue, m.city, m.country,
         m.attendance, m.referee, m.source, m.has_lineups, m.has_stats, m.has_events, m.updated_at,
         c.id AS competition_id, c.name AS competition_name, c.name_ru AS competition_name_ru,
         c.country_ru AS competition_country_ru, c.accent AS competition_accent, c.kind AS competition_kind,
         s.name AS season_name, s.label_ru AS season_label,
         th.id AS home_id, th.name AS home_name, th.name_ru AS home_name_ru, th.short_name AS home_short,
         th.primary_color AS home_color, th.crest_url AS home_crest,
         ta.id AS away_id, ta.name AS away_name, ta.name_ru AS away_name_ru, ta.short_name AS away_short,
         ta.primary_color AS away_color, ta.crest_url AS away_crest
    FROM matches m
    LEFT JOIN competitions c ON c.id = m.competition_id
    LEFT JOIN seasons s ON s.id = m.season_id
    LEFT JOIN teams th ON th.id = m.home_team_id
    LEFT JOIN teams ta ON ta.id = m.away_team_id`;

function decorate(matches) {
  const now = Date.now();
  return matches.map((m) => {
    const start = m.kickoff_utc ? Date.parse(m.kickoff_utc) : null;
    let status = m.status;
    let minute = m.minute;
    const hasScore = m.home_score != null && m.away_score != null;
    const validStart = start && !Number.isNaN(start);
    const staleLive = status === 'live' && validStart && now - start > 165 * 60_000;

    if (staleLive) {
      // статус «live» устарел (нет живого источника) — матч считаем завершённым
      status = 'finished';
    } else if (status !== 'live' && hasScore) {
      status = 'finished';
    } else if (status !== 'live' && !hasScore && validStart) {
      const fullTime = start + 125 * 60_000;
      if (now >= start && now < fullTime) {
        status = 'live';
        if (minute == null) minute = minuteFromKickoff(m.kickoff_utc);
      }
    }
    return { ...m, status, minute };
  });
}

function attachStreams(matches) {
  if (!matches.length) return matches;
  const ids = matches.map((m) => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = all(
    `SELECT ms.match_id, s.platform, s.title, s.channel, s.url, s.viewers, s.captured_at
       FROM match_streams ms JOIN streams s ON s.id = ms.stream_id
      WHERE ms.match_id IN (${placeholders})
      ORDER BY ms.score DESC, s.viewers DESC`,
    ids,
  );
  const byMatch = new Map();
  for (const r of rows) {
    if (!byMatch.has(r.match_id)) byMatch.set(r.match_id, []);
    byMatch.get(r.match_id).push(r);
  }
  return matches.map((m) => ({ ...m, streams: byMatch.get(m.id) || [] }));
}

function listMatches(params, limit = 200) {
  const where = [];
  const values = [];
  if (params.status) {
    where.push('m.status = ?');
    values.push(params.status);
  }
  if (params.competition) {
    where.push('m.competition_id = ?');
    values.push(params.competition);
  }
  if (params.season) {
    where.push('m.season_id = ?');
    values.push(params.season);
  }
  if (params.team) {
    where.push('(m.home_team_id = ? OR m.away_team_id = ?)');
    values.push(params.team, params.team);
  }
  if (params.from) {
    where.push('m.kickoff_utc >= ?');
    values.push(params.from);
  }
  if (params.to) {
    where.push('m.kickoff_utc <= ?');
    values.push(params.to);
  }
  if (params.day) {
    where.push("substr(m.kickoff_utc, 1, 10) = ?");
    values.push(params.day);
  }
  if (params.withStreams === '1') {
    where.push('m.id IN (SELECT match_id FROM match_streams)');
  }
  const order = params.order === 'desc' ? 'DESC' : 'ASC';
  const sql = `${MATCH_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY m.kickoff_utc IS NULL, m.kickoff_utc ${order} LIMIT ?`;
  return decorate(all(sql, [...values, limit]));
}

/* ------------------------------- meta ------------------------------- */

app.get('/api/meta', (req, res) => {
  const meta = allMeta();
  res.json({
    generated_at: new Date().toISOString(),
    counts: {
      competitions: one('SELECT COUNT(*) n FROM competitions').n,
      seasons: one('SELECT COUNT(*) n FROM seasons').n,
      teams: one('SELECT COUNT(*) n FROM teams').n,
      players: one('SELECT COUNT(*) n FROM players').n,
      matches: one('SELECT COUNT(*) n FROM matches').n,
      lineups: one('SELECT COUNT(*) n FROM lineups').n,
      events: one('SELECT COUNT(*) n FROM match_events').n,
      stats: one('SELECT COUNT(*) n FROM match_stats').n,
      streams: one('SELECT COUNT(*) n FROM streams').n,
      match_streams: one('SELECT COUNT(*) n FROM match_streams').n,
    },
    sources: meta,
    refresh: refreshState(),
    db_populated: one('SELECT COUNT(*) n FROM matches').n > 0,
  });
});

/** Принудительное обновление трансляций и счёта (кнопка «обновить» в шапке). */
app.post('/api/refresh', (req, res) => {
  res.json(refreshNow({ reason: 'manual' }));
});

/* ------------------------------ overview ---------------------------- */

app.get('/api/overview', (req, res) => {
  const now = new Date().toISOString();
  const live = decorate(
    all(
      `${MATCH_SELECT}
        WHERE m.status = 'live'
           OR (m.home_score IS NULL AND m.kickoff_utc IS NOT NULL
               AND m.kickoff_utc <= datetime('now', '+3 hours')
               AND m.kickoff_utc >= datetime('now', '-3 hours'))
        ORDER BY m.kickoff_utc ASC LIMIT 40`,
    ),
  );
  const upcoming = listMatches(
    { from: new Date(Date.now() + 3 * 3600_000).toISOString(), to: new Date(Date.now() + 8 * 86400_000).toISOString() },
    60,
  );
  const featured = attachStreams(live).sort((a, b) => (b.streams.length - a.streams.length))[0]
    || attachStreams(
        decorate(
          all(
            `${MATCH_SELECT}
              WHERE m.kickoff_utc IS NOT NULL AND m.kickoff_utc <= datetime('now', '+24 hours')
                AND m.kickoff_utc >= datetime('now', '-6 hours')
                AND m.id IN (SELECT match_id FROM match_streams)
              ORDER BY m.kickoff_utc ASC LIMIT 5`,
          ),
        ),
      )[0] || null;

  const streams = all(
    `SELECT s.*, (SELECT COUNT(*) FROM match_streams ms WHERE ms.stream_id = s.id) AS matched
       FROM streams s ORDER BY s.viewers DESC, s.captured_at DESC LIMIT 40`,
  );

  const scorers = all(
    `SELECT p.name, p.nickname, t.name AS team_name, t.name_ru AS team_name_ru, t.id AS team_id,
            sc.goals, c.name_ru AS competition_name_ru, c.accent, sc.season_id, t.crest_url AS team_crest
       FROM scorers sc
       JOIN players p ON p.id = sc.player_id
       LEFT JOIN teams t ON t.id = sc.team_id
       JOIN competitions c ON c.id = sc.competition_id
      WHERE sc.goals > 0
      ORDER BY sc.goals DESC LIMIT 15`,
  );

  const competitions = all(
    `SELECT c.id, c.name, c.name_ru, c.country_ru, c.kind, c.accent, c.default_season_id,
            (SELECT COUNT(*) FROM matches m WHERE m.competition_id = c.id) AS matches
       FROM competitions c
      WHERE c.id IN (SELECT DISTINCT competition_id FROM matches WHERE kickoff_utc >= date('now', '-40 days'))
      ORDER BY c.tier ASC, c.name ASC`,
  );

  res.json({
    now,
    featured,
    live: attachStreams(live),
    upcoming: attachStreams(upcoming.slice(0, 24)),
    streams,
    scorers,
    competitions,
    sources: allMeta(),
  });
});

/* ------------------------------ matches ----------------------------- */

app.get('/api/matches', (req, res) => {
  const matches = listMatches(req.query, Math.min(Number(req.query.limit || 200), 500));
  res.json({ matches: attachStreams(matches) });
});

app.get('/api/matches/:id', (req, res) => {
  const match = one(`${MATCH_SELECT} WHERE m.id = ?`, [req.params.id]);
  if (!match) return res.status(404).json({ error: 'Матч не найден' });
  const [m] = decorate([match]);

  const events = all(
    `SELECT e.minute, e.type, e.team_id, e.detail, e.player_id,
            p.name AS player_name, rp.name AS related_player_name,
            t.name AS team_name, t.name_ru AS team_name_ru
       FROM match_events e
       LEFT JOIN players p ON p.id = e.player_id
       LEFT JOIN players rp ON rp.id = e.related_player_id
       LEFT JOIN teams t ON t.id = e.team_id
      WHERE e.match_id = ?
      ORDER BY e.minute ASC`,
    [m.id],
  );

  const lineups = all(
    `SELECT l.team_id, l.jersey, l.position, l.side, l.on_minute, l.off_minute,
            p.id AS player_id, p.name AS player_name, p.nickname, p.country,
            t.name AS team_name, t.name_ru AS team_name_ru, t.primary_color
       FROM lineups l
       JOIN players p ON p.id = l.player_id
       JOIN teams t ON t.id = l.team_id
      WHERE l.match_id = ?
      ORDER BY l.team_id, l.side DESC, l.jersey ASC`,
    [m.id],
  );

  const stats = all(
    `SELECT team_id, stat, value FROM match_stats WHERE match_id = ? ORDER BY stat`,
    [m.id],
  );

  const streams = all(
    `SELECT s.*, ms.score, ms.method
       FROM match_streams ms JOIN streams s ON s.id = ms.stream_id
      WHERE ms.match_id = ? ORDER BY ms.score DESC, s.viewers DESC`,
    [m.id],
  );

  const headToHead = all(
    `${MATCH_SELECT}
      WHERE m.id != ? AND m.status = 'finished'
        AND ((m.home_team_id = ? AND m.away_team_id = ?) OR (m.home_team_id = ? AND m.away_team_id = ?))
      ORDER BY m.kickoff_utc DESC LIMIT 8`,
    [m.id, m.home_id, m.away_id, m.away_id, m.home_id],
  );

  res.json({ match: m, events, lineups, stats, streams, headToHead: decorate(headToHead) });
});

/* --------------------------- competitions --------------------------- */

app.get('/api/competitions', (req, res) => {
  const rows = all(
    `SELECT c.id, c.name, c.name_ru, c.country, c.country_ru, c.kind, c.tier, c.accent, c.default_season_id,
            COUNT(m.id) AS matches,
            SUM(CASE WHEN m.status = 'finished' THEN 1 ELSE 0 END) AS played,
            MAX(m.kickoff_utc) AS last_match,
            MIN(CASE WHEN m.home_score IS NULL THEN m.kickoff_utc END) AS next_match
       FROM competitions c
       LEFT JOIN matches m ON m.competition_id = c.id
      GROUP BY c.id
      HAVING matches > 0
      ORDER BY c.tier ASC, c.kind ASC, c.name_ru ASC`,
  );
  res.json({ competitions: rows });
});

app.get('/api/competitions/:id', (req, res) => {
  const c = one('SELECT * FROM competitions WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Турнир не найден' });
  const seasons = all(
    `SELECT s.id, s.name, s.label_ru,
            COUNT(m.id) AS matches,
            SUM(CASE WHEN m.status = 'finished' THEN 1 ELSE 0 END) AS played,
            MAX(m.kickoff_utc) AS last_match
       FROM seasons s LEFT JOIN matches m ON m.season_id = s.id
      WHERE s.competition_id = ? GROUP BY s.id ORDER BY s.name DESC`,
    [c.id],
  );
  const seasonId = req.query.season || seasons.find((s) => s.played > 0)?.id || seasons[0]?.id;

  const standings = seasonId
    ? all(
        `SELECT st.position, st.played, st.won, st.drawn, st.lost, st.goals_for, st.goals_against,
                st.goal_diff, st.points, t.id AS team_id, t.name AS team_name, t.name_ru AS team_name_ru,
                t.short_name AS team_short, t.primary_color, t.crest_url
           FROM standings st JOIN teams t ON t.id = st.team_id
          WHERE st.season_id = ? ORDER BY st.position ASC`,
        [seasonId],
      )
    : [];

  const scorers = seasonId
    ? all(
        `SELECT p.name, p.nickname, sc.goals, sc.assists, t.name AS team_name, t.name_ru AS team_name_ru, t.id AS team_id
           FROM scorers sc JOIN players p ON p.id = sc.player_id
           LEFT JOIN teams t ON t.id = sc.team_id
          WHERE sc.season_id = ? AND sc.goals > 0
          ORDER BY sc.goals DESC LIMIT 20`,
        [seasonId],
      )
    : [];

  const rounds = seasonId
    ? all(
        `SELECT COALESCE(m.round, 'Без тура') AS round, MIN(m.kickoff_utc) AS first_kickoff, COUNT(*) AS n
           FROM matches m WHERE m.season_id = ? GROUP BY m.round ORDER BY MIN(m.kickoff_utc)`,
        [seasonId],
      )
    : [];

  const matches = seasonId
    ? attachStreams(listMatches({ season: seasonId }, 500))
    : [];

  res.json({ competition: c, seasons, seasonId, standings, scorers, rounds, matches });
});

/* ------------------------------- teams ------------------------------ */

app.get('/api/teams/:id', (req, res) => {
  const team = one('SELECT * FROM teams WHERE id = ?', [req.params.id]);
  if (!team) return res.status(404).json({ error: 'Команда не найдена' });
  const upcoming = attachStreams(listMatches({ team: team.id, from: new Date().toISOString() }, 15));
  const results = attachStreams(listMatches({ team: team.id, to: new Date().toISOString(), order: 'desc' }, 15));
  const squad = all(
    `SELECT DISTINCT p.id, p.name, p.nickname, p.position, p.country
       FROM lineups l JOIN players p ON p.id = l.player_id
      WHERE l.team_id = ? ORDER BY p.position, p.name LIMIT 60`,
    [team.id],
  );
  res.json({ team, upcoming, results, squad });
});

/* ------------------------------ streams ----------------------------- */

app.get('/api/streams', (req, res) => {
  const where = [];
  const values = [];
  if (req.query.platform) {
    where.push('s.platform = ?');
    values.push(req.query.platform);
  }
  if (req.query.matched === '1') where.push('ms.match_id IS NOT NULL');
  const rows = all(
    `SELECT s.*, ms.match_id, ms.score, m.kickoff_utc, m.home_score, m.away_score, m.status AS match_status,
            th.name_ru AS home_name_ru, th.name AS home_name, th.short_name AS home_short,
            ta.name_ru AS away_name_ru, ta.name AS away_name, ta.short_name AS away_short,
            c.name_ru AS competition_name_ru, c.accent
       FROM streams s
       LEFT JOIN match_streams ms ON ms.stream_id = s.id
       LEFT JOIN matches m ON m.id = ms.match_id
       LEFT JOIN teams th ON th.id = m.home_team_id
       LEFT JOIN teams ta ON ta.id = m.away_team_id
       LEFT JOIN competitions c ON c.id = m.competition_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.viewers DESC, s.captured_at DESC
      LIMIT 200`,
    values,
  );
  const grouped = new Map();
  for (const r of rows) {
    const base = grouped.get(r.id) || { ...r, matches: [] };
    if (r.match_id) {
      base.matches.push({
        match_id: r.match_id,
        kickoff_utc: r.kickoff_utc,
        home_score: r.home_score,
        away_score: r.away_score,
        status: r.match_status,
        home: r.home_name_ru || r.home_name,
        home_short: r.home_short,
        away: r.away_name_ru || r.away_name,
        away_short: r.away_short,
        competition: r.competition_name_ru,
        accent: r.accent,
      });
    }
    grouped.set(r.id, base);
  }
  res.json({
    streams: [...grouped.values()],
    captured_at: one('SELECT MAX(captured_at) t FROM streams')?.t || null,
    sources: allMeta(),
  });
});

/* ------------------------------- health ----------------------------- */

app.get('/api/health', (req, res) => {
  res.json({ ok: true, matches: one('SELECT COUNT(*) n FROM matches').n });
});

/* ------------------------------- static ----------------------------- */

if (fs.existsSync(DIST)) {
  app.use(express.static(DIST, { index: false }));
  app.get('*', (req, res) => res.sendFile(path.join(DIST, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res
      .type('text/plain; charset=utf-8')
      .send('Фронтенд не собран. Выполните: npm run build\nAPI доступен на /api/meta'),
  );
}

export { app };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  app.listen(PORT, HOST, () => {
    const meta = allMeta();
    console.log(`ФУТБОЛ.TV → http://${HOST}:${PORT}`);
    console.log(`  матчей в базе: ${one('SELECT COUNT(*) n FROM matches').n}`);
    console.log(`  трансляций:    ${one('SELECT COUNT(*) n FROM streams').n} (снимок: ${meta['ingest.streams'] || '—'})`);
    if (!fs.existsSync(DIST)) console.log('  фронтенд не собран — выполните npm run build');
    const minutes = Number(process.env.REFRESH_MINUTES || 10);
    if (minutes > 0) startAutoRefresh({ minutes });
  });
}
