import test from 'node:test';
import assert from 'node:assert/strict';
import { transliterate, normalizeName, teamKey, slug, similarity } from '../lib/names.js';

test('транслитерация кириллицы в латиницу', () => {
  assert.equal(transliterate('Оренбург'), 'orenburg');
  assert.equal(transliterate('Крылья Советов'), 'krylya sovetov');
  assert.equal(transliterate('Манчестер Юнайтед'), 'manchester yunayted');
  assert.equal(transliterate('ЦСКА'), 'tsska');
});

test('нормализация убирает клубные суффиксы и шум', () => {
  assert.equal(normalizeName('Manchester United FC'), 'manchester united');
  assert.equal(normalizeName('«Зенит» (Санкт-Петербург)'), normalizeName('Зенит Санкт-Петербург'));
  assert.equal(teamKey('FC Barcelona'), 'barcelona');
  assert.equal(teamKey('Arsenal FC'), 'arsenal');
});

test('slug безопасен для идентификаторов', () => {
  assert.equal(slug('Крылья Советов'), 'krylya-sovetov');
  assert.equal(slug('  A / B  '), 'a-b');
});

test('similarity различает близкие и разные названия', () => {
  assert.ok(similarity('Эвертон — Манчестер Юнайтед', 'Everton Manchester Yunayted') > 0.5);
  assert.equal(similarity('Оренбург Акрон', 'Эвертон Ливерпуль'), 0);
});
