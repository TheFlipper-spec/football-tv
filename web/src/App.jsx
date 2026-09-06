import React, { useEffect, useState } from 'react';
import { HashRouter, NavLink, Route, Routes, Link } from 'react-router-dom';
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
  const [refreshing, setRefreshing] = useState(false);

  const refresh = () => {
    api.overview().then(setOverview).catch(() => {});
  };

  useEffect(() => {
    refresh();
    // шапка обновляется сама: счёт в эфире и список трансляций
    const id = setInterval(refresh, 60000);
    return () => clearInterval(id);
  }, []);

  // Кнопка перезапускает сбор на сервере: заново обходятся VK/OK и ESPN.
  const forceRefresh = async () => {
    setRefreshing(true);
    try {
      await api.refresh();
    } catch {
      /* сервер занят другим проходом — покажем то, что есть */
    }
    refresh();
    setRefreshing(false);
  };

  const liveCount = overview?.live?.filter((m) => m.status === 'live').length || 0;
  const captured = overview?.sources?.['ingest.streams'];
  const refreshInfo = overview?.refresh;
  // В статическом снимке (GitHub Pages) сервера нет: данные обновляет сборка
  // сайта, а не запрос в браузере. Говорим об этом прямо, чтобы «автообновление
  // каждые 10 мин» не обещало того, чего на Pages не существует.
  const snapshot = overview?.snapshot;

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
          <nav className="nav" aria-label="Основная навигация">
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
                <div>
                  {snapshot
                    ? `снимок данных от ${new Date(snapshot.generated_at).toLocaleString('ru-RU', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}`
                    : `${new Date(overview.now).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}${
                        refreshInfo?.interval_minutes
                          ? ` · автообновление каждые ${refreshInfo.interval_minutes} мин`
                          : ' · VK Видео Live / OK Видео'
                      }`}
                </div>
                <button
                  type="button"
                  className="btn btn-sm refresh-btn"
                  onClick={forceRefresh}
                  disabled={refreshing}
                  title={
                    snapshot
                      ? 'Перечитать снимок. Данные на этой копии сайта обновляет сборка, а не запрос в браузере.'
                      : 'Заново обойти VK Видео Live, OK Видео и ESPN'
                  }
                >
                  {refreshing ? 'Обновляем…' : snapshot ? '⟳ Перечитать' : '⟳ Обновить'}
                </button>
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
              <a href="https://live.vkvideo.ru" target="_blank" rel="noreferrer">VK Видео Live</a>,{' '}
              <a href="https://ok.ru/video/live" target="_blank" rel="noreferrer">OK Видео</a> и{' '}
              <a href="https://matchtv.ru/video/channel/matchtv" target="_blank" rel="noreferrer">Матч ТВ</a> (прямые эфиры),{' '}
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

      {/* Нижняя навигация — только на телефонах (см. styles.css) */}
      <nav className="bottom-nav" aria-label="Навигация">
        <NavLink to="/" end><span className="bn-icon">🏠</span>Главная</NavLink>
        <NavLink to="/live"><span className="bn-icon">📺</span>Эфиры</NavLink>
        <NavLink to="/matches"><span className="bn-icon">⚽</span>Матчи</NavLink>
        <NavLink to="/tournaments"><span className="bn-icon">🏆</span>Турниры</NavLink>
      </nav>
    </>
  );
}

export default function App() {
  // HashRouter: на GitHub Pages нет сервера, который отдал бы index.html на
  // произвольный путь, поэтому маршруты живут после «#». Ссылки вида
  // /football-tv/matches всё равно работают — dist/404.html перенаправляет
  // путь в хеш.
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}
