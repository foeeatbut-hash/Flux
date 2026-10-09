/**
 * Мост Проводника, этап A, слой «команды и нативный помощник»: то, что можно
 * проверить без Windows. Сам C#-помощник здесь не запускается — на Windows его
 * проверяет scripts/test-windows-files-native.ts. Здесь проверяются:
 *  - обмен с процессом-помощником (подставной процесс на Node): строки JSON,
 *    таймаут, обрыв, перезапуск, засыпание;
 *  - ShellCommands над подставным помощником: capability вместо путей,
 *    непрозрачные идентификаторы, кэш миниатюр, отказ вне Windows;
 *  - ExplorerBridge: каждая команда подключена, права на запись названы;
 *  - согласованность исходника помощника с тем, как его зовёт JS.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeShellHost } from '../electron/nativeShellHost';
import { NATIVE_SHELL_SCRIPT, NATIVE_SHELL_SOURCE } from '../electron/nativeShellSource';
import { ShellCommands, type NativeShellCaller } from '../electron/filesystem/shellCommands';
import { ExplorerBridge, EXPLORER_WRITE_ACTIONS, isExplorerAction } from '../electron/filesystem/explorerBridge';
import { ViewStateStore } from '../electron/filesystem/viewState';
import { OpaqueIds } from '../electron/filesystem/opaque';
import { WindowsFilesService } from '../electron/filesystem/service';
import { INVOKE_CHANNELS, SEND_CHANNELS } from '../electron/ipcAllow';
import type { WindowsFilesRequest, WindowsSearchEvent } from '../filesystem/contracts';

let passed = 0;
function check(condition: unknown, message: string) { assert.ok(condition, message); passed++; console.log(`✓ ${message}`); }
async function rejects(work: () => Promise<unknown>, code: string, message: string) {
  await assert.rejects(work, (error: any) => error.code === code || (console.error(`   получено ${error.code}: ${error.message}`), false)); passed++; console.log(`✓ ${message}`);
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=';
const read = (file: string) => fs.readFile(file, 'utf8');

async function main() {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-windows-bridge-test-'));
  try {
    // ---- исходник помощника: что нельзя проверить компиляцией здесь, проверяется по тексту
    const csharp = NATIVE_SHELL_SOURCE;
    // Add-Type в Windows PowerShell 5.1 собирает C# 5: новый синтаксис роняет сборку помощника целиком, а узнаешь об этом только на Windows.
    const modern: [RegExp, string][] = [[/\?\./u, 'null-условный доступ ?.'], [/\$"/u, 'интерполяция строк'], [/nameof\(/u, 'nameof'], [/\bout var\b/u, 'out var'], [/=>/u, 'лямбда или выражение-член'], [/\bis \w+ \w+\)/u, 'сопоставление is с образцом']];
    for (const [pattern, name] of modern) check(!pattern.test(csharp), `Код помощника не использует ${name}: Windows PowerShell 5.1 собирает C# 5`);
    check(NATIVE_SHELL_SCRIPT.includes("@'\n") && /\n'@\n/u.test(NATIVE_SHELL_SCRIPT) && !/\n'@/u.test(csharp), 'Here-string PowerShell не обрывается внутри кода C#');
    check(NATIVE_SHELL_SCRIPT.includes('{"ready":true}') && NATIVE_SHELL_SCRIPT.includes('[FluxShellFiles]::Handle'), 'Цикл помощника сообщает готовность и отвечает построчно');
    const nativeCommands = [...csharp.matchAll(/case "([a-z-]+)":/gu)].map(match => match[1]);
    const shellSource = await read(path.join(__dirname, '../electron/filesystem/shellCommands.ts'));
    const calledCommands = [...new Set([...shellSource.matchAll(/host\.call\('([a-z-]+)'/gu)].map(match => match[1]))];
    check(calledCommands.length >= 12 && calledCommands.every(command => nativeCommands.includes(command)), `Каждую команду, которую зовёт JS (${calledCommands.length}), знает помощник`);
    const NEEDS_NO_UI = ['bin-restore', 'bin-purge'];
    check(NEEDS_NO_UI.every(command => nativeCommands.includes(command)) && /InvokeVerb\(child, verb, true\)/u.test(csharp), 'Команды корзины вызываются без окон подтверждения (NO_UI)');
    check(/GetFileAttributes/u.test(csharp) && /0x400000u/u.test(csharp), 'Миниатюра облачной заглушки не заставляет Windows скачать файл');
    check(/name\.StartsWith\("OneDrive", StringComparison\.OrdinalIgnoreCase\)\) continue;/u.test(csharp), 'SyncRootManager не добавляет OneDrive в облачные места Проводника');
    check(!/ShellExecute|Process\.Start|cmd\.exe/u.test(csharp), 'Помощник не запускает процессы по данным запроса');

    // ---- обмен с процессом-помощником
    const fake = path.join(sandbox, 'fake-host.js');
    await fs.writeFile(fake, `
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'dies') process.exit(1);
if (mode !== 'never-ready') process.stdout.write('{"ready":true}\\n');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let end = buffer.indexOf('\\n'); end >= 0; end = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const request = JSON.parse(line); const reply = value => process.stdout.write(JSON.stringify({ id: request.id, ...value }) + '\\n');
    if (request.cmd === 'echo') reply({ ok: true, data: request.args });
    else if (request.cmd === 'pid') reply({ ok: true, data: process.pid });
    else if (request.cmd === 'fail') reply({ ok: false, code: 'MENU_EXPIRED', stage: 'menu-invoke', hresult: '80004005' });
    else if (request.cmd === 'weird') reply({ ok: false, code: 'bad code!' });
    else if (request.cmd === 'noise') { process.stdout.write('ПРЕДУПРЕЖДЕНИЕ: не JSON\\n'); process.stdout.write(JSON.stringify({ id: 9999, ok: true, data: 'чужой' }) + '\\n'); reply({ ok: true, data: 'после шума' }); }
    else if (request.cmd === 'slow') setTimeout(() => reply({ ok: true, data: request.args.n }), request.args.ms);
    else if (request.cmd === 'hang') { /* зависший вызов Оболочки */ }
    else if (request.cmd === 'crash') process.exit(3);
  }
});
process.stdin.on('end', () => process.exit(0));
`);
    const host = (mode = 'ok', extra: object = {}) => new NativeShellHost({ command: process.execPath, args: [fake], ...extra, ...(mode ? {} : {}) });
    const withMode = async <T>(mode: string, work: () => Promise<T>) => { const old = process.env.FAKE_MODE; process.env.FAKE_MODE = mode; try { return await work(); } finally { if (old === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = old; } };
    const h = host();
    check(h.running === false, 'Помощник не запущен, пока им не пользуются');
    check(JSON.stringify(await h.call('echo', { имя: 'значение «ё»', n: 1 })) === JSON.stringify({ имя: 'значение «ё»', n: 1 }) && h.running, 'Запрос и ответ идут строкой JSON в UTF-8; процесс поднимается по первому запросу');
    const pid = await h.call('pid');
    check(await h.call('pid') === pid, 'Следующие запросы обслуживает тот же процесс: компиляция C# не повторяется на каждую миниатюру');
    const order: number[] = [];
    await Promise.all([h.call('slow', { ms: 60, n: 1 }).then(value => order.push(value)), h.call('slow', { ms: 1, n: 2 }).then(value => order.push(value)), h.call('slow', { ms: 1, n: 3 }).then(value => order.push(value))]);
    check(order.join() === '1,2,3', 'Запросы идут по одному в порядке очереди: помощник однопоточный (STA)');
    await rejects(() => h.call('fail'), 'NATIVE_MENU_EXPIRED', 'Отказ помощника становится ошибкой с понятным кодом и русским текстом');
    const diag = await h.call('fail').catch(error => error);
    check(diag.nativeDiagnostic?.hresult === '80004005' && !/80004005/u.test(diag.message), 'Диагностика (этап, HRESULT) прикладывается к ошибке, но не попадает в текст для человека');
    await rejects(() => h.call('weird'), 'NATIVE_HELPER_FAILED', 'Неизвестный или неправильный код отказа не пропускается наружу как есть');
    check(await h.call('noise') === 'после шума', 'Посторонняя строка и ответ на чужой номер не ломают обмен');
    await rejects(() => h.call('hang', {}, 150), 'NATIVE_TIMEOUT', 'Зависший вызов Оболочки обрывается по таймауту');
    const afterHang = await h.call('pid');
    check(afterHang !== pid, 'После таймаута процесс убит и поднят новый: один плохой файл не отнимает миниатюры у остальных');
    const crashed = h.call('crash'); await rejects(() => crashed, 'NATIVE_CRASHED', 'Обрыв процесса во время запроса — отказ этого запроса');
    check(typeof await h.call('pid') === 'number', 'После обрыва следующий запрос поднимает помощника заново');
    const sleepy = host('ok', { idleMs: 80 });
    await sleepy.call('pid'); await wait(250);
    check(!sleepy.running, 'Неиспользуемый помощник засыпает и освобождает процесс PowerShell');
    check(typeof await sleepy.call('pid') === 'number' && sleepy.running, 'А следующий запрос будит его');
    sleepy.close();
    await rejects(() => withMode('dies', () => host('dies').call('echo')), 'NATIVE_UNAVAILABLE', 'Помощник, не сумевший запуститься, — понятный отказ, а не зависание');
    const broken = host('dies'); let failures = 0;
    await withMode('dies', async () => { for (let i = 0; i < 5; i++) await broken.call('echo').catch(() => failures++); });
    check(failures === 5, 'Серия неудачных запусков не превращается в бесконечный перезапуск: после трёх отказ мгновенный');
    const unready = host('never-ready', { startupMs: 200 });
    await rejects(() => withMode('never-ready', () => unready.call('echo')), 'NATIVE_UNAVAILABLE', 'Помощник, не сообщивший о готовности, ограничен временем запуска');
    const closing = host(); const pending = closing.call('hang', {}, 5000).catch(error => error.code); await wait(100); closing.close();
    check(await pending === 'NATIVE_CLOSED' && await closing.call('echo').catch(error => error.code) === 'NATIVE_CLOSED', 'Закрытие программы отказывает ожидающим запросам и не оставляет процесс-сироту');
    const linux = new NativeShellHost({ platform: 'linux' });
    await rejects(() => linux.call('thumbnail'), 'NOT_WINDOWS', 'Вне Windows помощник даже не пытается запуститься: понятная ошибка, а не падение');
    h.close();

    // ---- ShellCommands над подставным помощником
    const desktop = path.join(sandbox, 'desktop'); const userData = path.join(sandbox, 'data'); const elsewhere = path.join(sandbox, 'вне корня');
    await fs.mkdir(path.join(desktop, 'Проект', 'Вложенная'), { recursive: true }); await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(desktop, 'Проект', 'Файл.docx'), 'содержимое'); await fs.writeFile(path.join(desktop, 'Проект', 'Другой.docx'), 'другое');
    const service = await WindowsFilesService.create({ userData, knownFolders: { desktop }, trashItem: async () => undefined, showItemInFolder: () => undefined, openPath: async () => '' });
    const rootId = (await service.roots())[0].id; const real = await fs.realpath(desktop);
    const calls: { command: string; args: any }[] = [];
    let answers: Record<string, (args: any) => unknown> = {};
    const fakeHost: NativeShellCaller = { call: async (command, args = {}) => { calls.push({ command, args }); const answer = answers[command]; if (!answer) throw Object.assign(new Error('нет ответа'), { code: 'NATIVE_HELPER_FAILED' }); return answer(args); } };
    const shell = new ShellCommands(service, fakeHost, { platform: 'win32', acceptPath: value => typeof value === 'string' && path.isAbsolute(value) ? value : null });
    const R = (relativePath: string) => ({ rootId, relativePath });

    answers['quick-access'] = () => [
      { name: 'Проект', path: path.join(real, 'Проект'), pinned: true }, { name: 'Вне корня', path: elsewhere, pinned: false },
      { name: 'Не путь', path: 'относительный', pinned: true }, { name: '', path: elsewhere }, { name: 'Нет такой', path: path.join(sandbox, 'нет'), pinned: false },
    ];
    const quick = await shell.quickAccess();
    check(quick.supported && quick.items.length === 2 && quick.items[0].pinned && !quick.items[1].pinned, 'Быстрый доступ: закреплённые и частые, мусорные строки отброшены');
    check(quick.items[0].ref.rootId === rootId && quick.items[0].ref.relativePath === 'Проект', 'Папка внутри подключённого корня получает относительный путь в нём');
    const quickRoot = quick.items[1].ref;
    check(quickRoot.relativePath === '' && quickRoot.rootId !== rootId && (await service.list(quickRoot)).entries.length === 0, 'Папка вне корней становится собственным корнем: capability, а не путь');
    check(!JSON.stringify(quick).includes(sandbox), 'В ответе Быстрого доступа нет абсолютных путей');
    check(JSON.stringify((await shell.quickAccess()).items[1].ref) === JSON.stringify(quickRoot), 'Повторный список возвращает тот же корень, а не плодит новые');
    answers['quick-pin'] = args => ({ changed: true, echo: args });
    check(JSON.stringify(await shell.pin(R('Проект'), true)) === JSON.stringify({ pinned: true, changed: true }) && calls[calls.length - 1].args.path === path.join(real, 'Проект') && calls[calls.length - 1].args.pin === true, 'Закрепление передаёт помощнику настоящий путь папки и намерение');
    await shell.pin(R('Проект'), false);
    check(calls[calls.length - 1].args.pin === false, 'Открепление — то же через pin: false');
    await rejects(() => shell.pin(R('Проект/Файл.docx'), true), 'NOT_DIRECTORY', 'В Быстрый доступ закрепляются только папки');
    await rejects(() => shell.pin(R('Проект'), 'да' as any), 'INVALID_REQUEST', 'Намерение закрепления проверяется');
    const draftFolder = await service.createDraftFolder(R('Проект'), 'Черновая');
    await rejects(() => shell.pin(draftFolder.ref, true), 'DRAFT_NOT_PUBLISHED', 'Черновую папку в Быстрый доступ Windows не закрепить');
    await rejects(() => shell.pin({ rootId, relativePath: '../вне корня' }, true), 'INVALID_NAME', 'Закрепление не выходит за подключённые папки');

    const cloudFolder = path.join(sandbox, 'Яндекс Диск'); await fs.mkdir(cloudFolder);
    const oneDriveFolder = path.join(sandbox, 'OneDrive - Компания'); await fs.mkdir(oneDriveFolder);
    await fs.writeFile(path.join(oneDriveFolder, 'Файл.docx'), 'локальный файл');
    answers['cloud-roots'] = () => [
      { id: 'YandexDisk!S-1', name: 'Яндекс Диск', provider: 'yandex', path: cloudFolder, icon: PNG_1X1 },
      { id: 'OneDrive!S-1', name: 'OneDrive - Компания', provider: 'onedrive', path: oneDriveFolder, icon: null },
      { id: 'Other!S-1', name: 'Прочее', provider: 'странный', path: elsewhere, icon: 'не png' },
    ];
    const cloud = await shell.cloudRoots();
    check(cloud.supported && cloud.items.map(item => item.provider).join() === 'yandex,other' && !cloud.items.some(item => item.id === 'OneDrive!S-1') && cloud.items[0].icon?.startsWith('data:image/png;base64,') === true && cloud.items[1].icon === null, 'Облачные места исключают OneDrive, сохраняя Яндекс Диск и прочие корни');
    check(cloud.items[0].root.id !== rootId && cloud.items[0].root.kind === 'custom' && !JSON.stringify(cloud).includes(sandbox), 'Каждый облачный корень — отдельный capability, как подключённая папка, без путей');
    const oneDriveRoot = await service.addRoot(oneDriveFolder, 'OneDrive - Компания');
    const oneDriveListing = await service.list({ rootId: oneDriveRoot.id, relativePath: '' });
    check(oneDriveListing.entries.some(item => item.name === 'Файл.docx'), 'Папка внутри OneDrive остаётся доступной как обычный физический корень');

    // миниатюры
    const png = (extra: object = {}) => ({ base64: PNG_1X1, width: 96, height: 96, thumbnail: true, ...extra });
    answers.thumbnail = () => png();
    const thumbCalls = () => calls.filter(call => call.command === 'thumbnail').length;
    const t1 = await shell.thumbnail(R('Проект/Файл.docx'), 70, false);
    check(t1?.dataUrl.startsWith('data:image/png;base64,') === true && calls.find(call => call.command === 'thumbnail')!.args.size === 96, 'Размер миниатюры округляется вверх до ступени (70 → 96), чтобы кэш не множился по пикселю');
    await shell.thumbnail(R('Проект/Файл.docx'), 90, false);
    check(thumbCalls() === 1, 'Повторный запрос той же ступени отдаётся из кэша, помощник не зовётся');
    await shell.thumbnail(R('Проект/Файл.docx'), 256, false); await shell.thumbnail(R('Проект/Файл.docx'), 96, true);
    check(thumbCalls() === 3, 'Другая ступень и режим «только содержимое» — отдельные записи кэша');
    await fs.writeFile(path.join(desktop, 'Проект', 'Файл.docx'), 'новое содержимое другой длины');
    await shell.thumbnail(R('Проект/Файл.docx'), 96, false);
    check(thumbCalls() === 4, 'Правка файла меняет ключ кэша: старая миниатюра не показывается');
    await Promise.all([shell.thumbnail(R('Проект/Другой.docx'), 48, false), shell.thumbnail(R('Проект/Другой.docx'), 48, false)]);
    check(thumbCalls() === 5, 'Два одновременных запроса одной миниатюры сливаются в один вызов помощника');
    answers.thumbnail = () => ({ base64: 'AAAA', width: 1, height: 1 });
    check(await shell.thumbnail(R('Проект/Вложенная'), 32, false) === null, 'Ответ, который не PNG, миниатюрой не становится');
    answers.thumbnail = () => null;
    check(await shell.thumbnail(R('Проект/Файл.docx'), 16, true) === null, 'Файл без миниатюры — null: интерфейс покажет значок типа');
    const draft = await service.createDraft(R('Проект'), 'Тихий.md', Buffer.from('д').toString('base64'));
    await rejects(() => shell.thumbnail(draft.ref, 32, false), 'DRAFT_NOT_PUBLISHED', 'У черновика нет файла Windows — миниатюру запросить нельзя');
    await rejects(() => shell.thumbnail(R('Проект/Файл.docx'), 'большой' as any, false), 'INVALID_REQUEST', 'Размер миниатюры проверяется');
    await rejects(() => shell.thumbnail({ rootId, relativePath: '../вне корня/x' }, 32, false), 'INVALID_NAME', 'Миниатюра не читает файл вне подключённой папки');

    // «Открыть с помощью»
    answers['open-with-list'] = () => [{ name: 'C:\\Program Files\\Word\\WINWORD.EXE', title: 'Word', recommended: true, icon: PNG_1X1 }, { name: 'notepad.exe', title: 'Блокнот', recommended: false, icon: null }, { name: 'x', title: 'a'.repeat(300) }];
    answers['open-with'] = args => ({ opened: true, args });
    const handlers = await shell.openWithList(1, R('Проект/Файл.docx'));
    check(handlers.length === 2 && handlers[0].name === 'Word' && handlers[0].recommended && !JSON.stringify(handlers).includes('WINWORD') && /^[0-9a-f-]{36}$/u.test(handlers[0].id), 'Список программ: имя и значок, а путь к exe заменён непрозрачным номером');
    await shell.openWith(1, R('Проект/Файл.docx'), handlers[0].id);
    check(calls[calls.length - 1].args.name === 'C:\\Program Files\\Word\\WINWORD.EXE' && calls[calls.length - 1].args.path === path.join(real, 'Проект', 'Файл.docx'), 'Запуск по номеру передаёт помощнику настоящее имя программы и путь файла');
    await rejects(() => shell.openWith(1, R('Проект/Другой.docx'), handlers[0].id), 'HANDLER_EXPIRED', 'Номер, выданный для другого файла, не принимается');
    await rejects(() => shell.openWith(2, R('Проект/Файл.docx'), handlers[0].id), 'HANDLER_EXPIRED', 'Номер другого окна не принимается');
    await rejects(() => shell.openWith(1, R('Проект/Файл.docx'), 'C:\\Windows\\system32\\cmd.exe'), 'HANDLER_EXPIRED', 'Произвольная строка вместо номера не запускает ничего');
    check((await shell.openWithList(1, R('Проект/Вложенная'))).length === 0, 'У папки списка программ нет');
    await shell.openWithList(1, R('Проект/Файл.docx'));
    await rejects(() => shell.openWith(1, R('Проект/Файл.docx'), handlers[0].id), 'HANDLER_EXPIRED', 'Новый список заменяет прежний: старые номера перестают действовать');

    // классическое меню
    answers['menu-open'] = args => ({ token: 'хост-токен-1', items: [
      { id: 0, label: 'Открыть', enabled: true, verb: 'open' }, { id: -1, label: '', enabled: false, separator: true },
      { id: -1, label: 'Отправить', enabled: true, submenu: [{ id: 5, label: 'Рабочий стол (создать ярлык)', enabled: true, verb: 'bad verb!' }] },
      { id: 'не число', label: 'Мусор', enabled: true }, { id: 7, label: 'Свойства', enabled: false, checked: true, verb: 'properties' }], echo: args });
    answers['menu-invoke'] = args => ({ invoked: true, args });
    const menu = await shell.shellMenu(1, [R('Проект/Файл.docx'), R('Проект/Другой.docx')], true);
    check(calls[calls.length - 1].args.paths.length === 2 && calls[calls.length - 1].args.extended === true && menu.items.length === 4, 'Меню строится по настоящим путям выбранных объектов; повреждённые пункты отброшены');
    check(menu.items[2].submenu?.[0].verb === undefined && menu.items[0].verb === 'open' && menu.items[3].checked === true && menu.items[3].enabled === false, 'Подменю разбираются, каноничное имя команды проверяется по форме, флажки сохраняются');
    check(menu.token !== 'хост-токен-1' && /^[0-9a-f-]{36}$/u.test(menu.token), 'Сеанс меню идентифицируется непрозрачным токеном, а не токеном помощника');
    await rejects(() => shell.shellMenu(1, [R('Проект/Файл.docx'), R('Проект/Вложенная')], false).then(() => shell.shellMenu(1, [R('Проект/Файл.docx'), R('Проект')], false)), 'MENU_MIXED_FOLDERS', 'Одно меню — для объектов одной папки');
    await rejects(() => shell.shellMenu(1, [draft.ref], false), 'DRAFT_NOT_PUBLISHED', 'Для черновика классического меню Windows нет');
    await rejects(() => shell.shellMenu(1, [] as any, false), 'INVALID_REQUEST', 'Пустой выбор отклоняется');
    await rejects(() => shell.shellMenuInvoke(2, menu.token, 0, 'Открыть'), 'NATIVE_MENU_EXPIRED', 'Токен другого окна не принимается');
    await rejects(() => shell.shellMenuInvoke(1, 'угаданный', 0, 'Открыть'), 'NATIVE_MENU_EXPIRED', 'Угаданный токен не принимается');
    await rejects(() => shell.shellMenuInvoke(1, menu.token, -3, 'Открыть'), 'INVALID_REQUEST', 'Номер команды проверяется');
    await shell.shellMenuInvoke(1, menu.token, 0, 'Открыть');
    check(calls[calls.length - 1].command === 'menu-invoke' && calls[calls.length - 1].args.token === 'хост-токен-1' && calls[calls.length - 1].args.id === 0 && calls[calls.length - 1].args.label === 'Открыть', 'Вызов команды передаёт помощнику его токен, номер и подпись для сверки');
    await rejects(() => shell.shellMenuInvoke(1, menu.token, 0, 'Открыть'), 'NATIVE_MENU_EXPIRED', 'После вызова токен погашен');
    const second = await shell.shellMenu(1, [R('Проект/Файл.docx')], false);
    check((await shell.shellMenuClose(1, second.token)).closed && calls[calls.length - 1].command === 'menu-close', 'Закрытие меню освобождает сеанс в помощнике');

    // корзина Windows
    answers['bin-list'] = () => [
      { key: 'C:\\$Recycle.Bin\\S-1\\$R1.txt', name: 'удалённый.txt', location: 'C:\\Users\\я\\Рабочий стол', deletedAt: '2026-10-05T10:00:00.0000000Z', size: 1234, directory: false },
      { key: 'C:\\$Recycle.Bin\\S-1\\$R2', name: 'Папка', location: 'D:\\Проекты', deletedAt: 'не дата', size: null, directory: true }, { key: '', name: 'без ключа' },
    ];
    answers['bin-restore'] = args => ({ done: args.keys.length, failed: 0 }); answers['bin-purge'] = args => ({ done: args.keys.length, failed: 0 }); answers['bin-empty'] = () => ({ emptied: true });
    const bin = await shell.recycleBin(1);
    check(bin.supported && bin.items.length === 2 && bin.items[0].name === 'удалённый.txt' && bin.items[0].location === 'C:\\Users\\я\\Рабочий стол' && bin.items[0].size === 1234 && bin.items[0].deletedAt === '2026-10-05T10:00:00.000Z' && bin.items[1].deletedAt === null && bin.items[1].kind === 'directory', 'Список корзины: имя, исходное расположение, дата удаления, размер');
    check(!JSON.stringify(bin).includes('Recycle.Bin') && /^[0-9a-f-]{36}$/u.test(bin.items[0].id), 'Разбираемые имена корзины остаются в main; интерфейс получает номера');
    check((await shell.recycleBinRestore(1, [bin.items[0].id])).done === 1 && calls[calls.length - 1].args.keys[0] === 'C:\\$Recycle.Bin\\S-1\\$R1.txt', 'Восстановление идёт по номеру из списка');
    check((await shell.recycleBinPurge(1, [bin.items[1].id])).done === 1 && (await shell.recycleBinEmpty()).emptied === true, 'Удаление навсегда и очистка корзины доходят до помощника');
    await rejects(() => shell.recycleBinRestore(1, ['C:\\$Recycle.Bin\\S-1\\$R1.txt']), 'BIN_EXPIRED', 'Подставленное разбираемое имя вместо номера не принимается');
    await rejects(() => shell.recycleBinPurge(2, [bin.items[0].id]), 'BIN_EXPIRED', 'Номер другого окна не принимается');
    await rejects(() => shell.recycleBinRestore(1, []), 'INVALID_REQUEST', 'Пустой выбор корзины отклоняется');
    await shell.recycleBin(1);
    await rejects(() => shell.recycleBinRestore(1, [bin.items[0].id]), 'BIN_EXPIRED', 'Новый снимок списка заменяет прежний: старые номера недействительны');
    answers['bin-list'] = () => { throw Object.assign(new Error('x'), { code: 'NATIVE_TIMEOUT' }); };
    const fallback = await shell.recycleBin(1);
    check(!fallback.supported && fallback.fallback === 'openRecycleBin' && fallback.items.length === 0 && /Откройте корзину/u.test(fallback.message!), 'Если помощник не отвечает, список не падает: запасной путь — открыть системную корзину');
    answers['bin-restore-original'] = args => ({ restored: true, args });
    await shell.restoreFromTrash({ path: 'C:\\Users\\я\\файл.txt', deletedAfter: 123, size: 5, name: 'файл.txt' });
    check(calls[calls.length - 1].command === 'bin-restore-original' && calls[calls.length - 1].args.path === 'C:\\Users\\я\\файл.txt', 'Возврат по исходному пути для отмены удаления идёт через помощника');

    // не Windows: понятная ошибка вместо падения, помощник не зовётся
    const offCalls: string[] = [];
    const off = new ShellCommands(service, { call: async command => { offCalls.push(command); return null; } }, { platform: 'linux' });
    const offQuick = await off.quickAccess();
    check(!offQuick.supported && offQuick.items.length === 0 && /Windows/u.test(offQuick.message!), 'Быстрый доступ вне Windows: пустой список и понятное сообщение');
    check(!(await off.cloudRoots()).supported && !(await off.recycleBin(1)).supported, 'Облачные корни и корзина вне Windows: пустой список с сообщением');
    for (const [name, work] of Object.entries<() => Promise<unknown>>({
      закрепление: () => off.pin(R('Проект'), true), миниатюра: () => off.thumbnail(R('Проект/Файл.docx'), 32, false), 'программы для файла': () => off.openWithList(1, R('Проект/Файл.docx')),
      'запуск программы': () => off.openWith(1, R('Проект/Файл.docx'), 'x'), меню: () => off.shellMenu(1, [R('Проект/Файл.docx')], false), 'вызов меню': () => off.shellMenuInvoke(1, 'x', 0, 'x'),
      восстановление: () => off.recycleBinRestore(1, ['x']), 'удаление навсегда': () => off.recycleBinPurge(1, ['x']), очистка: () => off.recycleBinEmpty(),
    })) await rejects(work, 'NOT_WINDOWS', `Вне Windows команда «${name}» отказывает ошибкой NOT_WINDOWS`);
    await rejects(() => off.restoreFromTrash({ path: 'x', deletedAfter: 0, size: null, name: 'x' }), 'UNDO_UNAVAILABLE', 'Возврат из корзины вне Windows — «недоступно», а не падение');
    check(offCalls.length === 0, 'Вне Windows ни одна команда до помощника не доходит');
    const ids = new OpaqueIds<string>(1000, 3, () => 0); const issued = ids.replace(1, 'a', ['x', 'y']);
    check(ids.get(1, 'a', issued[0]) === 'x' && ids.get(2, 'a', issued[0]) === undefined && ids.get(1, 'b', issued[0]) === undefined && ids.get(1, 'a', 'не id') === undefined && (() => { try { ids.replace(1, 'a', ['1', '2', '3', '4']); return false; } catch { return true; } })(), 'Непрозрачные номера привязаны к окну и виду списка, а их выдача ограничена');

    // ---- ExplorerBridge: все команды подключены, права на запись названы
    const events: WindowsSearchEvent[] = [];
    const viewState = await ViewStateStore.load(userData);
    const bridge = new ExplorerBridge({ service, shell, viewState, emitSearch: (_owner, event) => events.push(event) });
    const actions = ['search', 'searchCancel', 'children', 'quickAccess', 'quickAccessPin', 'cloudRoots', 'systemProperties', 'resolveAddress', 'placeIcon', 'thumbnail', 'openWithList', 'openWith', 'shellMenu', 'shellMenuInvoke', 'shellMenuClose',
      'recycleBin', 'recycleBinRestore', 'recycleBinPurge', 'recycleBinEmpty', 'startDrag', 'importPaths', 'undoState', 'undo', 'redo', 'publishPlan', 'viewStateGet', 'viewStateSet', 'viewStateDelete'];
    check(actions.every(isExplorerAction) && !isExplorerAction('write') && !isExplorerAction('nonsense'), 'Все команды Проводника известны ipc, а прежние и выдуманные — нет');
    for (const action of actions) {
      const outcome = await bridge.handle({ action } as WindowsFilesRequest, 1).then(() => 'ok', (error: any) => error.code);
      assert.notEqual(outcome, 'INVALID_ACTION', `${action} не подключена`); passed++;
    }
    console.log('✓ Каждая команда обработана: у пустого запроса — отказ по существу, а не «команда неизвестна»');
    check(['quickAccessPin', 'shellMenuInvoke', 'recycleBinRestore', 'recycleBinPurge', 'recycleBinEmpty', 'startDrag', 'importPaths', 'undo', 'redo'].every(action => EXPLORER_WRITE_ACTIONS.has(action)), 'Команды, меняющие файлы и состояние Windows, требуют права на запись');
    check(['search', 'children', 'thumbnail', 'quickAccess', 'recycleBin', 'publishPlan', 'viewStateGet', 'viewStateSet'].every(action => !EXPLORER_WRITE_ACTIONS.has(action)), 'Чтение и вид папки право на запись не требуют');
    const ipcSource = await read(path.join(__dirname, '../electron/filesystem/ipc.ts'));
    check(/WRITE_ACTIONS = new Set\(\[[^\]]*\.\.\.EXPLORER_WRITE_ACTIONS\]\)/u.test(ipcSource), 'ipc подмешивает права на запись команд Проводника в общий список');
    for (const action of ['createDraft', 'createDraftFolder', 'publishDraft', 'publishDraftTree', 'mkdir', 'rename', 'copy', 'move', 'trash']) check(new RegExp(`WRITE_ACTIONS = new Set\\(\\[[^\\]]*'${action}'`, 'u').test(ipcSource), `Прежняя команда ${action} по-прежнему требует права на запись`);
    check(/carryMeta: request\.carryMeta === true/u.test(ipcSource) && /service\.publishDraft\(request\.ref, request\.choices\)/u.test(ipcSource) && /service\.publishDraftTree\(request\.ref, request\.choices\)/u.test(ipcSource), 'ipc передаёт carryMeta и выбор по объектам до службы');
    const preloadSource = await read(path.join(__dirname, '../electron/preload.ts'));
    check(!INVOKE_CHANNELS.has('windows-files:drop-paths') && !SEND_CHANNELS.has('windows-files:drop-paths') && !/pathOfFile[^}]*drop-paths/u.test(preloadSource), 'Канал с путями брошенных файлов не открыт странице через общий мост');
    check(/addEventListener\('drop'[\s\S]{0,200}isTrusted/u.test(preloadSource) && /takeDrop/u.test(preloadSource), 'Билет выдаётся только на настоящее событие drop, а страница получает имена, но не пути');

    // сквозной поиск и вид через мост
    await bridge.handle({ action: 'viewStateSet', entries: { 'folder:x': { mode: 'list' } } }, 1);
    check(JSON.stringify(await bridge.handle({ action: 'viewStateGet', keys: ['folder:x'] }, 1)) === JSON.stringify({ 'folder:x': { mode: 'list' } }), 'Вид папки проходит через мост туда и обратно');
    const started = await bridge.handle({ action: 'search', ref: R(''), requestId: 'bridge-1', query: 'файл' }, 1) as { requestId: string };
    for (let i = 0; i < 50 && !events.some(event => event.done); i++) await wait(20);
    check(started.requestId === 'bridge-1' && events.some(event => event.done && event.requestId === 'bridge-1') && events.flatMap(event => event.hits).some(hit => hit.name === 'Файл.docx'), 'Поиск через мост: ответ сразу, страницы — событиями');
    check((await bridge.handle({ action: 'searchCancel', requestId: 'нет' }, 1) as { canceled: boolean }).canceled === false, 'Отмена несуществующего поиска — не ошибка');
    check(((await bridge.handle({ action: 'children', ref: R('Проект') }, 1)) as { folders: unknown[] }).folders.length === 2, 'Подпапки через мост');
    check(/^Создание/u.test(((await bridge.handle({ action: 'undoState' }, 1)) as { undo: { label: string } }).undo.label), 'Состояние отмены через мост: последнее действие названо');
    bridge.registerDrop(1, 'ticket-from-preload', [path.join(sandbox, 'x')]);
    await rejects(async () => bridge.registerDrop(1, 'x', ['относительный']), 'INVALID_REQUEST', 'Пути из preload проверяются так же, как любые');
    bridge.closeOwner(1);
    service.close();
  } finally { await fs.rm(sandbox, { recursive: true, force: true }); }
  console.log(`\nВсе проверки моста Проводника пройдены (${passed})`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
