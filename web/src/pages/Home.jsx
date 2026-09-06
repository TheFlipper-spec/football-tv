import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useData, Crest, matchTeams, fmtTime, fmtDayLabel, countdown, useTicker, plural } from '../utils.jsx';
import { MatchList, StreamCard, SectionHead, ScorersList, Loading, ErrorBox } from '../components.jsx';

function Hero({ m }) {
  useTicker(1000);
  if (!m) return null;
  const { home, away, homeShort, awayShort } = matchTeams(m);
  const hasScore = m.home_score != null && m.away_score != null;
  const top = m.streams?.[0];

  return (
    <section className="hero fade-in">
      <div className="hero-grid">
        <div className="hero-team">
          <Crest name={home} short={homeShort} color={m.home_color} size="crest-lg" />
          <div>
            <div className="name">{home}</div>
            <div className="sub">хозяева</div>
          </div>
        </div>

        <div>
          <div className="hero-score">
            {hasScore ? (
              <>
                {m.home_score}
                <span className="dash">:</span>
                {m.away_score}
              </>
            ) : (
              <>{fmtTime(m.kickoff_utc)}</>
            )}
          </div>
          <div className="hero-meta">
            {m.status === 'live' ? (
              <span className="badge badge-live"><span className="dot-live" /> {m.minute != null ? `${m.minute}'` : 'прямой эфир'}</span>
            ) : hasScore ? (
              <span className="badge badge-ft">матч завершён</span>
            ) : (
              <span className="badge badge-soon">старт через {countdown(m.kickoff_utc)}</span>
            )}
            <span className="badge">{m.competition_name_ru || m.competition_name}{m.round ? ` · ${m.round}` : ''}</span>
          </div>
        </div>

        <div className="hero-team away">
          <Crest name={away} short={awayShort} color={m.away_color} size="crest-lg" />
          <div>
            <div className="name">{away}</div>
            <div className="sub">гости</div>
          </div>
        </div>
      </div>

      <div className="hero-foot">
        <div className="hero-chips">
          {m.venue && <span className="badge">📍 {m.venue}{m.city ? `, ${m.city}` : ''}</span>}
          {m.has_lineups ? <span className="badge">составы</span> : null}
          {m.has_stats ? <span className="badge">статистика</span> : null}
          {m.streams?.length ? (
            <span className="badge badge-vk">
              {m.streams.length} {plural(m.streams.length, 'трансляция', 'трансляции', 'трансляций')} в VK
            </span>
          ) : null}
        </div>
        <div className="row gap-8 wrap">
          {top && (
            <a className="btn btn-vk" href={top.url} target="_blank" rel="noreferrer noopener">
              ▶ Смотреть трансляцию
            </a>
          )}
          <Link className="btn btn-accent" to={`/match/${encodeURIComponent(m.id)}`}>Центр матча</Link>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const { data, error, loading } = useData(() => api.overview(), []);
  useTicker(1000);

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const liveCount = data.live?.length || 0;
  const streamsWithMatch = data.streams?.filter((s) => s.matched > 0).length || 0;

  return (
    <div className="fade-in">
      <Hero m={data.featured} />

      <section className="section">
        <SectionHead
          title="Сейчас в эфире"
          count={`${data.streams?.length || 0} потоков`}
          sub="Прямые трансляции из VK Видео Live и OK Видео. Список привязывается к реальным матчам по названию эфира."
          right={<Link className="btn btn-sm" to="/live">Все трансляции →</Link>}
        />
        {data.streams?.length ? (
          <div className="stream-grid">
            {data.streams.slice(0, 6).map((s) => (
              <StreamCard key={s.id} s={s} />
            ))}
          </div>
        ) : (
          <div className="empty">Трансляции не загружены — выполните <code>npm run ingest:streams</code></div>
        )}
      </section>

      <section className="section">
        <SectionHead
          title={liveCount ? `Live: ${liveCount} ${plural(liveCount, 'матч', 'матча', 'матчей')}` : 'Ближайшие матчи'}
          sub="Календарь и результаты из открытых данных openfootball, обновлённые live-слоем ESPN."
          right={<Link className="btn btn-sm" to="/matches">Все матчи →</Link>}
        />
        <MatchList matches={(data.live?.length ? data.live : data.upcoming).slice(0, 14)} />
      </section>

      <section className="section">
        <div className="row gap-8 wrap" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 420px', minWidth: 0 }}>
            <SectionHead title="Турниры" count={data.competitions?.length} sub="Активные соревнования в базе" />
            <div className="comp-grid">
              {(data.competitions || []).slice(0, 9).map((c) => (
                <Link key={c.id} to={`/tournament/${encodeURIComponent(c.id)}`} className="comp-card" style={{ '--accent-color': c.accent || 'rgba(255,255,255,.1)' }}>
                  <div className="country">{c.country_ru || 'международный'}</div>
                  <div className="title">{c.name_ru || c.name}</div>
                  <div className="stats">{c.matches} {plural(c.matches, 'матч', 'матча', 'матчей')} в базе</div>
                </Link>
              ))}
            </div>
            <div className="mt-16">
              <Link className="btn btn-sm" to="/tournaments">Все турниры →</Link>
            </div>
          </div>

          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <SectionHead title="Бомбардиры" sub="По данным событий StatsBomb" />
            <ScorersList rows={data.scorers?.slice(0, 10)} />
          </div>
        </div>
      </section>

      <section className="section">
        <SectionHead
          title="Матчи ближайших дней"
          sub="Реальные даты и время начала — таймер считается от настоящего времени старта."
        />
        <MatchList matches={data.upcoming?.slice(0, 20)} />
      </section>
    </div>
  );
}
