import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { XMLValidator, XMLParser } from 'fast-xml-parser';
import { WINDOWS_NOTIFICATIONS_CONSENT, WINDOWS_NOTIFICATIONS_SNAPSHOT } from '../filesystem/windowsNotifications';

async function main() {
  let checks = 0;
  const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log('✓ ' + name); };
  const handlers = new Map<string, (...args: any[]) => any>(); const app = new EventEmitter();
  const bundled = await build({ entryPoints: ['electron/windowsNotifications.ts'], bundle: true, write: false,
    platform: 'node', format: 'cjs', plugins: [{ name: 'electron-fixture', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const {app,BrowserWindow,ipcMain}=globalThis.__mock;', loader: 'js' }));
    } }] });
  const module = { exports: {} as any };
  vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, require, process, Buffer, setInterval, clearInterval,
    __mock: { app, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: (channel: string, handler: any) => handlers.set(channel, handler) } } });
  const { WindowsNotificationsService, validateWindowsNotifications, readWindowsNotificationsFile, setupWindowsNotifications } = module.exports;
  let now = Date.now();
  const raw = { schema: 1, status: 'ready', updatedAt: new Date(now).toISOString(), items: [{ id: 'win:42', source: 'windows',
    appName: 'Другая программа', title: 'Пришёл документ', body: 'Текст Windows', createdAt: new Date(now - 1000).toISOString(), route: 'file:///private' }] };
  let installed = true, reads = 0, launches = 0, payload: unknown = raw;
  const familyName = 'Flux.NotificationBridge_123456789abcd';
  let location = { familyName, localAppData: os.tmpdir() };
  const deps = { platform: 'win32', now: () => now, locatePackage: async () => installed ? location : null,
    readSnapshot: async () => { reads++; return JSON.stringify(payload); }, launch: async () => { launches++; } };
  const service = new WindowsNotificationsService(deps);
  const [first, concurrent] = await Promise.all([service.snapshot(), service.snapshot()]);
  check('Одновременный опрос Windows не запускает несколько чтений', first === concurrent && reads === 1);
  check('Уведомление сохраняет отдельный источник Windows', first.status === 'ready' && first.items[0].source === 'windows');
  check('Непроверенные маршруты и действия из локального файла не попадают в renderer', !JSON.stringify(first).includes('file:///private'));
  installed = false; const before = reads;
  check('Без установленного пакета источник явно недоступен', (await service.snapshot()).status === 'not-installed' && reads === before);
  check('Без пакета запрос согласия не запускает внешний процесс', !(await service.requestConsent()).ok && launches === 0);
  installed = true; now += 6000;
  check('Явный запрос согласия запускает только установленный компонент', (await service.requestConsent()).ok && launches === 1);
  check('Повторный запрос не открывает много процессов', !(await service.requestConsent()).ok && launches === 1);
  location = { ...location, familyName: '../outside' }; now += 6000;
  check('Произвольное имя пакета не становится путём чтения', (await service.snapshot()).status === 'not-installed');
  check('Произвольное имя пакета не становится Shell-командой', !(await service.requestConsent()).ok && launches === 1);
  location = { ...location, familyName };
  for (const status of ['denied', 'consent-required', 'unavailable']) {
    payload = { ...raw, status, updatedAt: new Date(now).toISOString() };
    const result = await service.snapshot();
    check('Состояние ' + status + ' очищает прошлые тексты Windows', result.status === status && result.items.length === 0);
  }
  payload = raw; now += 50000;
  check('Остановленный компонент не выдаёт устаревший снимок за действующий доступ', (await service.snapshot()).status === 'unavailable');
  for (const invalid of [{ ...raw, schema: 2 }, { ...raw, items: [...raw.items, ...raw.items] },
    { ...raw, items: [{ ...raw.items[0], source: 'flux' }] }, { ...raw, updatedAt: new Date(now + 60000).toISOString() },
    { ...raw, items: [{ ...raw.items[0], body: 'x'.repeat(8193) }] }]) {
    assert.throws(() => validateWindowsNotifications(invalid, now)); checks++;
  }
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-notification-test-'));
  try {
    const state = path.join(sandbox, 'Packages', familyName, 'LocalState');
    await fs.mkdir(state, { recursive: true });
    await fs.writeFile(path.join(state, 'notifications.json'), JSON.stringify(raw));
    const localAppData = process.platform === 'win32' ? sandbox.toUpperCase() : sandbox;
    check('Мост принимает регистр пути Windows, нормализованный файловой системой', JSON.parse(await readWindowsNotificationsFile({ familyName, localAppData })).schema === 1);
    const outside = path.join(sandbox, 'outside'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'notifications.json'), JSON.stringify(raw));
    await fs.rename(state, state + '-old'); await fs.symlink(outside, state, 'junction');
    await assert.rejects(() => readWindowsNotificationsFile({ familyName, localAppData: sandbox }), (error: any) => error.code === 'LINK_BLOCKED'); checks++;
    check('Junction в LocalState не переносит чтение в произвольную папку', true);
  } finally { await fs.rm(sandbox, { recursive: true, force: true }); }
  const unsupported = new WindowsNotificationsService({ ...deps, platform: 'linux', locatePackage: () => { throw new Error('Не запускать'); } });
  check('Другие ОС явно сообщают отсутствие Windows-источника', (await unsupported.snapshot()).status === 'unsupported');
  let trusted = false, licensed = true;
  setupWindowsNotifications({ isTrusted: () => trusted, mayRead: () => licensed });
  const sender = Object.assign(new EventEmitter(), { id: 1 });
  await assert.rejects(() => handlers.get(WINDOWS_NOTIFICATIONS_SNAPSHOT)!({ sender }), /Войдите/); checks++;
  trusted = true; licensed = false;
  await assert.rejects(() => handlers.get(WINDOWS_NOTIFICATIONS_CONSENT)!({ sender }), /Войдите/); checks++;
  app.emit('will-quit');
  const folder = 'tools/windows-notification-bridge/';
  const manifest = await fs.readFile(folder + 'Package.appxmanifest', 'utf8');
  const project = await fs.readFile(folder + 'Flux.NotificationBridge.csproj', 'utf8');
  const applicationManifest = await fs.readFile(folder + 'app.manifest', 'utf8');
  for (const [name, xml] of [['package', manifest], ['project', project], ['application', applicationManifest]])
    check('XML ' + name + ' не содержит синтаксических ошибок', XMLValidator.validate(xml) === true);
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(manifest);
  check('Manifest задаёт app identity и настоящее Windows-разрешение listener', parsed.Package.Identity['@_Name'] === 'Flux.NotificationBridge'
    && parsed.Package.Capabilities['uap3:Capability']['@_Name'] === 'userNotificationListener');
  check('Пакет запускает собранный WPF exe с app identity', parsed.Package.Applications.Application['@_Executable'] === 'Flux.NotificationBridge.exe'
    && parsed.Package.Applications.Application['@_EntryPoint'] === 'Windows.FullTrustApplication');
  const source = await fs.readFile(folder + 'Program.cs', 'utf8');
  check('Источник — публичный API listener, не внутренняя база Windows', source.includes('GetNotificationsAsync(NotificationKinds.Toast)') && !/wpndatabase|SQLiteConnection|RemoveNotification|ClearNotifications/.test(source));
  check('Windows-согласие запрашивается только отдельной кнопкой', source.includes('consent.Click +=') && source.match(/RequestAccessAsync\(/g)?.length === 1);
  console.log(`\nПроверено ${checks} сценариев Windows-уведомлений и исходного проекта companion.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
