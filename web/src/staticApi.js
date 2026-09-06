/**
 * Статический снимок API — то, чем сайт живёт на GitHub Pages.
 *
 * Pages отдаёт только файлы: ни Express, ни SQLite там нет. Поэтому
 * `npm run export:static` раскладывает ответы настоящего сервера по JSON-файлам
 * в `dist/data/`, а этот модуль читает их и повторяет поведение серверных роутов
 * (фильтры, сортировку, лимиты) на клиенте. Формы ответов совпадают с живым API,
 * так что страницы не знают, откуда пришли данные.
 *
 * Имена файлов считает lib/staticKey.js — тот же модуль, что и у экспортера.
 */
import { staticKey, competitionKey } from '../../lib/staticKey.js';
import { minuteFromKickoff } from '../../lib/time.js';

/**
 * Каталог, откуда читать снимок. В сборке Vite база известна из
 * import.meta.env.BASE_URL (для Pages это /football-tv/). Вне Vite — например,
 * когда смоук-тест бандлит приложение esbuild'ом, — берём каталог из адреса
 * страницы: с HashRouter путь при переходах не меняется, так что база стабильна.
 */
function detectBase() {
  const env = import.meta.env?.BASE_URL;
  if (env) return env.endsWith('/') ? env : `${env}/`;
  const pathname = typeof window !== 'undefined' && window.location ? window.location.pathname : '/';
  const cut = pathname.lastIndexOf('/');
  return cut >= 0 ? pathname.slice(0, cut + 1) : '/';
}

const DATA = `${detectBase()}data/`;

const cache = new Map();

/** Читает файл снимка. Кэш по пути: одна и та же страница опрашивается повторно. */
async function load(rel) {
  if (cache.has(rel)) return cache.get(rel);
  const pending = (async () => {
    const res = await fetch(`${DATA}${rel}.json`, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      const err = new Error(`${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    // Pages на отсутствующий путь может отдать HTML-заглушку со статусом 200 —
    // тогда это не данные, а ошибка.
    const type = res.headers.get('content-type') || '';
    if (!type.includes('json')) {
      const err = new Error('В снимке нет такого файла');
      err.status = 404;
      throw err;
    }
    return res.json();
  })();
  cache.set(rel, pending);
  try {
    return await pending;
  } catch (err) {
    cache.delete(rel);
    throw err;
  }
}

/**
 * Статус матча пересчитывается по времени открытия страницы — те же правила,
 * что в server/index.js:decorate. Без этого матч, который на момент экспорта
 * ещё не начался, навсегда остался бы «запланирован».
 */
function decorate(m, now = Date.now()) {
  const start = m.kickoff_utc ? Date.parse(m.kickoff_utc) : null;
  const validStart = Boolean(start) && !Number.isNaN(start);
  const hasScore = m.home_score != null && m.away_score != null;
  let status = m.status;
  let minute = m.minute;

  if (status === 'live' && validStart && now - start > 165 * 60_000) status = 'finished';
  else if (status !== 'live' && hasScore) status = 'finished';
  else if (status !== 'live' && !hasScore && validStart) {
    const fullTime = start + 125 * 60_000;
    if (now >= start && now < fullTime) status = 'live';
  }

  // Те же правила минуты, что в server/index.js: минута есть только у live,
  // а «настенное» время пересчитывается в игровое с учётом 15-минутного перерыва.
  if (status !== 'live') minute = null;
  else if (minute == null || minute > 120) minute = minuteFromKickoff(m.kickoff_utc, now);

  return status === m.status && minute === m.minute ? m : { ...m, status, minute };
}

/** Повторяет WHERE/ORDER BY/LIMIT из server/index.js:listMatches. */
function listMatches(rows, params = {}, now = Date.now()) {
  const from = params.from || null;
  const to = params.to || null;
  const filtered = rows.filter((raw) => {
    const m = decorate(raw, now);
    if (params.status && m.status !== params.status) return false;
    if (params.competition && m.competition_id !== params.competition) return false;
    if (params.season && m.season_id !== params.season) return false;
    if (params.team && m.home_id !== params.team && m.away_id !== params.team) return false;
    if (from && (!m.kickoff_utc || m.kickoff_utc < from)) return false;
    if (to && (!m.kickoff_utc || m.kickoff_utc > to)) return false;
    if (params.day && (m.kickoff_utc || '').slice(0, 10) !== params.day) return false;
    if (params.withStreams === '1' && !(m.streams || []).length) return false;
    if (params.withDepth === '1' && !m.has_lineups && !m.has_stats && !m.has_events) return false;
    return true;
  });

  const dir = params.order === 'desc' ? -1 : 1;
  filtered.sort((a, b) => {
    // ORDER BY kickoff_utc IS NULL, kickoff_utc ASC|DESC — матчи без даты в конце
    const an = a.kickoff_utc ? 0 : 1;
    const bn = b.kickoff_utc ? 0 : 1;
    if (an !== bn) return an - bn;
    return dir * String(a.kickoff_utc || '').localeCompare(String(b.kickoff_utc || ''));
  });

  const limit = Math.min(Number(params.limit || 200), 500);
  return filtered.slice(0, limit).map((m) => decorate(m, now));
}

export const staticApi = {
  mode: 'static',

  async meta() {
    const [meta, manifest] = await Promise.all([load('meta'), load('manifest')]);
    return { ...meta, snapshot: manifest };
  },

  async overview() {
    const [overview, manifest] = await Promise.all([load('overview'), load('manifest')]);
    return { ...overview, now: manifest.generated_at, snapshot: manifest };
  },

  async matches(params = {}) {
    const index = await load('matches-index');
    return {
      matches: listMatches(index.matches, params),
      snapshot: { ...index.window, generated_at: index.generated_at, total: index.matches.length },
    };
  },

  async match(id) {
    let detail;
    try {
      detail = await load(staticKey('match', id));
    } catch (err) {
      if (err.status === 404) {
        // Матч есть в базе, но не попал в снимок: выгружаются последние 90 дней,
        // 30 дней вперёд, матчи с трансляциями и матчи с протоколом.
        throw new Error(
          'Этого матча нет в статическом снимке. На копии сайта для GitHub Pages выгружаются матчи ' +
            'за последние 90 дней, на 30 дней вперёд, все матчи с трансляциями и все матчи с протоколом.',
        );
      }
      throw err;
    }
    return { ...detail, match: decorate(detail.match) };
  },

  async competitions() {
    return load('competitions');
  },

  async competition(id, season) {
    return load(competitionKey(id, season));
  },

  async team(id) {
    return load(staticKey('team', id));
  },

  async streams(params = {}) {
    const data = await load('streams');
    let rows = data.streams || [];
    if (params.platform) rows = rows.filter((s) => s.platform === params.platform);
    if (params.matched === '1') rows = rows.filter((s) => (s.matches || []).length > 0);
    return { ...data, streams: rows };
  },
};

/** Сбрасывает кеш снимка — после пересборки сайта файлы могли измениться. */
export function invalidate() {
  cache.clear();
}

export const snapshotManifest = () => load('manifest');

staticApi.invalidate = invalidate;
