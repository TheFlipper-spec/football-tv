import React, { useState } from 'react';
import { api } from '../api.js';
import { useData, fmtDateTime, plural } from '../utils.jsx';
import { StreamCard, SectionHead, Loading, ErrorBox } from '../components.jsx';

const FILTERS = [
  { id: 'all', label: 'Все площадки' },
  { id: 'vk', label: 'VK Видео Live' },
  { id: 'ok', label: 'OK Видео' },
  { id: 'matched', label: 'Привязанные к матчам' },
];

export default function Streams() {
  const [filter, setFilter] = useState('all');
  const { data, loading, error } = useData(
    () => api.streams(filter === 'matched' ? { matched: 1 } : filter === 'all' ? {} : { platform: filter }),
    [filter],
  );

  const captured = data?.captured_at ? new Date(data.captured_at) : null;

  return (
    <div className="fade-in">
      <SectionHead
        title="Прямые трансляции"
        count={data?.streams?.length}
        sub="Эфиры собираются из категории «Футбол» на live.vkvideo.ru и из раздела прямых эфиров OK Видео, затем сопоставляются с матчами из базы по названию трансляции."
      />

      <div className="chips" style={{ marginBottom: 16 }}>
        {FILTERS.map((f) => (
          <button key={f.id} className={`chip ${filter === f.id ? 'active' : ''}`} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      {captured && (
        <div className="notice" style={{ marginBottom: 18 }}>
          Снимок трансляций снят <b>{fmtDateTime(data.captured_at)}</b>. Трансляции живут недолго: чтобы обновить
          список на сервере с интернетом, выполните <code>npm run ingest:streams</code>.
        </div>
      )}

      {loading && <Loading label="Загружаем эфиры…" />}
      {error && <ErrorBox error={error} />}
      {data && !loading && (
        data.streams.length ? (
          <div className="stream-grid">
            {data.streams.map((s) => <StreamCard key={s.id} s={s} />)}
          </div>
        ) : (
          <div className="empty">На этой площадке сейчас нет эфиров в снимке</div>
        )
      )}
    </div>
  );
}
