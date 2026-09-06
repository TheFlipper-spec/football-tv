import test from 'node:test';
import assert from 'node:assert/strict';
import { matchStream, teamAliases, parseTitleDate } from '../lib/matcher.js';

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
  // live-слой ESPN хранит тот же матч под другим id турнира
  { id: 'm4', competition_id: 'espn:rus.1', home_team_id: 'fk-orenburg', away_team_id: 'akron-tolyatti' },
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

test('бонус за ключевое слово лиги работает и для id турниров ESPN', () => {
  const found = matchStream(
    { title: 'Оренбург - Акрон | РПЛ 7 тур | 06.09.26 14:00 по МСК' },
    matches,
    aliasesByTeam,
  );
  const ids = found.map((f) => f.matchId).sort();
  assert.deepEqual(ids, ['m1', 'm4'], 'связываются оба представления матча — openfootball и ESPN');
});

test('нечёткий матчинг: склонения, слитный дефис и опечатки', () => {
  // русские склонения названий
  assert.equal(matchStream({ title: 'Матч Оренбурга и Акрона сегодня' }, matches, aliasesByTeam)[0]?.matchId, 'm1');
  // дефис без пробелов не мешает
  assert.equal(matchStream({ title: 'ОРЕНБУРГ-АКРОН LIVE' }, matches, aliasesByTeam)[0]?.matchId, 'm1');
  // опечатки в пределах одной буквы на слово
  assert.equal(matchStream({ title: 'Эвиртон - Манчистер Юнайтед' }, matches, aliasesByTeam)[0]?.matchId, 'm2');
});

test('прозвища клубов: «МЮ» находит Манчестер Юнайтед', () => {
  const found = matchStream({ title: 'Эвертон - МЮ | прямая трансляция' }, matches, aliasesByTeam);
  assert.equal(found[0]?.matchId, 'm2');
});

test('дата в названии эфира разруливает двух кандидатов с общей командой', () => {
  const withDates = [
    { id: 'd1', competition_id: 'openfootball:en.1', home_team_id: 'everton', away_team_id: 'manchester-united', kickoff_utc: '2026-09-06T13:00:00Z' },
    { id: 'd2', competition_id: 'openfootball:en.1', home_team_id: 'liverpool', away_team_id: 'everton', kickoff_utc: '2026-09-13T13:00:00Z' },
  ];
  const a = matchStream({ title: 'Эвертон – Манчестер Юнайтед 06.09.2026' }, withDates, aliasesByTeam);
  assert.equal(a[0].matchId, 'd1');
  const b = matchStream({ title: 'Ливерпуль - Эвертон 13.09.2026' }, withDates, aliasesByTeam);
  assert.equal(b[0].matchId, 'd2');
});

test('parseTitleDate достаёт дату из свободного текста', () => {
  assert.equal(parseTitleDate('эфир 06.09.26 14:00 по МСК'), '2026-09-06');
  assert.equal(parseTitleDate('матч 6.9.2026!'), '2026-09-06');
  assert.equal(parseTitleDate('без даты'), null);
  assert.equal(parseTitleDate('счёт 99.99.99'), null);
});

test('одна команда с ключевым словом лиги матчится, без него — нет', () => {
  const found = matchStream({ title: 'Оренбург сегодня в РПЛ!' }, matches, aliasesByTeam);
  assert.equal(found[0]?.matchId, 'm1');
  const none = matchStream({ title: 'Оренбург: интервью с тренером' }, matches, aliasesByTeam);
  assert.deepEqual(none, []);
});
