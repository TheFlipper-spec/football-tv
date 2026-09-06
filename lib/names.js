/**
 * Нормализация и транслитерация названий.
 * Используется и в инжесте, и в матчинге трансляций, поэтому живёт в общем модуле.
 */

const CYRILLIC = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'i', є: 'e', ґ: 'g', ў: 'u',
};

/** Латинские лигатуры и буквы, которые NFD-разложение не упрощает само. */
const LATIN_SPECIAL = { ß: 'ss', ø: 'o', đ: 'd', ł: 'l', æ: 'ae', œ: 'oe', þ: 'th', ð: 'd', ı: 'i' };

export function transliterate(input = '') {
  const mapped = String(input)
    .toLowerCase()
    .split('')
    .map((ch) => (ch in CYRILLIC ? CYRILLIC[ch] : ch in LATIN_SPECIAL ? LATIN_SPECIAL[ch] : ch))
    .join('');
  // Диакритика складывается ПОСЛЕ кириллической карты (иначе NFD разложил бы
  // «й» на «и + бреве» и сломал транслитерацию): Málaga → malaga, München → munchen.
  return mapped.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Слова-паразиты, которые не несут смысла при сравнении названий. */
const NOISE = new Set([
  'fc', 'cf', 'afc', 'sc', 'sk', 'fk', 'ac', 'as', 'ss', 'cd', 'sd', 'ud', 'rc',
  'club', 'de', 'the', 'фк', 'кф', 'team', 'futbol', 'football', 'club de',
]);

/** Суффиксы/префиксы клубов, которые отбрасываем при построении ключа. */
const SUFFIXES = [
  ' fc', ' cf', ' afc', ' sc', ' sk', ' fk', ' ac', ' as', ' ss', ' cd', ' sd', ' ud',
  ' de madrid', ' de barcelona', ' madrid', ' calcio',
];

export function normalizeName(name = '') {
  let s = transliterate(name);
  s = s.replace(/[«»"'’‘"()]/g, ' ');
  s = s.replace(/[^a-z0-9\s-]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  for (const suf of SUFFIXES) {
    if (s.endsWith(suf)) s = s.slice(0, -suf.length).trim();
  }
  const parts = s.split(' ').filter((w) => w && !NOISE.has(w));
  return parts.join(' ') || transliterate(name).replace(/\s+/g, ' ').trim();
}

export function teamKey(name = '') {
  return normalizeName(name).replace(/\s+/g, '-').replace(/-+/g, '-');
}

export function slug(input = '') {
  return transliterate(input)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Токены для нечёткого сравнения. Дефис — тоже разделитель: «Оренбург-Акрон». */
export function tokens(text = '') {
  return normalizeName(text)
    .split(/[\s-]+/)
    .filter((t) => t.length > 1);
}

/**
 * Коэффициент совпадения двух строк (0..1): доля общих токенов + штраф за длину.
 */
export function similarity(a = '', b = '') {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  if (!shared) return 0;
  const union = new Set([...ta, ...tb]).size;
  return shared / union;
}

/** Расстояние Левенштейна — для коротких названий. */
export function editDistance(a = '', b = '') {
  const x = normalizeName(a).replace(/\s+/g, '');
  const y = normalizeName(b).replace(/\s+/g, '');
  if (!x.length || !y.length) return Math.max(x.length, y.length);
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= y.length; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[y.length];
}
