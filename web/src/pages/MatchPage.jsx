import React, { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import {
  useData, useTicker, Crest, matchTeams, fmtTime, fmtDayLabel, countdown,
  STAT_LABELS, STAT_ORDER, EVENT_META, fmtViewers, plural,
} from '../utils.jsx';
import { MatchList, SectionHead, Loading, ErrorBox } from '../components.jsx';

const TABS = [
  { id: 'events', label: 'События' },
  { id: 'lineups', label: 'Составы' },
  { id: 'stats', label: 'Статистика' },
  { id: 'tv', label: 'Трансляция' },
];

function Timeline({ events, match }) {
  if (!events?.length) {
    return (
      <div className="empty">
        Событий по этому матчу в источнике нет. Детальная событийная статистика доступна для турниров из StatsBomb
        (ЧМ-2022, Евро-2024, Евро-2020, Копа Америка-2024).
      </div>
    );
  }
  return (
    <div className="panel panel-pad timeline">
      {events.map((e, i) => {
        const meta = EVENT_META[e.type] || { icon: '•', cls: '', label: e.type };
        const isHome = e.team_id === match.home_id;
        const side = (
          <div className={`tl-event ${isHome ? '' : 'right'}`}>
            {!isHome && <span className={`icon ${meta.cls}`}>{meta.icon}</span>}
            <div>
              <div className="who">{e.player_name || e.detail || meta.label}</div>
              <div className="what">{e.detail && e.player_name ? e.detail : meta.label}</div>
            </div>
            {isHome && <span className={`icon ${meta.cls}`}>{meta.icon}</span>}
          </div>
        );
        return (
          <div className="tl-row" key={i}>
            {isHome ? side : <span />}
            <div className="tl-minute">{e.minute != null ? `${e.minute}'` : '—'}</div>
            {isHome ? <span /> : side}
          </div>
        );
      })}
    </div>
  );
}

function Lineups({ lineups, match }) {
  if (!lineups?.length) {
    return <div className="empty">Составы на матч не опубликованы в источнике данных</div>;
  }
  const byTeam = new Map();
  for (const l of lineups) {
    if (!byTeam.has(l.team_id)) byTeam.set(l.team_id, []);
    byTeam.get(l.team_id).push(l);
  }
  const order = [match.home_id, match.away_id].filter((id) => byTeam.has(id));
  for (const id of byTeam.keys()) if (!order.includes(id)) order.push(id);

  return (
    <div className="lineup-cols">
      {order.map((teamId, idx) => {
        const rows = byTeam.get(teamId);
        const starting = rows.filter((r) => r.side === 'starting');
        const bench = rows.filter((r) => r.side !== 'starting');
        const color = idx === 0 ? match.home_color : match.away_color;
        const name = idx === 0 ? (match.home_name_ru || match.home_name) : (match.away_name_ru || match.away_name);
        const short = idx === 0 ? match.home_short : match.away_short;
        return (
          <div className="lineup-team panel panel-pad" key={teamId}>
            <h4>
              <Crest name={name} short={short} color={color} size="crest-sm" />
              {name}
              <span className="muted small">· {starting.length} в старте</span>
            </h4>
            <div className="lineup-list">
              {starting.map((p) => (
                <div className="lineup-row" key={p.player_id}>
                  <span className="lineup-num">{p.jersey ?? '—'}</span>
                  <span className="lineup-name" title={p.player_name}>{p.nickname || p.player_name}</span>
                  <span className="lineup-meta"><span className="lineup-pos">{p.position || ''}</span></span>
                </div>
              ))}
            </div>
            {bench.length > 0 && (
              <>
                <div className="day-title mt-16">Запасные</div>
                <div className="lineup-list">
                  {bench.map((p) => (
                    <div className="lineup-row bench" key={p.player_id}>
                      <span className="lineup-num">{p.jersey ?? '—'}</span>
                      <span className="lineup-name" title={p.player_name}>{p.nickname || p.player_name}</span>
                      <span className="lineup-meta">
                        {p.on_minute != null ? `${p.on_minute}'` : ''}
                        {p.off_minute != null ? ` → ${p.off_minute}'` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Stats({ stats, match }) {
  if (!stats?.length) {
    return (
      <div className="empty">
        Матчевой статистики в источнике нет. Развёрнутая статистика (владение, xG, удары, пасы, обводки) доступна
        для турниров из StatsBomb.
      </div>
    );
  }
  const map = new Map();
  for (const s of stats) {
    if (!map.has(s.stat)) map.set(s.stat, {});
    map.get(s.stat)[s.team_id] = s.value;
  }
  const keys = [...STAT_ORDER.filter((k) => map.has(k)), ...[...map.keys()].filter((k) => !STAT_ORDER.includes(k))];
  return (
    <div className="panel panel-pad">
      {keys.map((k) => {
        const home = map.get(k)[match.home_id] || 0;
        const away = map.get(k)[match.away_id] || 0;
        const total = home + away || 1;
        const fmt = (v) => (k === 'xg' ? Number(v).toFixed(2) : Math.round(v));
        return (
          <div className="stat-row" key={k}>
            <span className="stat-val">{fmt(home)}</span>
            <div className="stat-bar home"><i style={{ width: `${(home / total) * 100}%` }} /></div>
            <span className="stat-label">{STAT_LABELS[k] || k}</span>
            <div className="stat-bar away"><i style={{ width: `${(away / total) * 100}%` }} /></div>
            <span className="stat-val right">{fmt(away)}</span>
          </div>
        );
      })}
    </div>
  );
}

function TvTab({ streams, match }) {
  const [active, setActive] = useState(0);
  if (!streams?.length) {
    return (
      <div className="empty">
        К этому матчу пока не привязана ни одна трансляция. Сопоставление идёт по названию эфира в VK Видео Live
        и OK Видео — обновите список командой <code>npm run ingest:streams</code>.
      </div>
    );
  }
  const s = streams[active] || streams[0];
  const viewers = fmtViewers(s.viewers);

  return (
    <div>
      <div className="player-frame">
        <div className="player-fallback">
          <span className={`badge ${s.platform === 'ok' ? 'badge-ok' : 'badge-vk'}`}>
            {s.platform === 'ok' ? 'OK Видео' : 'VK Видео Live'}
          </span>
          <div className="big">{s.title}</div>
          <p>
            {s.channel ? `Канал: ${s.channel}. ` : ''}
            Прямой эфир доступен на площадке вещателя — плеер открывается в новой вкладке, чтобы сохранить
            авторизацию и защиту контента платформы.
            {viewers ? ` Сейчас смотрят: ${viewers}.` : ''}
          </p>
          <a className={`btn ${s.platform === 'ok' ? 'btn-ok' : 'btn-vk'}`} href={s.url} target="_blank" rel="noreferrer noopener">
            ▶ Открыть трансляцию
          </a>
        </div>
      </div>

      {streams.length > 1 && (
        <div className="chips mt-16">
          {streams.map((st, i) => (
            <button key={st.id} className={`chip ${i === active ? 'active' : ''}`} onClick={() => setActive(i)}>
              {st.channel || st.platform} {st.viewers ? `· ${fmtViewers(st.viewers)}` : ''}
            </button>
          ))}
        </div>
      )}

      <div className="panel panel-pad mt-16">
        <div className="row-between wrap">
          <div>
            <div className="muted small">Все доступные эфиры на матч</div>
            <div style={{ fontWeight: 700, marginTop: 4 }}>
              {streams.length} {plural(streams.length, 'трансляция', 'трансляции', 'трансляций')}
            </div>
          </div>
          <a className="btn btn-sm" href={s.url} target="_blank" rel="noreferrer noopener">Открыть {s.platform.toUpperCase()}</a>
        </div>
        <div className="mt-16">
          {streams.map((st) => (
            <div className="scorer-row" key={st.id}>
              <span className="n">{st.platform === 'ok' ? 'OK' : 'VK'}</span>
              <span>
                <div className="p" style={{ fontSize: 13 }}>{st.title}</div>
                <div className="t">{st.channel || '—'}</div>
              </span>
              <span className="t">{fmtViewers(st.viewers) || ''}</span>
              <a className="badge" href={st.url} target="_blank" rel="noreferrer noopener">смотреть</a>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function MatchPage() {
  const { id } = useParams();
  const [tab, setTab] = useState('events');
  const { data, loading, error } = useData(() => api.match(id), [id], { intervalMs: 30_000 });
  useTicker(1000);

  const availableTabs = useMemo(() => {
    if (!data) return TABS;
    return TABS.map((t) => ({
      ...t,
      disabled:
        (t.id === 'lineups' && !data.lineups.length) ||
        (t.id === 'stats' && !data.stats.length) ||
        (t.id === 'events' && !data.events.length),
      count:
        t.id === 'lineups' ? data.lineups.length
          : t.id === 'stats' ? new Set(data.stats.map((s) => s.stat)).size
          : t.id === 'tv' ? data.streams.length
          : data.events.length,
    }));
  }, [data]);

  if (loading) return <Loading label="Открываем матч…" />;
  if (error) return <ErrorBox error={error} />;

  const m = data.match;
  const { home, away, homeShort, awayShort, homeSrc, awaySrc } = matchTeams(m);
  const hasScore = m.home_score != null && m.away_score != null;

  return (
    <div className="fade-in">
      <div className="match-head">
        <div className="row gap-8 wrap" style={{ justifyContent: 'center', marginBottom: 18 }}>
          <Link to={`/tournament/${encodeURIComponent(m.competition_id)}`} className="badge">
            {m.competition_name_ru || m.competition_name}
          </Link>
          {m.round && <span className="badge">{m.round}</span>}
          <span className="badge">{fmtDayLabel(m.kickoff_utc)}, {fmtTime(m.kickoff_utc)}</span>
          {m.status === 'live' ? (
            <span className="badge badge-live"><span className="dot-live" /> {m.minute != null ? `${m.minute}'` : 'LIVE'}</span>
          ) : hasScore ? (
            <span className="badge badge-ft">завершён</span>
          ) : (
            <span className="badge badge-soon">через {countdown(m.kickoff_utc)}</span>
          )}
        </div>

        <div className="match-head-grid">
          <Link to={`/team/${encodeURIComponent(m.home_id)}`} className="hero-team">
            <Crest name={home} short={homeShort} color={m.home_color} src={homeSrc} size="crest-lg" />
            <div>
              <div className="name" style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600 }}>{home}</div>
              <div className="sub muted small">{m.home_name}</div>
            </div>
          </Link>

          <div className="hero-score" style={{ fontSize: 48 }}>
            {hasScore ? <>{m.home_score}<span className="dash">:</span>{m.away_score}</> : 'vs'}
            {m.ht_home != null && (
              <div className="muted small" style={{ fontFamily: 'var(--font-body)', fontSize: 12, marginTop: 8 }}>
                перерыв {m.ht_home}:{m.ht_away}
              </div>
            )}
          </div>

          <Link to={`/team/${encodeURIComponent(m.away_id)}`} className="hero-team away">
            <Crest name={away} short={awayShort} color={m.away_color} src={awaySrc} size="crest-lg" />
            <div>
              <div className="name" style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600 }}>{away}</div>
              <div className="sub muted small">{m.away_name}</div>
            </div>
          </Link>
        </div>

        <div className="hero-chips mt-24" style={{ justifyContent: 'center' }}>
          {m.venue && <span className="badge">📍 {m.venue}{m.city ? `, ${m.city}` : ''}{m.country ? `, ${m.country}` : ''}</span>}
          {m.referee && <span className="badge">🧑‍⚖️ {m.referee}</span>}
          {m.attendance ? <span className="badge">👥 {m.attendance.toLocaleString('ru-RU')}</span> : null}
          <span className="badge">источник: {m.source}</span>
        </div>

        {m.streams?.length > 0 && (
          <div className="row gap-8 mt-16" style={{ justifyContent: 'center' }}>
            <button className="btn btn-vk" onClick={() => setTab('tv')}>
              ▶ {m.streams.length} {plural(m.streams.length, 'трансляция', 'трансляции', 'трансляций')}
            </button>
          </div>
        )}
      </div>

      <div className="tabs">
        {availableTabs.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'active' : ''} ${t.disabled ? 'muted' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}{t.count ? ` · ${t.count}` : ''}
          </button>
        ))}
      </div>

      {tab === 'events' && <Timeline events={data.events} match={m} />}
      {tab === 'lineups' && <Lineups lineups={data.lineups} match={m} />}
      {tab === 'stats' && <Stats stats={data.stats} match={m} />}
      {tab === 'tv' && <TvTab streams={data.streams} match={m} />}

      {data.headToHead?.length > 0 && (
        <section className="section">
          <SectionHead title="Личные встречи" sub="Последние очные матчи этих команд" />
          <MatchList matches={data.headToHead} showLeague={false} />
        </section>
      )}
    </div>
  );
}
