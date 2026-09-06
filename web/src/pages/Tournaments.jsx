import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useData, plural, fmtDayLabel } from '../utils.jsx';
import { SectionHead, Loading, ErrorBox } from '../components.jsx';

export default function Tournaments() {
  const { data, loading, error } = useData(() => api.competitions(), []);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const groups = new Map();
  for (const c of data.competitions) {
    const key = c.kind === 'international' ? 'Международные' : c.country_ru || c.country || 'Прочие';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <div className="fade-in">
      <SectionHead
        title="Турниры"
        count={data.competitions.length}
        sub="Лиги, кубки и международные соревнования, по которым в базе есть реальные матчи."
      />
      {sortedGroups.map(([group, list]) => (
        <section className="section" key={group}>
          <h3 className="day-title">{group}</h3>
          <div className="comp-grid">
            {list.map((c) => (
              <Link
                key={c.id}
                to={`/tournament/${encodeURIComponent(c.id)}`}
                className="comp-card"
                style={{ '--accent-color': c.accent || 'rgba(255,255,255,.1)' }}
              >
                <div className="country">{c.kind === 'cup' ? 'кубок' : c.kind === 'international' ? 'международный' : 'лига'}</div>
                <div className="title">{c.name_ru || c.name}</div>
                <div className="stats">
                  {c.matches} {plural(c.matches, 'матч', 'матча', 'матчей')} · сыграно {c.played}
                </div>
                {c.next_match && <div className="stats" style={{ color: 'var(--gold)' }}>следующий: {fmtDayLabel(c.next_match)}</div>}
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
