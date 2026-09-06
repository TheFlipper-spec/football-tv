import test from 'node:test';
import assert from 'node:assert/strict';
import { matchStream, teamAliases } from '../lib/matcher.js';

const teams = {
  'fk-orenburg': { id: 'fk-orenburg', name: 'FK Orenburg', name_ru: 'Оренбург' },
  'akron-tolyatti': { id: 'akron-tolyatti', name: 'Akron Tolyatti', name_ru: 'Акрон' },
  everton: { id: 'everton', name: 'Everton FC', name_ru: 'Эвертон' },
  'manchester-united': { id: 'manchester-united', name: 'Manchester United FC', name_ru: 'Манчестер Юнайтед' },
  liverpool: { id: 'liverpool', name: 'Liverpool FC', name_ru: 'Ливерпуль' },
  'fk-rostov': { id: 'fk-rostov', name: 'FK Rostov', name_ru: 'Ростов' },
};

const aliasesByTeam = new Map(Object.entries(teams).map(([id, t]) => [id, teamAliases(t)]));

const matches = [
  { id: 'm1', competition_id: 'openfootball:ru.1', home_team_id: 'fk-orenburg', away_team_id: 'akron-tolyatti' },
  { id: 'm2', competition_id: 'openfootball:en.1', home_team_id: 'everton', away_team_id: 'manchester-united' },
  { id: 'm3', competition_id: 'openfootball:en.1', home_team_id: 'liverpool', away_team_id: 'everton' },
];

test('реальный заголовок VK-эфира связывается с матчем РПЛ', () => {
  const found = matchStream(
    { title: 'ОРЕНБУРГ - АКРОН | ПРЯМАЯ ТРАНСЛЯЦИЯ' },
    matches,
    aliasesByTeam,
  );
  assert.equal(found[0].matchId, 'm1');
  assert.equal(found[0].matched, 2);
});

test('заголовок с указанием тура АПЛ связывается с Эвертон — МЮ', () => {
  const found = matchStream(
    { title: '3 тур АПЛ | Эвертон - Манчестер Юнайтед | прямая трансляция | 06.09.2026 в 16:00 мск' },
    matches,
    aliasesByTeam,
  );
  assert.equal(found[0].matchId, 'm2');
});

test('нерелевантный эфир ни к чему не привязывается', () => {
  const found = matchStream(
    { title: 'ЮФЛ Центр U-16. 25 тур. ОК СШОР «Металлург» - СШ «Витязь»' },
    matches,
    aliasesByTeam,
  );
  assert.deepEqual(found, []);
});

test('одна команда без ключевого слова турнира — недостаточно для связи', () => {
  const found = matchStream({ title: 'Ростов играет дома' }, matches, aliasesByTeam);
  assert.deepEqual(found, []);
});
