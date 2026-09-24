#!/usr/bin/env node
/**
 * Сборка редакторов Flux Office из исходников GenOffice.
 *
 * Редакторы берутся из github.com/genspark-ai/genoffice (Apache-2.0) по
 * закреплённому коммиту — не «последнее, что есть», а ровно то, что проверено
 * на бланках Flux (docs/office-engine-choice.md). Исходники в репозиторий Flux
 * не кладутся: там 96 МБ со шрифтами, а нужен только собранный интерфейс.
 *
 * Что делает:
 *   1. берёт исходники (GENOFFICE_SRC — готовый каталог, иначе клон в
 *      .cache/genoffice) и ставит зависимости без скриптов установки;
 *   2. собирает интерфейс редактора как обычную веб-страницу (--base ./);
 *   3. в index.html добавляет запрет внешних соединений (CSP) и мост Flux
 *      (flux-bridge.js) — ДО скриптов редактора: мост должен стоять раньше,
 *      чем редактор спросит window.desktop;
 *   4. кладёт LICENSE и NOTICE исходного проекта — этого требует Apache-2.0;
 *   5. вносит в исходники немногие правки Flux (patches.mjs) — например,
 *      режим «только просмотр», пока файл правит другой.
 *
 * Итог — public/genoffice/<редактор>/, в репозиторий не идёт (.gitignore).
 *
 *   node tools/genoffice/build.mjs            # Документ
 *   node tools/genoffice/build.mjs docs       # то же явно
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPatches } from './patches.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

/** Проверенный коммит GenOffice. Менять — только с повтором проверки на бланках */
const COMMIT = '89b11083d89ab2b5c89c9a0a014886552a7a9f91';
const REPO = 'https://github.com/genspark-ai/genoffice.git';

/** Совместная правка внутри редактора: те же версии, что проверены */
const COLLAB_DEPS = ['yjs@13.6.33', 'y-prosemirror@1.3.7', 'y-protocols@1.0.7'];

/** Редакторы, которые умеет собирать этот скрипт */
const APPS = { docs: 'apps/docs' };

// На Windows npm и npx — это .cmd, и без оболочки их не запустить: сборка
// выпуска идёт на windows-latest
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });

function source() {
  if (process.env.GENOFFICE_SRC) return resolve(process.env.GENOFFICE_SRC);
  const dir = join(root, '.cache', 'genoffice');
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    run('git', ['init', '-q'], dir);
    run('git', ['remote', 'add', 'origin', REPO], dir);
  }
  run('git', ['fetch', '-q', '--depth', '1', 'origin', COMMIT], dir);
  run('git', ['checkout', '-q', '--force', COMMIT], dir);
  return dir;
}

/**
 * Запрет внешних соединений. Flux работает без интернета, данные наружу не
 * уходят (flux-data-safety, правило 8). Мост и так глушит вызовы ИИ, а CSP —
 * вторая стена: даже забытый в редакторе запрос наружу браузер не выпустит.
 */
const CSP = "default-src 'self' file: blob: data:; script-src 'self' file:; " +
  "style-src 'self' file: 'unsafe-inline'; img-src 'self' file: blob: data:; font-src 'self' file: blob: data:; " +
  "connect-src 'self' file: blob: data:; worker-src 'self' file: blob:";
// Скрипты — только свои файлы, как в исходном редакторе. file: — портативная
// сборка открывает страницу с диска, и «свой адрес» у неё именно file:;
// наружу это ничего не открывает. blob: в connect-src — мост отдаёт файл
// редактору одноразовой blob-ссылкой. frame-ancestors здесь нет: в <meta>
// браузер его не читает

function inject(html) {
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}">\n` +
    '<title>Flux Office</title>\n<script src="../flux-bridge.js"></script>\n';
  // Свой CSP редактора убираем, а не дописываем второй рядом: браузер
  // применяет оба сразу, и чужой запрещал бы то, что нужно мосту
  // (blob-ссылку на открытый файл), а разрешал бы соединения с localhost
  const out = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>\s*/gi, '')
    .replace(/<title>[^<]*<\/title>\s*/i, '').replace(/<html lang="[^"]*"/i, '<html lang="ru"').replace(/<head>/i, `<head>\n${head}`);
  if (out === html) throw new Error('в index.html нет <head> — мост вставить некуда');
  return out;
}

function main() {
  const which = process.argv[2] || 'docs';
  const app = APPS[which];
  if (!app) throw new Error(`неизвестный редактор «${which}»; есть: ${Object.keys(APPS).join(', ')}`);
  const src = source();
  if (!existsSync(join(src, 'node_modules'))) run('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], src);

  // Одновременная правка: Yjs внутри редактора — закреплёнными версиями,
  // без записи в lock-файл исходника (он у GenOffice свой)
  if (!existsSync(join(src, 'node_modules', 'y-prosemirror'))) {
    run('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--ignore-scripts', ...COLLAB_DEPS], src);
  }
  // Наш код внутри редактора — рядом с его исходниками (tools/genoffice/inject)
  const injectDir = join(here, 'inject');
  if (which === 'docs') cpSync(join(injectDir, 'docs-collab.ts'), join(src, app, 'src', 'renderer', 'flux', 'docs-collab.ts'));

  // Правки Flux — до сборки (tools/genoffice/patches.mjs)
  for (const line of applyPatches(src)) console.log(`  правка ${line}`);

  const out = join(root, 'public', 'genoffice', which);
  rmSync(out, { recursive: true, force: true });
  run('npx', ['vite', 'build', '--config', 'vite.renderer.config.ts', '--base', './', '--outDir', out, '--emptyOutDir'], join(src, app));

  const index = join(out, 'index.html');
  writeFileSync(index, inject(readFileSync(index, 'utf8')));

  const base = join(root, 'public', 'genoffice');
  cpSync(join(here, 'flux-bridge.js'), join(base, 'flux-bridge.js'));
  for (const f of ['LICENSE', 'NOTICE']) if (existsSync(join(src, f))) cpSync(join(src, f), join(base, f));
  writeFileSync(join(base, 'SOURCE.txt'), `GenOffice ${REPO}\nкоммит ${COMMIT}\nлицензия Apache-2.0 (LICENSE, NOTICE)\n`);
  console.log(`Flux Office: «${which}» собран в ${out}`);
}

main();
