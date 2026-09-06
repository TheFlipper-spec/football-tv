import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useData, fmtDayLabel, plural } from '../utils.jsx';
import { MatchList, StandingsTable, ScorersList, SectionHead, Loading, ErrorBox } from '../components.jsx';

export default function TournamentPage() {
  const { id } = useParams();
  const [season, setSeason] = useState('');
  const { data, loading, error } = useData(() => api.competition(id, season), [id, season]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const c = data.competition;
  const activeSeason = data.seasonId;
  const played = data.matches.filter((m) => m.status === 'finished').length;
  const upcoming = data.matches.filter((m) => m.home_score == null).slice(0, 12);
  const results = data.matches.filter((m) => m.home_score != null).slice(0, 16);

  return (
    <div className="fade-in">
      <div className="hero">
        <div className="row-between wrap">
          <div>
            <div className="badge">{c.kind === 'cup' ? 'кубок' : c.kind === 'international' ? 'международный турнир' : 'лига'}{c.country_ru ? ` · ${c.country_ru}` : ''}</div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 30, margin: '12px 0 6px', letterSpacing: '-0.02em' }}>
              {c.name_ru || c.name}
            </h1>
            <p className="muted small" style={{ margin: 0 }}>
              {c.name} · {data.matches.length} {plural(data.matches.length, 'матч', 'матча', 'матчей')} · сыграно {played}
            </p>
          </div>
        </div>

        {data.seasons.length > 1 && (
          <div className="chips" style={{ marginTop: 20 }}>
            {data.seasons.slice(0, 12).map((s) => (
              <button key={s.id} className={`chip ${activeSeason === s.id ? 'active' : ''}`} onClick={() => setSeason(s.id)}>
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="row gap-8 wrap mt-24" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 480px', minWidth: 0 }}>
          <SectionHead title="Турнирная таблица" sub="Считается по реально сыгранным матчам сезона" />
          <StandingsTable rows={data.standings} />
        </div>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <SectionHead title="Бомбардиры" />
          <ScorersList rows={data.scorers} />
        </div>
      </div>

      <section className="section">
        <SectionHead title="Ближайшие матчи" count={upcoming.length} />
        <MatchList matches={upcoming} showLeague={false} empty="Ближайших матчей нет" />
      </section>

      <section className="section">
        <SectionHead title="Результаты" count={results.length} />
        <MatchList matches={results} showLeague={false} empty="Сыгранных матчей пока нет" />
      </section>
    </div>
  );
}
