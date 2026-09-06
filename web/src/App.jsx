import React, { useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Route, Routes, Link } from 'react-router-dom';
import { api } from './api.js';
import { useTicker, fmtTime, plural } from './utils.jsx';
import Home from './pages/Home.jsx';
import Matches from './pages/Matches.jsx';
import MatchPage from './pages/MatchPage.jsx';
import Tournaments from './pages/Tournaments.jsx';
import TournamentPage from './pages/TournamentPage.jsx';
import Streams from './pages/Streams.jsx';
import TeamPage from './pages/TeamPage.jsx';

function Ticker({ overview }) {
  useTicker(30000);
  const items = overview?.live?.length ? overview.live : overview?.upcoming?.slice(0, 12) || [];
  if (!items.length) return null;
  const line = items.map((m, i) => {
    const home = m.home_name_ru || m.home_name;
    const away = m.away_name_ru || m.away_name;
    const hasScore = m.home_score != null;
    return (
      <Link to={`/match/${encodeURIComponent(m.id)}`} className="ticker-item" key={`${m.id}-${i}`}>
        {m.status === 'live' && <span className="dot-live" />}
        <b>{home}</b>
        <span className="score">{hasScore ? `${m.home_score}:${m.away_score}` : fmtTime(m.kickoff_utc)}</span>
        <b>{away}</b>
      </Link>
    );
  });
  return (
    <div className="ticker">
      <div className="ticker-track">
        {line}
        {line}
      </div>
    </div>
  );
}

function Shell() {
  const [overview, setOverview] = useState(null);

  const refresh = () => {
    api.overview().then(setOverview).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60000);
    return () => clearInterval(id);
  }, []);

  const liveCount = overview?.live?.filter((m) => m.status === 'live').length || 0;
  const captured = overview?.sources?.['ingest.streams'];

  return (
    <>
      <div className="backdrop" />
      <div className="grain" />

      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="logo">
            <span className="logo-mark"><span>⚽</span></span>
            ФУТБОЛ<em>.TV</em>
          </Link>
          <nav className="nav">
            <NavLink to="/" end>Главная</NavLink>
            <NavLink to="/live">Трансляции</NavLink>
            <NavLink to="/matches">Матчи</NavLink>
            <NavLink to="/tournaments">Турниры</NavLink>
          </nav>
          <div className="topbar-meta">
            {overview ? (
              <>
                <div>
                  <b>{liveCount}</b> в эфире · <b>{overview.streams?.length || 0}</b> потоков
                </div>
                <div>{new Date(overview.now).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · VK Видео Live / OK Видео</div>
              </>
            ) : (
              <div>загрузка…</div>
            )}
          </div>
        </div>
        <Ticker overview={overview} />
      </header>

      <main className="page">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/live" element={<Streams />} />
          <Route path="/matches" element={<Matches />} />
          <Route path="/match/:id" element={<MatchPage />} />
          <Route path="/tournaments" element={<Tournaments />} />
          <Route path="/tournament/:id" element={<TournamentPage />} />
          <Route path="/team/:id" element={<TeamPage />} />
          <Route path="*" element={<Home />} />
        </Routes>

        <footer className="foot">
          <div className="row-between wrap">
            <div>
              <b style={{ color: 'var(--muted)' }}>ФУТБОЛ.TV</b> — матчи, составы, статистика и прямые трансляции.
              <br />
              Данные: <a href="https://github.com/openfootball" target="_blank" rel="noreferrer">openfootball</a> (календарь и результаты),{' '}
              <a href="https://github.com/statsbomb/open-data" target="_blank" rel="noreferrer">StatsBomb Open Data</a> (составы, события, статистика),{' '}
              <a href="https://live.vkvideo.ru" target="_blank" rel="noreferrer">VK Видео Live</a> и{' '}
              <a href="https://ok.ru/video/live" target="_blank" rel="noreferrer">OK Видео</a> (прямые эфиры),{' '}
              ESPN Site API (живой счёт).
            </div>
            <div style={{ textAlign: 'right' }}>
              {captured ? <>Снимок трансляций: {new Date(captured).toLocaleString('ru-RU')}</> : null}
              <br />
              Обновление базы: <code>npm run ingest</code>
            </div>
          </div>
        </footer>
      </main>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
