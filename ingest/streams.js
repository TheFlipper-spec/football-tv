/**
 * Трансляции: VK Видео Live и OK Видео.
 *
 * В обычной сети `npm run ingest:streams` скачивает страницы категорий
 * live.vkvideo.ru / ok.ru и обновляет таблицу streams.
 * Если сети нет, используется последний снимок из data/snapshots/*.json
 * (снимки — реальные, с временем захвата).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getDb, setMeta } from '../server/db.js';
import { slug } from '../lib/names.js';
import { matchStream, teamAliases } from '../lib/matcher.js';

const VK_CATEGORY_URLS = [
  { url: 'https://live.vkvideo.ru/app/category/596a416c-76b3-4ec4-bba1-52b3d51378b2', category: 'Футбол' },
  { url: 'https://live.vkvideo.ru/app/category/93825d66-5a06-4016-a7cb-fbf25dc6da5d', category: 'Спорт' },
];

/**
 * Разбор HTML страницы категории live.vkvideo.ru.
 * Ссылки вида https://live.vkvideo.ru/<канал>/stream/<id> + текст карточки.
 */
export function parseVkLiveHtml(html, sourceUrl, category) {
  const streams = [];
  const seen = new Set();
  const re = /href="(https:\/\/live\.vkvideo\.ru\/([^/"?]+)\/stream\/([^/"?]+))"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    // текст карточки — всё, что идёт после ссылки до следующего тега-контейнера
    const tail = html.slice(m.index, m.index + 1600).replace(/<[^>]+>/g, ' ');
    const title = tail
      .replace(/\s+/g, ' ')
      .trim()
      .split(/\s{2,}/)[0]
      ?.slice(0, 200);
    const viewers = tail.match(/(\d[\d\s.,]*K?)\s*(зрител|viewers)/i);
    streams.push({
      platform: 'vk',
      category,
      title: title || url,
      channel: m[2],
      url,
      viewers: viewers ? Number(viewers[1].replace(/[^\d]/g, '')) : 0,
    });
  }
  return { streams, sourceUrl, category };
}

export function parseOkLiveHtml(html, sourceUrl) {
  const streams = [];
  const seen = new Set();
  const re = /href="(https:\/\/ok\.ru\/video\/(\d+))"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    const tail = html.slice(m.index, m.index + 1200).replace(/<[^>]+>/g, ' ');
    const title = tail.replace(/\s+/g, ' ').trim().split(/\s{2,}/)[0]?.slice(0, 200);
    streams.push({ platform: 'ok', category: 'ТВ-каналы, прямой эфир', title: title || url, channel: null, url, viewers: 0 });
  }
  return { streams, sourceUrl, category: 'ТВ-каналы, прямой эфир' };
}

function snapshotFiles(snapshotsDir) {
  if (!fs.existsSync(snapshotsDir)) return [];
  return fs
    .readdirSync(snapshotsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(snapshotsDir, f));
}

function upsertStreams(list, capturedAt, snapshotId) {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO streams (id, platform, category, title, channel, url, viewers, is_live, captured_at, snapshot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       title = excluded.title, channel = excluded.channel, viewers = excluded.viewers,
       is_live = excluded.is_live, captured_at = excluded.captured_at, snapshot_id = excluded.snapshot_id`,
  );
  let n = 0;
  for (const s of list) {
    stmt.run(
      `${s.platform}:${slug(s.url)}`.slice(0, 120),
      s.platform,
      s.category || null,
      s.title,
      s.channel || null,
      s.url,
      Number(s.viewers || 0),
      s.is_live == null ? 1 : Number(s.is_live),
      capturedAt,
      snapshotId || null,
    );
    n += 1;
  }
  return n;
}

/** Связывает трансляции с матчами в окне -6ч … +48ч. */
export function rebuildMatchStreams({ windowHoursBefore = 6, windowHoursAfter = 48, log = console.log } = {}) {
  const db = getDb();
  const now = Date.now();
  const from = new Date(now - windowHoursBefore * 3600_000).toISOString();
  const to = new Date(now + windowHoursAfter * 3600_000).toISOString();
  const matches = db
    .prepare(
      `SELECT id, competition_id, home_team_id, away_team_id
         FROM matches
        WHERE kickoff_utc IS NOT NULL AND kickoff_utc BETWEEN ? AND ?`,
    )
    .all(from, to);

  const teams = db.prepare('SELECT id, name, name_ru, short_name FROM teams').all();
  const aliasesByTeam = new Map(teams.map((t) => [t.id, teamAliases(t)]));

  db.exec('DELETE FROM match_streams');
  const streams = db.prepare('SELECT * FROM streams').all();
  const insert = db.prepare(
    `INSERT INTO match_streams (stream_id, match_id, score, method) VALUES (?, ?, ?, ?)
     ON CONFLICT(stream_id, match_id) DO UPDATE SET score = excluded.score`,
  );

  let links = 0;
  const matchedStreams = new Set();
  for (const stream of streams) {
    const found = matchStream(stream, matches, aliasesByTeam);
    for (const f of found) {
      insert.run(stream.id, f.matchId, f.score, `title-match:${f.matched}teams`);
      links += 1;
      matchedStreams.add(stream.id);
    }
  }
  setMeta('streams.matched_at', new Date().toISOString());
  log(`  связи трансляций: ${links} (${matchedStreams.size} из ${streams.length} трансляций)`);
  return { links, matched: matchedStreams.size, streams: streams.length };
}

export function ingestStreams({ snapshotsDir, live = true, log = console.log }) {
  const db = getDb();
  let total = 0;
  let mode = 'snapshot';

  if (live) {
    for (const { url, category } of VK_CATEGORY_URLS) {
      try {
        const html = fetchSync(url);
        const parsed = parseVkLiveHtml(html, url, category);
        if (parsed.streams.length) {
          const capturedAt = new Date().toISOString();
          total += upsertStreams(parsed.streams, capturedAt, null);
          // сохраняем снимок, чтобы сайт пережил отсутствие сети
          fs.mkdirSync(snapshotsDir, { recursive: true });
          fs.writeFileSync(
            path.join(snapshotsDir, `vk-live-${new Date().toISOString().slice(0, 10)}.json`),
            JSON.stringify(
              { captured_at: capturedAt, platform: 'vk', source_url: url, category, streams: parsed.streams },
              null,
              2,
            ),
          );
          mode = 'live';
        }
      } catch (err) {
        log(`  live.vkvideo.ru недоступен (${err.message}) — беру снимок из data/snapshots`);
      }
    }
  }

  if (mode === 'snapshot') {
    for (const file of snapshotFiles(snapshotsDir)) {
      const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
      const capturedAt = snap.captured_at || new Date().toISOString();
      const list = [...(snap.streams || []), ...(snap.side_streams || [])].map((s) => ({
        platform: snap.platform || 'vk',
        category: s.category || snap.category || null,
        title: s.title,
        channel: s.channel || null,
        url: s.url,
        viewers: s.viewers || 0,
        is_live: s.is_live == null ? 1 : s.is_live,
      }));
      total += upsertStreams(list, capturedAt, path.basename(file));
    }
  }

  db.prepare('UPDATE streams SET is_live = 0 WHERE captured_at < ?').run(
    new Date(Date.now() - 12 * 3600_000).toISOString(),
  );
  setMeta('ingest.streams', new Date().toISOString());
  setMeta('ingest.streams.mode', mode);
  log(`  трансляции: ${total} (${mode})`);
  const linked = rebuildMatchStreams({ log });
  return { total, mode, ...linked };
}

/** Синхронный fetch — нужен только в скрипте инжеста. */
function fetchSync(url) {
  const script = `
    fetch(${JSON.stringify(url)}, { headers: { 'user-agent': 'Mozilla/5.0 (football-tv ingest)' } })
      .then(r => r.text())
      .then(t => process.stdout.write(t))
      .catch(e => { process.stderr.write(String(e)); process.exit(1); });
  `;
  try {
    return execFileSync(process.execPath, ['--input-type=commonjs', '-e', script], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30000,
      // stderr дочернего процесса не показываем: при отсутствии интернета он
      // печатает «TypeError: fetch failed» на каждый URL, а вызывающий код и так
      // сообщает, что берётся снимок
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8');
  } catch (err) {
    throw new Error(`нет доступа к ${url} (${err.code || 'offline'})`);
  }
}
