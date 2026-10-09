/**
 * Проверки моста Проводника на настоящей Windows и NTFS (windows-latest в
 * verify-windows-shell.yml). Linux этого не покажет: ReplaceFileW, занятые
 * файлы, корзина, Оболочка и миниатюры — особенности ОС, а не Node.
 *
 * Правила этого набора:
 *  - то, чего на машине нет (второй том), называется SKIP и попадает в итог
 *    строкой «пропущено», а не тихим успехом;
 *  - известное ограничение (запись по пути длиннее 260 знаков) называется
 *    LIMIT и описывается словами, но порча данных при этом не допускается;
 *  - на других ОС набор ничего не проверяет и говорит об этом вслух.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WindowsFilesService, hashWindowsBytes } from '../electron/filesystem/service';
import { ShellCommands } from '../electron/filesystem/shellCommands';
import { enumerateWindowsVolumes } from '../electron/filesystem/nativePlaces';
import { NativeShellHost } from '../electron/nativeShellHost';
import { undoLast } from '../electron/filesystem/undo';
import { SearchRegistry } from '../electron/filesystem/search';
import type { WindowsFileRef, WindowsSearchHit } from '../filesystem/contracts';

const run = promisify(execFile);
let passed = 0, failed = 0, skipped = 0, limits = 0;
const ok = (message: string) => { passed++; console.log(`✓ ${message}`); };
const bad = (message: string, detail?: unknown) => { failed++; console.error(`✗ ${message}${detail === undefined ? '' : `\n   ${detail instanceof Error ? `${(detail as any).code ?? ''} ${detail.message}` : String(detail)}`}`); };
const skip = (message: string) => { skipped++; console.log(`SKIP ${message}`); };
const limit = (message: string) => { limits++; console.log(`LIMIT ${message}`); };
const check = (condition: unknown, message: string, detail?: unknown) => condition ? ok(message) : bad(message, detail);
let helperHost: NativeShellHost | undefined;
async function section(name: string, work: () => Promise<void>) {
  try { await work(); } catch (error) {
    bad(`${name}: набор прерван непредвиденной ошибкой`, error);
    if ((error as any)?.nativeDiagnostic) console.error(`   диагностика помощника: ${JSON.stringify((error as any).nativeDiagnostic)}`);
    if (helperHost?.lastStderr) console.error(`   stderr помощника: ${helperHost.lastStderr.replace(/\r?\n/gu, ' / ').slice(0, 2500)}`);
  }
}
/** Поиск до конца: страницы собираются, пока не придёт done. */
const searchEverything = (service: WindowsFilesService, ref: WindowsFileRef, query: string) => new Promise<WindowsSearchHit[]>((resolve, reject) => {
  const hits: WindowsSearchHit[] = [];
  try { new SearchRegistry().start(service, 1, { ref, requestId: 'native-search', query }, (_owner, event) => { hits.push(...event.hits); if (event.done) event.error ? reject(new Error(event.error.message)) : resolve(hits); }); }
  catch (error) { reject(error); }
});
const text = (value: string) => Buffer.from(value).toString('base64');
const PNG_64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=';

/** Корзина Windows без Electron: тот же системный вызов, что у shell.trashItem. */
async function recycle(target: string) {
  await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:FLUX_TRASH; if ((Get-Item -LiteralPath $p -Force).PSIsContainer) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }"],
  { env: { ...process.env, FLUX_TRASH: target }, windowsHide: true, timeout: 30_000 });
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('SKIP scripts/test-windows-files-native.ts проверяет настоящую NTFS, корзину и Оболочку Windows; здесь он ничего не проверяет. Запускается в verify-windows-shell.yml.');
    return;
  }
  // Системный диск: корзина на диске временных файлов раннера (D:) может быть отключена, а профиль пользователя — на C:.
  const base = await fs.mkdtemp(path.join(os.homedir(), 'flux-native-'));
  // Трассировка помощника: если он упадёт, шаги в stderr покажут, где именно.
  process.env.FLUX_SHELL_TRACE = '1';
  const host = new NativeShellHost(); helperHost = host;
  let service: WindowsFilesService | undefined; let shell: ShellCommands | undefined;
  try {
    const desktop = path.join(base, 'Рабочий стол'); const userData = path.join(base, 'данные Flux');
    await fs.mkdir(desktop, { recursive: true });
    shell = new ShellCommands({} as WindowsFilesService, host); // подменяется ниже, когда служба создана
    service = await WindowsFilesService.create({
      userData, knownFolders: { desktop }, trashItem: recycle, showItemInFolder: () => undefined, openPath: async () => '',
      fileDetails: async paths => host.call('file-info', { paths }),
      restoreFromTrash: info => shell!.restoreFromTrash(info),
    });
    shell = new ShellCommands(service, host);
    const svc = service; const rootId = (await svc.roots())[0].id; const R = (relativePath: string) => ({ rootId, relativePath });
    const dir = (relative: string) => path.join(desktop, ...relative.split('/'));

    await section('Помощник Оболочки', async () => {
      const first = await host.call('ping').then(() => null, error => error);
      if (first) { bad('Нативный помощник собирается и отвечает', `${first.code}: ${host.lastFailure}\n   ${host.lastStderr}`); throw new Error('помощник не запустился — остальные нативные проверки невозможны'); }
      ok('Нативный помощник (C# через Add-Type) собирается на этой Windows и отвечает на ping');
    });

    await section('Запись и замена файла', async () => {
      const created = await svc.createDraft(R(''), 'Расчёт.txt', text('первая версия'));
      const published = await svc.publishDraft(created.ref) as any;
      const file = await svc.read(published.ref);
      const written = await svc.write(published.ref, text('вторая версия'), file.sha256);
      check(await fs.readFile(dir('Расчёт.txt'), 'utf8') === 'вторая версия' && written.fileId === file.fileId, 'Замена файла через ReplaceFileW меняет содержимое и сохраняет идентичность файла');
      try { await svc.write(published.ref, text('чужая версия'), file.sha256); bad('Устаревшая версия не должна записываться'); }
      catch (error: any) { check(error.code === 'CONFLICT' && await fs.readFile(dir('Расчёт.txt'), 'utf8') === 'вторая версия', 'Запись поверх чужой версии отклонена конфликтом, файл не тронут', error); }
      check(!(await fs.readdir(desktop)).some(name => name.startsWith('.flux-')), 'Временные файлы и блокировки записи не остаются в папке');
    });

    await section('Заблокированный файл', async () => {
      await fs.writeFile(dir('Занят.txt'), 'до блокировки');
      const before = await svc.read(R('Занят.txt'));
      const hold = (share: string) => new Promise<ReturnType<typeof spawn>>((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          "$f = [IO.File]::Open($env:FLUX_LOCK, 'Open', 'ReadWrite', $env:FLUX_SHARE); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Seconds 90"],
          { env: { ...process.env, FLUX_LOCK: dir('Занят.txt'), FLUX_SHARE: share }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => { child.kill(); reject(new Error('процесс-держатель не взял файл за 30 с')); }, 30_000);
        child.stdout.on('data', chunk => { if (String(chunk).includes('locked')) { clearTimeout(timer); resolve(child); } });
        child.on('error', reject);
      });
      const release = (child: ReturnType<typeof spawn>) => new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill(); });
      let holder = await hold('None');
      try {
        const reading = await svc.read(R('Занят.txt')).then(() => null, error => error);
        check(reading && ['EBUSY', 'EPERM', 'EACCES'].includes(reading.code), 'Файл, открытый другой программой без общего доступа, не читается молча: понятный отказ', reading);
        const writing = await svc.write(R('Занят.txt'), text('перезапись'), before.sha256).then(() => null, error => error);
        check(!!writing, 'Запись в занятый файл отказывает', writing);
      } finally { await release(holder); }
      // Содержимое сверяется после освобождения: пока держатель открыл файл без общего доступа, его не может прочитать и сама проверка.
      check(await fs.readFile(dir('Занят.txt'), 'utf8') === 'до блокировки', 'После отказа записи в занятый файл содержимое цело');
      holder = await hold('Read');
      try {
        const writing = await svc.write(R('Занят.txt'), text('перезапись при читателе'), before.sha256).then(() => null, error => error);
        check(!!writing && ['EBUSY', 'EPERM', 'NATIVE_REPLACE_FAILED', 'CONFLICT'].includes(writing.code) && await fs.readFile(dir('Занят.txt'), 'utf8') === 'до блокировки', 'Файл, открытый на запись другой программой, не заменяется: отказ с названным кодом, содержимое цело', writing);
        check(!(await fs.readdir(desktop)).some(name => /^\.flux-.*\.tmp$/u.test(name)), 'Отказ не оставляет временных файлов');
      } finally { await release(holder); }
      await svc.write(R('Занят.txt'), text('после освобождения'), (await svc.read(R('Занят.txt'))).sha256);
      check(await fs.readFile(dir('Занят.txt'), 'utf8') === 'после освобождения', 'Когда файл освобождён, запись проходит');
    });

    await section('Кириллица и длинный путь', async () => {
      const segments = Array.from({ length: 9 }, (_, i) => `Очень длинное имя папки проекта номер ${i + 1}`);
      const relative = segments.join('/');
      const absolute = dir(relative);
      check(absolute.length > 300, `Путь длиннее 260 знаков: ${absolute.length}`);
      await fs.mkdir(absolute, { recursive: true });
      await fs.writeFile(path.join(absolute, 'Отчёт «итог».txt'), 'длинный путь');
      const listing = await svc.list(R(relative));
      check(listing.entries.some(item => item.name === 'Отчёт «итог».txt'), 'Список папки по длинному пути с кириллицей работает');
      check((await svc.read(R(`${relative}/Отчёт «итог».txt`))).base64 === text('длинный путь'), 'Чтение файла по длинному пути работает');
      const copy = await svc.copy(R(`${relative}/Отчёт «итог».txt`), R(relative), 'Копия «итог».txt');
      check(copy.file.size === Buffer.byteLength('длинный путь'), 'Копирование по длинному пути работает');
      const found = await searchEverything(svc, R(''), 'итог');
      check(found.some(hit => hit.name === 'Отчёт «итог».txt' && hit.parentPath === relative), 'Поиск находит файл на глубине девяти уровней по длинному пути');
      const read = await svc.read(R(`${relative}/Отчёт «итог».txt`));
      try {
        await svc.write(R(`${relative}/Отчёт «итог».txt`), text('перезаписано'), read.sha256);
        check(await fs.readFile(path.join(absolute, 'Отчёт «итог».txt'), 'utf8') === 'перезаписано', 'Запись (ReplaceFileW) по длинному пути работает');
      } catch (error: any) {
        // Windows PowerShell без LongPathsEnabled не принимает пути длиннее 260 знаков: это ограничение ОС, не порча данных.
        limit(`запись по пути длиннее 260 знаков отказала (${error.code}); исходный файл ${await fs.readFile(path.join(absolute, 'Отчёт «итог».txt'), 'utf8') === 'длинный путь' ? 'цел' : 'ИЗМЕНЁН'}`);
        check(await fs.readFile(path.join(absolute, 'Отчёт «итог».txt'), 'utf8') === 'длинный путь', 'Отказ записи по длинному пути не портит исходный файл');
      }
    });

    await section('Перенос между томами', async () => {
      const volumes = await enumerateWindowsVolumes();
      const mine = path.parse(base).root.toUpperCase();
      let second: string | null = null;
      for (const volume of volumes.filter(item => (item.kind === 'fixed' || item.kind === 'removable') && item.path.toUpperCase() !== mine)) {
        const candidate = path.join(volume.path, `flux-native-${process.pid}`);
        try { await fs.mkdir(candidate); second = candidate; break; } catch { /* том только для чтения или без прав */ }
      }
      if (!second) { skip(`перенос между томами: на этой машине нет второго доступного для записи тома (найдено: ${volumes.map(item => item.path).join(', ') || 'ни одного'})`); return; }
      try {
        const other = await svc.addRoot(second, 'Второй том'); const O = (relativePath: string) => ({ rootId: other.id, relativePath });
        await fs.writeFile(dir('Переезд.txt'), 'переезжает между дисками');
        const sha = hashWindowsBytes(Buffer.from('переезжает между дисками'));
        const moved = await svc.move(R('Переезд.txt'), O(''), 'Приехал.txt');
        check(moved.ref.rootId === other.id && await fs.readFile(path.join(second, 'Приехал.txt'), 'utf8') === 'переезжает между дисками' && !(await fs.stat(dir('Переезд.txt')).then(() => true, () => false)), `Перенос файла между томами (${mine} → ${path.parse(second).root}) копирует и удаляет оригинал`);
        check((await svc.read(O('Приехал.txt'))).sha256 === sha, 'Содержимое после переноса между томами совпадает побайтно');
        await fs.mkdir(dir('Папка переезда/Вложенная'), { recursive: true }); await fs.writeFile(dir('Папка переезда/Вложенная/файл.txt'), 'в папке');
        await svc.move(R('Папка переезда'), O(''), 'Папка приехала');
        check(await fs.readFile(path.join(second, 'Папка приехала', 'Вложенная', 'файл.txt'), 'utf8') === 'в папке' && !(await fs.stat(dir('Папка переезда')).then(() => true, () => false)), 'Перенос папки между томами проверяет копию и отправляет оригинал в корзину');
      } finally { await fs.rm(second, { recursive: true, force: true }); }
    });

    await section('Корзина Windows', async () => {
      await fs.mkdir(dir('Корзина'), { recursive: true });
      const since = Date.now() - 5000;
      await fs.writeFile(dir('Корзина/в корзину.txt'), 'удалить и вернуть'); await fs.writeFile(dir('Корзина/навсегда.txt'), 'удалить навсегда');
      await svc.trash(R('Корзина/в корзину.txt')); await svc.trash(R('Корзина/навсегда.txt'));
      const listed = await shell!.recycleBin(1);
      let binWhy: unknown = listed.message;
      if (!listed.supported) binWhy = await host.call('bin-list').then(rows => `помощник ответил: ${JSON.stringify(rows).slice(0, 300)}`, (error: any) => `${error.code} ${JSON.stringify(error.nativeDiagnostic)}\n   stderr помощника: ${host.lastStderr.replace(/\r?\n/gu, ' / ').slice(0, 2500)}`);
      check(listed.supported, 'Список корзины Windows читается помощником', binWhy);
      const binDir = (await fs.realpath(dir('Корзина'))).toLowerCase();
      const mine = (name: string) => listed.items.find(item => item.name.replace(/\.txt$/iu, '') === name && item.location.toLowerCase() === binDir);
      const one = mine('в корзину'), two = mine('навсегда');
      check(!!one && !!two && one!.size === Buffer.byteLength('удалить и вернуть') && one!.deletedAt !== null && Date.parse(one!.deletedAt!) >= since, 'В списке корзины видны имя, исходное расположение, дата удаления и размер', JSON.stringify(listed.items.slice(0, 3)));
      check(!JSON.stringify(listed).includes('$Recycle.Bin'), 'Внутренние имена корзины интерфейсу не отдаются');
      if (!one || !two) return;
      await shell!.recycleBinRestore(1, [one.id]);
      check(await fs.readFile(dir('Корзина/в корзину.txt'), 'utf8') === 'удалить и вернуть', 'Восстановление из корзины возвращает файл на прежнее место с содержимым');
      const again = await shell!.recycleBin(1); const two2 = again.items.find(item => item.name.replace(/\.txt$/iu, '') === 'навсегда');
      await shell!.recycleBinPurge(1, [two2!.id]);
      const after = await shell!.recycleBin(1);
      check(!after.items.some(item => item.name.replace(/\.txt$/iu, '') === 'навсегда' && item.location.toLowerCase() === binDir) && !(await fs.stat(dir('Корзина/навсегда.txt')).then(() => true, () => false)), 'Удаление навсегда убирает объект из корзины и не возвращает на диск');
      // Отмена удаления через журнал: настоящая корзина, поиск по исходному месту и времени.
      await svc.trash(R('Корзина/в корзину.txt'));
      await undoLast(svc);
      check(await fs.readFile(dir('Корзина/в корзину.txt'), 'utf8') === 'удалить и вернуть', 'Отмена удаления возвращает файл из настоящей корзины Windows');
    });

    await section('Миниатюры и значки', async () => {
      await fs.writeFile(dir('Картинка.png'), Buffer.from(PNG_64, 'base64')); await fs.writeFile(dir('Заметка.txt'), 'текст');
      const picture = await shell!.thumbnail(R('Картинка.png'), 96, false);
      check(!!picture && picture.dataUrl.startsWith('data:image/png;base64,') && picture.width > 0 && picture.height > 0, `Миниатюра PNG приходит картинкой (${picture ? `${picture.width}×${picture.height}, ${picture.thumbnail ? 'содержимое файла' : 'значок типа'}` : 'нет'})`);
      const note = await shell!.thumbnail(R('Заметка.txt'), 48, false);
      check(!!note && note.width > 0, 'У текстового файла миниатюра — значок типа от Windows');
      const folder = await shell!.thumbnail(R('Корзина'), 48, false);
      check(!!folder && folder.width > 0, 'У папки есть значок от Windows');
      const again = await shell!.thumbnail(R('Картинка.png'), 96, false);
      check(again === picture, 'Повторный запрос приходит из кэша');
      for (let i = 0; i < 20; i++) await shell!.thumbnail(R('Заметка.txt'), 20 + i * 10, false);
      check(host.running, 'Двадцать подряд запросов обслуживает один запущенный помощник');
      const computer = await shell!.placeIcon('computer', 32);
      check(!!computer?.dataUrl.startsWith('data:image/png;base64,'), 'Значок «Этот компьютер» поступает из виртуального места Windows');
      const invalidPlace = await shell!.placeIcon('произвольное место', 32).then(() => null, error => error.code);
      check(invalidPlace === 'INVALID_REQUEST', 'Команда значка виртуального места принимает только фиксированные места');
    });

    await section('Системные свойства и скрытые объекты', async () => {
      await fs.writeFile(dir('Скрытый.txt'), 'тест системного атрибута');
      await run('attrib.exe', ['+H', dir('Скрытый.txt')]);
      const rows = await host.call('file-info', { paths: [dir('Скрытый.txt'), dir('Заметка.txt')] });
      check(rows[0]?.hidden === true && rows[1]?.hidden === false, 'Hidden читается из атрибута Windows, а не из имени файла');
      const properties = await shell!.fileProperties(R('Скрытый.txt'));
      check(properties.hidden && Number.isFinite(Date.parse(properties.createdAt)) && typeof properties.author === 'string', 'Системные свойства возвращают дату создания, скрытость и строку автора');
      const hits = await searchEverything(svc, R(''), 'Скрытый.txt');
      check(hits.length === 1 && hits[0].hidden === true, 'Результат поиска сохраняет атрибут Hidden настоящего файла Windows');
    });

    await section('Быстрый доступ и облачные корни', async () => {
      const quick = await shell!.quickAccess();
      check(quick.supported && Array.isArray(quick.items) && quick.items.every(item => item.name && typeof item.pinned === 'boolean' && item.ref.rootId), `Быстрый доступ Windows читается (${quick.items.length} папок, закреплено ${quick.items.filter(item => item.pinned).length})`, quick.message);
      check(!JSON.stringify(quick).includes(os.homedir()), 'В Быстром доступе нет абсолютных путей');
      await fs.mkdir(dir('Закрепить'), { recursive: true });
      const pinned = await shell!.pin(R('Закрепить'), true);
      const afterPin = await shell!.quickAccess();
      check(pinned.pinned && afterPin.items.some(item => item.name === 'Закрепить' && item.pinned), 'Закрепление папки через shell-глагол pintohome появляется в списке закреплённых', JSON.stringify(afterPin.items.map(item => [item.name, item.pinned])));
      const unpinned = await shell!.pin(R('Закрепить'), false);
      const afterUnpin = await shell!.quickAccess();
      check(!afterUnpin.items.some(item => item.name === 'Закрепить' && item.pinned), 'Открепление через unpinfromhome убирает папку из закреплённых', `помощник ответил ${JSON.stringify(unpinned)}; список: ${JSON.stringify(afterUnpin.items.map(item => [item.name, item.pinned]))}`);
      const cloud = await shell!.cloudRoots();
      check(cloud.supported && Array.isArray(cloud.items) && cloud.items.every(item => (item.provider as string) !== 'onedrive'), `Облачные места SyncRootManager читаются без OneDrive (${cloud.items.length}: ${cloud.items.map(item => item.name).join(', ') || 'кроме исключённого OneDrive, облачных папок нет'})`);
      for (const item of cloud.items) check(item.root.id && item.root.available, `Облачный корень «${item.name}» стал корнем-capability`);
    });

    await section('Тома, «Открыть с помощью», классическое меню', async () => {
      const volumes = await enumerateWindowsVolumes();
      check(volumes.length > 0 && volumes.every(item => item.label && /^[A-Z]:$/u.test(item.letter) && (item.size === null || item.used !== null)), `Тома: метка, буква и занятое место (${volumes.map(item => `${item.name} ${item.used}/${item.size}`).join('; ')})`);
      await fs.writeFile(dir('Для меню.txt'), 'меню');
      const handlers = await shell!.openWithList(1, R('Для меню.txt'));
      check(handlers.length > 0 && handlers.every(item => item.name && item.id), `Для .txt Windows предлагает программы: ${handlers.map(item => item.name).join(', ')}`);
      const menu = await shell!.shellMenu(1, [R('Для меню.txt')], false);
      const flat = (items: any[]): any[] => items.flatMap(item => [item, ...(item.submenu ? flat(item.submenu) : [])]);
      const verbs = flat(menu.items).map(item => item.verb).filter(Boolean);
      check(menu.items.length > 0 && verbs.includes('properties'), `Классическое меню Windows построено (${flat(menu.items).length} пунктов; команды: ${verbs.slice(0, 8).join(', ')})`,
        `все пункты (подпись=команда): ${flat(menu.items).filter(item => !item.separator).map(item => `${item.label}=${item.verb ?? '-'}`).join(' | ')}`);
      if (!verbs.includes('properties')) {
        const raw = await host.call('menu-open', { paths: [dir('Для меню.txt')], extended: false }, 20_000);
        const rawFlat = (items: any[]): any[] => items.flatMap(item => [item, ...(item.submenu ? rawFlat(item.submenu) : [])]);
        console.log(`   ${raw.scan}\n   ${rawFlat(raw.items).filter(item => item.probe).map(item => `[${item.label}] ${item.probe}`).join('\n   ')}`);
        await host.call('menu-close');
      }
      await shell!.shellMenuClose(1, menu.token);
      skip('вызов пунктов меню и запуск программы через «Открыть с помощью»: открывают окна Windows, на неинтерактивной сессии CI не проверяются');
      skip('startDrag: требует окно Electron (webContents.startDrag); проверяется отказ для черновика на Linux и приёмкой владельца');
    });
  } finally {
    host.close(); service?.close();
    await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
  console.log(`\n${passed} проверок пройдено, ${failed} провалено, ${skipped} пропущено (SKIP), ${limits} ограничений ОС (LIMIT)`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
