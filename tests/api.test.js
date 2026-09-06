import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// База для теста — отдельный временный файл, чтобы не трогать рабочую.
const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'footballtv-')), 'test.db');
process.env.FOOTBALL_DB = tmpDb;

const { getDb, setMeta } = await import('../server/db.js');
const { upsertCompetition, upsertSeason } = await import('../ingest/openfootball.js');
const { upsertTeam } = await import('../ingest/teams.js');
const { rebuildMatchStreams } = await import('../ingest/streams.js');
const { buildStandings } = await import('../ingest/standings.js');
const { zonedToUtcIso } = await import('../lib/time.js');

function seed() {
  const db = getDb();
  upsertCompetition('en.1', {
    name: 'Premier League', ru: 'Английская Премьер-лига', country: 'England',
    countryRu: 'Англия', tz: 'Europe/London', tier: 1, accent: '#3d195b',
  }, '2026/27');
  const seasonId = upsertSeason('en.1', '2026-27', 'English Premier League 2026/27');
  const competitionId = 'openfootball:en.1';
  const everton = upsertTeam('Everton FC');
  const manutd = upsertTeam('Manchester United FC');
  const liverpool = upsertTeam('Liverpool FC');
  const chelsea = upsertTeam('Chelsea FC');

  const insertMatch = db.prepare(
    `INSERT INTO matches (id, competition_id, season_id, round, matchday, kickoff_utc, kickoff_local, timezone,
        status, home_team_id, away_team_id, home_score, away_score, source, source_match_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Матч в эфире: старт час назад, счёт уже есть.
  insertMatch.run(
    'openfootball:en.1:2026-27:2026-09-06:everton-manchester-united',
    competitionId, seasonId, 'Matchday 3', 3,
    new Date(Date.now() - 3600_000).toISOString(),
    '2026-09-06 14:00', 'Europe/London', 'live',
    everton, manutd, 1, 0, 'openfootball', 'en.1/2026-27/2026-09-06/Everton-ManUtd',
    new Date().toISOString(),
  );

  // Сыгранный матч — по нему считается турнирная таблица.
  insertMatch.run(
    'openfootball:en.1:2026-27:2026-08-30:liverpool-chelsea',
    competitionId, seasonId, 'Matchday 2', 2,
    '2026-08-30T13:00:00.000Z',
    '2026-08-30 14:00', 'Europe/London', 'finished',
    liverpool, chelsea, 2, 1, 'openfootball', 'en.1/2026-27/2026-08-30/Liverpool-Chelsea',
    new Date().toISOString(),
  );

  db.prepare(
    `INSERT INTO streams (id, platform, category, title, channel, url, viewers, is_live, captured_at)
     VALUES ('vk:test', 'vk', 'Футбол', ?, 'ManUtdOne', 'https://live.vkvideo.ru/manutdone/stream/sl_234432', 908, 1, ?)`,
  ).run('Эвертон – Манчестер Юнайтед | ПРЯМАЯ ТРАНСЛЯЦИЯ | АПЛ', new Date().toISOString());

  rebuildMatchStreams({ log: () => {} });
  buildStandings({ log: () => {} });
  setMeta('ingest.streams.mode', 'snapshot');
}

seed();

const { app } = await import('../server/index.js');
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const json = async (p) => (await fetch(base + p)).json();

test('GET /api/meta отдаёт реальное состояние базы', async () => {
  const meta = await json('/api/meta');
  assert.equal(meta.db_populated, true);
  assert.equal(meta.counts.matches, 2);
  assert.equal(meta.counts.teams, 4);
  assert.equal(meta.counts.streams, 1);
});

test('GET /api/matches возвращает матчи с командами и привязанной трансляцией', async () => {
  const { matches } = await json('/api/matches');
  assert.equal(matches.length, 2);
  const m = matches.find((x) => x.home_name_ru === 'Эвертон');
  assert.equal(m.away_name_ru, 'Манчестер Юнайтед');
  assert.equal(m.status, 'live', 'матч со счётом, но идущий, остаётся live');
  assert.equal(m.home_score, 1);
  assert.equal(m.streams.length, 1);
  assert.equal(m.streams[0].platform, 'vk');

  const played = matches.find((x) => x.home_name_ru === 'Ливерпуль');
  assert.equal(played.status, 'finished');
});

test('GET /api/matches/:id отдаёт состав, события и трансляции', async () => {
  const data = await json('/api/matches/openfootball:en.1:2026-27:2026-09-06:everton-manchester-united');
  assert.equal(data.match.home_name_ru, 'Эвертон');
  assert.equal(data.streams.length, 1);
  assert.deepEqual(data.lineups, []);
  assert.deepEqual(data.events, []);
});

test('GET /api/streams группирует трансляции по привязанным матчам', async () => {
  const data = await json('/api/streams');
  assert.equal(data.streams.length, 1);
  assert.equal(data.streams[0].matches.length, 1);
  assert.equal(data.streams[0].matches[0].home, 'Эвертон');
  assert.equal(data.sources['ingest.streams.mode'], 'snapshot');
});

test('GET /api/competitions/:id считает таблицу по сыгранным матчам', async () => {
  const data = await json('/api/competitions/openfootball:en.1');
  assert.equal(data.competition.name_ru, 'Английская Премьер-лига');
  assert.equal(data.standings.length, 2, 'в таблицу попадают только сыгранные матчи');
  assert.equal(data.standings[0].team_name_ru, 'Ливерпуль');
  assert.equal(data.standings[0].points, 3);
  assert.equal(data.standings[1].team_name_ru, 'Челси');
  assert.equal(data.standings[1].points, 0);
  assert.equal(data.standings[0].goals_for, 2);
  assert.equal(data.standings[0].goals_against, 1);
});

test('GET /api/health отвечает ok', async () => {
  const h = await json('/api/health');
  assert.equal(h.ok, true);
  assert.equal(h.matches, 2);
});

test('завершение', () => {
  server.close();
  fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
});
