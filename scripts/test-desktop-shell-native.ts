import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { SHELL_DESKTOP_OPEN, SHELL_DESKTOP_SNAPSHOT } from '../filesystem/shellDesktop';
import { WindowsFilesService } from '../electron/filesystem/service';

async function main() {
  const app = new EventEmitter(); const screen = new EventEmitter();
  const handlers = new Map<string, (...args: any[]) => any>();
  const bundled = await build({ entryPoints: ['electron/desktopShell.ts'], bundle: true, write: false,
    platform: 'node', format: 'cjs', plugins: [{ name: 'electron-fixture', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents:
        'export const {app,screen,ipcMain,BrowserWindow,shell}=globalThis.__mock;', loader: 'js' }));
    } }] });
  const module = { exports: {} as any };
  vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, require, Buffer, process,
    setInterval, clearInterval, __mock: { app, screen, BrowserWindow: { getAllWindows: () => [] },
      ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn) } } });
  const { DesktopShellService, validateNativeDesktop, setupDesktopShell } = module.exports;
  const key = Buffer.alloc(32, 1).toString('base64'), secondKey = Buffer.alloc(32, 2).toString('base64');
  const icon = { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=', width: 48, height: 48 };
  const raw = { items: [{ nativeId: key, name: 'Корзина', kind: 'virtual', x: -1750, y: -50, icon }],
    skipped: 0, iconSize: 48, spacing: { x: 112, y: 112 }, iconsVisible: true,
    physicalBounds: { x: -1920, y: -200, width: 3840, height: 1280 } };
  let now = 0, calls = 0, opened: unknown[] = [], response: unknown = raw;
  const deps = { platform: 'win32', now: () => now,
    run: async (action: string, id: string) => { calls++; if (action === 'open') { opened.push(id); return { opened: true }; } return response; },
    // Масштаб меняет смещение внутри монитора, его начало DIP задаёт Electron.
    screenToDipPoint: (p: { x: number; y: number }) => ({ x: -1280 + (p.x + 1920) / 1.5, y: -100 + (p.y + 200) / 1.5 }),
    displayAt: () => ({ id: 2, scaleFactor: 1.5 }),
  };
  let count = 0;
  const check = (name: string, value: unknown) => { assert.ok(value, name); count++; console.log(`✓ ${name}`); };
  const service = new DesktopShellService(deps);
  const [first, concurrent] = await Promise.all([service.snapshot(), service.snapshot()]);
  check('Одновременные снимки не запускают несколько помощников', calls === 1 && first === concurrent);
  check('Виртуальный значок сохраняется без выдуманного файла', first.items[0].kind === 'virtual' && !('path' in first.items[0]));
  check('Отрицательное начало монитора преобразуется Electron, без деления абсолютного x', first.items[0].position.x === -1280 + 170 / 1.5 && first.items[0].position.y === 0);
  check('Размер native-изображения преобразуется один раз', first.items[0].icon.width === 32 && first.items[0].monitorId === 2);
  check('Подписи значков используют размер клетки собственного DPI монитора', first.items[0].cell.width === raw.spacing.x / 1.5 && first.items[0].cell.height === raw.spacing.y / 1.5);
  check('Renderer получает непрозрачный ID вместо PIDL', first.items[0].id !== key && !JSON.stringify(first).includes(key));
  const shortcutService = new DesktopShellService({ ...deps,
    run: async () => ({ ...raw, items: [{ ...raw.items[0], kind: 'shortcut', isFluxAppShortcut: true }] }) });
  const legacyShortcut = await shortcutService.snapshot();
  check('Старый Flux-ярлык помечается для скрытия, не раскрывая путь .lnk', legacyShortcut.items[0].isFluxAppShortcut === true && !('fileSystemPath' in legacyShortcut.items[0]));
  check('Путь и команда не могут стать действием открытия', !(await service.open('C:\\Windows\\System32\\cmd.exe')).ok && calls === 1);
  check('Известный значок открывается только по сохранённому native ID', (await service.open(first.items[0].id)).ok && opened[0] === key);
  now = 6000;
  const refreshed = await service.snapshot();
  check('Непрозрачный ID не меняется при перечитывании того же PIDL', refreshed.items[0].id === first.items[0].id);
  response = { ...raw, items: [{ ...raw.items[0], nativeId: secondKey, name: 'Этот компьютер' }] };
  service.invalidate(); await service.snapshot();
  const before = calls;
  check('Исчезнувший значок нельзя открыть старым ID', !(await service.open(first.items[0].id)).ok && calls === before);
  response = { ...raw, items: [{ ...raw.items[0], x: Number.NaN }] };
  service.invalidate(); const invalid = await service.snapshot();
  check('Сбой координат не подменяется раскладкой Flux', invalid.status === 'unavailable' && invalid.items.length === 0);
  check('После отказа помощника очищаются capability предыдущего снимка', !(await service.open(first.items[0].id)).ok);
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-shell-ref-'));
  let files: WindowsFilesService | undefined;
  try {
    const desktopInput = path.join(fixture, 'desktop'), sharedInput = path.join(fixture, 'public-desktop'), outsideInput = path.join(fixture, 'outside');
    await Promise.all([desktopInput, sharedInput, outsideInput].map(folder => fs.mkdir(folder)));
    // Service roots are persisted through realpath; use those same canonical paths
    // for Shell fixture inputs on Windows, where temp paths may use an 8.3 alias.
    const [desktop, shared, outside] = await Promise.all([desktopInput, sharedInput, outsideInput].map(folder => fs.realpath(folder)));
    const actual = path.join(desktop, 'Документ.md'), common = path.join(shared, 'Общий.md'), privateFile = path.join(outside, 'private.md');
    await Promise.all([fs.writeFile(actual, 'физический оригинал'), fs.writeFile(common, 'общий оригинал'), fs.writeFile(privateFile, 'вне корней')]);
    files = await WindowsFilesService.create({ userData: path.join(fixture, 'state'), knownFolders: { desktop },
      trashItem: async () => {}, showItemInFolder: () => {}, openPath: async () => '' });
    const publicRoot = await files.addRoot(shared, 'Общий рабочий стол');
    response = { ...raw, items: [{ ...raw.items[0], kind: 'file', name: 'Документ.md', fileSystemPath: actual }] };
    const physicalService = new DesktopShellService({ ...deps, fileRefForPath: (filename: string) => files!.refForShellPath(filename) });
    const physical = await physicalService.snapshot(); const ref = physical.items[0].fileRef;
    check('Физический значок получает capability редактора без абсолютного пути', ref && !JSON.stringify(physical).includes(actual) && !('fileSystemPath' in physical.items[0]));
    const initial = await files.read(ref);
    await files.write(ref, Buffer.from('сохранено из редактора Flux').toString('base64'), initial.sha256);
    check('Сохранение по capability Shell меняет исходный Windows-файл', await fs.readFile(actual, 'utf8') === 'сохранено из редактора Flux');
    check('Общий Desktop получает отдельный безопасный корень', (await files.refForShellPath(common))?.rootId === publicRoot.id);
    check('Путь Shell за пределами подключённых корней не выдаёт доступ', await files.refForShellPath(privateFile) === null);
    await fs.symlink(outside, path.join(desktop, 'junction'), 'junction');
    check('Shell не выдаёт capability через junction', await files.refForShellPath(path.join(desktop, 'junction', 'private.md')) === null);
    check('Родственная папка с совпавшим префиксом не входит в корень', await files.refForShellPath(path.join(`${desktop}-other`, 'private.md')) === null);
    check('Содержимое реальных файлов не подгружается снимком значков', !JSON.stringify(physical).includes('физический оригинал'));
    const directoryRef = await files.refForShellPath(desktop);
    check('Физическая папка открывает Проводник Flux по пустому относительному пути', directoryRef?.relativePath === '');
    response = { ...raw, items: [{ ...raw.items[0], kind: 'shortcut', fileSystemPath: actual }] };
    physicalService.invalidate();
    check('Ярлык не превращается в редактируемый файл по присланному пути', !(await physicalService.snapshot()).items[0].fileRef);
  } finally { files?.close(); await fs.rm(fixture, { recursive: true, force: true }); }
  for (const invalid of [{ ...raw, items: [...raw.items, ...raw.items] }, { ...raw, physicalBounds: { ...raw.physicalBounds, width: -1 } },
    { ...raw, physicalBounds: { x: 0, y: 0, width: 200 } }, { ...raw, skipped: -1 },
    { ...raw, items: [{ ...raw.items[0], icon: { ...icon, base64: 'c2VjcmV0' } }] },
    { ...raw, items: [{ ...raw.items[0], isFluxAppShortcut: 'yes' }] }]) {
    assert.throws(() => validateNativeDesktop(invalid)); count++;
  }
  const browserService = new DesktopShellService({ ...deps, platform: 'linux', run: () => { throw new Error('Не запускать'); } });
  check('Другие ОС не запускают Windows-помощник', (await browserService.snapshot()).status === 'unsupported');
  let trusted = false, licensed = true;
  setupDesktopShell({ isTrusted: () => trusted, mayRead: () => licensed });
  const sender = Object.assign(new EventEmitter(), { id: 1 });
  await assert.rejects(() => handlers.get(SHELL_DESKTOP_SNAPSHOT)!({ sender }), /Войдите/); count++;
  trusted = true; licensed = false;
  await assert.rejects(() => handlers.get(SHELL_DESKTOP_OPEN)!({ sender }, key), /Войдите/); count++;
  licensed = true;
  if (process.platform !== 'win32') {
    check('Разрешённый IPC вне Windows сообщает ограничение платформы', (await handlers.get(SHELL_DESKTOP_SNAPSHOT)!({ sender })).status === 'unsupported');
  }
  app.emit('will-quit');
  check('При выходе снимаются наблюдения за экранами', screen.listenerCount('display-metrics-changed') === 0);
  console.log(`\nПроверено ${count} сценариев моста Shell Windows.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
