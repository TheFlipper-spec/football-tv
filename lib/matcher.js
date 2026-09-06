/**
 * Сопоставление трансляций (VK Видео Live, OK Видео) с матчами из базы.
 * Названия трансляций пишутся по-русски, команды в базе — по-английски,
 * поэтому обе стороны прогоняются через транслитерацию и нормализацию.
 */
import { normalizeName, tokens } from './names.js';

/** Ключевые слова турниров в названиях трансляций → суффикс id турнира. */
export const LEAGUE_KEYWORDS = [
  { words: ['rpl', 'premer-liga', 'premier-liga'], suffix: 'ru.1' },
  { words: ['apl', 'epl', 'premiership'], suffix: 'en.1' },
  { words: ['la liga', 'laliga', 'primera'], suffix: 'es.1' },
  { words: ['seriya a', 'serie a'], suffix: 'it.1' },
  { words: ['bundesliga', 'bundeslig'], suffix: 'de.1' },
  { words: ['liga 1', 'ligue 1'], suffix: 'fr.1' },
  { words: ['lch', 'liga chempionov', 'champions league'], suffix: 'uefa.cl' },
  { words: ['chempionship', 'championship'], suffix: 'en.2' },
  { words: ['eredivizi', 'eredivisie'], suffix: 'nl.1' },
  { words: ['euro-2024', 'evro 2024', 'euro 2024'], suffix: '55' },
  { words: ['chempionat mira', 'world cup'], suffix: '43' },
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
  for (const { words, suffix } of LEAGUE_KEYWORDS) {
    if (words.some((w) => titleNorm.includes(w)) && competitionId.endsWith(suffix)) return 0.15;
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
