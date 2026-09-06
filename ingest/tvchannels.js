/**
 * Телеканалы, транслирующие футбол.
 *
 * Идея: если матч показывают по телевизору (РПЛ — на «Матч ТВ»), то на
 * странице матча должна быть и трансляция телеканала. Основной путь — сайт
 * самого канала: календарь matchtv.ru разбирается в ingest/streams.js
 * (parseMatchtvHtml), и к каждому матчу привязывается СТРАНИЦА ЕГО
 * СОБСТВЕННОЙ трансляции (matchtv.ru/…/matchtvvideo_NI…_translation_…).
 *
 * Ссылка ниже — запасной вариант: общий прямой эфир канала для матчей
 * турниров канала, у которых отдельной страницы трансляции не нашлось.
 *
 * Встраивание плеера Матч ТВ в iframe канал не разрешает (проверено:
 * /vdl/player/media/… внешним сайтам отдаёт заглушку), поэтому embed_url
 * пуст — интерфейс честно открывает эфир на сайте канала.
 *
 * `competitions` — суффиксы id турниров, которые канал показывает
 * (openfootball и ESPN хранят один турнир под разными id, поэтому
 * суффиксов несколько — как в lib/matcher.js).
 */

export const TV_CHANNELS = [
  {
    id: 'matchtv-site',
    channel: 'Матч ТВ',
    title: 'Прямой эфир Матч ТВ',
    platform: 'matchtv',
    url: 'https://matchtv.ru/on-air',
    embed_url: null,
    source_page: 'https://matchtv.ru/video/channel/matchtv',
    verified: '2026-09-06',
    // Матч ТВ — главный вещатель РПЛ (подтверждается анонсами каждого тура).
    competitions: ['ru.1', 'rus.1'],
  },
];

/** Быстрый поиск канала по url его эфира. */
export const TV_CHANNEL_BY_URL = new Map(TV_CHANNELS.map((c) => [c.url, c]));

/**
 * Матчи каких турниров этот эфир должен «подсветить».
 * @param {string} competitionId — например 'openfootball:ru.1' или 'espn:rus.1'
 */
export function channelBroadcasts(channel, competitionId = '') {
  return channel.competitions.some((suffix) => competitionId.endsWith(suffix));
}
