/**
 * Общий слой Проводника и рабочего стола (src/components/files): чистая логика
 * без браузера. Выделение, клавиши, создание, буфер и корзина проверяются с
 * подставным мостом — так видно, что именно уходит в команды моста.
 */
import {
  CREATE_KINDS, DEFAULT_NAME, createEntry, createdMessage, createTitle, finalName, isCreated, validateName, type BridgeRequest,
} from '../src/components/files/createEntry';
import { EXPLORER_KEYS, keyAvailable, matchKey } from '../src/components/files/explorerKeys';
import { copyName, makeClip, pasteClip, trashEntries, trashQuestion } from '../src/components/files/fileOps';
import { EMPTY_SELECTION, applyClick, applyMove, reconcileSelection, selectAll } from '../src/components/files/useSelection';
import { changeTouches, folderKey } from '../src/components/files/useFolder';
import type { WindowsFileEntry, WindowsFileRef, WindowsFilesRequest } from '../src/lib/windowsFiles';

let ok = 0; let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) { ok++; console.log('✓', name); } else { fail++; console.error('✗', name, '\n   получено:', JSON.stringify(got), '\n   ожидалось:', JSON.stringify(want)); }
};

const file = (name: string, fileId = `id-${name}`, extra: Partial<WindowsFileEntry> = {}): WindowsFileEntry =>
  ({ name, relativePath: name, storage: 'windows', kind: 'file', fileId, size: 1, modifiedAt: '2026-01-01T00:00:00.000Z', linked: false, ...extra });
const list = ['a', 'b', 'c', 'd', 'e'].map((name) => file(name));
const ids = (state: { ids: string[] }) => state.ids.map((id) => id.replace('id-', ''));

// --- Выделение
let state = applyClick(EMPTY_SELECTION, list, list[1], {});
eq('щелчок выделяет один объект', ids(state), ['b']);
state = applyClick(state, list, list[3], { ctrl: true });
eq('Ctrl+щелчок добавляет', ids(state), ['b', 'd']);
state = applyClick(state, list, list[1], { ctrl: true });
eq('Ctrl+щелчок по выбранному снимает', ids(state), ['d']);
state = applyClick(applyClick(EMPTY_SELECTION, list, list[1], {}), list, list[3], { shift: true });
eq('Shift+щелчок — диапазон между якорем и объектом', ids(state), ['b', 'c', 'd']);
state = applyClick(state, list, list[0], { shift: true });
eq('Shift+щелчок в другую сторону переносит диапазон от того же якоря', ids(state), ['a', 'b']);
state = applyClick(applyClick(EMPTY_SELECTION, list, list[0], {}), list, list[2], { ctrl: true });
state = applyClick(state, list, list[4], { ctrl: true, shift: true });
eq('Ctrl+Shift+щелчок добавляет диапазон к выбранному', ids(state), ['a', 'c', 'd', 'e']);
eq('Ctrl+A выбирает всё', ids(selectAll(list)), ['a', 'b', 'c', 'd', 'e']);
eq('Ctrl+A в пустой папке не падает', selectAll([]).ids, []);
eq('стрелка вниз без выбора начинает с первого', ids(applyMove(EMPTY_SELECTION, list, 1, false)), ['a']);
eq('стрелка вверх без выбора начинает с последнего', ids(applyMove(EMPTY_SELECTION, list, -1, false)), ['e']);
eq('стрелка не уходит за край', ids(applyMove(applyMove(EMPTY_SELECTION, list, -1, false), list, 1, false)), ['e']);
state = applyMove(applyClick(EMPTY_SELECTION, list, list[1], {}), list, 1, true);
state = applyMove(state, list, 1, true);
eq('Shift+стрелка тянет диапазон от якоря', ids(state), ['b', 'c', 'd']);
eq('Shift+стрелка назад сжимает диапазон', ids(applyMove(state, list, -1, true)), ['b', 'c']);
eq('стрелка без Shift схлопывает выбор в один объект', ids(applyMove(state, list, 1, false)), ['e']);

// Обновление списка: объекты те же, но записи новые; один переименован (fileId сменился)
const refreshed = [file('a', 'id-a'), file('c', 'id-c'), file('d', 'new-id-d'), file('x', 'id-x')];
const picked = applyClick(applyClick(applyClick(EMPTY_SELECTION, list, list[0], {}), list, list[2], { ctrl: true }), list, list[3], { ctrl: true });
const after = reconcileSelection(picked, refreshed);
eq('после обновления выбор по fileId остаётся', ids(after).includes('a') && ids(after).includes('c'), true);
eq('объект с новым fileId находится по имени', after.ids.includes('new-id-d'), true);
eq('исчезнувший объект уходит из выбора', reconcileSelection(applyClick(EMPTY_SELECTION, list, list[1], {}), refreshed).ids, []);
eq('без изменений выбор возвращается тем же объектом (нет лишних перерисовок)', reconcileSelection(after, refreshed) === after, true);
eq('одноимённые не слипаются: имя занято уже выбранным', reconcileSelection({ ids: ['gone1', 'gone2'], names: { gone1: 'x', gone2: 'x' }, anchor: null, focus: null }, [file('x', 'new-x')]).ids, ['new-x']);

// --- Клавиши
const press = (key: string, mods: Record<string, boolean> = {}, code = '') => matchKey({ key, code, ...mods })?.action;
eq('Ctrl+C — копировать', press('c', { ctrlKey: true }), 'copy');
eq('Ctrl+C при русской раскладке (key «с») — тоже копировать', press('с', { ctrlKey: true }, 'KeyC'), 'copy');
eq('Ctrl+Shift+N — панель создания', press('N', { ctrlKey: true, shiftKey: true }, 'KeyN'), 'create');
eq('Ctrl+N без Shift — не из таблицы', press('n', { ctrlKey: true }), undefined);
eq('Enter и Alt+Enter различаются', [press('Enter'), press('Enter', { altKey: true })], ['open', 'properties']);
eq('Del — в корзину, Shift+Del в таблице нет (удаление мимо корзины — позже)', [press('Delete'), press('Delete', { shiftKey: true })], ['trash', undefined]);
eq('Cmd на Mac читается как Ctrl', press('a', { metaKey: true }), 'selectAll');
eq('буква без Ctrl не перехватывается', press('c'), undefined);
eq('сочетания в таблице не повторяются', new Set(EXPLORER_KEYS.map((binding) => `${binding.key}|${!!binding.ctrl}|${!!binding.shift}|${!!binding.alt}`)).size, EXPLORER_KEYS.length);
eq('переименовать требует ровно один объект', [keyAvailable(matchKey({ key: 'F2' })!, 0), keyAvailable(matchKey({ key: 'F2' })!, 1), keyAvailable(matchKey({ key: 'F2' })!, 2)], [false, true, false]);
eq('удалить работает над несколькими', [keyAvailable(matchKey({ key: 'Delete' })!, 0), keyAvailable(matchKey({ key: 'Delete' })!, 3)], [false, true]);

// --- Создание
eq('набор один для обоих мест: пять пунктов', CREATE_KINDS.map((item) => item.label), ['Папку', 'Документ Word', 'Книгу Excel', 'Текстовый файл', 'Архив ZIP']);
eq('имена по умолчанию', CREATE_KINDS.map((item) => DEFAULT_NAME[item.kind]), ['Новая папка', 'Новый документ.docx', 'Новая таблица.xlsx', 'Новый текстовый документ.txt', 'Новый архив.zip']);
eq('расширение добавляется, если его нет', [finalName('doc', 'Отчёт'), finalName('doc', 'Отчёт.DOCX'), finalName('folder', 'Чертежи')], ['Отчёт.docx', 'Отчёт.DOCX', 'Чертежи']);
eq('имя со знаком Windows отвергается, пустое — тоже', [validateName('а/б'), validateName('  '), validateName('Нормально')].map((value) => value === null ? null : 'ошибка'), ['ошибка', 'ошибка', null]);
eq('заголовки окна называют место', [createTitle('windows', 'folder'), createTitle('flux', 'folder'), createTitle('flux', 'archive'), createTitle('windows', 'archive')], ['Новая папка Windows', 'Новая папка Flux', 'Новый архив Flux', 'Новый файл Windows']);

// Дальше — вызовы моста, они асинхронные
(async () => {
const parent: WindowsFileRef = { rootId: 'r', relativePath: 'Папка' };
function bridge(handler: (request: WindowsFilesRequest) => any) {
  const calls: WindowsFilesRequest[] = [];
  const request = (async (value: WindowsFilesRequest) => { calls.push(value); return handler(value); }) as unknown as BridgeRequest;
  return { request, calls };
}
const good = (data: unknown) => ({ ok: true, data });
const bad = (message: string) => ({ ok: false, error: { code: 'X', message } });

let rig = bridge((r) => r.action === 'mkdir' ? good(file('Чертежи', 'f1', { kind: 'directory', relativePath: 'Папка/Чертежи' })) : bad('нет'));
let made = await createEntry(rig.request, { place: 'windows', kind: 'folder', parent, name: ' Чертежи ' });
eq('папка Windows — один mkdir с обрезанным именем', [rig.calls.map((call) => call.action), (rig.calls[0] as any).name, isCreated(made)], [['mkdir'], 'Чертежи', true]);
rig = bridge((r) => r.action === 'createDraftFolder' ? good({ ref: { ...parent, draftId: 'd1' }, file: file('Чертежи') }) : bad('нет'));
made = await createEntry(rig.request, { place: 'flux', kind: 'folder', parent, name: 'Чертежи' });
eq('папка Flux — createDraftFolder, без публикации', [rig.calls.map((call) => call.action), isCreated(made)], [['createDraftFolder'], true]);
rig = bridge((r) => r.action === 'createDraft' ? good({ ref: { ...parent, draftId: 'd2' }, file: file('x') }) : r.action === 'publishDraft' ? good({ ref: parent, file: file('x') }) : bad('нет'));
made = await createEntry(rig.request, { place: 'windows', kind: 'archive', parent, name: 'Сжатая' });
eq('ZIP в Windows — черновик «.zip», затем сразу публикация', [rig.calls.map((call) => call.action), (rig.calls[0] as any).name], [['createDraft', 'publishDraft'], 'Сжатая.zip']);
const zipBytes = Buffer.from((rig.calls[0] as any).base64, 'base64');
eq('пустой ZIP — только запись конца каталога (22 байта, PK\\5\\6)', [zipBytes.length, zipBytes.readUInt32LE(0)], [22, 0x06054b50]);
rig = bridge((r) => r.action === 'createDraft' ? good({ ref: { ...parent, draftId: 'd3' }, file: file('x') }) : good({ ref: parent }));
made = await createEntry(rig.request, { place: 'flux', kind: 'text', parent, name: 'Записка' });
eq('файл Flux — createDraft, пустой текст, публикации нет', [rig.calls.map((call) => call.action), (rig.calls[0] as any).name, (rig.calls[0] as any).base64], [['createDraft'], 'Записка.txt', '']);
rig = bridge((r) => r.action === 'createDraft' ? good({ ref: { ...parent, draftId: 'd4' }, file: file('x') }) : bad('Диск занят'));
made = await createEntry(rig.request, { place: 'windows', kind: 'doc', parent, name: 'Договор' });
eq('сорвалась публикация — черновик остаётся, об этом сказано', [isCreated(made), isCreated(made) ? '' : (made as any).draftKept, isCreated(made) ? '' : (made as any).message], [false, true, 'Диск занят']);
rig = bridge(() => bad('Папка недоступна'));
made = await createEntry(rig.request, { place: 'windows', kind: 'folder', parent, name: 'Ф' });
eq('отказ моста при создании — окно остаётся (draftKept ложь)', [isCreated(made), (made as any).draftKept, (made as any).message], [false, false, 'Папка недоступна']);
rig = bridge(() => { throw new Error('мост упал'); });
made = await createEntry(rig.request, { place: 'flux', kind: 'doc', parent, name: 'Д' });
eq('исключение моста не вылетает наружу', [isCreated(made), (made as any).message], [false, 'мост упал']);
const okMade = { ok: true as const, place: 'windows' as const, kind: 'doc' as const, name: 'Д.docx' };
eq('тексты об удаче: стол и Проводник говорят о месте по-своему', [createdMessage(okMade, 'на рабочем столе Windows'), createdMessage({ ...okMade, kind: 'folder' }, 'в Windows'), createdMessage({ ...okMade, place: 'flux' })], ['Файл создан на рабочем столе Windows', 'Папка создана в Windows', 'Черновик создан в Flux.']);

// --- Буфер, вставка, корзина
eq('копия получает свободное имя, как в Windows', [copyName('Отчёт.docx', new Set()), copyName('Отчёт.docx', new Set(['Отчёт - копия.docx'])), copyName('Без расширения', new Set())], ['Отчёт - копия.docx', 'Отчёт - копия (2).docx', 'Без расширения - копия']);
rig = bridge((r) => r.action === 'read' ? good({ sha256: 'h-' + (r as any).ref.relativePath }) : good({}));
const cutClip = await makeClip(rig.request, [file('a'), file('Папка1', 'f', { kind: 'directory' })], 'r', true);
eq('при вырезании у файла запоминается хеш, у папки нет', cutClip.items.map((item) => item.sha256), ['h-a', undefined]);
eq('при копировании хеш не читается', (await makeClip(rig.request, [file('a')], 'r', false)).items[0].sha256, undefined);

rig = bridge(() => good({}));
let pasted = await pasteClip(rig.request, { cut: false, items: [{ ref: { rootId: 'r', relativePath: 'a' }, name: 'a', kind: 'file' }, { ref: { rootId: 'r', relativePath: 'b' }, name: 'b', kind: 'file' }] }, { rootId: 'r', relativePath: '' }, ['a']);
eq('вставка копий: каждому объекту свой вызов copy; занятое имя заменено свободным', [rig.calls.map((call) => `${call.action}:${(call as any).name}`), pasted.done, pasted.failed.length], [['copy:a - копия', 'copy:b'], 2, 0]);
rig = bridge((r) => (r as any).ref.relativePath === 'b' ? bad('Файл занят') : good({}));
pasted = await pasteClip(rig.request, { cut: true, items: [{ ref: { rootId: 'r', relativePath: 'a' }, name: 'a', kind: 'file', sha256: 'h' }, { ref: { rootId: 'r', relativePath: 'b' }, name: 'b', kind: 'file' }, { ref: { rootId: 'r', relativePath: 'c' }, name: 'c', kind: 'file' }] }, { rootId: 'r', relativePath: 'Куда' }, []);
eq('ошибка одного объекта не останавливает остальные', [rig.calls.length, pasted.done, pasted.failed], [3, 2, [{ name: 'b', message: 'Файл занят' }]]);
eq('при переносе уходит хеш, если он был', [(rig.calls[0] as any).baseSha256, (rig.calls[1] as any).baseSha256], ['h', undefined]);
rig = bridge(() => good({}));
pasted = await pasteClip(rig.request, { cut: true, items: [{ ref: { rootId: 'r', relativePath: 'Папка/a' }, name: 'a', kind: 'file' }] }, { rootId: 'r', relativePath: 'Папка' }, ['a']);
eq('вырезать и вставить в ту же папку — не действие, мост не зовётся', [rig.calls.length, pasted.done], [0, 1]);

rig = bridge((r) => r.action === 'read' ? good({ sha256: 'h' }) : good({}));
const trashed = await trashEntries(rig.request, 'r', [file('a'), file('Папка1', 'f', { kind: 'directory' }), file('Черновик.docx', 'd', { draftId: 'dr1', storage: 'flux' })]);
eq('в корзину — trash на каждый объект; файл идёт с хешем, папка без', rig.calls.filter((call) => call.action === 'trash').map((call) => (call as any).baseSha256), ['h', undefined, 'h']);
eq('черновик уходит тем же trash с draftId в ссылке', (rig.calls.filter((call) => call.action === 'trash')[2] as any).ref.draftId, 'dr1');
eq('итог корзины', [trashed.done, trashed.failed.length], [3, 0]);
eq('вопрос про одного называет имя', trashQuestion([file('Смета.xlsx')]), 'Переместить «Смета.xlsx» в корзину Windows?');
eq('вопрос про нескольких называет число', trashQuestion([file('a'), file('b')]).includes('(2)'), true);
eq('вопрос про одни черновики говорит «удалить»', trashQuestion([file('a', 'x', { draftId: 'd' }), file('b', 'y', { draftId: 'e' })]).startsWith('Удалить черновики'), true);

// --- Папка и наблюдатель
const folder: WindowsFileRef = { rootId: 'r', relativePath: 'Проекты' };
eq('изменение внутри папки касается её', changeTouches(folder, { rootId: 'r', relativePath: 'Проекты/файл.txt' }), true);
eq('изменение самой папки касается её', changeTouches(folder, { rootId: 'r', relativePath: 'Проекты' }), true);
eq('изменение глубже или в другом корне не касается', [changeTouches(folder, { rootId: 'r', relativePath: 'Проекты/Вложенная/файл.txt' }), changeTouches(folder, { rootId: 'x', relativePath: 'Проекты/файл.txt' })], [false, false]);
eq('ключ папки различает черновую папку с тем же путём', folderKey(folder) === folderKey({ ...folder, draftId: 'd' }), false);

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
