import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useData, fmtDayLabel } from '../utils.jsx';
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

  return (
    <div className="fade-in">
      <SectionHead
        title="Матчи"
        count={data?.matches?.length}
        sub="Полный календарь и результаты. Все матчи — реальные, из открытых источников; таймеры считаются от настоящего времени начала."
      />

      <div className="chips" style={{ marginBottom: 12 }}>
        {RANGES.map((r) => (
          <button key={r.id} className={`chip ${range === r.id ? 'active' : ''}`} onClick={() => setRange(r.id)}>
            {r.label}
          </button>
        ))}
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
          {data.matches.length === 0 && <div className="empty">На выбранный период матчей нет</div>}
          {groupByDay(data.matches).map(([day, list]) => (
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
