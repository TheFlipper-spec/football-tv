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
import { getDb, setMeta, withTransaction } from '../server/db.js';
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

/**
 * Ссылка встраиваемого плеера.
 *
 * VK Видео Live отдаёт публичный embed по каналу: live.vkvideo.ru/app/embed/<канал>
 * показывает текущий эфир этого канала (это официальный код из кнопки
 * «Поделиться → Встроить», токен для него не нужен). OK Видео встраивается
 * по id ролика: ok.ru/videoembed/<id>.
 */
export function buildEmbedUrl(platform, url) {
  if (platform === 'vk') {
    const m = /live\.vkvideo\.ru\/([^/?#]+)\/stream\//.exec(String(url || ''));
    return m && m[1] !== 'app' ? `https://live.vkvideo.ru/app/embed/${m[1]}` : null;
  }
  if (platform === 'ok') {
    const m = /ok\.ru\/(?:videoembed|video|live)\/(\d+)/.exec(String(url || ''));
    return m ? `https://ok.ru/videoembed/${m[1]}` : null;
  }
  return null;
}

function upsertStreams(list, capturedAt, snapshotId) {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO streams (id, platform, category, title, channel, url, embed_url, viewers, is_live, captured_at, snapshot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       title = excluded.title, channel = excluded.channel, embed_url = excluded.embed_url,
       viewers = excluded.viewers,
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
      s.embed_url || buildEmbedUrl(s.platform, s.url),
      Number(s.viewers || 0),
      s.is_live == null ? 1 : Number(s.is_live),
      capturedAt,
      snapshotId || null,
    );
    n += 1;
  }
  return n;
}

/**
 * Связывает трансляции с матчами.
 *
 * Окно кандидатов считается от времени захвата КАЖДОЙ трансляции, а не от
 * «сейчас»: эфир, снятый в 13:02, относится к матчам вокруг 13:02. Раньше окно
 * скользило от текущего времени, и стоило серверу перезапустить связывание
 * через 6 часов после начала матча — все его эфиры «отвязывались», хотя и матч,
 * и трансляции никуда не делись.
 */
export function rebuildMatchStreams({ windowHoursBefore = 12, windowHoursAfter = 48, log = console.log } = {}) {
  const db = getDb();

  const streams = db.prepare('SELECT * FROM streams').all();

  const anchors = streams
    .map((s) => Date.parse(s.captured_at || ''))
    .filter((t) => !Number.isNaN(t));
  anchors.push(Date.now());
  const from = new Date(Math.min(...anchors) - windowHoursBefore * 3600_000).toISOString();
  const to = new Date(Math.max(...anchors) + windowHoursAfter * 3600_000).toISOString();
  const matches = db
    .prepare(
      `SELECT id, competition_id, home_team_id, away_team_id, kickoff_utc
         FROM matches
        WHERE kickoff_utc IS NOT NULL AND kickoff_utc BETWEEN ? AND ?`,
    )
    .all(from, to);

  const teams = db.prepare('SELECT id, name, name_ru, short_name FROM teams').all();
  const aliasesByTeam = new Map(teams.map((t) => [t.id, teamAliases(t)]));

  /** Кандидаты для конкретной трансляции — окно вокруг её времени захвата. */
  const candidatesFor = (stream) => {
    const captured = Date.parse(stream.captured_at || '');
    if (Number.isNaN(captured)) return matches;
    const lo = captured - windowHoursBefore * 3600_000;
    const hi = captured + windowHoursAfter * 3600_000;
    return matches.filter((m) => {
      const t = Date.parse(m.kickoff_utc);
      return t >= lo && t <= hi;
    });
  };

  /*
   * Удаление и вставка — одна транзакция. Иначе сайт, открытый в момент
   * автообновления, видит таблицу связей наполовину пустой: матч теряет
   * трансляции и выпадает из featured. Ровно так снимок для GitHub Pages
   * однажды собрался с другим главным матчем.
   */
  const { links, matchedStreams } = withTransaction((tx) => {
    tx.exec('DELETE FROM match_streams');
    const insert = tx.prepare(
      `INSERT INTO match_streams (stream_id, match_id, score, method) VALUES (?, ?, ?, ?)
       ON CONFLICT(stream_id, match_id) DO UPDATE SET score = excluded.score`,
    );
    let n = 0;
    const seen = new Set();
    for (const stream of streams) {
      const found = matchStream(stream, candidatesFor(stream), aliasesByTeam);
      for (const f of found) {
        insert.run(stream.id, f.matchId, f.score, `title-match:${f.matched}teams`);
        n += 1;
        seen.add(stream.id);
      }
    }
    return { links: n, matchedStreams: seen };
  });

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
