import React from 'react';
import { Link } from 'react-router-dom';
import { Crest, StatusBadge, fmtTime, fmtDayLabel, countdown, useTicker, matchTeams, fmtViewers, plural } from './utils.jsx';

export function MatchRow({ m, showLeague = true }) {
  useTicker(1000);
  const { home, away, homeShort, awayShort } = matchTeams(m);
  const hasScore = m.home_score != null && m.away_score != null;
  const soon = !hasScore && m.kickoff_utc && Date.parse(m.kickoff_utc) - Date.now() < 6 * 3600_000;

  return (
    <Link to={`/match/${encodeURIComponent(m.id)}`} className="match-row">
      <div className="match-time">
        <b>{fmtTime(m.kickoff_utc)}</b>
        {m.status === 'live' ? (
          <span className="badge badge-live" style={{ marginTop: 4 }}>
            <span className="dot-live" /> {m.minute != null ? `${m.minute}'` : 'LIVE'}
          </span>
        ) : soon ? (
          <span style={{ color: 'var(--gold)' }}>через {countdown(m.kickoff_utc)}</span>
        ) : (
          fmtDayLabel(m.kickoff_utc)
        )}
      </div>

      <div className="match-team">
        <Crest name={home} short={homeShort} color={m.home_color} />
        <div className="grow">
          <div className="name">{home}</div>
          {showLeague && <div className="league">{m.competition_name_ru || m.competition_name}</div>}
        </div>
      </div>

      <div className={`match-score ${m.status === 'live' ? 'live' : hasScore ? 'ft' : 'soon'}`}>
        {hasScore ? `${m.home_score} : ${m.away_score}` : 'vs'}
      </div>

      <div className="match-team away">
        <Crest name={away} short={awayShort} color={m.away_color} />
        <div className="grow">
          <div className="name">{away}</div>
          {showLeague && <div className="league">{m.round || m.stage || ''}</div>}
        </div>
      </div>

      <div className="match-side">
        {(m.streams?.length > 0) && (
          <span className="badge badge-vk">
            {m.streams.length} {plural(m.streams.length, 'эфир', 'эфира', 'эфиров')}
          </span>
        )}
        <StatusBadge status={m.status} minute={m.minute} kickoff={m.kickoff_utc} />
      </div>
    </Link>
  );
}

export function MatchList({ matches, empty = 'Матчей не найдено' }) {
  if (!matches?.length) return <div className="empty">{empty}</div>;
  return (
    <div className="panel">
      {matches.map((m) => (
        <MatchRow key={m.id} m={m} />
      ))}
    </div>
  );
}

export function StreamCard({ s }) {
  const isOk = s.platform === 'ok';
  const viewers = fmtViewers(s.viewers);
  const matched = s.matches?.length ? s.matches : s.match_id ? [s] : [];
  const first = matched[0];

  return (
    <article className={`stream-card ${isOk ? 'ok' : ''}`}>
      <div className="stream-top">
        <span className={`badge ${isOk ? 'badge-ok' : 'badge-vk'}`}>
          {isOk ? 'OK Видео' : 'VK Видео Live'}
        </span>
        <span className="row gap-8">
          {s.is_live ? <span className="badge badge-live"><span className="dot-live" /> live</span> : null}
          {viewers && <span className="stream-viewers">👁 {viewers}</span>}
        </span>
      </div>

      <h3 className="stream-title">{s.title}</h3>
      {s.channel && <div className="stream-channel">📡 {s.channel}</div>}

      {first && (
        <div className="stream-match">
          <span>
            Матч: <b>{first.home || first.home_name_ru || '—'}</b> — <b>{first.away || first.away_name_ru || '—'}</b>
          </span>
          {first.match_id && (
            <Link to={`/match/${encodeURIComponent(first.match_id)}`} className="badge">
              центр матча
            </Link>
          )}
        </div>
      )}

      <div className="stream-actions">
        <a className={`btn btn-sm ${isOk ? 'btn-ok' : 'btn-vk'}`} href={s.url} target="_blank" rel="noreferrer noopener">
          {isOk ? 'Смотреть в OK' : 'Смотреть в VK'}
        </a>
        {s.embed_url && (
          <span className="badge" title="Встраиваемый плеер">embed</span>
        )}
        {s.category && <span className="badge">{s.category}</span>}
      </div>
    </article>
  );
}

export function StandingsTable({ rows }) {
  if (!rows?.length) return <div className="empty">Таблица появится после завершения матчей</div>;
  const posClass = (p, total) => {
    if (p <= 4) return 'pos ucl';
    if (p <= 6) return 'pos uel';
    if (p > total - 3) return 'pos rel';
    return 'pos';
  };
  return (
    <div className="table-wrap">
      <table className="standings">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Команда</th>
            <th className="num">И</th>
            <th className="num">В</th>
            <th className="num">Н</th>
            <th className="num">П</th>
            <th className="num">Мячи</th>
            <th className="num">±</th>
            <th className="num">О</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.team_id}>
              <td className="num"><span className={posClass(r.position, rows.length)}>{r.position}</span></td>
              <td>
                <Link to={`/team/${encodeURIComponent(r.team_id)}`} className="team-cell">
                  <Crest name={r.team_name_ru || r.team_name} short={r.team_short} color={r.primary_color} size="crest-sm" />
                  {r.team_name_ru || r.team_name}
                </Link>
              </td>
              <td className="num">{r.played}</td>
              <td className="num">{r.won}</td>
              <td className="num">{r.drawn}</td>
              <td className="num">{r.lost}</td>
              <td className="num">{r.goals_for}:{r.goals_against}</td>
              <td className="num">{r.goal_diff > 0 ? `+${r.goal_diff}` : r.goal_diff}</td>
              <td className="num pts">{r.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ScorersList({ rows }) {
  if (!rows?.length) return <div className="empty">Статистика бомбардиров появится после инжеста событий</div>;
  return (
    <div className="panel panel-pad scorers-list">
      {rows.map((s, i) => (
        <div className="scorer-row" key={`${s.name}-${i}`}>
          <span className="n">{i + 1}</span>
          <span>
            <div className="p">{s.nickname || s.name}</div>
            <div className="t">{s.team_name_ru || s.team_name}{s.competition_name_ru ? ` · ${s.competition_name_ru}` : ''}</div>
          </span>
          <span />
          <span className="g">{s.goals}</span>
        </div>
      ))}
    </div>
  );
}

export function SectionHead({ title, count, sub, right }) {
  return (
    <div className="section-head">
      <div>
        <h2 className="section-title">
          {title}
          {count != null && <span className="count">{count}</span>}
        </h2>
        {sub && <p className="section-sub">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Loading({ label = 'Загружаем реальные данные…' }) {
  return (
    <div className="section">
      <div className="skeleton" style={{ height: 220 }} />
      <div className="skeleton mt-16" />
      <div className="skeleton mt-16" style={{ minHeight: 40 }} />
      <p className="muted small mt-16">{label}</p>
    </div>
  );
}

export function ErrorBox({ error }) {
  return (
    <div className="notice">
      Не удалось загрузить данные: {error}. Проверьте, что база собрана — выполните <code>npm run ingest</code>.
    </div>
  );
}
