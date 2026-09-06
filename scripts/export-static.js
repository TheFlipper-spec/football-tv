#!/usr/bin/env node
/**
 * Экспорт статического снимка API в dist/data/.
 *
 * GitHub Pages умеет отдавать только файлы: ни Node, ни SQLite там не запустить.
 * Чтобы сайт работал на Pages *полностью*, этот скрипт поднимает настоящий
 * сервер в том же процессе, обходит его реальные роуты и раскладывает ответы
 * по JSON-файлам. Формы ответов при этом не переписываются заново — снимок
 * побайтово такой же, как живой API, и не может с ним разъехаться.
 *
 * Что попадает в снимок (и почему именно это):
 *   match        все матчи за последние 90 дней и на 30 дней вперёд,
 *                плюс каждый матч с трансляцией и каждый матч с протоколом.
 *                Остальные ~114 тысячи исторических матчей openfootball лежат
 *                в базе, но в снимок не выгружаются — их страницы честно
 *                говорят «матч не вошёл в снимок» вместо подделки данных.
 *   competition  каждый турнир и каждый его сезон (таблица, бомбардиры, туры).
 *   team         каждая команда, встречающаяся в выгруженных матчах.
 *   overview / meta / competitions / streams — по одному файлу.
 *
 * Использование: npm run export:static   (после npm run build)
 *   --base=/football-tv/   базовый путь сайта (нужен для 404.html)
 */
import fs from 'node:fs';
import path from 'node:path';
import { app } from '../server/index.js';
import { getDb, ROOT } from '../server/db.js';
import { staticKey, competitionKey } from '../lib/staticKey.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = arg('base', '/');
const OUT = path.join(ROOT, 'dist', 'data');
const WINDOW_BACK_DAYS = 90;
const WINDOW_FWD_DAYS = 30;

/* ------------------------------ утилиты ------------------------------ */

const log = (...a) => console.log(...a);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Пишет JSON и возвращает его размер — размеры потом суммируются в отчёте. */
function writeJson(rel, payload) {
  const file = path.join(OUT, `${rel}.json`);
  ensureDir(path.dirname(file));
  const text = JSON.stringify(payload);
  fs.writeFileSync(file, text);
  return Buffer.byteLength(text);
}

/** Ограниченный параллелизм: localhost быстрый, но 1000 одновременных запросов — нет. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------- запуск ------------------------------ */

const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function get(route) {
  const res = await fetch(`${origin}${route}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${route} → ${res.status} ${res.statusText}`);
  return res.json();
}

const db = getDb();
const startedAt = Date.now();
const keys = new Map(); // ключ файла → исходный id; ловим коллизии хеша
let bytes = 0;
let files = 0;

function claim(rel, id) {
  const prev = keys.get(rel);
  if (prev !== undefined && prev !== id) {
    throw new Error(`Коллизия ключа снимка: ${rel} требуется и для «${prev}», и для «${id}»`);
  }
  keys.set(rel, id);
  return rel;
}

log('Экспорт статического снимка API');
log(`  сервер:  ${origin}`);
log(`  каталог: ${path.relative(ROOT, OUT)}/`);
ensureDir(OUT);
fs.rmSync(OUT, { recursive: true, force: true });
ensureDir(OUT);

/* --- одиночные файлы ------------------------------------------------- */

const meta = await get('/api/meta');
const overview = await get('/api/overview');
const competitionsList = await get('/api/competitions');
const streams = await get('/api/streams');

bytes += writeJson('meta', meta);
bytes += writeJson('overview', overview);
bytes += writeJson('competitions', competitionsList);
bytes += writeJson('streams', streams);
files += 4;
log(`  одиночные: meta, overview, competitions (${competitionsList.competitions.length}), streams (${streams.streams.length})`);

/* --- матчи ----------------------------------------------------------- */

const matchIds = db
  .prepare(
    `SELECT id FROM (
       SELECT id, kickoff_utc FROM matches
        WHERE date(kickoff_utc) BETWEEN date('now', ?) AND date('now', ?)
       UNION
       SELECT match_id AS id, NULL AS kickoff_utc FROM match_streams
       UNION
       SELECT id, kickoff_utc FROM matches
        WHERE has_lineups = 1 OR has_stats = 1 OR has_events = 1
     )`,
  )
  .all(`-${WINDOW_BACK_DAYS} days`, `+${WINDOW_FWD_DAYS} days`)
  .map((r) => r.id);

log(`  матчей в снимке: ${matchIds.length} (окно −${WINDOW_BACK_DAYS}/+${WINDOW_FWD_DAYS} дней, трансляции, протоколы)`);

const indexRows = [];
let missing = 0;

await mapLimit(matchIds, 8, async (id) => {
  const res = await fetch(`${origin}/api/matches/${encodeURIComponent(id)}`);
  if (res.status === 404) {
    missing += 1;
    return;
  }
  if (!res.ok) throw new Error(`/api/matches/${id} → ${res.status}`);
  const detail = await res.json();
  const rel = claim(staticKey('match', id), id);
  bytes += writeJson(rel, detail);
  files += 1;
  indexRows.push({ ...detail.match, streams: detail.streams || [] });
});

indexRows.sort((a, b) => String(b.kickoff_utc || '').localeCompare(String(a.kickoff_utc || '')));
bytes += writeJson('matches-index', {
  generated_at: new Date().toISOString(),
  window: { back_days: WINDOW_BACK_DAYS, forward_days: WINDOW_FWD_DAYS },
  matches: indexRows,
});
files += 1;
log(`  индекс матчей: ${indexRows.length} строк${missing ? ` (не найдено: ${missing})` : ''}`);

/* --- турниры и сезоны ------------------------------------------------ */

let compFiles = 0;
for (const c of competitionsList.competitions) {
  const base = await get(`/api/competitions/${encodeURIComponent(c.id)}`);
  bytes += writeJson(claim(competitionKey(c.id), c.id), base);
  files += 1;
  compFiles += 1;
  for (const s of base.seasons || []) {
    if (!s.id || s.id === base.seasonId) continue;
    const seasonPayload = await get(`/api/competitions/${encodeURIComponent(c.id)}?season=${encodeURIComponent(s.id)}`);
    bytes += writeJson(claim(competitionKey(c.id, s.id), `${c.id}@${s.id}`), seasonPayload);
    files += 1;
    compFiles += 1;
  }
}
log(`  турниров и сезонов: ${compFiles}`);

/* --- команды --------------------------------------------------------- */

const teamIds = [...new Set(indexRows.flatMap((m) => [m.home_id, m.away_id]).filter(Boolean))].sort();
let teamFiles = 0;
await mapLimit(teamIds, 8, async (id) => {
  const res = await fetch(`${origin}/api/teams/${encodeURIComponent(id)}`);
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`/api/teams/${id} → ${res.status}`);
  bytes += writeJson(claim(staticKey('team', id), id), await res.json());
  files += 1;
  teamFiles += 1;
});
log(`  команд: ${teamFiles}`);

/* --- манифест и 404.html -------------------------------------------- */

const manifest = {
  generated_at: new Date().toISOString(),
  mode: 'static',
  matches: indexRows.length,
  competitions: compFiles,
  teams: teamFiles,
  streams: streams.streams.length,
  window: { back_days: WINDOW_BACK_DAYS, forward_days: WINDOW_FWD_DAYS },
  total_matches_in_db: db.prepare('SELECT COUNT(*) n FROM matches').get().n,
  source_snapshot: meta.counts || null,
};
bytes += writeJson('manifest', manifest);
files += 1;

/*
 * HashRouter ведёт сайт по адресу /#/match/…, но красивую ссылку вида
 * /football-tv/matches кто-нибудь да вставит. GitHub Pages на любой неизвестный
 * путь отдаёт 404.html — пусть он перенаправляет путь в хеш, тогда работают
 * оба вида ссылок.
 */
const dist404 = path.join(ROOT, 'dist', '404.html');
fs.writeFileSync(
  dist404,
  `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <title>⚽ ФУТБОЛ.TV</title>
    <script>
      (function () {
        var base = ${JSON.stringify(BASE.endsWith('/') ? BASE : `${BASE}/`)};
        var p = window.location.pathname;
        if (p.indexOf(base) === 0) p = p.slice(base.length - 1);
        if (!p || p === '/') p = '/';
        window.location.replace(base + '#' + p);
      })();
    </script>
  </head>
  <body>
    <p>Перенаправляем на <a id="l" href="${BASE}">ФУТБОЛ.TV</a>…</p>
  </body>
</html>
`,
);

server.close();

const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
log(`Готово: ${files} файлов, ${(bytes / 1024 / 1024).toFixed(1)} МБ за ${secs} с`);
if (missing) log(`  предупреждение: ${missing} матчей из выборки сервер не отдал`);
