#!/usr/bin/env node
/**
 * Сборка единого исполняемого файла (Node Single Executable Application).
 *
 *   npm run exe        → соберёт ./sea/out/football-tv[.exe] под текущую ОС
 *
 * Что делает:
 *   1. Склеивает Express-сервер (server/ + ingest/ + lib/) с launcher-ом в один
 *      CJS-бандл (esbuild), все npm-зависимости — внутрь.
 *   2. Собирает «чемодан» данных: фронтенд dist/, базу data/football.db и
 *      снимки data/snapshots/ — и вшивает их в бинарник как ассеты SEA
 *      (большой football.db сжимается gzip).
 *   3. Генерирует sea-config.json, готовит sea-prep.blob и впрыскивает его в
 *      копию бинарника Node с помощью postject.
 *
 * Внутри exe нет отдельного node: сервер запускается самим бинарником, данные
 * при первом старте распаковываются в каталог пользователя (см. sea/entry.js).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'sea', 'out');
const DIST = path.join(ROOT, 'dist');
const DB = path.join(ROOT, 'data', 'football.db');
const SNAPSHOTS = path.join(ROOT, 'data', 'snapshots');

// Пометка версии данных: меняется при каждой сборке → повторная распаковка.
const VERSION = Date.now().toString(36);

const log = (...a) => console.log(...a);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** Рекурсивный список файлов каталога. */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const GZIP_MIN = 512 * 1024; // сжимаем только большие файлы (база)

/** Файлы, которые поедут внутрь exe, + манифест. */
function collectFiles() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error('dist/index.html не найден. Сначала: npm run build');
  }
  if (!fs.existsSync(DB)) {
    throw new Error('data/football.db не найден. Сначала: npm run ingest');
  }

  const files = [];
  for (const p of [...walk(DIST), DB, ...walk(SNAPSHOTS)]) {
    const stat = fs.statSync(p);
    if (stat.size === 0) continue;
    const gz = stat.size >= GZIP_MIN;
    files.push({ abs: p, rel: rel(p), gz });
  }
  return files;
}

function run(cmd, args, opts = {}) {
  log(`  $ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

/**
 * Запускает JS-скрипт интерпретатором node.
 *
 * ВАЖНО для Windows: `execFileSync` не умеет исполнять `.cmd`/`.bat`-шимсы из
 * node_modules/.bin (например postject.cmd) — они требуют cmd.exe. Поэтому
 * вызываем саму JS-точку входа через node, а не файл-обёртку. Работает
 * одинаково на Windows, Linux и macOS.
 */
function runNode(script, args, opts = {}) {
  run(process.execPath, [script, ...args], opts);
}

async function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  log('▸ 1/4 Склейка сервера (esbuild)');
  // Используем JS API esbuild напрямую: его bin/esbuild — это нативный бинарник
  // (ELF на Linux, .exe на Windows), и пути к нему различаются между ОС.
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'sea', 'entry.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: path.join(OUT, 'bundle.cjs'),
    external: ['node:sqlite', 'node:sea'],
    logLevel: 'warning',
    absWorkingDir: ROOT,
  });

  log('▸ 2/4 Сбор данных');
  const files = collectFiles();
  const assets = {};
  const manifest = { version: VERSION, generated_at: new Date().toISOString(), files: [] };

  for (const f of files) {
    let buf = fs.readFileSync(f.abs);
    if (f.gz) buf = zlib.gzipSync(buf, { level: 9 });
    // Ассеты SEA хранятся по относительному ключу; запишем их во временный каталог
    const assetPath = path.join(OUT, 'assets', f.rel);
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(assetPath, buf);
    assets[f.rel] = assetPath;
    manifest.files.push({ rel: f.rel, gz: f.gz });
  }

  const manifestJson = JSON.stringify(manifest);
  const manifestPath = path.join(OUT, 'assets', 'manifest.json');
  fs.writeFileSync(manifestPath, manifestJson);
  assets['manifest.json'] = manifestPath;

  const totalMb = (files.reduce((s, f) => s + fs.statSync(f.abs).size, 0) / 1024 / 1024).toFixed(1);
  log(`  файлов: ${files.length}, данных: ${totalMb} МБ, сжато больших: ${files.filter((f) => f.gz).length}`);

  log('▸ 3/4 sea-config + sea-prep.blob');
  const seaConfig = {
    main: path.join(OUT, 'bundle.cjs'),
    output: path.join(OUT, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
    assets,
  };
  fs.writeFileSync(path.join(OUT, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
  run(process.execPath, ['--experimental-sea-config', path.join(OUT, 'sea-config.json')]);

  log('▸ 4/4 Впрыскивание blob в копию node');
  const exeName = process.platform === 'win32' ? 'football-tv.exe' : process.platform === 'darwin' ? 'football-tv-macos' : 'football-tv';
  const exePath = path.join(OUT, exeName);
  fs.copyFileSync(process.execPath, exePath);
  runNode(
    path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
    [
      exePath,
      'NODE_SEA_BLOB',
      path.join(OUT, 'sea-prep.blob'),
      '--sentinel-fuse',
      'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ],
  );
  if (process.platform !== 'win32') fs.chmodSync(exePath, 0o755);

  const mb = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
  log('');
  log(`Готово: ${exePath}  (${mb} МБ)`);
  log('Запуск: двойной клик (или ' + exeName + ' из терминала). Сайт откроется на http://localhost:8080');
}

build().catch((err) => {
  console.error(`\nСборка exe не удалась: ${err && err.message}\n`);
  process.exit(1);
});
