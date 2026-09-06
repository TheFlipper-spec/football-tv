import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenfootballText } from '../ingest/openfootball.js';
import { aggregateEvents } from '../ingest/statsbomb.js';
import { parseVkLiveHtml, parseMatchtvHtml, buildEmbedUrl, streamId } from '../ingest/streams.js';
import { zonedToUtcIso, deriveStatus, minuteFromKickoff } from '../lib/time.js';

const RPL_TXT = `= Russia Premier League 2024/25

# Date       Sat Jul 20 2024 - Sat May 24 2025 (308d)
# Teams      16

▪ Matchday 1
  Sat Jul 20 2024
    15:00  Lokomotiv Moskva        v Akron Tolyatti           3-2 (2-2)
    17:30  Krylia Sovetov          v Zenit St. Petersburg     0-4 (0-3)
    20:00  FK Rostov               v CSKA Moskva              0-0
  Sun Jul 21
    17:30  FK Orenburg             v Spartak Moskva           2-0 (0-0)

▪ Matchday 2
  Fri Jul 26
    18:00  Krylia Sovetov          v FK Rostov                1-3 (0-1)
`;

test('парсер openfootball читает тур, дату, время, счёт и счёт перерыва', () => {
  const rows = parseOpenfootballText(RPL_TXT);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], {
    round: 'Matchday 1',
    date: '2024-07-20',
    time: '15:00',
    team1: 'Lokomotiv Moskva',
    team2: 'Akron Tolyatti',
    score: { ft: [3, 2], ht: [2, 2] },
  });
  assert.equal(rows[3].date, '2024-07-21');
  assert.equal(rows[4].round, 'Matchday 2');
});

test('местное время матча корректно переводится в UTC', () => {
  // 20:00 по Москве = 17:00 UTC (MSK = UTC+3)
  assert.equal(zonedToUtcIso('2026-09-06', '20:00', 'Europe/Moscow'), '2026-09-06T17:00:00.000Z');
  // 15:30 в Лондоне летом = 14:30 UTC (BST = UTC+1)
  assert.equal(zonedToUtcIso('2026-09-06', '15:30', 'Europe/London'), '2026-09-06T14:30:00.000Z');
});

test('статус матча выводится из времени и наличия счёта', () => {
  const past = new Date(Date.now() - 3600_000).toISOString();
  assert.equal(deriveStatus(past, false), 'live');
  assert.equal(deriveStatus(past, true), 'finished');
  assert.equal(deriveStatus(new Date(Date.now() + 86400_000).toISOString(), false), 'scheduled');
});

test('события StatsBomb агрегируются в статистику, таймлайн и бомбардиров', () => {
  const events = [
    { team: { name: 'France' }, type: { name: 'Pass' }, pass: {}, minute: 3 },
    { team: { name: 'France' }, type: { name: 'Pass' }, pass: { outcome: { name: 'Incomplete' } }, minute: 4 },
    { team: { name: 'France' }, type: { name: 'Pass' }, pass: { type: { name: 'Corner' } }, minute: 5 },
    {
      team: { name: 'France' },
      type: { name: 'Shot' },
      shot: { statsbomb_xg: 0.42, outcome: { name: 'Goal' } },
      player: { id: 3009, name: 'Kylian Mbappé Lottin' },
      minute: 61,
    },
    {
      team: { name: 'Denmark' },
      type: { name: 'Foul Committed' },
      foul_committed: { card: { name: 'Yellow Card' } },
      player: { id: 5555, name: 'Pierre-Emile Højbjerg' },
      minute: 70,
    },
    {
      team: { name: 'France' },
      type: { name: 'Substitution' },
      substitution: { replacement: { id: 2972, name: 'Marcus Thuram' } },
      player: { id: 3009, name: 'Kylian Mbappé Lottin' },
      minute: 78,
    },
  ];

  const agg = aggregateEvents(events, 'france', 'denmark', 'France', 'Denmark');

  assert.equal(agg.stats.france.passes_attempted, 3);
  assert.equal(agg.stats.france.passes_completed, 2);
  assert.equal(agg.stats.france.corners, 1);
  assert.equal(agg.stats.france.goals, 1);
  assert.equal(agg.stats.france.shots_on_target, 1);
  assert.ok(agg.stats.france.xg > 0.4 && agg.stats.france.xg < 0.5);
  assert.equal(agg.stats.france.possession_pct + agg.stats.denmark.possession_pct, 100);
  assert.equal(agg.stats.denmark.yellow_cards, 1);

  assert.deepEqual(agg.timeline.map((t) => t.type), ['goal', 'yellow', 'substitution']);
  assert.equal(agg.timeline[0].playerId, 'sb:3009');
  assert.equal(agg.timeline[2].relatedPlayerId, 'sb:2972');

  assert.equal(agg.scorers.length, 1);
  assert.equal(agg.scorers[0].playerId, 'sb:3009');
  assert.equal(agg.scorers[0].teamId, 'france');
});

test('парсер страницы VK Видео Live достаёт ссылки на эфиры', () => {
  const html = `
    <a href="https://live.vkvideo.ru/channel37051916/stream/sl_235167">
      <div>ОРЕНБУРГ - АКРОН | ПРЯМАЯ ТРАНСЛЯЦИЯ</div><span>899 зрителей</span>
    </a>
    <a href="https://live.vkvideo.ru/manutdone/stream/sl_234432">
      <div>Эвертон – Манчестер Юнайтед</div><span>908 зрителей</span>
    </a>`;
  const parsed = parseVkLiveHtml(html, 'https://live.vkvideo.ru/app/category/x', 'Футбол');
  assert.equal(parsed.streams.length, 2);
  assert.equal(parsed.streams[0].platform, 'vk');
  assert.ok(parsed.streams[0].url.endsWith('sl_235167'));
  assert.ok(parsed.streams[0].title.includes('ОРЕНБУРГ'));
});

test('игровая минута учитывает перерыв и не выходит за 90', () => {
  const now = Date.now();
  const kickoff = (minsAgo) => new Date(now - minsAgo * 60_000).toISOString();
  assert.equal(minuteFromKickoff(kickoff(0), now), 0);
  assert.equal(minuteFromKickoff(kickoff(30), now), 30, 'первый тайм — минута равна настенной');
  assert.equal(minuteFromKickoff(kickoff(50), now), 45, 'перерыв — держим 45-ю');
  assert.equal(minuteFromKickoff(kickoff(61), now), 46, 'второй тайм начинается с 46-й');
  assert.equal(minuteFromKickoff(kickoff(105), now), 90);
  assert.equal(minuteFromKickoff(kickoff(134), now), 90, 'больше 90-й не показываем — реальное добавленное время неизвестно');
});

test('ссылка встраиваемого плеера строится для VK и OK', () => {
  assert.equal(
    buildEmbedUrl('vk', 'https://live.vkvideo.ru/manutdone/stream/sl_234432'),
    'https://live.vkvideo.ru/app/embed/manutdone',
  );
  assert.equal(buildEmbedUrl('ok', 'https://ok.ru/video/1115050286838'), 'https://ok.ru/videoembed/1115050286838');
  assert.equal(buildEmbedUrl('vk', 'https://example.com/что-то-другое'), null);
  // Матч ТВ не отдаёт встраиваемый плеер внешним сайтам — эмбеда нет
  assert.equal(buildEmbedUrl('matchtv', 'https://matchtv.ru/on-air'), null);
});

test('парсер календаря Матч ТВ собирает страницы трансляций матчей', () => {
  const html = `
    <a href="https://matchtv.ru/football/rpl/matchtvvideo_NI2358157_translation_Baltika___Lokomotiv_Alfa_Bank_Rossijskaja_Premjer_Liga_Tur_7"><img src="x.jpg">с 20:30</a>
    <a href="https://matchtv.ru/football/rpl/matchtvvideo_NI2358157_translation_Baltika___Lokomotiv_Alfa_Bank_Rossijskaja_Premjer_Liga_Tur_7">Балтика - Локомотив</a><a href="https://matchtv.ru/football/rpl/matchtvvideo_NI2358157_translation_Baltika___Lokomotiv_Alfa_Bank_Rossijskaja_Premjer_Liga_Tur_7">Футбол. Альфа-Банк Российская Премьер-Лига. Тур 7</a>
    <a href="https://matchtv.ru/football/italy/matchtvvideo_NI2358164_translation_Juventus___Milan_Chempionat_Italii_Tur_3">Ювентус - Милан</a>
    <a href="https://matchtv.ru/news/obychnaja-novost">не трансляция</a>
  `;
  const parsed = parseMatchtvHtml(html, 'https://matchtv.ru/video/channel/matchtv');
  assert.equal(parsed.streams.length, 2, 'дубли одной страницы схлопываются, новости не попадают');
  const baltika = parsed.streams[0];
  assert.equal(baltika.platform, 'matchtv');
  assert.equal(baltika.channel, 'Матч ТВ');
  assert.equal(baltika.is_live, 0, 'анонс из календаря — ещё не эфир');
  assert.match(baltika.title, /Балтика - Локомотив/);
  assert.match(baltika.title, /Премьер-Лига/, 'берётся самый длинный текст карточки — с турниром');
});

test('id трансляции различает длинные ссылки Кубка России', () => {
  // slug() ограничен 64 символами: без хеша эти два url дали бы одинаковый id
  const a = streamId('matchtv', 'https://matchtv.ru/football/rossija/kubok_rossii/matchtvvideo_NI2360576_translation_Razan___Spartak_Kostroma_FONBET_Kubok_Rossii');
  const b = streamId('matchtv', 'https://matchtv.ru/football/rossija/kubok_rossii/matchtvvideo_NI2360578_translation_Tekstilshhik___Arsenal_FONBET_Kubok_Rossii');
  assert.notEqual(a, b);
  assert.ok(a.length <= 120 && b.length <= 120);
  // короткие id не меняются — иначе бы «поехали» все существующие записи
  assert.equal(streamId('vk', 'https://live.vkvideo.ru/manutdone/stream/sl_234432'), 'vk:https-live-vkvideo-ru-manutdone-stream-sl-234432');
});
