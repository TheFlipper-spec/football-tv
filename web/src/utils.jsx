import React, { useEffect, useState } from 'react';

export const teamName = (t, field = 'name_ru') => t?.[field] || t?.name || '—';

export function matchTeams(m) {
  return {
    home: m.home_name_ru || m.home_name || '—',
    away: m.away_name_ru || m.away_name || '—',
    homeShort: m.home_short || (m.home_name_ru || m.home_name || '?').slice(0, 3).toUpperCase(),
    awayShort: m.away_short || (m.away_name_ru || m.away_name || '?').slice(0, 3).toUpperCase(),
    homeSrc: m.home_crest || null,
    awaySrc: m.away_crest || null,
  };
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

export function fmtTime(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDayLabel(iso) {
  if (!iso) return 'дата уточняется';
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Сегодня';
  if (same(d, tomorrow)) return 'Завтра';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${WEEKDAYS[d.getDay()]}`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  return `${fmtDate(iso)}, ${fmtTime(iso)}`;
}

export function countdown(iso) {
  const diff = Date.parse(iso) - Date.now();
  if (Number.isNaN(diff)) return null;
  if (diff <= 0) return 'идёт';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  if (h > 24) return `${Math.floor(h / 24)} д`;
  if (h > 0) return `${h} ч ${String(m).padStart(2, '0')} мин`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function fmtViewers(n) {
  if (!n) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',')} тыс.`;
  return String(n);
}

/**
 * Путь к файлу из сборки.
 *
 * В базе эмблемы хранятся как `/crests/…` — от корня домена. На GitHub Pages
 * сайт живёт в подкаталоге `/football-tv/`, и корневой путь уехал бы в 404,
 * поэтому дополняем его базой сборки. Внешние ссылки (http/https) не трогаем.
 */
const ASSET_BASE = (() => {
  const env = import.meta.env?.BASE_URL;
  if (!env) return '';
  return env.endsWith('/') ? env.slice(0, -1) : env;
})();

export function assetUrl(src) {
  if (!src || !src.startsWith('/') || !ASSET_BASE) return src;
  return `${ASSET_BASE}${src}`;
}

/**
 * Эмблема клуба. Если в базе есть настоящая картинка (источник — репозиторий
 * sportlogos/football.db.logos, лежит в web/public/crests), показываем её;
 * иначе — аккуратная плашка с буквами в цветах клуба.
 */
export function Crest({ name, short, color, src, size = '' }) {
  const [broken, setBroken] = useState(false);
  const letters = (short || (name || '?').slice(0, 3)).toString().toUpperCase().slice(0, 4);
  const showImage = src && !broken;
  return (
    <div
      className={`crest ${size} ${showImage ? 'crest-img' : ''}`}
      style={{ '--c1': color || '#2a3346' }}
      title={name}
      aria-hidden="true"
    >
      {showImage ? (
        <img src={assetUrl(src)} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : (
        letters
      )}
    </div>
  );
}

export function StatusBadge({ status, minute, kickoff }) {
  if (status === 'live') {
    return (
      <span className="badge badge-live">
        <span className="dot-live" /> {minute != null ? `${minute}'` : 'LIVE'}
      </span>
    );
  }
  if (status === 'finished') return <span className="badge badge-ft">завершён</span>;
  const soon = kickoff && Date.parse(kickoff) - Date.now() < 3 * 3600_000;
  if (soon) return <span className="badge badge-soon">скоро</span>;
  return <span className="badge">{kickoff ? fmtTime(kickoff) : 'по расписанию'}</span>;
}

/** Тикающий таймер — раз в секунду обновляет компонент. */
export function useTicker(intervalMs = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

export function useData(loader, deps = [], { intervalMs = 0 } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true, fetched_at: null });
  useEffect(() => {
    let alive = true;
    const run = (first) => {
      if (first) setState((s) => ({ ...s, loading: true, error: null }));
      return loader()
        .then((data) => alive && setState({ data, error: null, loading: false, fetched_at: new Date().toISOString() }))
        .catch((error) =>
          alive &&
          setState((s) => ({
            data: s.data,                       // при ошибке не затираем то, что уже показали
            error: String(error.message || error),
            loading: false,
            fetched_at: new Date().toISOString(),
          })),
        );
    };
    run(true);
    if (!intervalMs) return () => { alive = false; };
    // автообновление: счёт и трансляции подтягиваются сами, без перезагрузки страницы
    const timer = setInterval(() => run(false), intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs]);
  return state;
}

export const STAT_LABELS = {
  possession_pct: 'Владение, %',
  xg: 'xG (ожидаемые голы)',
  goals: 'Голы',
  shots: 'Удары',
  shots_on_target: 'Удары в створ',
  passes_attempted: 'Пасы',
  passes_completed: 'Точные пасы',
  corners: 'Угловые',
  offsides: 'Офсайды',
  goal_assists: 'Голевые передачи',
  fouls_committed: 'Фолы',
  fouls_won: 'Заработано фолов',
  yellow_cards: 'Жёлтые',
  red_cards: 'Красные',
  tackles: 'Отборы',
  saves: 'Сейвы',
  dribbles_completed: 'Удачные обводки',
  duels_won: 'Выигранные единоборства',
};

export const STAT_ORDER = [
  'possession_pct', 'xg', 'shots', 'shots_on_target', 'passes_attempted', 'passes_completed',
  'corners', 'offsides', 'goal_assists', 'fouls_committed', 'tackles', 'saves', 'dribbles_completed',
  'yellow_cards', 'red_cards',
];

export const EVENT_META = {
  goal: { icon: '⚽', cls: 'goal', label: 'гол' },
  penalty: { icon: '⚽', cls: 'goal', label: 'пенальти' },
  own_goal: { icon: '⚽', cls: 'goal', label: 'автогол' },
  yellow: { icon: '▮', cls: 'yellow', label: 'жёлтая' },
  red: { icon: '▮', cls: 'red', label: 'красная' },
  substitution: { icon: '⇄', cls: 'sub', label: 'замена' },
  miss: { icon: '✕', cls: '', label: 'промах' },
};
