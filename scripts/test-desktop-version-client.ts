/**
 * Файлы рабочего стола под сверкой версии: клиент (строка 4, часть E).
 *
 * Без браузера и без службы. Пять половин:
 *   1. Правила «что изменилось» (src/components/desktop/changeRules.ts): имя, папка словами, «в корзине»;
 *      номер версии, даты, размер и автор в перечень не попадают.
 *   2. Разбор отказа (desktopWrite.ts): 409 с кодом — перечень «было → стало» из показанной записи и `current`,
 *      404 с кодом — текст сервера; поле имени остаётся с набранным, пока запись не принята.
 *   3. Запросы `dataService` с подставным fetch: файл идёт с `expectedVersion` (в теле; у DELETE — в строке
 *      запроса), папка — как была; отказ доходит до экрана с кодом и `current`.
 *   4. Стол (`desktopStore`): версия берётся из показанной записи, после отказа по версии или «уже удалили»
 *      стол перечитывается, а отказ не глотается; прочий сбой стол не перечитывает.
 *   5. Исходники: экран пишет файлы только через `useDeskWrite`, а тот берёт показанную запись ДО записи.
 *
 * Запуск: npx tsx scripts/test-desktop-version-client.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileChanges, fileRules, folderTitle, SHARED_DESK, PERSONAL_DESK, OTHER_FOLDER } from '../src/components/desktop/changeRules';
import { fileRefusalOf, keepsTypedName, runWrite } from '../src/components/desktop/desktopWrite';
import { resultOfRefusal } from '../src/components/projects/projectWrite';
import { VERSION_CONFLICT, RECORD_GONE, RECORD_OPEN } from '../src/components/equipment/versionedWrite';

const root = path.resolve(__dirname, '..');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const same = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); passed++; console.log(`  ✓ ${name}`); };

const DESK = { sharedFolderId: 'fs', personalFolderId: 'fp' };
const file = (over: Record<string, unknown> = {}) => ({
  id: 'f1', name: 'Ведомость.docx', folderId: 'fp', scope: 'PERSONAL', deletedAt: null, size: 10, version: 3, updatedAt: '2026-01-01T00:00:00.000Z', ...over,
});

(async () => {
  console.log('1. Что изменилось: имя, папка, в корзине');
  {
    same('ничего не менялось — перечня нет', fileChanges(file(), file(), DESK), []);
    same('имя: «было → стало»', fileChanges(file(), file({ name: 'Ведомость-2.docx' }), DESK), [{ label: 'Имя', was: 'Ведомость.docx', now: 'Ведомость-2.docx' }]);
    same('папка читается словами: с вашего стола на общий', fileChanges(file(), file({ folderId: 'fs' }), DESK), [{ label: 'Папка', was: PERSONAL_DESK, now: SHARED_DESK }]);
    same('ушёл в другую папку Проводника', fileChanges(file(), file({ folderId: 'zz' }), DESK), [{ label: 'Папка', was: PERSONAL_DESK, now: OTHER_FOLDER }]);
    same('в корзине: нет → да', fileChanges(file(), file({ deletedAt: '2026-02-01T00:00:00.000Z' }), DESK), [{ label: 'В корзине', was: 'нет', now: 'да' }]);
    same('порядок — как на столе: имя, папка, корзина', fileChanges(file(), file({ name: 'X', folderId: 'fs', deletedAt: 'd' }), DESK).map((c) => c.label), ['Имя', 'Папка', 'В корзине']);
    same('версия, даты, размер, автор и служебное не шумят', fileChanges(file(), file({ version: 9, size: 99, updatedAt: 'x', updatedById: 'u2', scope: 'SHARED', content: 'x' }), DESK), []);
    same('нет одной из записей — перечень пуст', [fileChanges(null, file(), DESK), fileChanges(file(), null, DESK)], [[], []]);
    same('подписи правил', fileRules(DESK).map((r) => r.label), ['Имя', 'Папка', 'В корзине']);
    same('папка без номера — пусто (в перечне прочерк)', [folderTitle(null, DESK), folderTitle('', DESK)], ['', '']);
  }

  console.log('2. Отказ узнаётся по коду, имя остаётся');
  {
    const shown = file();
    const current = file({ name: 'Ведомость-2.docx', version: 4 });
    const conflict = resultOfRefusal(409, { error: 'Файл «Ведомость-2.docx» изменили, пока вы его правили.', code: VERSION_CONFLICT, current }, 'x');
    const why = fileRefusalOf(conflict, shown, DESK, 'x');
    same('409 с кодом — текст сервера и перечень', [why?.kind, why?.message, why?.changes], ['conflict', 'Файл «Ведомость-2.docx» изменили, пока вы его правили.', [{ label: 'Имя', was: 'Ведомость.docx', now: 'Ведомость-2.docx' }]]);
    ok('поле имени после отказа по версии остаётся с набранным', keepsTypedName(conflict));
    const gone = resultOfRefusal(404, { error: 'Файл «Ведомость.docx» уже удалили. Ваша правка не записана.', code: RECORD_GONE }, 'x');
    same('404 с кодом — текст сервера без перечня', [fileRefusalOf(gone, shown, DESK, 'x')?.kind, fileRefusalOf(gone, shown, DESK, 'x')?.message, fileRefusalOf(gone, shown, DESK, 'x')?.changes], ['gone', 'Файл «Ведомость.docx» уже удалили. Ваша правка не записана.', undefined]);
    ok('файла нет — поле имени закрывается', !keepsTypedName(gone));
    ok('409 без кода — не отказ по версии', fileRefusalOf(resultOfRefusal(409, { error: 'Файл изменили' }, 'x'), shown, DESK, 'запасной')?.kind === 'plain');
    const open = resultOfRefusal(409, { error: 'Занято', code: RECORD_OPEN, holders: [{ userId: 'u2', name: 'Иванов' }] }, 'x');
    same('открытая запись — текст сервера', fileRefusalOf(open, shown, DESK, 'x')?.kind, 'open');
    const plain = resultOfRefusal(403, { error: 'Нет права' }, 'запасной');
    same('прочий отказ — строка текста; поле остаётся', [fileRefusalOf(plain, shown, DESK, 'x'), keepsTypedName(plain)], [{ kind: 'plain', message: 'Нет права' }, true]);
    same('принятая запись — не отказ, поле закрывается', [fileRefusalOf({ kind: 'ok', data: {} }, shown, DESK, 'x'), keepsTypedName({ kind: 'ok', data: {} })], [null, false]);
    const r = await runWrite(async () => { throw Object.assign(new Error('x'), { name: 'WriteRefusal', status: 409, body: { error: 'Изменили', code: VERSION_CONFLICT, current } }); }, 'x');
    ok('runWrite: отказ приходит результатом, а не исключением', r.kind === 'conflict');
  }

  console.log('3. Запросы dataService с подставным fetch');
  (globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const calls: Array<{ url: string; method: string; body: any }> = [];
  let reply: (url: string, method: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    const method = String(init?.method || 'GET');
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = reply(String(url), method);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  const { dataService, WriteRefusal } = await import('../src/services/dataService');
  {
    await dataService.renameNode('f1', true, 'Новое.docx', 3);
    same('переименование файла: версия в теле рядом с именем', [calls[0].method, calls[0].url.endsWith('/files/f1'), calls[0].body], ['PATCH', true, { name: 'Новое.docx', expectedVersion: 3 }]);
    await dataService.renameNode('f1', true, 'Новое.docx');
    ok('нет версии — поле не уходит', !('expectedVersion' in calls[1].body));
    await dataService.renameNode('d1', false, 'Папка', 5);
    same('переименование папки — как было: без версии, по адресу папки', [calls[2].url.endsWith('/folders/d1'), calls[2].body], [true, { name: 'Папка' }]);

    await dataService.trashNode('f1', true, 4);
    same('в корзину: версия в строке запроса', [calls[3].method, calls[3].url.endsWith('/files/f1?expectedVersion=4')], ['DELETE', true]);
    await dataService.trashNode('f1', true);
    ok('в корзину без версии: адрес прежний', calls[4].url.endsWith('/files/f1'));
    await dataService.trashNode('d1', false, 4);
    ok('папка в корзину — как была, без версии', calls[5].url.endsWith('/folders/d1'));

    await dataService.moveDesktopItem('p1', 'f1', 'SHARED', 6);
    same('перенос файла на столе: версия в теле', [calls[6].method, calls[6].url.endsWith('/desktop/move'), calls[6].body], ['POST', true, { projectId: 'p1', id: 'f1', to: 'SHARED', expectedVersion: 6 }]);
    await dataService.moveDesktopItem('p1', 'd1', 'SHARED');
    ok('перенос папки — без версии', !('expectedVersion' in calls[7].body));
    await dataService.renameNode('f1', true, 'Н', 0);
    ok('ноль — не версия', !('expectedVersion' in calls[8].body));

    const current = file({ name: 'Ведомость-2.docx', version: 4 });
    reply = () => ({ status: 409, body: { error: 'Файл изменили', code: VERSION_CONFLICT, current } });
    let caught: any;
    try { await dataService.renameNode('f1', true, 'А', 3); } catch (e) { caught = e; }
    ok('отказ по версии доходит до экрана как WriteRefusal', caught instanceof WriteRefusal && caught.status === 409);
    same('отказ не теряет код и текущую запись', [caught?.body?.code, caught?.body?.current], [VERSION_CONFLICT, current]);
    reply = () => ({ status: 404, body: { error: 'Файл уже удалили', code: RECORD_GONE } });
    ok('в корзину: «уже удалили» — gone', (await runWrite(() => dataService.trashNode('f1', true, 3), 'x')).kind === 'gone');
    ok('перенос: «уже удалили» — gone', (await runWrite(() => dataService.moveDesktopItem('p1', 'f1', 'SHARED', 3), 'x')).kind === 'gone');
    reply = () => ({ status: 200, body: {} });
  }

  console.log('4. Стол: версия из показанной записи, перечитывание после отказа');
  {
    const { useDesktopStore } = await import('../src/store/desktopStore');
    const row = (over: Record<string, unknown>) => ({ id: 'f1', name: 'Ведомость.docx', scope: 'PERSONAL', folderId: 'fp', version: 3, mainTags: [], ...over });
    const desk = (files: any[], folders: any[] = []) => ({ sharedFolderId: 'fs', personalFolderId: 'fp', files, folders, trashCount: 0 });
    let version = 3;
    reply = (url, method) => {
      if (method === 'GET' && /\/desktop\?/.test(url)) return { status: 200, body: desk([row({ version })], [{ id: 'd1', name: 'Папка', scope: 'PERSONAL' }]) };
      return { status: 200, body: { success: true } };
    };
    const store = useDesktopStore;
    const mark = () => calls.length;
    const since = (n: number) => calls.slice(n);
    const rereads = (n: number) => since(n).filter((c) => c.method === 'GET' && /\/desktop\?/.test(c.url)).length;

    await store.getState().load('p1');
    same('версия файла попала в значок, у папки её нет', store.getState().items.map((i) => [i.id, i.version]), [['d1', undefined], ['f1', 3]]);

    let n = mark();
    await store.getState().rename('f1', 'Новое.docx', 'p1');
    ok('переименование шлёт версию показанного файла', since(n)[0].body.expectedVersion === 3);
    n = mark();
    await store.getState().rename('d1', 'Другая', 'p1');
    ok('переименование папки — без версии', !('expectedVersion' in since(n)[0].body));
    n = mark();
    await store.getState().share('f1', 'SHARED', 'p1');
    ok('перенос на общий стол шлёт версию показанного файла', since(n)[0].body.expectedVersion === 3);
    n = mark();
    await store.getState().remove('f1', 'p1');
    ok('уборка в корзину шлёт версию в строке запроса', /\/files\/f1\?expectedVersion=3$/.test(since(n)[0].url));
    n = mark();
    await store.getState().remove('d1', 'p1');
    ok('папка в корзину — без версии', /\/folders\/d1$/.test(since(n)[0].url));

    // Коллега успел изменить файл: стол показывает версию 3, в базе уже 4
    version = 4;
    reply = (url, method) => {
      if (method === 'GET' && /\/desktop\?/.test(url)) return { status: 200, body: desk([row({ version, name: 'Ведомость-2.docx' })]) };
      return { status: 409, body: { error: 'Файл изменили', code: VERSION_CONFLICT, current: row({ version, name: 'Ведомость-2.docx' }) } };
    };
    for (const [what, act] of [
      ['переименование', () => store.getState().rename('f1', 'Моё.docx', 'p1')],
      ['уборка в корзину', () => store.getState().remove('f1', 'p1')],
      ['перенос на общий стол', () => store.getState().share('f1', 'SHARED', 'p1')],
    ] as Array<[string, () => Promise<void>]>) {
      n = mark();
      let caught: any;
      await act().catch((e) => { caught = e; });
      ok(`${what}: отказ по версии не глотается — экран получает WriteRefusal с кодом`, caught?.name === 'WriteRefusal' && caught.body?.code === VERSION_CONFLICT);
      ok(`${what}: после отказа стол перечитан`, rereads(n) === 1);
      ok(`${what}: стол показывает запись коллеги`, store.getState().items.find((i) => i.id === 'f1')?.name === 'Ведомость-2.docx' && store.getState().items.find((i) => i.id === 'f1')?.version === 4);
    }
    // Файл исчез
    reply = (url, method) => method === 'GET' && /\/desktop\?/.test(url) ? { status: 200, body: desk([]) } : { status: 404, body: { error: 'Файл уже удалили', code: RECORD_GONE } };
    n = mark();
    await store.getState().remove('f1', 'p1').catch(() => {});
    ok('«уже удалили»: стол перечитан и файла на нём нет', rereads(n) === 1 && !store.getState().items.some((i) => i.id === 'f1'));
    // Прочий сбой стол не меняет
    reply = (url, method) => method === 'GET' && /\/desktop\?/.test(url) ? { status: 200, body: desk([row({})]) } : { status: 403, body: { error: 'Нет права' } };
    await store.getState().load('p1');
    n = mark();
    let plain: any;
    await store.getState().rename('f1', 'Нельзя.docx', 'p1').catch((e) => { plain = e; });
    ok('нет права: ошибка доходит до экрана, стол не перечитывается', plain?.name === 'WriteRefusal' && rereads(n) === 0);
    reply = () => ({ status: 200, body: {} });
  }

  console.log('5. Исходники');
  {
    const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
    const screen = read('src/components/Desktop.tsx');
    const hook = read('src/components/desktop/useDeskWrite.tsx');
    ok('экран пишет файлы через useDeskWrite: переименовать, убрать, переложить', /deskWrite\.rename\(/.test(screen) && /deskWrite\.trash\(/.test(screen) && /deskWrite\.share\(/.test(screen));
    ok('экран не зовёт запись стола в обход отказа', !/(?<![.\w])(rename|remove|share)\(item\.id, /.test(screen));
    ok('окно отказа выведено на экран', /deskWrite\.element/.test(screen));
    ok('поле имени закрывается только по keepsTypedName', /keepsTypedName\(result\)/.test(screen));
    ok('показанный файл берётся ДО записи', hook.indexOf('const shown =') > -1 && hook.indexOf('const shown =') < hook.indexOf('await runWrite('));
    ok('отказ показывается общим окном (useRefusalDialog)', /useRefusalDialog\(/.test(hook) && /refusals\.show\(/.test(hook));
    const store = read('src/store/desktopStore.ts');
    ok('стол перечитывается после отказа по версии и «уже удалили»', /staleRefusal\(err\)\) await get\(\)\.load\(projectId\)/.test(store));
    const svc = read('src/services/dataService.ts');
    ok('файлы стола пишутся через requestWrite (он не теряет код и current)', /requestWrite\(`\/files\/\$\{id\}`, 'PATCH'/.test(svc) && /requestWrite\('\/desktop\/move', 'POST'/.test(svc));
  }

  console.log(`\nПройдено проверок: ${passed}`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
