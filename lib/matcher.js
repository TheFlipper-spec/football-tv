/**
 * Сопоставление трансляций (VK Видео Live, OK Видео) с матчами из базы.
 *
 * Названия эфиров пишут люди, и пишут как угодно: «ОРЕНБУРГ-АКРОН», «Эвертон
 * – МЮ», «Барса сегодня!!!», «Оренбурга — Акрона 06.09.26 14:00 по МСК».
 * Поэтому матчер не полагается на точное совпадение:
 *
 *   1) обе стороны транслитерируются и нормализуются (lib/names.js);
 *   2) слова сравниваются нечётко — совпадение по началу слова покрывает
 *      русские склонения («Оренбурга» ~ «orenburg»), расстояние Левенштейна
 *      прощает опечатки и разночтения транслитерации;
 *   3) известные прозвища клубов («МЮ», «Барса», «Юве», «Локо»…) добавляются
 *      к псевдонимам автоматически;
 *   4) дата и время из названия эфира сверяются с временем начала матча —
 *      это добивает уверенность там, где найдена только одна команда,
 *      и отсекает эфир вчерашнего матча от сегодняшнего.
 */
import { normalizeName, tokens } from './names.js';

/**
 * Ключевые слова турниров в названиях трансляций → суффиксы id турнира.
 * Суффиксов несколько, потому что один турнир живёт под разными id:
 * календарь openfootball («openfootball:ru.1») и live-слой ESPN («espn:rus.1»).
 */
export const LEAGUE_KEYWORDS = [
  { words: ['rpl', 'premer-liga', 'premier-liga', 'rfpl', 'mir rpl'], suffixes: ['ru.1', 'rus.1'] },
  { words: ['apl', 'epl', 'premiership', 'angliyskaya premer'], suffixes: ['en.1', 'eng.1'] },
  { words: ['la liga', 'laliga', 'primera', 'ispanii'], suffixes: ['es.1', 'esp.1'] },
  { words: ['seriya a', 'serie a', 'italii'], suffixes: ['it.1', 'ita.1'] },
  { words: ['bundesliga', 'bundeslig', 'germanii'], suffixes: ['de.1', 'ger.1'] },
  { words: ['liga 1', 'ligue 1', 'frantsii'], suffixes: ['fr.1', 'fra.1'] },
  { words: ['lch', 'liga chempionov', 'ligi chempionov', 'champions league'], suffixes: ['uefa.cl', 'uefa.champions'] },
  { words: ['liga evropy', 'ligi evropy', 'europa league'], suffixes: ['uefa.el', 'uefa.europa'] },
  { words: ['chempionship', 'championship'], suffixes: ['en.2', 'eng.2'] },
  { words: ['eredivizi', 'eredivisie'], suffixes: ['nl.1'] },
  { words: ['euro-2024', 'evro 2024', 'euro 2024'], suffixes: ['55'] },
  { words: ['chempionat mira', 'world cup'], suffixes: ['43'] },
];

/**
 * Народные прозвища клубов. Ключи — нормализованные варианты официального
 * названия (латиница после транслитерации), значения — такие же
 * нормализованные прозвища, которыми эфиры называют клуб.
 */
const NICKNAMES = [
  { canon: ['manchester yunayted', 'manchester united'], alts: ['myu', 'man yunayted', 'manyunayted'] },
  { canon: ['manchester siti', 'manchester city'], alts: ['man siti', 'mansiti'] },
  { canon: ['real madrid'], alts: ['real'] },
  { canon: ['barselona', 'barcelona'], alts: ['barsa'] },
  { canon: ['bavariya', 'bayern munich', 'bayern myunkhen'], alts: ['bayern', 'bavariya'] },
  { canon: ['pari sen-zhermen', 'paris saint-germain', 'pari sen zhermen'], alts: ['pszh', 'psg'] },
  { canon: ['yuventus', 'juventus'], alts: ['yuve'] },
  { canon: ['lokomotiv', 'lokomotiv moskva', 'lokomotiv moscow'], alts: ['loko'] },
  { canon: ['atletiko madrid', 'atletico madrid', 'atletiko'], alts: ['atletiko'] },
  { canon: ['borussiya dortmund', 'borussia dortmund'], alts: ['borussiya d', 'bd'] },
  { canon: ['volverkhempton', 'wolverhampton wanderers', 'vulverkhempton'], alts: ['vulvz', 'wolves'] },
  { canon: ['tottenkhem khotspur', 'tottenham hotspur', 'tottenkhem'], alts: ['shpory', 'tottenkhem'] },
  { canon: ['krylya sovetov'], alts: ['krylya'] },
  { canon: ['npo saturn', 'saturn ramenskoe'], alts: ['saturn'] },
];

/** Набор строк-псевдонимов команды (каждый псевдоним — список слов). */
export function teamAliases(team) {
  const out = new Set();
  for (const raw of [team.name, team.name_ru, team.id]) {
    if (!raw) continue;
    const norm = normalizeName(raw);
    if (norm.length >= 4) out.add(norm);
  }
  // прозвища: если официальное имя узнано — добавляем народные варианты
  for (const { canon, alts } of NICKNAMES) {
    if (canon.some((c) => out.has(c))) for (const a of alts) out.add(a);
  }
  return [...out];
}

function leagueBonus(titleNorm, competitionId = '') {
  for (const { words, suffixes } of LEAGUE_KEYWORDS) {
    if (words.some((w) => titleNorm.includes(w)) && suffixes.some((s) => competitionId.endsWith(s))) return 0.15;
  }
  return 0;
}

/** Быстрое расстояние Левенштейна с потолком (дальше считать бессмысленно). */
function editDistanceCapped(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Насколько слово псевдонима похоже на какой-нибудь токен названия эфира.
 * 1 — точное совпадение; 0.92 — совпадение по началу слова (склонения:
 * «оренбурга» ~ «orenburg»); 0.85 — опечатка/разночтение транслитерации
 * в пределах расстояния Левенштейна; 0 — не похоже.
 */
function wordScore(word, titleTokens) {
  for (const t of titleTokens) {
    if (t === word) return 1;
  }
  for (const t of titleTokens) {
    if (word.length >= 4 && t.length >= 4) {
      const [shorter, longer] = word.length <= t.length ? [word, t] : [t, word];
      // «оренбург» ↔ «оренбурга/оренбургом»: хвост склонения не длиннее 3 букв
      if (longer.startsWith(shorter) && longer.length - shorter.length <= 3) return 0.92;
    }
    const cap = word.length >= 9 ? 2 : word.length >= 5 ? 1 : 0;
    if (cap && editDistanceCapped(word, t, cap) <= cap) return 0.85;
  }
  return 0;
}

/** Похожесть псевдонима (все слова должны найтись); 0 — псевдоним не найден. */
function aliasScore(alias, titleTokens) {
  const words = alias.split(' ').filter(Boolean);
  if (!words.length) return 0;
  let sum = 0;
  for (const w of words) {
    const s = wordScore(w, titleTokens);
    if (!s) return 0;
    sum += s;
  }
  return sum / words.length;
}

/** Дата dd.mm.yy(yy) из сырого названия эфира → 'YYYY-MM-DD' или null. */
export function parseTitleDate(title = '') {
  const m = /(\d{1,2})[./](\d{1,2})[./](\d{2,4})/.exec(String(title));
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y = Number(m[3]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  if (y < 100) y += 2000;
  if (y < 2000 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Бонус/штраф за дату в названии эфира. Сверяем и с UTC-датой матча, и с
 * московской (большинство русскоязычных эфиров указывают время по МСК).
 */
function dateBonus(titleRaw, kickoffUtc) {
  const titleDate = parseTitleDate(titleRaw);
  if (!titleDate || !kickoffUtc) return 0;
  const t = Date.parse(kickoffUtc);
  if (Number.isNaN(t)) return 0;
  const utcDate = new Date(t).toISOString().slice(0, 10);
  const mskDate = new Date(t + 3 * 3600_000).toISOString().slice(0, 10);
  if (titleDate === utcDate || titleDate === mskDate) return 0.12;
  return -0.2; // дата указана и не совпала — это эфир другого дня
}

/**
 * @param {{title:string}} stream
 * @param {Array} matches — кандидаты с полями id, competition_id, home_team_id,
 *   away_team_id и (опционально) kickoff_utc
 * @param {Map<string, string[]>} aliasesByTeam
 */
export function matchStream(stream, matches, aliasesByTeam) {
  const titleRaw = stream.title || '';
  const titleNorm = normalizeName(titleRaw);
  const titleTokens = [...new Set(tokens(titleRaw))];
  if (!titleTokens.length) return [];
  const results = [];

  for (const m of matches) {
    let score = 0;
    let matched = 0;
    for (const teamId of [m.home_team_id, m.away_team_id]) {
      const aliases = aliasesByTeam.get(teamId) || [];
      let best = 0;
      for (const alias of aliases) {
        const s = aliasScore(alias, titleTokens);
        if (s > best) best = s;
        if (best === 1) break;
      }
      if (best > 0) {
        matched += 1;
        score += 0.5 * best;
      }
    }
    if (!matched) continue;
    const league = leagueBonus(titleNorm, m.competition_id);
    const date = dateBonus(titleRaw, m.kickoff_utc);
    score += league + date;
    results.push({ matchId: m.id, score: Math.round(score * 100) / 100, matched, league: league > 0, date });
  }

  /*
   * Порог: обе команды — достаточно самих команд (0.78 прощает склонения и
   * опечатки, а штраф за чужую дату всё равно валит ниже). Одна команда —
   * только вместе с ключевым словом турнира: одна фамилия клуба в заголовке
   * без контекста слишком часто означает обзор, интервью или другой матч.
   * Совпавшая дата при этом добавляет уверенности, несовпавшая — отнимает.
   */
  return results
    .filter((r) => (r.matched === 2 && r.score >= 0.78) || (r.matched === 1 && r.league && r.score >= 0.58))
    .sort((a, b) => b.score - a.score)
    .map(({ matchId, score, matched }) => ({ matchId, score, matched }));
}
