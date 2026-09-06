/**
 * Точка входа собранного исполняемого файла (Node SEA).
 *
 * esbuild склеивает этот файл вместе с Express-сервером в один CJS-бандл,
 * который вшивается в копию бинарника Node. При запуске exe:
 *
 *   1. Распаковываем встроенные данные (фронтенд dist/, база data/football.db,
 *      снимки data/snapshots/) в каталог пользователя — писать внутрь exe нельзя.
 *   2. Направляем сервер на этот каталог через FOOTBALL_TV_ROOT / FOOTBALL_DB.
 *   3. Поднимаем сервер и открываем сайт в браузере.
 *
 * Повторный запуск данных не распаковывает: сверяется версия манифеста.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import * as sea from 'node:sea';

// node:sqlite помечен в Node 22 как «experimental» и печатает предупреждение.
// Для пользователя exe это лишний шум — гасим только это конкретное сообщение,
// остальные предупреждения по-прежнему видны.
(() => {
  const stderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    const s = String(chunk);
    if (s.includes('ExperimentalWarning') && s.includes('SQLite')) return true;
    return stderr(chunk, ...rest);
  };
})();

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

/** Каталог данных приложения на этом компьютере. */
function userDataDir() {
  if (process.env.FOOTBALL_TV_ROOT) return process.env.FOOTBALL_TV_ROOT;
  if (process.env.FOOTBALL_TV_DATA) return process.env.FOOTBALL_TV_DATA;
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'football-tv');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'football-tv');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'football-tv');
}

/** Достаёт встроенные файлы на диск (один раз, пока не сменится версия). */
function extractData() {
  const root = userDataDir();
  const manifest = JSON.parse(sea.getAsset('manifest.json', 'utf8'));
  const stamp = path.join(root, '.build-stamp');
  try {
    if (fs.readFileSync(stamp, 'utf8') === String(manifest.version)) {
      process.env.FOOTBALL_TV_ROOT = root;
      process.env.FOOTBALL_DB = process.env.FOOTBALL_DB || path.join(root, 'data', 'football.db');
      return root;
    }
  } catch {
    /* каталога или метки ещё нет */
  }

  fs.mkdirSync(root, { recursive: true });
  let written = 0;
  for (const file of manifest.files) {
    const raw = sea.getAsset(file.rel); // ArrayBuffer
    if (!raw) continue;
    let buf = Buffer.from(raw);
    if (file.gz) buf = zlib.gunzipSync(buf);
    const dest = path.join(root, file.rel);
    // защита от выхода за пределы каталога данных
    if (!dest.startsWith(root + path.sep) && dest !== root) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    written += 1;
  }
  fs.writeFileSync(stamp, String(manifest.version));
  console.log(`  данные распакованы: ${written} файлов → ${root}`);
  process.env.FOOTBALL_TV_ROOT = root;
  process.env.FOOTBALL_DB = process.env.FOOTBALL_DB || path.join(root, 'data', 'football.db');
  return root;
}

/** Открывает сайт в браузере по умолчанию (можно отключить FOOTBALL_TV_NO_OPEN=1). */
function openBrowser(url) {
  if (process.env.FOOTBALL_TV_NO_OPEN === '1') return;
  let cmd;
  let args;
  if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* браузер не открылся — адрес всё равно напечатан в консоли */
  }
}

async function main() {
  const root = extractData();

  // Сервер импортируется ПОСЛЕ установки путей — иначе он прочитал бы
  // __dirname/import.meta.url, которые внутри exe указывают не на данные.
  const [{ app }, { getDb, allMeta }, { startAutoRefresh }] = await Promise.all([
    import('../server/index.js'),
    import('../server/db.js'),
    import('../server/refresh.js'),
  ]);

  const server = app.listen(PORT, HOST, () => {
    const url = `http://localhost:${PORT}`;
    console.log('');
    console.log('  ⚽ ФУТБОЛ.TV — готово!');
    console.log(`     сайт:      ${url}`);
    console.log(`     данные:    ${root}`);
    try {
      const db = getDb();
      const matches = db.prepare('SELECT COUNT(*) AS n FROM matches').get().n;
      const streams = db.prepare('SELECT COUNT(*) AS n FROM streams').get().n;
      console.log(`     матчей:    ${matches.toLocaleString('ru-RU')}`);
      console.log(`     эфиров:    ${streams}`);
    } catch (e) {
      console.log(`     база не прочитана: ${e.message}`);
    }
    const meta = allMeta();
    console.log(`     снимок:    ${meta['ingest.streams'] || '—'}`);
    console.log('');
    console.log('  Закройте это окно, чтобы остановить приложение (Ctrl+C).');
    // В exe живые источники не обходятся: данные — встроенные реальные снимки.
    const minutes = Number(process.env.REFRESH_MINUTES || 0);
    if (minutes > 0) startAutoRefresh({ minutes });
    openBrowser(url);
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\n  Порт ${PORT} уже занят.`);
      console.error(`  Остановите другую копию приложения или запустите с PORT=….\n`);
    } else {
      console.error(`\n  Не удалось запустить сервер: ${err && err.message}\n`);
    }
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(`\n  Ошибка запуска: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
