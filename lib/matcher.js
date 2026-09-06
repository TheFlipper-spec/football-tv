/**
 * Сопоставление трансляций (VK Видео Live, OK Видео) с матчами из базы.
 * Названия трансляций пишутся по-русски, команды в базе — по-английски,
 * поэтому обе стороны прогоняются через транслитерацию и нормализацию.
 */
import { normalizeName, tokens } from './names.js';

/**
 * Ключевые слова турниров в названиях трансляций → суффиксы id турнира.
 * Суффиксов несколько, потому что один турнир живёт под разными id:
 * календарь openfootball («openfootball:ru.1») и live-слой ESPN («espn:rus.1»).
 */
export const LEAGUE_KEYWORDS = [
  { words: ['rpl', 'premer-liga', 'premier-liga', 'rfpl'], suffixes: ['ru.1', 'rus.1'] },
  { words: ['apl', 'epl', 'premiership'], suffixes: ['en.1', 'eng.1'] },
  { words: ['la liga', 'laliga', 'primera'], suffixes: ['es.1', 'esp.1'] },
  { words: ['seriya a', 'serie a'], suffixes: ['it.1', 'ita.1'] },
  { words: ['bundesliga', 'bundeslig'], suffixes: ['de.1', 'ger.1'] },
  { words: ['liga 1', 'ligue 1'], suffixes: ['fr.1', 'fra.1'] },
  { words: ['lch', 'liga chempionov', 'champions league'], suffixes: ['uefa.cl', 'uefa.champions'] },
  { words: ['liga evropy', 'ligi evropy', 'europa league'], suffixes: ['uefa.el', 'uefa.europa'] },
  { words: ['chempionship', 'championship'], suffixes: ['en.2', 'eng.2'] },
  { words: ['eredivizi', 'eredivisie'], suffixes: ['nl.1'] },
  { words: ['euro-2024', 'evro 2024', 'euro 2024'], suffixes: ['55'] },
  { words: ['chempionat mira', 'world cup'], suffixes: ['43'] },
];

/** Набор строк-псевдонимов команды (все токены должны найтись в названии). */
export function teamAliases(team) {
  const out = new Set();
  for (const raw of [team.name, team.name_ru, team.id]) {
    if (!raw) continue;
    const norm = normalizeName(raw);
    if (norm.length >= 4) out.add(norm);
  }
  return [...out];
}

function leagueBonus(titleNorm, competitionId = '') {
  for (const { words, suffixes } of LEAGUE_KEYWORDS) {
    if (words.some((w) => titleNorm.includes(w)) && suffixes.some((s) => competitionId.endsWith(s))) return 0.15;
  }
  return 0;
}

/**
 * @param {{title:string}} stream
 * @param {Array} matches — кандидаты с полями id, competition_id, home_team_id, away_team_id
 * @param {Map<string, string[]>} aliasesByTeam
 */
export function matchStream(stream, matches, aliasesByTeam) {
  const titleNorm = normalizeName(stream.title || '');
  const titleTokens = new Set(tokens(stream.title || ''));
  const results = [];

  for (const m of matches) {
    let score = 0;
    let matched = 0;
    for (const teamId of [m.home_team_id, m.away_team_id]) {
      const aliases = aliasesByTeam.get(teamId) || [];
      const hit = aliases.some((alias) => alias.split(' ').every((w) => titleTokens.has(w)));
      if (hit) {
        matched += 1;
        score += 0.5;
      }
    }
    if (!matched) continue;
    score += leagueBonus(titleNorm, m.competition_id);
    results.push({ matchId: m.id, score: Math.round(score * 100) / 100, matched });
  }

  return results
    .filter((r) => (r.matched === 2 && r.score >= 0.9) || (r.matched === 1 && r.score >= 0.65))
    .sort((a, b) => b.score - a.score);
}
