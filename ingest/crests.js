/**
 * Эмблемы клубов.
 *
 * Источник: https://github.com/sportlogos/football.db.logos — 334 настоящих PNG-эмблемы
 * клубов, разложенные по странам (сестринский репозиторий openfootball).
 *
 * Мы не хотлинким чужие домены: файлы копируются в web/public/crests/ и отдаются
 * нашим же сервером, поэтому эмблемы работают и без интернета.
 *
 * Соответствие «файл → команда» находится не по жёсткой таблице, а сопоставлением
 * нормализованного имени файла с тремя вариантами имени команды в базе:
 *   • id команды (слаговое, например `dinamo-moskva` → `dinamomoskva`)
 *   • официальное название (`Manchester United FC` → `manchesterunitedfc`)
 *   • русское название транслитом («Динамо М» → `dinamo m`)
 * Каждая эмблема достаётся ровно одной — лучшей по счёту — команде, поэтому
 * дублей не бывает.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../server/db.js';
import { transliterate, normalizeName, similarity } from '../lib/names.js';

const ALNUM = (s) => transliterate(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Слова-хвосты, которые не участвуют в сравнении («FC», «CF», «1907»…). */
const NOISE = new Set([
  'fc', 'cf', 'sc', 'ac', 'as', 'asd', 'ssc', 'cfc', 'afc', 'bk', 'fk', 'sk', 'if', 'cd', 'sd',
  'club', 'de', 'del', 'la', 'el', 'le', '1899', '1900', '1902', '1903', '1904', '1905', '1907',
  '1908', '1909', '1910', '1912', '1913', '1919', '1920', '1921', '1926', '1927', '1928', '1930',
  'moskva', 'moscow', 'st', 'petersburg', 'calcio', 'futbol', 'football',
]);

function tokensOf(name) {
  return transliterate(String(name || ''))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !NOISE.has(t) && !/^\d{3,4}$/.test(t));
}

/** Все варианты написания команды одним слитным ключом. */
function teamKeys(row) {
  const set = new Set();
  for (const raw of [row.id, row.name, row.name_ru]) {
    if (!raw) continue;
    const norm = ALNUM(raw);
    if (norm) set.add(norm);
    const tok = tokensOf(raw).join('');
    if (tok) set.add(tok);
  }
  return [...set];
}

function score(stem, candidate) {
  if (!stem || !candidate) return 0;
  if (stem === candidate) return 100;
  if (candidate.startsWith(stem) && stem.length >= 5) return 88;
  if (candidate.includes(stem) && stem.length >= 6) return 78;
  if (stem.startsWith(candidate) && candidate.length >= 5) return 74;
  const sim = similarity(candidate, stem);
  if (sim >= 0.55 && stem.length >= 5) return Math.round(sim * 80);
  return 0;
}

/** Явные соответствия там, где имя файла и название клуба расходятся. */
const OVERRIDES = {
  paris: 'paris-saint-germain',       // paris.png — это ПСЖ, а не «Париж»
  manunited: 'manchester-united',
  mancity: 'manchester-city',
  hull: 'hull-city',
  atletico: 'atl-tico-madrid',
  betis: 'real-betis',
  villareal: 'villarreal',
  malaga: 'm-laga',
  rayo: 'rayo-vallecano',
  almeria: 'almer-a',
  lyon: 'olympique-lyonnais',
  saintetienne: 'saint-tienne',
  hellasverona: 'hellas-verona',
  mgladbach: 'borussia-m-nchengladbach',
  aue: 'erzgebirge-aue',
  atletico: 'atl-tico',
  nice: 'ogc-nice',
  reims: 'stade-reims',
  braga: 'sporting-braga',
};

/**
 * Коды стран в именах папок и в турнирах openfootball местами расходятся:
 * папка `sc-scottland`, а турнир — `sco.1`. (Проверено по списку кодов в базе:
 * Германия — `de` в обоих местах, Уэльса в турнирах нет вовсе.)
 */
const COUNTRY_CODE_ALIAS = { sc: 'sco' };

/**
 * В немецкой части репозитория файлы названы с номером дивизиона:
 * `i-bayern.png` — Бундеслига, `ii-bochum.png` — вторая. Префикс срезаем.
 */
const DIVISION_PREFIX = /^(i{1,3})-/;

/** Эмблемы клубов, которых в базе нет (не сопоставляем ни с кем). */
const SKIP = new Set(['moskva']); // FC Moskva расформирован, CSKA — другой клуб

/** Суффиксы страны в id команд из репозитория openfootball/europe. */
const COUNTRY_SUFFIX = /-(eng|rus|esp|fra|ita|ger|por|ned|bel|sco|tur|ukr|pol|cze|aut|sui|den|swe|nor|grc|cro|rou|bul|srb|hun|isr|fin|arg|bra|ecu|per|par|uru|col|chi|bol|mex|usa|jpn|kor|chn|aus|irl|wal|svn|svk|blr|kaz|aze|arm|geo|ltu|lva|est|isr|cyp|mlt|lca)$/;

export function listCrests(srcDir) {
  const out = [];
  if (!fs.existsSync(srcDir)) return out;
  for (const continent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!continent.isDirectory() || continent.name === '.git') continue;
    const cPath = path.join(srcDir, continent.name);
    for (const country of fs.readdirSync(cPath, { withFileTypes: true })) {
      if (!country.isDirectory()) continue;
      const dirPath = path.join(cPath, country.name);
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.png')) continue;
        out.push({
          stem: ALNUM(file.replace(/\.png$/, '').replace(DIVISION_PREFIX, '')),
          file,
          country: country.name,
          continent: continent.name,
          src: path.join(dirPath, file),
        });
      }
    }
  }
  return out;
}

export function ingestCrests({
  log = console.log,
  srcDir = path.resolve('.cache/football-logos'),
  publicDir = path.resolve('web/public/crests'),
  threshold = 62,
} = {}) {
  const db = getDb();
  const crests = listCrests(srcDir);
  if (!crests.length) {
    log('  эмблемы: источник .cache/football-logos не найден — пропускаю');
    return { matched: 0, copied: 0 };
  }

  fs.mkdirSync(publicDir, { recursive: true });
  // прошлый прогон мог оставить неверные пары — сначала всё обнуляем
  db.prepare("UPDATE teams SET crest_url = NULL WHERE crest_url LIKE '/crests/%'").run();
  for (const old of fs.existsSync(publicDir) ? fs.readdirSync(publicDir) : []) {
    fs.rmSync(path.join(publicDir, old), { recursive: true, force: true });
  }
  const teams = db.prepare('SELECT id, name, name_ru FROM teams').all();
  const keysByTeam = new Map(teams.map((t) => [t.id, teamKeys(t)]));

  const insert = db.prepare('UPDATE teams SET crest_url = ? WHERE id = ?');

  // Страна клуба — из турниров, в которых он играет (openfootball:en.1 → «en»).
  // Без этого «Арсенал» из Саранди получал эмблему лондонского «Арсенала».
  const countryByTeam = new Map();
  for (const row of db
    .prepare(
      `SELECT DISTINCT m.team_id AS team_id, m.competition_id AS competition_id
         FROM (SELECT home_team_id AS team_id, competition_id FROM matches
               UNION
               SELECT away_team_id, competition_id FROM matches) m`,
    )
    .all()) {
    const raw = String(row.competition_id).split(':')[1]?.split('.')[0];
    // у StatsBomb турниры нумерованные (`statsbomb:9`) — страны из них не вывести
    if (!raw || !/^[a-z]{2,3}$/.test(raw)) continue;
    const code = raw;
    if (!countryByTeam.has(row.team_id)) countryByTeam.set(row.team_id, new Set());
    countryByTeam.get(row.team_id).add(code);
  }

  let matched = 0;
  let copied = 0;
  const misses = [];
  const taken = new Set();

  const ordered = [...crests].sort((a, b) => b.stem.length - a.stem.length || a.file.localeCompare(b.file));
  for (const crest of ordered) {
    if (SKIP.has(crest.stem)) {
      misses.push(crest.file);
      continue;
    }
    const crestCountry = COUNTRY_CODE_ALIAS[crest.country.split('-')[0]] || crest.country.split('-')[0];
    let best = null;
    const forced = OVERRIDES[crest.stem];
    for (const team of teams) {
      if (taken.has(team.id)) continue; // одна эмблема — одному клубу
      const known = countryByTeam.get(team.id);
      if (known?.size && !known.has(crestCountry)) continue; // не та страна
      for (const cand of keysByTeam.get(team.id) || []) {
        const s = forced ? (team.id === forced ? 100 : 0) : score(crest.stem, cand);
        if (s > (best?.score || 0)) best = { team, score: s, cand };
      }
    }
    if (!best || best.score < threshold) {
      misses.push(crest.file);
      continue;
    }
    const dest = path.join(publicDir, crest.country, crest.file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(crest.src, dest);
    copied += 1;
    const url = `/crests/${crest.country}/${crest.file}`;
    insert.run(url, best.team.id);
    taken.add(best.team.id);
    matched += 1;
  }

  // Клуб в базе бывает дважды — `arsenal` и `arsenal-eng` (openfootball и
  // openfootball/europe дают разные ключи). Раздаём эмблему обоим вариантам,
  // иначе у части матчей логотипа не будет.
  // Второй проход: openfootball хранит один клуб под разными ключами
  // (`real` и `real-madrid-esp`, `atl-tico` и `atl-tico-madrid-esp`). Если имена
  // совпадают с точностью до хвоста «(ESP)», эмблема достаётся обоим.
  const canon = (name) => ALNUM(String(name || '').replace(/\s*\([A-Za-z]{2,4}\)\s*$/, ''));
  const groups = new Map();
  for (const t of teams) {
    const key = canon(t.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t.id);
  }
  const crestOf = new Map(
    db.prepare("SELECT id, crest_url FROM teams WHERE crest_url IS NOT NULL AND crest_url <> ''")
      .all()
      .map((r) => [r.id, r.crest_url]),
  );
  let byName = 0;
  for (const ids of groups.values()) {
    const donor = ids.map((id) => crestOf.get(id)).find(Boolean);
    if (!donor) continue;
    for (const id of ids) {
      if (crestOf.has(id)) continue;
      insert.run(donor, id);
      crestOf.set(id, donor);
      byName += 1;
    }
  }

  const withCrest = db
    .prepare("SELECT id, crest_url FROM teams WHERE crest_url IS NOT NULL AND crest_url <> ''")
    .all();
  const ids = new Set(teams.map((t) => t.id));
  const suffixes = (COUNTRY_SUFFIX.source.match(/[a-z]{2,3}/g) || []);
  let propagated = 0;
  for (const row of withCrest) {
    for (const cc of suffixes) {
      const twin = `${row.id}-${cc}`;
      if (!ids.has(twin) || twin === row.id) continue;
      const cur = db.prepare('SELECT crest_url FROM teams WHERE id = ?').get(twin);
      if (cur?.crest_url) continue;
      insert.run(row.crest_url, twin);
      propagated += 1;
    }
  }

  const total = db
    .prepare("SELECT COUNT(*) AS n FROM teams WHERE crest_url IS NOT NULL AND crest_url <> ''")
    .get().n;
  log(`  эмблемы: ${copied} файлов, сопоставлено ${matched}, по суффиксу страны +${propagated}, по совпадению имён +${byName}, всего команд с эмблемой ${total}`);
  if (misses.length) log(`  эмблемы без пары (${misses.length}): ${misses.slice(0, 12).join(', ')}${misses.length > 12 ? '…' : ''}`);
  setMetaCrests(copied, matched);
  return { copied, matched, total, propagated, misses };
}

function setMetaCrests(copied, matched) {
  const db = getDb();
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('crests.copied', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(copied));
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('crests.matched', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(matched));
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('crests.at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(new Date().toISOString());
}
