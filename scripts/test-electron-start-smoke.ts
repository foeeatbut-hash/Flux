/**
 * Запуск собранного Flux настоящим Electron: главный процесс доходит до создания
 * окна без необработанных исключений. Проверки на заглушках этого не видят —
 * ошибка в теле app.whenReady() роняла запуск молча (окна нет, процесс живёт).
 * Нужны dist/ и dist-electron/ (npm run build && npm run build:electron).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (!existsSync(path.join(root, 'dist-electron/main.cjs'))) {
  console.error('Нет dist-electron/main.cjs: сначала npm run build && npm run build:electron');
  process.exit(1);
}
const electron = createRequire(import.meta.url)('electron') as unknown as string;
const home = mkdtempSync(path.join(tmpdir(), 'flux-smoke-'));
const WAIT_MS = Number(process.env.FLUX_SMOKE_MS || 25000);
const BAD = /UnhandledPromiseRejection|ReferenceError|TypeError|SyntaxError|Cannot find module|Uncaught Exception/;
// Отметка главного процесса о созданном окне: без неё «тихо» не значит «запустился»
const READY = /\[smoke\] window-created/;

const child = spawn(electron, ['--no-sandbox', '.'], {
  cwd: root,
  // Свой каталог данных, чтобы не трогать настоящий профиль. Профиль Windows
  // (USERPROFILE) не подменяем: без него Electron на раннере падает при старте
  env: { ...process.env, APPDATA: home, ...(process.platform === 'win32' ? {} : { HOME: home }), FLUX_START_SMOKE: '1', NODE_OPTIONS: '', ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
const take = (chunk: Buffer) => { out += chunk.toString(); };
child.stdout.on('data', take); child.stderr.on('data', take);

const finish = (code: number, message: string) => {
  try { child.kill('SIGKILL'); } catch { /* уже завершён */ }
  console.log(message);
  // При сбое показываем хвост вывода целиком: причина не всегда исключение JS
  if (code) console.log(out.split('\n').slice(-60).join('\n'));
  process.exit(code);
};
const started = Date.now();
const timer = setInterval(() => {
  if (BAD.test(out)) { clearInterval(timer); finish(1, '✗ Главный процесс Flux упал при запуске'); }
  else if (READY.test(out)) { clearInterval(timer); finish(0, '✓ Главный процесс Flux создал окно без исключений'); }
  else if (Date.now() - started > WAIT_MS) { clearInterval(timer); finish(1, `✗ За ${WAIT_MS} мс окно не создано`); }
}, 250);
child.once('exit', code => {
  if (!READY.test(out)) { clearInterval(timer); finish(1, `✗ Electron завершился до создания окна (код ${code})`); }
});
