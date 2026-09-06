/**
 * Детерминированный ключ файла для статического снимка API.
 *
 * Один и тот же код выполняется и в Node (scripts/export-static.js), и в браузере
 * (web/src/staticApi.js) — иначе браузер не угадает имя файла, которое положил
 * экспортер. Поэтому здесь только строки и целочисленная арифметика: никаких
 * node:crypto, никаких зависимостей от окружения.
 *
 * Идентификаторы в базе длинные и содержат символы, неудобные в URL
 * (`openfootball:en.1:2026-27:2026-09-06:everton-fc-manchester-united-fc`),
 * поэтому ключ = читаемый слаг + короткий хеш FNV-1a. Хеш нужен не для красоты,
 * а чтобы разные id с похожими слагами не легли в один файл: экспортер
 * проверяет коллизии и падает, если они появились.
 */

/** FNV-1a, 32 бита. Достаточно, чтобы развести тысячи идентификаторов. */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hash36(str) {
  return fnv1a32(str).toString(36);
}

/**
 * @param {string} kind  раздел снимка: `match` | `competition` | `team`
 * @param {string} id    идентификатор из базы (для турнира — `id` или `id@season`)
 * @returns {string}     относительный путь без расширения, например
 *                       `match/openfootball-en-1-2026-27-2026-09-06-everton-fc-ma-k3j9x2`
 */
export function staticKey(kind, id) {
  const raw = String(id == null ? '' : id);
  const slug = raw
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${kind}/${slug || 'x'}-${hash36(`${kind}:${raw}`)}`;
}

/** Ключ турнира: сам турнир или конкретный его сезон. */
export function competitionKey(id, season) {
  return staticKey('competition', season ? `${id}@${season}` : id);
}
