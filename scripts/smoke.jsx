// Смоук-тест: монтирует НАСТОЯЩЕЕ приложение (роутер + данные с API)
// в jsdom и проверяет, что каждая страница реально отрисовывается.
import { JSDOM } from 'jsdom';

const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:8080';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: ORIGIN + '/',
  pretendToBeVisual: true,
});
const { window } = dom;
const define = (key, value) => {
  try {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  } catch { /* узел уже даёт это свойство только на чтение */ }
};
define('window', window);
define('document', window.document);
define('navigator', window.navigator);
global.HTMLElement = window.HTMLElement;
global.Element = window.Element;
global.Node = window.Node;
global.Event = window.Event;
global.CustomEvent = window.CustomEvent;
global.MouseEvent = window.MouseEvent;
global.KeyboardEvent = window.KeyboardEvent;
global.PopStateEvent = window.PopStateEvent;
global.getComputedStyle = window.getComputedStyle;
global.requestAnimationFrame = window.requestAnimationFrame;
global.cancelAnimationFrame = window.cancelAnimationFrame;
global.history = window.history;
global.location = window.location;
global.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
global.IS_REACT_ACT_ENVIRONMENT = true;

// Node-fetch не умеет относительные URL — разворачиваем их в адрес API
const nodeFetch = globalThis.fetch;
globalThis.fetch = (input, init) =>
  nodeFetch(typeof input === 'string' && input.startsWith('/') ? ORIGIN + input : input, init);

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const App = (await import('../web/src/App.jsx')).default;

const hush = (s) => !/not wrapped in act|useLayoutEffect|ReactDOMTestUtils/.test(s);
const origError = console.error;
const origWarn = console.warn;
console.error = (...a) => hush(String(a[0])) && origError(...a);
console.warn = (...a) => hush(String(a[0])) && origWarn(...a);

const root = createRoot(document.getElementById('root'));
await act(async () => {
  root.render(React.createElement(App));
});
const settle = async (ms = 1200) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};
await settle();

const failures = [];
// проверяем только содержимое <main>, чтобы шапка и подвал не давали ложных срабатываний
const main = () => document.querySelector('main') || document.body;
const text = () => main().textContent.replace(/\s+/g, ' ').trim();
const html = () => main().innerHTML;
const expect = (cond, label) => {
  console.log(`  ${cond ? 'OK ' : 'ERR'} ${label}`);
  if (!cond) failures.push(label);
};

async function visit(path, waitMs = 900) {
  await act(async () => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new window.PopStateEvent('popstate'));
  });
  await settle(waitMs);
  return { text: text(), html: html() };
}

console.log('\nМаршруты (реальный рендер в DOM, данные с API):');
const home = { text: text(), html: html() };
console.log(`  /                    ${home.text.length} символов текста`);
expect(home.text.includes('Эвертон'), '/ — живой матч Эвертон — Манчестер Юнайтед');
expect(/трансляц/i.test(home.text), '/ — блок трансляций');
expect(home.html.includes('vkvideo.ru'), '/ — ссылки на эфиры VK Видео Live в контенте');

const matches = await visit('/matches');
console.log(`  /matches             ${matches.text.length} символов текста`);
expect(/матч/i.test(matches.text) && matches.text.length > 2000, '/matches — список матчей загружен');

const live = await visit('/live');
console.log(`  /live                ${live.text.length} символов текста`);
expect(/эфир|сейчас/i.test(live.text) && live.text.length > 500, '/live — раздел эфиров');

const streams = await visit('/streams');
console.log(`  /streams             ${streams.text.length} символов текста`);
expect(streams.html.includes('vkvideo.ru'), '/streams — реальные VK-потоки');
expect(/Оренбург/.test(streams.text), '/streams — Оренбург — Акрон привязан к эфирам');

const tours = await visit('/tournaments');
console.log(`  /tournaments         ${tours.text.length} символов текста`);
expect(tours.text.includes('Российская Премьер-лига'), '/tournaments — РПЛ в списке');

const tour = await visit('/tournament/openfootball:en.1');
console.log(`  /tournament/…en.1    ${tour.text.length} символов текста`);
expect(/Манчестер Сити/.test(tour.text), '/tournament/…en.1 — таблица АПЛ рассчитана');
expect(/Оренбург|Бомбардир|Голы/i.test(tour.text), '/tournament/…en.1 — блоки таблицы/бомбардиров');

const overview = await (await fetch(ORIGIN + '/api/overview')).json();
const match = await visit('/match/' + overview.featured.id, 1200);
console.log(`  /match/<featured>    ${match.text.length} символов текста`);
expect(/Эвертон/.test(match.text) && /Манчестер Юнайтед/.test(match.text), '/match — карточка матча');
expect(match.html.includes('vkvideo.ru'), '/match — прямые эфиры матча');

const team = await visit('/team/everton');
console.log(`  /team/everton        ${team.text.length} символов текста`);
expect(/Эвертон/.test(team.text), '/team/everton — страница клуба');

const sb = await visit('/match/statsbomb:3857266', 1200);
console.log(`  /match/<statsbomb>   ${sb.text.length} символов текста`);
expect(/Франция|Дания|Марсьяль|xG/i.test(sb.text), '/match StatsBomb — глубокая статистика');

await act(async () => root.unmount());
console.log(failures.length ? `\nПРОВАЛЕНО: ${failures.length}` : '\nвсе маршруты отрисовались без ошибок');
process.exit(failures.length ? 1 : 0);
