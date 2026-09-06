#!/usr/bin/env node
/**
 * Локальная копия GitHub Pages — чтобы проверять сайт до публикации.
 *
 * Намеренно повторяет поведение Pages, а не Express:
 *   · обслуживает только файлы из dist/ по базовому пути (/football-tv/);
 *   · роутов /api/* нет вовсе — как на Pages;
 *   · на неизвестный путь отдаёт 404.html со статусом 404, а НЕ index.html.
 *     Именно поэтому проверка ловит битые глубокие ссылки: если бы сервер
 *     молча отдавал index.html, проблема всплыла бы уже у пользователя.
 *
 * Использование: npm run serve:static   (нужен собранный dist/)
 *   --port=8090   порт (по умолчанию 8090)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/db.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const PORT = Number(arg('port', process.env.PORT || 8090));
const HOST = process.env.HOST || '0.0.0.0';
const BASE = '/football-tv/';
const DIST = path.join(ROOT, 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/index.html не найден. Сначала: npm run build:pages');
  process.exit(1);
}

/** Приводит URL к файлу внутри dist/ и не даёт выйти за его пределы. */
function resolveFile(pathname) {
  if (!pathname.startsWith(BASE)) return null;
  let rel = decodeURIComponent(pathname.slice(BASE.length));
  // Корень сайта и любой каталог — это index.html (как на Pages).
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(DIST, rel);
  if (!file.startsWith(DIST)) return null;
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  const file = resolveFile(pathname);

  if (file) {
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  // Как на Pages: 404.html и честный статус 404.
  const notFound = path.join(DIST, '404.html');
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  if (fs.existsSync(notFound)) fs.createReadStream(notFound).pipe(res);
  else res.end('404');
});

server.listen(PORT, HOST, () => {
  console.log(`Статическая копия Pages → http://${HOST}:${PORT}${BASE}`);
  console.log(`  каталог: ${path.relative(ROOT, DIST)}/  (роутов /api нет — как на Pages)`);
});
