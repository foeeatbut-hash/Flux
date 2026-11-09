/**
 * Раздел владельца в FluxStudio-Владелец.exe: готовый пакет, а не исходники.
 *
 * Пакет собирается как в CI, Electron подменён заглушкой, домашняя папка — одноразовая.
 *
 * Что доказывается:
 * - оболочка показывает раздел владельца и открывает его окно, а в сборке разработчика раздела нет;
 * - окно владельца берёт тот же путь хранилища (~/.flux-owner/vault.flux-owner) и открывает
 *   хранилище, созданное прежним отдельным Flux Owner, теми же открытыми ключами — без перевыпуска лицензий;
 * - новое хранилище создаётся и открывается заново тем же форматом;
 * - вызовы действий владельца принимаются только от его окна;
 * - закрытие окна владельца запирает хранилище, но не закрывает Studio.
 *
 * Запуск: npx tsx scripts/test-studio-owner-section.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildStudio } = require('../studio/build.cjs');
const root = path.resolve(__dirname, '..');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };

const STUB = `
const handlers = new Map(); const windows = []; let nextSave = '';
class Win {
  constructor(options) { this.options = options; this.closedHandlers = []; this.destroyed = false;
    this.webContents = { setWindowOpenHandler() {}, on() {}, send() {}, mainFrame: {}, id: windows.length };
    windows.push(this); }
  setMenu() {} loadFile(file) { this.file = file; return Promise.resolve(); } isDestroyed() { return this.destroyed; }
  isMinimized() { return false; } restore() {} focus() { this.focused = (this.focused || 0) + 1; }
  on(event, fn) { if (event === 'closed') this.closedHandlers.push(fn); }
  close() { this.destroyed = true; this.closedHandlers.forEach(fn => fn()); }
}
module.exports = {
  __handlers: handlers, __windows: windows, __save: (file) => { nextSave = file; },
  app: { whenReady: () => Promise.resolve(), on() {}, quit() {}, getPath: () => process.env.STUDIO_TEST_USERDATA },
  BrowserWindow: Win, ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  clipboard: { writeText() {} }, shell: { openPath: async () => '' },
  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: nextSave }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) },
};`;

async function run(target: 'developer' | 'owner', home: string) {
  const out = path.join(home, `build-${target}`);
  await buildStudio({ target, outDir: out });
  const nodeModules = path.join(out, 'app', 'node_modules', 'electron');
  fs.mkdirSync(nodeModules, { recursive: true });
  fs.writeFileSync(path.join(nodeModules, 'index.js'), STUB);
  const electron = require(path.join(nodeModules, 'index.js'));
  require(path.join(out, 'app', 'main.cjs'));
  await new Promise((resolve) => setImmediate(resolve));
  const shellWindow = electron.__windows[0];
  const shellCall = (action: string, args: object = {}) => electron.__handlers.get('studio:call')({ sender: shellWindow.webContents, senderFrame: shellWindow.webContents.mainFrame }, action, args);
  return { electron, shellWindow, shellCall, app: path.join(out, 'app') };
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-owner-'));
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  process.env.HOME = home; process.env.USERPROFILE = home;
  process.env.STUDIO_TEST_USERDATA = path.join(home, 'userdata');
  const vaultFile = path.join(home, '.flux-owner', 'vault.flux-owner');
  try {
    const fixtures = path.join(root, 'studio/owner/scripts/fixtures');
    const legacy = JSON.parse(fs.readFileSync(path.join(fixtures, 'legacy-vault.public.json'), 'utf8'));
    fs.mkdirSync(path.dirname(vaultFile), { recursive: true });
    fs.copyFileSync(path.join(fixtures, 'legacy-vault.fixture.json'), vaultFile);

    console.log('Сборка владельца');
    const built = await run('owner', home);
    const state = (await built.shellCall('state')).value;
    ok('оболочка показывает раздел владельца', state.sections.length === 1 && state.sections[0].id === 'owner' && state.build === 'owner');
    ok('до открытия окна владельца нет', built.electron.__windows.length === 1);
    ok('раздел открывается из оболочки', (await built.shellCall('openSection', { id: 'owner' })).ok === true && built.electron.__windows.length === 2);
    const ownerWindow = built.electron.__windows[1];
    ok('окно владельца грузит свой интерфейс с изоляцией', /ui[\\/]index\.html$/.test(ownerWindow.file) && ownerWindow.options.webPreferences.contextIsolation === true && /owner[\\/]preload\.cjs$/.test(ownerWindow.options.webPreferences.preload));
    ok('имя окна говорит, что это Studio — Владелец', /Flux Studio — Владелец/.test(ownerWindow.options.title));
    await built.shellCall('openSection', { id: 'owner' });
    ok('повторное открытие не плодит окон', built.electron.__windows.length === 2 && ownerWindow.focused >= 1);

    const ownerCall = (action: string, args: object = {}, sender = ownerWindow) => built.electron.__handlers.get('owner:action')({ sender: sender.webContents, senderFrame: sender.webContents.mainFrame }, action, args);
    ok('действия владельца принимает только его окно', (await ownerCall('state', {}, built.shellWindow)).ok === false && (await ownerCall('state')).ok === true);
    const initial = (await ownerCall('state')).value;
    ok('окно видит прежний путь хранилища и ту же версию, что у Flux', initial.vaultExists === true && initial.vaultPath === vaultFile && initial.version === version);
    ok('неизвестное действие отклоняется', (await ownerCall('exec')).ok === false);

    console.log('Прежнее хранилище владельца');
    ok('неверный пароль не открывает', (await ownerCall('unlock', { password: 'неверный-пароль-хранилища' })).ok === false);
    const unlocked = await ownerCall('unlock', { password: legacy.passphrase });
    ok('хранилище прежнего Flux Owner открывается без переноса и перевыпуска', unlocked.ok === true && unlocked.value.unlocked === true && unlocked.value.kind === legacy.kind);
    ok('закреплённые открытые ключи прежние: лицензии и обновления не перевыпускаются',
      JSON.stringify(Object.fromEntries(Object.keys(legacy.publicKeys).map((k) => [k, unlocked.value.publicKeys[k]]))) === JSON.stringify(legacy.publicKeys));
    ok('закрытые ключи не отдаются окну', !JSON.stringify(unlocked.value).includes('PRIVATE KEY'));
    ok('без подключения публикация обновления закрыта', (await ownerCall('publish', { version: '9.9.9', changelog: 'x' })).ok === false);
    ok('закрытие окна запирает хранилище, а Studio остаётся', (ownerWindow.close(), (await ownerCall('state')).ok === false || (await ownerCall('state')).value.unlocked === false));
    ok('оболочка жива после закрытия окна владельца', (await built.shellCall('state')).ok === true);
    fs.rmSync(vaultFile);
    const again = await built.shellCall('openSection', { id: 'owner' });
    ok('раздел открывается снова новым окном', again.ok && built.electron.__windows.length === 3);

    console.log('Новое хранилище');
    const second = built.electron.__windows[2];
    const call2 = (action: string, args: object = {}) => built.electron.__handlers.get('owner:action')({ sender: second.webContents, senderFrame: second.webContents.mainFrame }, action, args);
    ok('без файла окно говорит, что хранилища нет', (await call2('state')).value.vaultExists === false);
    built.electron.__save(path.join(home, 'backup.flux-owner'));
    const created = await call2('create', { password: 'новая-фраза-пароль-1', backupPassword: 'запасная-фраза-пароль-2' });
    ok('хранилище создаётся по прежнему пути и формату', created.ok === true && fs.existsSync(vaultFile) && JSON.parse(fs.readFileSync(vaultFile, 'utf8')).format === 'FLUXOWNER1');
    await call2('lock');
    ok('созданное хранилище открывается заново', (await call2('unlock', { password: 'новая-фраза-пароль-1' })).value.unlocked === true);

    console.log('Сборка разработчика');
    for (const key of Object.keys(require.cache)) if (key.includes('build-owner')) delete require.cache[key];
    const developer = await run('developer', home);
    const devState = (await developer.shellCall('state')).value;
    ok('в сборке разработчика разделов владельца нет', devState.sections.length === 0 && devState.build === 'developer');
    ok('раздел владельца не открывается', (await developer.shellCall('openSection', { id: 'owner' })).ok === false && developer.electron.__windows.length === 1);
    ok('канала владельца у разработчика нет вовсе', !developer.electron.__handlers.has('owner:action') && !fs.existsSync(path.join(developer.app, 'owner')));

    console.log(`\nFlux Studio: раздел владельца в готовой сборке — ${passed} проверок пройдено`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
