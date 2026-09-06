/**
 * Перевод «местного» времени матча в UTC без внешних зависимостей.
 */

const partsCache = new Map();

function zonedParts(date, timeZone) {
  let fmt = partsCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    partsCache.set(timeZone, fmt);
  }
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  const hour = out.hour === '24' ? 0 : Number(out.hour);
  return Date.UTC(Number(out.year), Number(out.month) - 1, Number(out.day), hour, Number(out.minute));
}

/**
 * dateStr "YYYY-MM-DD", timeStr "HH:MM", timeZone — IANA.
 * Возвращает ISO-строку в UTC (или null, если вход неполный).
 */
export function zonedToUtcIso(dateStr, timeStr, timeZone) {
  if (!dateStr) return null;
  const [Y, M, D] = dateStr.split('-').map(Number);
  if (!Y || !M || !D) return null;
  const [h = 0, m = 0] = (timeStr || '00:00').split(':').map(Number);
  const naive = Date.UTC(Y, M - 1, D, h, m);
  let guess = naive;
  for (let i = 0; i < 3; i += 1) {
    const offset = zonedParts(new Date(guess), timeZone) - guess;
    const next = naive - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString();
}

export function utcDateOnly(iso) {
  return iso ? iso.slice(0, 10) : null;
}

/** Статус матча по времени и наличию счёта. */
export function deriveStatus(kickoffUtc, hasScore, explicitStatus = null) {
  if (explicitStatus) return explicitStatus;
  if (hasScore) return 'finished';
  if (!kickoffUtc) return 'scheduled';
  const start = Date.parse(kickoffUtc);
  const now = Date.now();
  if (Number.isNaN(start)) return 'scheduled';
  const fullTime = start + 125 * 60 * 1000;
  if (now >= start && now < fullTime) return 'live';
  return 'scheduled';
}

/**
 * Оценка игровой минуты по времени начала матча.
 *
 * Настенные часы ≠ минута матча: после 45-й идёт 15-минутный перерыв,
 * поэтому его вычитаем, а больше 90-й не показываем — реальную добавленную
 * минуту без живого источника узнать нельзя.
 */
export function minuteFromKickoff(kickoffUtc, now = Date.now()) {
  if (!kickoffUtc) return null;
  const start = Date.parse(kickoffUtc);
  if (Number.isNaN(start)) return null;
  const mins = Math.floor((now - start) / 60000);
  if (mins < 0) return 0;
  if (mins <= 45) return mins;        // первый тайм
  if (mins <= 60) return 45;          // перерыв
  if (mins <= 105) return mins - 15;  // второй тайм: 61-я настенная = 46-я игровая
  return 90;                          // добавленное время — без источника только «90'»
}
