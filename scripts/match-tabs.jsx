import { JSDOM, VirtualConsole } from 'jsdom';

const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:8080';
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => {
  if (!/Not implemented: window\.open/.test(String(e.message))) console.error(e);
});
// Приложение живёт на HashRouter (GitHub Pages не отдаёт index.html на
// произвольный путь), поэтому маршрут передаётся в хеше, а не в pathname.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: ORIGIN + '/#/match/statsbomb:3857266',
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;
const define = (k, v) => { try { Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); } catch {} };
define('window', window); define('document', window.document); define('navigator', window.navigator);
for (const k of ['HTMLElement','Element','Node','Event','CustomEvent','MouseEvent','KeyboardEvent','PopStateEvent','getComputedStyle','requestAnimationFrame','cancelAnimationFrame','history','location']) define(k, window[k]);
global.IS_REACT_ACT_ENVIRONMENT = true;
const nodeFetch = globalThis.fetch;
globalThis.fetch = (i, o) => nodeFetch(typeof i === 'string' && i.startsWith('/') ? ORIGIN + i : i, o);

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const App = (await import('../web/src/App.jsx')).default;
const hush = (s) => !/not wrapped in act|useLayoutEffect|Future Flag/.test(s);
const oe = console.error, ow = console.warn;
console.error = (...a) => hush(String(a[0])) && oe(...a);
console.warn = (...a) => hush(String(a[0])) && ow(...a);

const root = createRoot(document.getElementById('root'));
await act(async () => { root.render(React.createElement(App)); });
await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });

const main = () => document.querySelector('main') || document.body;
const tabs = [...document.querySelectorAll('.tabs .tab')].map((b) => b.textContent);
console.log('вкладки:', tabs.join(' | '));

for (const label of ['События', 'Составы', 'Статистика', 'Трансляция']) {
  const btn = [...document.querySelectorAll('.tabs .tab')].find((b) => (b.textContent || '').startsWith(label));
  if (!btn) { console.log(`\n[${label}] — вкладки нет`); continue; }
  await act(async () => { btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
  const txt = main().textContent.replace(/\s+/g, ' ').trim();
  console.log(`\n[${label}] ${txt.length} символов`);
  console.log('  ', txt.slice(0, 420));
}
await act(async () => root.unmount());
