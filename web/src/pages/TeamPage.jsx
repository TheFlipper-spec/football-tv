import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useData, Crest, plural } from '../utils.jsx';
import { MatchList, SectionHead, Loading, ErrorBox } from '../components.jsx';

export default function TeamPage() {
  const { id } = useParams();
  const { data, loading, error } = useData(() => api.team(id), [id]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const t = data.team;
  const name = t.name_ru || t.name;

  return (
    <div className="fade-in">
      <div className="hero">
        <div className="row gap-8" style={{ alignItems: 'center' }}>
          <Crest name={name} short={t.short_name} color={t.primary_color} src={t.crest_url} size="crest-lg" />
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: 0, letterSpacing: '-0.02em' }}>{name}</h1>
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              {t.name}{t.country ? ` · ${t.country}` : ''} · {data.results.length + data.upcoming.length} матчей в подборке
            </p>
          </div>
        </div>
      </div>

      <section className="section">
        <SectionHead title="Ближайшие матчи" count={data.upcoming.length} />
        <MatchList matches={data.upcoming} empty="Ближайших матчей нет" />
      </section>

      <section className="section">
        <SectionHead title="Последние результаты" count={data.results.length} />
        <MatchList matches={data.results} empty="Результатов пока нет" />
      </section>

      {data.squad?.length > 0 && (
        <section className="section">
          <SectionHead
            title="Игроки"
            count={data.squad.length}
            sub="Состав собран по реальным протоколам матчей (StatsBomb)."
          />
          <div className="lineup-cols">
            {data.squad.map((p, i) => (
              <div className="lineup-row" key={p.id} style={i % 2 ? {} : { borderLeft: '2px solid transparent' }}>
                <span className="lineup-num">—</span>
                <span className="lineup-name">{p.nickname || p.name}</span>
                <span className="lineup-meta"><span className="lineup-pos">{p.position || ''}</span>{p.country ? ` · ${p.country}` : ''}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
