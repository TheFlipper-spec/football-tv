/**
 * Трансляции: VK Видео Live, OK Видео и календарь Матч ТВ.
 *
 * В обычной сети `npm run ingest:streams` скачивает страницы категорий
 * live.vkvideo.ru / ok.ru и календарь трансляций matchtv.ru, обновляя
 * таблицу streams. Если сети нет, используется последний снимок из
 * data/snapshots/*.json (снимки — реальные, с временем захвата).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isSea } from 'node:sea';
import { getDb, setMeta, withTransaction } from '../server/db.js';
import { slug } from '../lib/names.js';
import { matchStream, teamAliases } from '../lib/matcher.js';
import { TV_CHANNELS, TV_CHANNEL_BY_URL, channelBroadcasts } from './tvchannels.js';

const VK_CATEGORY_URLS = [
  { url: 'https://live.vkvideo.ru/app/category/596a416c-76b3-4ec4-bba1-52b3d51378b2', category: 'Футбол' },
  { url: 'https://live.vkvideo.ru/app/category/93825d66-5a06-4016-a7cb-fbf25dc6da5d', category: 'Спорт' },
];

/** Календарь трансляций на канале «Матч ТВ» — там ссылки на страницы матчей. */
const MATCHTV_CALENDAR_URL = 'https://matchtv.ru/video/channel/matchtv';

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

/**
 * Календарь трансляций на сайте Матч ТВ (matchtv.ru/video/channel/matchtv).
 *
 * У каждого матча там СВОЯ страница трансляции вида
 * https://matchtv.ru/football/rpl/matchtvvideo_NI…_translation_Baltika___Lokomotiv_…
 * На одну и ту же страницу с карточки ведут несколько ссылок (картинка со
 * временем, названия команд, строка турнира) — берём самый длинный текст:
 * это «Команда — Команда» плюс название турнира, то, что нужно матчеру.
 * Если текста нет вовсе, название восстанавливается из slug самой ссылки.
 *
 * Анонсы из календаря — не текущий эфир, поэтому is_live = 0; после привязки
 * к матчам ingestStreams помечает живыми те страницы, чей матч сейчас идёт.
 */
export function parseMatchtvHtml(html, sourceUrl) {
  const byUrl = new Map();
  const re = /href="(https:\/\/matchtv\.ru\/[^"]*matchtvvideo_NI\d+_translation_([^"?#]+))"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    const tail = html.slice(m.index + m[0].length, m.index + m[0].length + 600).replace(/<[^>]+>/g, '  ');
    const text = tail.replace(/\s+/g, ' ').trim().split(/\s{2,}/).filter(Boolean)
      .join(' · ').slice(0, 200);
    const prev = byUrl.get(url);
    if (!prev) {
      byUrl.set(url, { url, slug: m[2], title: text });
    } else if (text.length > prev.title.length) {
      prev.title = text;
    }
  }
  const streams = [...byUrl.values()].map((s) => ({
    platform: 'matchtv',
    category: 'Матч ТВ — календарь трансляций',
    title: s.title || s.slug.split('_').filter(Boolean).join(' '),
    channel: 'Матч ТВ',
    url: s.url,
    viewers: 0,
    is_live: 0,
  }));
  return { streams, sourceUrl, category: 'Матч ТВ — календарь трансляций' };
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

/**
 * Id трансляции из платформы и url. Длинные url (страницы календаря Матч ТВ
 * доходят до 190 символов) нельзя просто обрезать: slug() ограничен 64
 * символами, а ссылки «Кубка России» различаются только хвостом — обрезка
 * давала им одинаковый id и UNIQUE constraint. Если slug упёрся в лимит,
 * добавляется хеш полного url. Короткие id (vk, ok) не меняются.
 */
export function streamId(platform, url) {
  const s = slug(url);
  if (s.length < 64) return `${platform}:${s}`;
  const hash = crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 10);
  return `${platform}:${s}-${hash}`;
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
      streamId(s.platform, s.url),
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
 * Постоянные эфиры телеканалов (Матч ТВ и т.п.) — не зависят от парсинга
 * категорий: это официальные круглосуточные трансляции, ссылки в справочнике
 * ingest/tvchannels.js. Обновляем captured_at при каждом проходе, чтобы
 * эфир не считался устаревшим.
 */
export function upsertTvChannels(capturedAt = new Date().toISOString()) {
  return upsertStreams(
    TV_CHANNELS.map((c) => ({
      platform: c.platform,
      category: 'ТВ-канал',
      title: c.title,
      channel: c.channel,
      url: c.url,
      embed_url: c.embed_url,
      viewers: 0,
      is_live: 1,
    })),
    capturedAt,
    'tv-channels',
  );
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

  /*
   * Календарь Матч ТВ анонсирует трансляции почти на неделю вперёд, поэтому
   * для страниц matchtv окно кандидатов шире обычного: ссылка «Зенит —
   * Локомотив, 12 сентября» должна привязаться к матчу уже сегодня.
   */
  const MATCHTV_HOURS_AFTER = 8 * 24;
  const hasMatchtv = streams.some((s) => s.platform === 'matchtv');
  const maxAfter = hasMatchtv ? Math.max(windowHoursAfter, MATCHTV_HOURS_AFTER) : windowHoursAfter;

  const anchors = streams
    .map((s) => Date.parse(s.captured_at || ''))
    .filter((t) => !Number.isNaN(t));
  anchors.push(Date.now());
  const from = new Date(Math.min(...anchors) - windowHoursBefore * 3600_000).toISOString();
  const to = new Date(Math.max(...anchors) + maxAfter * 3600_000).toISOString();
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
    const after = stream.platform === 'matchtv' ? MATCHTV_HOURS_AFTER : windowHoursAfter;
    const lo = captured - windowHoursBefore * 3600_000;
    const hi = captured + after * 3600_000;
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

    // Матчи, к которым уже привязана СОБСТВЕННАЯ страница трансляции на
    // matchtv.ru — общий эфир канала им не нужен, у них есть точная ссылка.
    const coveredByMatchtvPage = new Set();

    for (const stream of streams) {
      const found = matchStream(stream, candidatesFor(stream), aliasesByTeam);
      for (const f of found) {
        insert.run(stream.id, f.matchId, f.score, `title-match:${f.matched}teams`);
        n += 1;
        seen.add(stream.id);
        if (stream.platform === 'matchtv') coveredByMatchtvPage.add(f.matchId);
      }
    }

    /*
     * Эфир телеканала привязывается по турниру, а не по названию: если
     * «Матч ТВ» транслирует РПЛ, его прямой эфир добавляется к матчам РПЛ
     * в окне −3 ч … +24 ч от «сейчас» — но только тем, у которых не нашлось
     * собственной страницы трансляции в календаре канала. Балл ниже, чем у
     * прямых эфиров конкретного матча, поэтому в списке трансляций матча
     * канал идёт после них, а не вместо них.
     */
    for (const stream of streams) {
      const tv = TV_CHANNEL_BY_URL.get(stream.url);
      if (!tv) continue;
      const now = Date.now();
      for (const m of matches) {
        if (!channelBroadcasts(tv, m.competition_id)) continue;
        if (coveredByMatchtvPage.has(m.id)) continue;
        const t = Date.parse(m.kickoff_utc);
        if (Number.isNaN(t) || t < now - 3 * 3600_000 || t > now + 24 * 3600_000) continue;
        insert.run(stream.id, m.id, 0.4, 'tv-channel');
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
        platform: s.platform || snap.platform || 'vk',
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

  /*
   * Календарь Матч ТВ — отдельный источник со своим запасным снимком:
   * он даёт страницы трансляций КОНКРЕТНЫХ матчей на сайте канала.
   * При живой сети снимок обновляется, без сети берётся последний
   * (даже если VK при этом отвечал и общий режим — live).
   */
  const matchtvSnapshot = path.join(snapshotsDir, 'matchtv-calendar.json');
  try {
    const html = fetchSync(MATCHTV_CALENDAR_URL);
    const parsed = parseMatchtvHtml(html, MATCHTV_CALENDAR_URL);
    if (!parsed.streams.length) throw new Error('календарь пуст — вероятно, отдана заглушка');
    const capturedAt = new Date().toISOString();
    total += upsertStreams(parsed.streams, capturedAt, 'matchtv-calendar');
    fs.mkdirSync(snapshotsDir, { recursive: true });
    fs.writeFileSync(
      matchtvSnapshot,
      JSON.stringify(
        { captured_at: capturedAt, platform: 'matchtv', source_url: MATCHTV_CALENDAR_URL, streams: parsed.streams },
        null,
        2,
      ),
    );
    log(`  календарь Матч ТВ: ${parsed.streams.length} страниц трансляций`);
  } catch (err) {
    log(`  matchtv.ru недоступен (${err.message}) — календарь беру из снимка`);
    if (mode === 'live' && fs.existsSync(matchtvSnapshot)) {
      // в snapshot-режиме этот файл уже загрузил общий цикл по снимкам
      const snap = JSON.parse(fs.readFileSync(matchtvSnapshot, 'utf8'));
      total += upsertStreams(snap.streams || [], snap.captured_at || new Date().toISOString(), 'matchtv-calendar');
    }
  }

  // Постоянные эфиры телеканалов идут поверх любого режима (live или снимок):
  // это официальные круглосуточные трансляции, их время «захвата» — сейчас.
  const tvCount = upsertTvChannels();
  total += tvCount;

  db.prepare('UPDATE streams SET is_live = 0 WHERE captured_at < ?').run(
    new Date(Date.now() - 12 * 3600_000).toISOString(),
  );
  setMeta('ingest.streams', new Date().toISOString());
  setMeta('ingest.streams.mode', mode);
  log(`  трансляции: ${total} (${mode}, из них ТВ-каналов: ${tvCount})`);
  const linked = rebuildMatchStreams({ log });

  // Анонс из календаря Матч ТВ становится «живым», когда его матч в эфире.
  // Общий эфир канала (matchtv.ru/on-air) не трогаем — он идёт круглосуточно.
  db.prepare(
    `UPDATE streams SET is_live = CASE WHEN EXISTS (
        SELECT 1 FROM match_streams ms JOIN matches m ON m.id = ms.match_id
         WHERE ms.stream_id = streams.id AND m.status = 'live'
      ) THEN 1 ELSE 0 END
      WHERE platform = 'matchtv' AND url LIKE '%translation%'`,
  ).run();

  return { total, mode, ...linked };
}

/** Внутри собранного exe (SEA) — process.execPath это сам бинарник, не node. */
const EMBEDDED = typeof isSea === 'function' && isSea();

/**
 * Синхронный fetch с жёстким таймаутом — нужен только в скрипте инжеста.
 *
 * Поднимается дочерний node-процесс, чтобы таймаут был жёстким. В собранном
 * исполняемом файле отдельного интерпретатора нет, поэтому там живые источники
 * не обходятся: трансляции честно берутся из встроенных реальных снимков.
 */
function fetchSync(url) {
  if (EMBEDDED) {
    throw new Error(`нет доступа к ${url} (в exe живые источники отключены — используется снимок)`);
  }
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

