/**
 * Единая точка доступа к данным.
 *
 * Сначала пробуем живой API (Express + SQLite). Если его нет — а на GitHub
 * Pages его нет физически, там только статические файлы, — переключаемся на
 * снимок из dist/data/, который собрал `npm run export:static`. Страницы об
 * этом не знают: формы ответов одинаковые.
 *
 * Режим определяется один раз по GET /api/health и дальше кешируется.
 */
import { staticApi } from './staticApi.js';

/** 0 = ещё не проверяли, 'live' | 'static' */
let mode = 0;

async function detect() {
  if (mode) return mode;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const res = await fetch('/api/health', {
      headers: { accept: 'application/json' },
      signal: ctl.signal,
      cache: 'no-store',
    });
    const type = res.headers.get('content-type') || '';
    mode = res.ok && type.includes('json') ? 'live' : 'static';
  } catch {
    mode = 'static';
  } finally {
    clearTimeout(timer);
  }
  return mode;
}

async function live(path, options) {
  const res = await fetch(`/api${path}`, { headers: { accept: 'application/json' }, ...options });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/** Вызывает живой роут или его статический двойник. */
async function call(name, path, ...staticArgs) {
  const m = await detect();
  if (m === 'live') return live(path);
  return staticApi[name](...staticArgs);
}

export const api = {
  /** 'live' — работает сервер, 'static' — сайт открыт как набор файлов. */
  mode: () => detect(),

  overview: () => call('overview', '/overview'),
  meta: () => call('meta', '/meta'),
  matches: (params = {}) => call('matches', `/matches?${new URLSearchParams(params)}`, params),
  match: (id) => call('match', `/matches/${encodeURIComponent(id)}`, id),
  competitions: () => call('competitions', '/competitions'),
  competition: (id, season) =>
    call(
      'competition',
      `/competitions/${encodeURIComponent(id)}${season ? `?season=${encodeURIComponent(season)}` : ''}`,
      id,
      season,
    ),
  team: (id) => call('team', `/teams/${encodeURIComponent(id)}`, id),
  streams: (params = {}) => call('streams', `/streams?${new URLSearchParams(params)}`, params),

  /**
   * Перезапуск сбора трансляций и счёта.
   * На живом сервере дёргает POST /api/refresh; в статическом снимке сервера
   * нет — данные обновляет сборка сайта, поэтому здесь только сброс кеша.
   */
  refresh: async () => {
    const m = await detect();
    if (m !== 'live') {
      staticApi.invalidate();
      return { mode: 'static' };
    }
    const res = await fetch('/api/refresh', { method: 'POST' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
};
