#!/usr/bin/env node
/**
 * Единая точка инжеста.
 *
 *   npm run ingest                 — всё
 *   npm run ingest -- --only=openfootball
 *   npm run ingest -- --only=statsbomb
 *   npm run ingest -- --only=streams
 *   npm run ingest -- --only=espn
 *   npm run ingest -- --no-live    — не ходить в сеть за трансляциями (только снимки)
 *   npm run ingest -- --no-events  — не тянуть события StatsBomb (быстрее)
 *
 * Источники (все реальные, открытые):
 *   • openfootball  — github.com/openfootball  (календарь, результаты, туры)
 *   • StatsBomb     — github.com/statsbomb/open-data (составы, события, статистика)
 *   • VK Видео Live — live.vkvideo.ru (прямые трансляции)
 *   • OK Видео      — ok.ru/video/live (прямые эфиры)
 *   • ESPN Site API — site.api.espn.com (живой счёт и минута)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDb, tableCount, allMeta } from '../server/db.js';
import { ingestOpenfootball } from './openfootball.js';
import { ingestStatsbomb } from './statsbomb.js';
import { ingestStreams, rebuildMatchStreams } from './streams.js';
import { ingestEspn } from './espn.js';
import { buildStandings } from './standings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const SNAPSHOTS = path.join(ROOT, 'data', 'snapshots');

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : null;
const noLive = args.includes('--no-live');
const noEvents = args.includes('--no-events');
const skipClone = args.includes('--no-clone');

const log = (...a) => console.log(...a);
const step = (name) => log(`\n▸ ${name}`);

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000 });
}

function ensureRepo(dir, url, { blobless = false, sparse = null } = {}) {
  if (fs.existsSync(path.join(dir, '.git'))) {
    log(`  кэш найден: ${path.basename(dir)}`);
    return dir;
  }
  fs.mkdirSync(CACHE, { recursive: true });
  log(`  клонирую ${url} → ${path.basename(dir)}`);
  const cloneArgs = ['clone'];
  if (blobless) cloneArgs.push('--filter=blob:none', '--no-checkout');
  else cloneArgs.push('--depth', '1');
  cloneArgs.push(url, dir);
  git(cloneArgs, CACHE);
  if (sparse) {
    git(['sparse-checkout', 'init', '--cone'], dir);
    git(['sparse-checkout', 'set', ...sparse], dir);
    git(['checkout'], dir);
  }
  return dir;
}

function summary() {
  const db = getDb();
  const counts = {
    турниров: tableCount('competitions'),
    сезонов: tableCount('seasons'),
    команд: tableCount('teams'),
    игроков: tableCount('players'),
    матчей: tableCount('matches'),
    составов: tableCount('lineups'),
    событий: tableCount('match_events'),
    статистики: tableCount('match_stats'),
    бомбардиров: tableCount('scorers'),
    таблиц: tableCount('standings'),
    трансляций: tableCount('streams'),
    связей_матч_трансляция: tableCount('match_streams'),
  };
  log('\n— База данных —');
  for (const [k, v] of Object.entries(counts)) log(`  ${k.padEnd(26)} ${v}`);
  log(`\n  файл: ${db ? process.env.FOOTBALL_DB || path.join(ROOT, 'data', 'football.db') : '?'}`);
  const meta = allMeta();
  log(`  снимок трансляций: ${meta['ingest.streams'] || '—'} (${meta['ingest.streams.mode'] || '—'})`);
  log(`  ESPN live:         ${meta['ingest.espn'] || 'нет (нет исходящего интернета)'}`);
}

const started = Date.now();
log('ФУТБОЛ.TV — инжест реальных данных');

try {
  if (!only || only === 'openfootball') {
    step('openfootball (календарь и результаты)');
    if (!skipClone) {
      ensureRepo(path.join(CACHE, 'openfootball-json'), 'https://github.com/openfootball/football.json.git');
      ensureRepo(path.join(CACHE, 'openfootball-europe'), 'https://github.com/openfootball/europe.git');
    }
    ingestOpenfootball({ cacheDir: CACHE, log });
  }

  if (!only || only === 'statsbomb') {
    step('StatsBomb (составы, события, статистика)');
    if (!skipClone) {
      ensureRepo(path.join(CACHE, 'statsbomb'), 'https://github.com/statsbomb/open-data.git', {
        blobless: true,
        sparse: ['data/lineups', 'data/matches', 'data/competitions.json'],
      });
    }
    ingestStatsbomb({ cacheDir: CACHE, log, withEvents: !noEvents });
  }

  if (!only) {
    step('Турнирные таблицы');
    buildStandings({ log });
  }

  if (!only || only === 'streams') {
    step('Трансляции (VK Видео Live, OK Видео)');
    ingestStreams({ snapshotsDir: SNAPSHOTS, live: !noLive, log });
  }

  if (!only || only === 'espn') {
    step('ESPN live (текущий счёт и минута)');
    ingestEspn({ log, snapshotsDir: SNAPSHOTS, live: !noLive });
    rebuildMatchStreams({ log });
  }

  if (!only) {
    step('Пересборка связей трансляций');
    rebuildMatchStreams({ log });
  }

  summary();
  log(`\nГотово за ${((Date.now() - started) / 1000).toFixed(1)} с`);
} catch (err) {
  console.error('\nОшибка инжеста:', err.message);
  if (process.env.DEBUG) console.error(err);
  process.exitCode = 1;
}
