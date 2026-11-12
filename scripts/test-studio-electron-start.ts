/**
 * Настоящий запуск собранной Studio под Electron до экрана входа (по образцу scripts/test-electron-start-smoke.ts).
 *
 * Проверки на заглушках не видят, что главный процесс падает в whenReady, что окно не грузит страницу или что заставка
 * не гаснет. Здесь запускается пакет dist-studio/<сборка>/app настоящим Electron; ждём отметку главного процесса «экран входа
 * показан»: заставка погашена, рамка окна на месте, в карточке — название программы. Нужен собранный пакет
 * (node studio/build.cjs developer|owner) и дисплей (на Linux — xvfb-run).
 *
 *   node --import tsx scripts/test-studio-electron-start.ts developer|owner
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const target = process.argv[2] === 'owner' ? 'owner' : 'developer';
const root = path.resolve(import.meta.dirname, '..');
const app = path.join(root, 'dist-studio', target, 'app');
if (!existsSync(path.join(app, 'main.cjs'))) { console.error(`Нет ${app}/main.cjs: сначала node studio/build.cjs ${target}`); process.exit(1); }
const electron = createRequire(import.meta.url)('electron') as unknown as string;
const data = mkdtempSync(path.join(tmpdir(), 'flux-studio-smoke-'));
const WAIT_MS = Number(process.env.FLUX_SMOKE_MS || 40000);
const BAD = /UnhandledPromiseRejection|ReferenceError|TypeError|SyntaxError|Cannot find module|Uncaught Exception/;
const READY = /\[smoke\] studio-login-screen (\{.*\})/;
const NAME = target === 'owner' ? 'Flux Studio — Владелец' : 'Flux Studio';

const child = spawn(electron, ['--no-sandbox', `--user-data-dir=${data}`, app], {
  env: { ...process.env, FLUX_START_SMOKE: '1', NODE_OPTIONS: '', ELECTRON_ENABLE_LOGGING: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
const take = (chunk: Buffer) => { out += chunk.toString(); };
child.stdout.on('data', take); child.stderr.on('data', take);
const finish = (code: number, message: string) => {
  try { child.kill('SIGKILL'); } catch { /* уже завершён */ }
  console.log(message);
  if (code) console.log(out.split('\n').slice(-60).join('\n'));
  process.exit(code);
};
const started = Date.now();
const timer = setInterval(() => {
  const ready = READY.exec(out);
  if (BAD.test(out)) { clearInterval(timer); finish(1, `✗ Главный процесс Studio (${target}) упал при запуске`); }
  else if (ready) {
    clearInterval(timer);
    const info = JSON.parse(ready[1]);
    if (info.build !== target || !String(info.text).includes(NAME)) finish(1, `✗ Экран входа не тот: ${ready[1]}`);
    else finish(0, `✓ ${NAME}: настоящий запуск дошёл до экрана входа (${info.text})`);
  } else if (Date.now() - started > WAIT_MS) { clearInterval(timer); finish(1, `✗ За ${WAIT_MS} мс экран входа не показан`); }
}, 250);
child.once('exit', code => { if (!READY.test(out)) { clearInterval(timer); finish(1, `✗ Electron завершился до экрана входа (код ${code})`); } });
