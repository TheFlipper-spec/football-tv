import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useData, fmtDayLabel, useFavorites, plural } from '../utils.jsx';
import { MatchList, SectionHead, Loading, ErrorBox } from '../components.jsx';

const RANGES = [
  { id: 'live', label: 'Сейчас', live: true },
  { id: 'today', label: 'Сегодня', today: true },
  { id: '3d', label: '3 дня', days: 3 },
  { id: 'week', label: 'Неделя', days: 7 },
  { id: 'month', label: 'Месяц', days: 30 },
  { id: 'all', label: 'С трансляциями', streams: true },
  { id: 'depth', label: 'С протоколом', depth: true, past: true },
  { id: 'history', label: 'Результаты', past: true },
];

function groupByDay(matches) {
  // Матчи приходят уже в нужном порядке (для будущих — по возрастанию, для
  // результатов — по убыванию), поэтому дни идут в порядке появления. Раньше
  // группы всегда сортировались по убыванию, и в «Неделе» первым показывался
  // самый дальний день вместо сегодняшнего.
  const map = new Map();
  for (const m of matches) {
    const key = (m.kickoff_utc || 'nodate').slice(0, 10);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  return [...map.entries()];
}

export default function Matches() {
  const [range, setRange] = useState('week');
  const [competition, setCompetition] = useState('');
  const [query, setQuery] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const { favs, has } = useFavorites();
  const { data: comps } = useData(() => api.competitions(), []);

  const params = useMemo(() => {
    const r = RANGES.find((x) => x.id === range) || RANGES[2];
    const p = { limit: 400 };
    if (competition) p.competition = competition;
    if (r.live) p.status = 'live';
    if (r.streams) p.withStreams = '1';
    if (r.depth) p.withDepth = '1';
    if (r.past) {
      p.to = new Date().toISOString();
      p.order = 'desc';
    } else if (r.today) {
      // «Сегодня» — весь текущий день по UTC-дате матча, включая уже сыгранное.
      // Раньше { days: 0 } не давал ни одного фильтра, и список открывался
      // с самых старых матчей базы — 2010 год вместо сегодняшнего дня.
      p.day = new Date().toISOString().slice(0, 10);
    } else if (r.days) {
      p.from = new Date().toISOString();
      p.to = new Date(Date.now() + r.days * 86400000).toISOString();
    }
    return p;
  }, [range, competition]);

  const { data, loading, error } = useData(() => api.matches(params), [range, competition], { intervalMs: 120_000 });

  const topCompetitions = (comps?.competitions || [])
    .filter((c) => c.matches > 0)
    .sort((a, b) => (b.played - a.played) || (b.matches - a.matches))
    .slice(0, 14);

  // Быстрый поиск по уже загруженному окну + фильтр «мои команды». Поиск идёт
  // по названиям команд, турниру и туру; 400 строк фильтруются мгновенно.
  const visible = useMemo(() => {
    const list = data?.matches || [];
    const q = query.trim().toLowerCase();
    return list.filter((m) => {
      if (favOnly && !has(m.home_id) && !has(m.away_id)) return false;
      if (!q) return true;
      const hay = [
        m.home_name_ru, m.home_name, m.away_name_ru, m.away_name,
        m.competition_name_ru, m.competition_name, m.round, m.stage,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [data, query, favOnly, has]);

  return (
    <div className="fade-in">
      <SectionHead
        title="Матчи"
        count={data ? visible.length : undefined}
        sub="Полный календарь и результаты. Все матчи — реальные, из открытых источников; таймеры считаются от настоящего времени начала."
      />

      <div className="chips" style={{ marginBottom: 12 }}>
        {RANGES.map((r) => (
          <button key={r.id} className={`chip ${range === r.id ? 'active' : ''}`} onClick={() => setRange(r.id)}>
            {r.label}
          </button>
        ))}
      </div>

      <div className="matches-tools">
        <div className="search-box">
          <span className="search-icon">🔍</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по команде или турниру…"
            aria-label="Поиск по команде или турниру"
          />
          {query && (
            <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="Очистить поиск">
              ✕
            </button>
          )}
        </div>
        <button
          type="button"
          className={`chip ${favOnly ? 'active' : ''} ${favs.size ? '' : 'muted'}`}
          onClick={() => setFavOnly((v) => !v)}
          title={favs.size ? `Показать матчи ${favs.size} ${plural(favs.size, 'команды', 'команд', 'команд')} из избранного` : 'Добавьте команды в избранное на странице клуба или матча'}
        >
          ⭐ Мои команды{favs.size ? ` (${favs.size})` : ''}
        </button>
      </div>

      <div className="chips" style={{ marginBottom: 22 }}>
        <button className={`chip ${!competition ? 'active' : ''}`} onClick={() => setCompetition('')}>
          Все турниры
        </button>
        {topCompetitions.map((c) => (
          <button
            key={c.id}
            className={`chip ${competition === c.id ? 'active' : ''}`}
            onClick={() => setCompetition(c.id)}
          >
            {c.name_ru || c.name}
          </button>
        ))}
      </div>

      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && !loading && (
        <>
          {favOnly && favs.size === 0 && (
            <div className="notice">
              В избранном пока нет команд. Добавьте клубы звёздочкой ⭐ на странице команды или матча — и они появятся здесь.
            </div>
          )}
          {visible.length === 0 && (
            <div className="empty">
              {query || favOnly
                ? 'По этому фильтру матчей нет — измените поиск или период.'
                : 'На выбранный период матчей нет'}
            </div>
          )}
          {groupByDay(visible).map(([day, list]) => (
            <div className="day-group" key={day}>
              <h3 className="day-title">{fmtDayLabel(list[0].kickoff_utc) || 'Без даты'}</h3>
              <MatchList matches={list} showLeague />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
