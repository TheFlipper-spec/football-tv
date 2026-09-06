// Смоук-тест: монтирует НАСТОЯЩЕЕ приложение (роутер + данные с API)
// в jsdom и проверяет, что каждая страница реально отрисовывается.
import { JSDOM, VirtualConsole } from 'jsdom';

const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:8080';

// jsdom не реализует window.open и пишет об этом в консоль — нам как раз нужен
// его «не открылось», чтобы проверить запасной путь. Шум глушим.
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => {
  if (!/Not implemented: window\.open/.test(String(e.message))) console.error(e);
});

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: ORIGIN + '/',
  pretendToBeVisual: true,
  virtualConsole,
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
expect(home.html.includes('src="/crests/'), '/ — на главной видны эмблемы клубов');

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

// --- эмблемы: картинка в DOM и она реально отдаётся сервером ---
const imgs = [...document.querySelectorAll('main img[src^="/crests/"]')].map((i) => i.getAttribute('src'));
expect(imgs.length > 0, 'эмблемы клубов отрисованы как <img>');
if (imgs.length) {
  const probe = await fetch(ORIGIN + imgs[0]);
  expect(probe.ok && probe.headers.get('content-type')?.includes('image'), `файл эмблемы отдаётся: ${imgs[0]} (${probe.status})`);
}

// --- кнопка «Смотреть»: всплывающее окно заблокировано → должно открыться наше окно ---
await visit('/streams', 900);
const watch = [...document.querySelectorAll('main a')].find((a) => /Смотреть в/.test(a.textContent || ''));
expect(!!watch, 'кнопка «Смотреть» есть в карточке трансляции');
if (watch) {
  await act(async () => {
    watch.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle(300);
  const modal = document.querySelector('.modal-veil');
  expect(!!modal, 'при заблокированном всплывающем окне открывается окно с ссылкой');
  if (modal) {
    expect(/https?:\/\//.test(modal.textContent || '') || !!modal.querySelector('code'), 'в окне видна ссылка на эфир');
    const closeBtn = modal.querySelector('.modal-close');
    await act(async () => { closeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    await settle(200);
    expect(!document.querySelector('.modal-veil'), 'окно закрывается');
  }
}

// --- автообновление: серверный refresh и поле в meta ---
const meta = await (await fetch(ORIGIN + '/api/meta')).json();
expect(!!meta.refresh && meta.refresh.interval_minutes > 0, 'автообновление включено на сервере');
const refreshed = await (await fetch(ORIGIN + '/api/refresh', { method: 'POST' })).json();
expect(refreshed.runs >= 1 && !refreshed.last_error, `POST /api/refresh прошёл (${refreshed.streams} трансляций, ${refreshed.matched} связей, режим ${refreshed.streams_mode})`);

// --- вкладки матча: события, составы, статистика должны РЕАЛЬНО рендериться ---
const clickTab = async (label) => {
  const btn = [...document.querySelectorAll('.tabs .tab')].find((b) => (b.textContent || '').startsWith(label));
  if (!btn) return null;
  await act(async () => { btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await settle(250);
  return text();
};

const sb = await visit('/match/statsbomb:3857266', 1200);
console.log(`  /match/<statsbomb>   ${sb.text.length} символов текста`);
const tabsLine = [...document.querySelectorAll('.tabs .tab')].map((b) => b.textContent).join(' | ');
console.log(`    вкладки: ${tabsLine}`);
expect(/События · \d+/.test(tabsLine), 'вкладка «События» знает число событий');

const evTab = await clickTab('События');
expect(evTab && /Christensen|Koundé|Mbappé/.test(evTab), 'События: тайлайн с игроками и минутами отрисован');
const luTab = await clickTab('Составы');
expect(luTab && /в старте/.test(luTab) && /Lloris|Griezmann|Schmeichel/.test(luTab), 'Составы: стартовый состав с номерами отрисован');
const stTab = await clickTab('Статистика');
expect(stTab && /Владение/.test(stTab) && /xG/.test(stTab) && /Удары/.test(stTab), 'Статистика: владение, xG, удары отрисованы');

// матч без протокола: пустая вкладка должна объяснять и вести туда, где протокол есть
const plain = await visit('/match/' + overview.featured.id, 1200);
expect(plain.text.includes('2:2'), 'featured-матч показывает итоговый счёт 2:2 из live-слоя');
expect(/Mbeumo|Sesko|George|Maitland-Niles/.test(plain.text), 'в шапке матча видны авторы голов');
expect(plain.html.includes('goal-chip'), 'авторы голов оформлены отдельными плашками');
const fStats = await clickTab('Статистика');
expect(fStats && /Владение/.test(fStats) && /Удары в створ/.test(fStats), 'Статистика матча АПЛ: владение и удары из live-слоя');
// матч БЕЗ протокола берём отдельный: у featured теперь есть события из live-слоя
const noDepth = (await (await fetch(ORIGIN + '/api/matches?limit=400')).json()).matches
  .find((m) => !m.has_events && !m.has_lineups && !m.has_stats);
if (noDepth) {
  await visit('/match/' + noDepth.id, 1200);
  const emptyTab = await clickTab('События');
  expect(emptyTab && /StatsBomb/.test(emptyTab), 'пустая вкладка объясняет, откуда берутся протоколы');
  expect(!!document.querySelector('main a[href="/matches"]'), 'из пустой вкладки есть переход к матчам с протоколом');
}

// на главной раздел «Матчи с протоколом» должен быть виден
const home2 = await visit('/', 1200);
expect(home2.text.includes('Матчи с протоколом'), '/ — раздел «Матчи с протоколом» на главной');
expect(/badge-depth|протокол/.test(home2.html), '/ — у матчей с протоколом стоит значок');

await act(async () => root.unmount());
console.log(failures.length ? `\nПРОВАЛЕНО: ${failures.length}` : '\nвсе маршруты отрисовались без ошибок');
process.exit(failures.length ? 1 : 0);
