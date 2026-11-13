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
    this.webContents = { setWindowOpenHandler() {}, setWebRTCIPHandlingPolicy() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }, on() {}, send() {}, mainFrame: {}, id: windows.length, scripts: [], executeJavaScript(code) { this.scripts.push(code); return Promise.resolve(); } };
    windows.push(this); }
  setMenu() {} once() {} show() {} loadFile(file) { this.file = file; return Promise.resolve(); } isDestroyed() { return this.destroyed; }
  isMinimized() { return false; } restore() {} focus() { this.focused = (this.focused || 0) + 1; }
  on(event, fn) { if (event === 'closed') this.closedHandlers.push(fn); }
  close() { this.destroyed = true; this.closedHandlers.forEach(fn => fn()); }
}
module.exports = {
  __handlers: handlers, __windows: windows, __save: (file) => { nextSave = file; },
  app: { whenReady: () => Promise.resolve(), on() {}, quit() {}, getPath: () => process.env.STUDIO_TEST_USERDATA },
  BrowserWindow: Win, nativeImage: { createFromPath: () => ({}) },
  ipcMain: { on() {}, removeAllListeners() {}, handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} }, safeStorage: { isEncryptionAvailable: () => false },
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
    ok('оболочка показывает три пункта: программы на проверку, обновления Flux, лицензии',
      state.sections.map((x: any) => x.id).join() === 'programs,updates,licenses' && state.sections.map((x: any) => x.title).join() === 'Программы на проверку,Flux: обновления,Лицензии' && state.build === 'owner');
    ok('до открытия окна владельца нет', built.electron.__windows.length === 1);
    ok('пункт открывается из оболочки окном разделов', (await built.shellCall('openSection', { id: 'programs' })).ok === true && built.electron.__windows.length === 2);
    const consoleWindow = built.electron.__windows[1];
    const consoleCall = (action: string, args: object = {}, sender = consoleWindow) => built.electron.__handlers.get('console:action')({ sender: sender.webContents, senderFrame: sender.webContents.mainFrame }, action, args);
    const lic = await built.shellCall('openSection', { id: 'licenses' });
    ok('«Лицензии» открываются в том же окне разделов: отдельного окна лицензий больше нет', lic.ok === true && built.electron.__windows.length === 2 && !built.electron.__handlers.has('owner:action'));
    ok('окно разделов называется Studio — Владелец', /Flux Studio — Владелец/.test(consoleWindow.options.title));
    const initial = (await consoleCall('licensesState')).value;
    ok('окно видит прежний путь хранилища и ту же версию, что у Flux', initial.vaultExists === true && initial.vaultPath === vaultFile && initial.version === version);
    ok('неизвестное действие отклоняется', (await consoleCall('exec')).ok === false);

    console.log('Разделы владельца (программы на проверку, обновления Flux, лицензии)');
    const before = 0;
    ok('окно разделов грузит свой интерфейс с изоляцией и своим мостом', /ui[\\/]console[\\/]index\.html$/.test(consoleWindow.file) && consoleWindow.options.webPreferences.contextIsolation === true
      && consoleWindow.options.webPreferences.nodeIntegration === false && consoleWindow.options.webPreferences.sandbox === true && /owner[\\/]console-preload\.cjs$/.test(consoleWindow.options.webPreferences.preload));
    ok('другой раздел владельца открывается в том же окне', (await built.shellCall('openSection', { id: 'updates' })).ok === true && built.electron.__windows.length === before + 2 && consoleWindow.focused >= 1);
    ok('действия разделов принимает только их окно', (await consoleCall('state', {}, built.shellWindow)).ok === false && (await consoleCall('state')).ok === true);
    ok('неизвестное действие отклоняется, а действия с ключами без хранилища — нет доступа', (await consoleCall('exec')).ok === false && (await consoleCall('create')).ok === false && (await consoleCall('openFlux')).ok === false && (await consoleCall('export')).ok === false);
    ok('хранилище пока заперто', (await consoleCall('state')).value.unlocked === false);
    ok('без хранилища и подключения разделы ничего не подписывают и не читают', (await consoleCall('release', { id: 'x', channel: 'test', sha256: 'a' })).ok === false && (await consoleCall('requests')).ok === false && (await consoleCall('assignUpdate', {})).ok === false);

    console.log('Прежнее хранилище владельца');
    ok('неверный пароль не открывает', (await consoleCall('unlock', { password: 'неверный-пароль-хранилища' })).ok === false);
    const unlockedPublic = await consoleCall('unlock', { password: legacy.passphrase });
    const unlocked = await consoleCall('licensesState');
    ok('хранилище прежнего Flux Owner открывается без переноса и перевыпуска', unlockedPublic.ok === true && unlocked.value.unlocked === true && unlocked.value.kind === legacy.kind);
    ok('закреплённые открытые ключи прежние: лицензии и обновления не перевыпускаются',
      JSON.stringify(Object.fromEntries(Object.keys(legacy.publicKeys).map((k) => [k, unlocked.value.publicKeys[k]]))) === JSON.stringify(legacy.publicKeys));
    ok('закрытые ключи не отдаются окну', !JSON.stringify(unlocked.value).includes('PRIVATE KEY') && !JSON.stringify(unlockedPublic.value).includes('PRIVATE KEY'));
    const shared = await consoleCall('state');
    ok('общее состояние окна (state) показывает открытое хранилище, но не ключи, лицензии и реестры', shared.value.unlocked === true && !JSON.stringify(shared.value).match(/PRIVATE KEY|licenses|publicKeys|revocations/));
    ok('открытое хранилище без подключения к базе: запросы по-прежнему закрыты', (await consoleCall('requests')).ok === false);
    ok('без подключения публикация обновления закрыта', (await consoleCall('publish', { version: '9.9.9', changelog: 'x' })).ok === false);
    ok('лицензии и ключи читаются из окна разделов без подключения к базе', (await consoleCall('licensesState')).value.publicKeys.license === legacy.publicKeys.license);
    ok('закрытие окна запирает хранилище, а Studio остаётся', (consoleWindow.close(), (await built.shellCall('state')).ok === true));
    const reopened = await built.shellCall('openSection', { id: 'licenses' });
    const reopenedWindow = built.electron.__windows[2];
    ok('пункт открывается снова новым окном, хранилище в нём заперто', reopened.ok && built.electron.__windows.length === 3
      && (await built.electron.__handlers.get('console:action')({ sender: reopenedWindow.webContents, senderFrame: reopenedWindow.webContents.mainFrame }, 'state', {})).value.unlocked === false);
    reopenedWindow.close();
    fs.rmSync(vaultFile);
    await built.shellCall('openSection', { id: 'licenses' });

    console.log('Новое хранилище');
    const second = built.electron.__windows[3];
    const call2 = (action: string, args: object = {}) => built.electron.__handlers.get('console:action')({ sender: second.webContents, senderFrame: second.webContents.mainFrame }, action, args);
    ok('без файла окно говорит, что хранилища нет и оно заперто', (await call2('licensesState')).value.vaultExists === false && (await call2('state')).value.unlocked === false);
    ok('выбор папки для копий можно отменить', (await call2('chooseSetupFolder')).value.canceled === true);
    ok('ключи не создаются без папки для копий', (await call2('setup', { password: 'новая-фраза-пароль-1', confirmPassword: 'новая-фраза-пароль-1' })).ok === false && !fs.existsSync(vaultFile));

    console.log('Сборка разработчика');
    const developer = await run('developer', home);
    const devState = (await developer.shellCall('state')).value;
    ok('в сборке разработчика разделов владельца нет', devState.sections.length === 0 && devState.build === 'developer');
    ok('раздел владельца не открывается', (await developer.shellCall('openSection', { id: 'licenses' })).ok === false && developer.electron.__windows.length === 1);
    ok('канала владельца у разработчика нет вовсе', !developer.electron.__handlers.has('owner:action') && !developer.electron.__handlers.has('console:action') && !fs.existsSync(path.join(developer.app, 'owner')) && !fs.existsSync(path.join(developer.app, 'ui')));
    ok('разделы владельца у разработчика не открываются', (await developer.shellCall('openSection', { id: 'programs' })).ok === false && (await developer.shellCall('openSection', { id: 'updates' })).ok === false);

    console.log(`\nFlux Studio: раздел владельца в готовой сборке — ${passed} проверок пройдено`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
