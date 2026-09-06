/**
 * Автообновление трансляций и расписания.
 *
 * Сервер держит базу в SQLite и по таймеру заново обходит источники:
 *   • VK Видео Live и OK Видео — список прямых эфиров;
 *   • ESPN Site API            — счёт и минута идущих матчей.
 * Каждый успешный проход перезаписывает снимок в data/snapshots/, поэтому даже
 * если сеть пропала, следующие запуски берут последний реальный снимок.
 *
 * Расписание матчей — это не «зашитые в код» игры: оно приходит из openfootball
 * (115 тысяч матчей в базе), а текущие игры поверх обновляет ESPN.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestStreams, rebuildMatchStreams } from '../ingest/streams.js';
import { ingestEspn } from '../ingest/espn.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOTS = path.join(ROOT, 'data', 'snapshots');

const state = {
  running: false,
  runs: 0,
  started_at: new Date().toISOString(),
  last_run: null,
  last_ms: null,
  last_error: null,
  streams_mode: null,
  espn_mode: null,
  streams: 0,
  matched: 0,
  interval_minutes: null,
};

export const refreshState = () => ({ ...state });

/** Один проход обновления. Синхронный — инжест сам ходит в сеть. */
export function refreshNow({ reason = 'manual', log = () => {} } = {}) {
  if (state.running) return { ...state, skipped: true };
  state.running = true;
  const started = Date.now();
  const quiet = () => {};
  try {
    const streams = ingestStreams({ snapshotsDir: SNAPSHOTS, live: true, log: quiet });
    const espn = ingestEspn({ snapshotsDir: SNAPSHOTS, live: true, log: quiet });
    const links = rebuildMatchStreams({ log: quiet });
    state.runs += 1;
    state.last_run = new Date().toISOString();
    state.last_ms = Date.now() - started;
    state.last_error = null;
    state.streams_mode = streams?.mode ?? null;
    state.espn_mode = espn?.mode ?? null;
    state.streams = streams?.total ?? 0;
    state.matched = links?.matched ?? 0;
    log(`  [refresh:${reason}] трансляций ${state.streams} (${state.streams_mode}), связей ${state.matched}, за ${state.last_ms} мс`);
  } catch (err) {
    state.last_error = String(err.message || err);
    state.last_run = new Date().toISOString();
    log(`  [refresh:${reason}] ошибка: ${state.last_error}`);
  } finally {
    state.running = false;
  }
  return { ...state };
}

/** Таймер фонового обновления. Возвращает функцию остановки. */
export function startAutoRefresh({ minutes = 10, log = console.log } = {}) {
  state.interval_minutes = minutes;
  const everyMs = Math.max(1, minutes) * 60_000;
  const timer = setInterval(() => refreshNow({ reason: 'timer', log }), everyMs);
  timer.unref?.();
  log(`  автообновление: каждые ${minutes} мин (VK/OK + ESPN)`);
  return () => clearInterval(timer);
}
