/**
 * Логика окна Проводника без браузера: место и путь, вкладки и их история,
 * строки панели навигации, фильтры поиска, таблица клавиш окна.
 * Всё, что в этих правилах ломается молча (вкладка закрылась, а показалась
 * первая попавшаяся; черновик потерял номер; путь «C:\\x» ушёл не на тот диск).
 *
 * Запуск: npx tsx scripts/test-explorer-shell.ts
 */
import {
  COMPUTER, HOME, NETWORK, childPlace, parentPlace, parseTypedPath, pathText, placeForRef, placeForRoot, placeKey, topPlaces, walkPlace,
  type PlaceCatalog,
} from '../src/components/files/places';
import {
  MAX_TABS, activate, activeTab, canBack, canForward, closeTab, cycle, initialTabs, makeTab, moveTab, navigate, openTab, placeOf, readTabs, recentBack, stepHistory, writeTabs,
} from '../src/components/files/tabsModel';
import { buildRows, expandChain, type Kids } from '../src/components/files/navTree';
import { NO_FILTERS, activeFilters, dateRange, toBridgeFilters } from '../src/components/files/searchFilters';
import { EXPLORER_KEYS, SHELL_KEYS, matchKey, matchShellKey } from '../src/components/files/explorerKeys';
import { searchScopes } from '../src/components/files/useExplorerSearch';
import { computerPlaces, networkPlaces } from '../src/components/files/placesApi';
import type { WindowsFolderNode, WindowsRoot, WindowsVolume } from '../src/lib/windowsFiles';

let ok = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) ok++; else { fail++; console.error(`✗ ${name}\n    получили ${JSON.stringify(got)}\n    ждали    ${JSON.stringify(want)}`); }
};

const root = (id: string, name: string, kind: WindowsRoot['kind'] = 'custom', extra: Partial<WindowsRoot> = {}): WindowsRoot => ({ id, name, kind, available: true, ...extra });
const desktop = root('desktop', 'Рабочий стол', 'desktop');
const docs = root('documents', 'Документы', 'documents');
const diskC = root('disk-c', 'Локальный диск (C:)');
const diskD = root('disk-d', 'Новый том (D:)');
const share = root('net', 'Проекты (Z:)', 'custom', { network: true });
const yandex = root('yandex', 'Яндекс Диск');
const vdr = root('vdr', 'Проект ВДР');
const vol = (id: string, name: string, letter: string, r: WindowsRoot, kind: WindowsVolume['kind'] = 'fixed', networkPath?: string): WindowsVolume =>
  ({ id, name, letter, kind, size: 1, free: 1, root: r, ...(networkPath ? { networkPath } : {}) });
const catalog: PlaceCatalog = {
  roots: [desktop, docs, diskC, diskD, share, yandex, vdr],
  volumes: [vol('vc', 'Локальный диск (C:)', 'C:', diskC), vol('vd', 'Новый том (D:)', 'D:', diskD), vol('vz', 'Проекты (Z:)', 'Z:', share, 'network', '\\\\corp\\Проекты')],
  cloud: [{ id: 'y1', name: 'Яндекс Диск', provider: 'yandex', icon: null, root: yandex }],
};

(async () => {
// --- Место и цепочка
console.log('Место и цепочка');
{
  const folder = placeForRef({ rootId: 'disk-c', relativePath: 'Users/Анна' }, catalog);
  eq('диск: цепочка начинается с «Этого компьютера»', folder.trail.map((step) => step.name), ['Этот компьютер', 'Локальный диск (C:)', 'Users', 'Анна']);
  eq('имя места — последнее звено', folder.name, 'Анна');
  eq('текст пути у диска — буква, а не длинное имя', pathText(folder), 'C:\\Users\\Анна');
  eq('сетевой том ложится под «Сеть»', placeForRoot('net', catalog).trail.map((step) => step.name), ['Сеть', 'Проекты (Z:)']);
  eq('известная папка — без верха', placeForRoot('desktop', catalog).trail.map((step) => step.name), ['Рабочий стол']);
  eq('облачная папка — без верха', placeForRef({ rootId: 'yandex', relativePath: 'Фото' }, catalog).trail.map((step) => step.name), ['Яндекс Диск', 'Фото']);
  eq('путь известной папки пишется по имени', pathText(placeForRef({ rootId: 'desktop', relativePath: 'Проекты' }, catalog)), 'Рабочий стол\\Проекты');
  eq('у виртуального места путь — его имя', pathText(COMPUTER), 'Этот компьютер');
  eq('корень неизвестен — место всё равно строится, не падает', placeForRef({ rootId: 'нет', relativePath: 'а' }, catalog).trail.length, 2);

  const draft = childPlace(placeForRoot('documents', catalog), { name: 'Черновик', relativePath: 'Черновик', draftId: 'd1' });
  const inner = childPlace(draft, { name: 'Внутри', relativePath: 'Черновик/Внутри', draftId: 'd2' });
  eq('спуск по папкам хранит draftId каждого предка', inner.trail.map((step) => step.ref?.draftId ?? null), [null, 'd1', 'd2']);
  eq('«Вверх» из черновика возвращает предка вместе с его draftId', parentPlace(inner)?.ref, { rootId: 'documents', relativePath: 'Черновик', draftId: 'd1' });
  eq('по пути, без спуска, номера предков неизвестны — и это не выдумывается', placeForRef(inner.ref!, catalog).trail.map((step) => step.ref?.draftId ?? null), [null, null, 'd2']);
  eq('ключ места не зависит от draftId', placeKey(childPlace(placeForRoot('documents', catalog), { name: 'А', relativePath: 'А', draftId: 'x' })), placeKey(placeForRef({ rootId: 'documents', relativePath: 'А' }, catalog)));
  eq('у Главной вверх некуда', parentPlace(HOME), null);
  eq('у корня без верха (Рабочий стол) вверх тоже некуда', parentPlace(placeForRoot('desktop', catalog)), null);
  eq('у диска вверх — «Этот компьютер»', parentPlace(placeForRoot('disk-c', catalog))?.kind, 'computer');
  eq('верхние места: Главная, известные папки, компьютер, сеть', topPlaces(catalog).map((place) => place.name), ['Главная', 'Рабочий стол', 'Документы', 'Этот компьютер', 'Сеть']);
}

// --- Введённый путь
console.log('Введённый путь');
{
  const parse = (text: string) => parseTypedPath(text, catalog);
  const asPlace = (text: string) => { const r = parse(text); return r.kind === 'place' ? { place: pathText(r.place), rest: r.rest } : r; };
  eq('диск и папка: C:\\Users\\Анна', asPlace('C:\\Users\\Анна'), { place: 'C:', rest: ['Users', 'Анна'] });
  eq('буква диска без учёта регистра', asPlace('d:\\'), { place: 'D:', rest: [] });
  eq('прямые косые принимаются', asPlace('C:/Users'), { place: 'C:', rest: ['Users'] });
  eq('кавычки вокруг пути снимаются', asPlace('"C:\\Users"'), { place: 'C:', rest: ['Users'] });
  eq('имя места: «Рабочий стол\\Проекты»', asPlace('рабочий стол\\Проекты'), { place: 'Рабочий стол', rest: ['Проекты'] });
  eq('«Этот компьютер\\C:\\Users» — тот же диск', asPlace('Этот компьютер\\C:\\Users'), { place: 'C:', rest: ['Users'] });
  eq('«Этот компьютер» — виртуальное место', parse('Этот компьютер'), { kind: 'place', place: COMPUTER, rest: [] });
  eq('«Сеть» — виртуальное место', parse('сеть'), { kind: 'place', place: NETWORK, rest: [] });
  eq('сетевая папка по адресу', asPlace('\\\\corp\\Проекты\\ВДР'), { place: 'Z:', rest: ['ВДР'] });
  eq('сетевая папка с другим сервером — вне подключённых', parse('\\\\чужой\\ресурс'), { kind: 'outside', reason: 'network' });
  eq('диска Q: нет — вне подключённых', parse('Q:\\Файлы'), { kind: 'outside', reason: 'drive' });
  eq('неизвестное имя — вне подключённых', parse('Секретная папка'), { kind: 'outside', reason: 'unknown' });
  eq('%USERPROFILE% не раскрывается: значение знает только main', parse('%USERPROFILE%\\Desktop'), { kind: 'outside', reason: 'env' });
  eq('пустая строка — ничего не открывается', parse('   '), { kind: 'empty' });
  eq('«..» поднимается на уровень', asPlace('C:\\Users\\Анна\\..'), { place: 'C:', rest: ['Users'] });
  eq('«..» выше корня — вне', parse('..'), { kind: 'outside', reason: 'unknown' });
}

// --- Обход звеньев по именам с диска
console.log('Обход звеньев');
{
  const tree: Record<string, WindowsFolderNode[]> = {
    'documents|': [{ name: 'Отчёты', relativePath: 'Отчёты', storage: 'windows' }, { name: 'Черновик', relativePath: 'Черновик', storage: 'flux', draftId: 'd1' }],
    'documents|Черновик': [{ name: 'Внутри', relativePath: 'Черновик/Внутри', storage: 'flux', draftId: 'd2' }],
  };
  const children = async (ref: { rootId: string; relativePath: string }) => tree[`${ref.rootId}|${ref.relativePath}`] ?? null;
  const base = placeForRoot('documents', catalog);
  const res = await walkPlace(base, ['отчёты'], catalog, children);
  eq('регистр берётся с диска', 'place' in res && res.place.name, 'Отчёты');
  const deep = await walkPlace(base, ['ЧЕРНОВИК', 'внутри'], catalog, children);
  eq('номера черновиков берутся у найденных папок', 'place' in deep && deep.place.trail.map((step) => step.ref?.draftId ?? null), [null, 'd1', 'd2']);
  const miss = await walkPlace(base, ['Отчёты', 'Нет'], catalog, children);
  eq('отсутствующее звено названо', 'place' in miss ? null : miss.missing, 'Нет');
}

// --- Вкладки
console.log('Вкладки');
{
  const a = placeForRoot('desktop', catalog), b = placeForRoot('documents', catalog), c = placeForRoot('disk-c', catalog);
  let s = initialTabs();
  eq('начало — одна вкладка на «Главной»', [s.tabs.length, placeOf(activeTab(s)).kind], [1, 'home']);
  s = navigate(s, a); s = navigate(s, b);
  eq('переходы пополняют историю', activeTab(s).history.map((p) => p.name), ['Главная', 'Рабочий стол', 'Документы']);
  eq('повторный переход в то же место историю не пополняет', activeTab(navigate(s, b)).history.length, 3);
  s = stepHistory(s, -1);
  eq('назад: на шаг', [placeOf(activeTab(s)).name, canBack(activeTab(s)), canForward(activeTab(s))], ['Рабочий стол', true, true]);
  s = navigate(s, c);
  eq('переход после «Назад» отбрасывает «Вперёд»', [activeTab(s).history.map((p) => p.name), canForward(activeTab(s))], [['Главная', 'Рабочий стол', 'Локальный диск (C:)'], false]);
  eq('«Назад» дальше начала не уходит', activeTab(stepHistory(s, -10)).index, 0);
  eq('недавние: от ближайшего, с шагом прыжка', recentBack(activeTab(s)).map((x) => [x.place.name, x.delta]), [['Рабочий стол', -1], ['Главная', -2]]);

  // у каждой вкладки своя история
  s = openTab(s, b);
  eq('новая вкладка встаёт справа и активна', [s.tabs.length, placeOf(activeTab(s)).name], [2, 'Документы']);
  eq('у новой вкладки своя история', activeTab(s).history.length, 1);
  s = navigate(s, a, s.tabs[0].id);
  eq('переход в чужой вкладке не трогает активную', [s.tabs[0].history.length, activeTab(s).history.length], [4, 1]);
  // закрытие
  let t = initialTabs(); t = openTab(t); t = openTab(t); const ids = t.tabs.map((x) => x.id);
  t = activate(t, ids[1]); t = closeTab(t, ids[1]);
  eq('закрытая активная отдаёт место соседу справа', t.activeId, ids[2]);
  t = closeTab(t, ids[2]);
  eq('закрытая последняя — соседу слева', t.activeId, ids[0]);
  eq('единственную вкладку набор не закрывает', closeTab(t, ids[0]).tabs.length, 1);
  t = openTab(openTab(t)); const [x0, x1, x2] = t.tabs.map((x) => x.id);
  t = activate(t, x1); t = closeTab(t, x2);
  eq('закрытая неактивная не двигает активную', t.activeId, x1);
  eq('Ctrl+Tab идёт по кругу', [cycle(activate(t, x0), 1).activeId, cycle(activate(t, x1), 1).activeId], [x1, x0]);
  eq('Ctrl+Shift+Tab идёт по кругу назад', cycle(activate(t, x0), -1).activeId, x1);
  // перестановка
  let m = initialTabs(); m = openTab(m); m = openTab(m); const [m0, m1, m2] = m.tabs.map((x) => x.id);
  eq('перенос перед другой', moveTab(m, m2, m0).tabs.map((x) => x.id), [m2, m0, m1]);
  eq('перенос в конец', moveTab(m, m0, null).tabs.map((x) => x.id), [m1, m2, m0]);
  eq('перенос на своё место — тот же объект', moveTab(m, m1, m2) === m || JSON.stringify(moveTab(m, m1, m2).tabs.map((x) => x.id)) === JSON.stringify([m0, m1, m2]), true);
  eq('перенос не меняет активную', moveTab(m, m2, m0).activeId, m.activeId);
  let many = initialTabs(); for (let i = 0; i < MAX_TABS + 5; i++) many = openTab(many);
  eq('вкладок не больше предела', many.tabs.length, MAX_TABS);
  // сохранение
  const saved = writeTabs(s);
  const back = readTabs(JSON.parse(JSON.stringify(saved)));
  eq('набор переживает запись и чтение', [back.tabs.length, back.activeId === s.activeId, placeOf(activeTab(back)).name], [2, true, 'Документы']);
  eq('история и номер места восстанавливаются', [back.tabs[0].history.map((p) => p.name), back.tabs[0].index], [['Главная', 'Рабочий стол', 'Локальный диск (C:)', 'Рабочий стол'], 3]);
  eq('чужой мусор в файле — одна «Главная»', readTabs({ tabs: 'нет' }).tabs.map((x) => x.history[0].kind), ['home']);
  eq('вкладка без ссылки на папку отбрасывается', readTabs({ tabs: [{ id: 'a', history: [{ trail: [{ name: 'x', kind: 'folder' }] }], index: 0 }] }).tabs[0].history[0].kind, 'home');
  eq('одинаковые id вкладок не дублируются', readTabs({ tabs: [{ id: 'a', history: [HOME], index: 0 }, { id: 'a', history: [HOME], index: 0 }] }).tabs.length, 1);
  eq('индекс вне истории прижимается', readTabs({ tabs: [{ id: 'a', history: [HOME], index: 9 }] }).tabs[0].index, 0);
  let longTab = makeTab(HOME); for (let i = 0; i < 30; i++) longTab = navigate({ tabs: [longTab], activeId: longTab.id }, placeForRef({ rootId: 'disk-c', relativePath: `п${i}` }, catalog)).tabs[0];
  eq('на диск уходит хвост истории, не вся она', (writeTabs({ tabs: [longTab], activeId: longTab.id }) as any).tabs[0].history.length, 10);
}

// --- Строки панели навигации
console.log('Панель навигации');
{
  const quick = [
    { name: 'Рабочий стол', pinned: true, ref: { rootId: 'desktop', relativePath: '' } },
    { name: 'Документы', pinned: true, ref: { rootId: 'documents', relativePath: '' } },
    { name: '1_PDF', pinned: false, ref: { rootId: 'documents', relativePath: '1_PDF' } },
  ];
  const input = (extra: Partial<Parameters<typeof buildRows>[0]> = {}) => ({ catalog, quick, quickSupported: true, kids: {} as Record<string, Kids>, expanded: new Set<string>(), current: HOME, ...extra });
  const labels = (rows: ReturnType<typeof buildRows>) => rows.map((row) => row.kind === 'sep' ? '—' : row.label);
  const base = buildRows(input());
  eq('порядок: Главная, закреплённое, облако, компьютер, сеть', labels(base), ['Главная', '—', 'Рабочий стол', 'Документы', '1_PDF', '—', 'Яндекс Диск', 'Этот компьютер', 'Сеть']);
  eq('«Галереи» нет', labels(base).includes('Галерея'), false);
  eq('булавка только у закреплённых, а частая папка — без неё', base.filter((row) => row.quick).map((row) => row.pinned), [true, true, false]);
  eq('закреплённые и частые — без стрелки', base.filter((row) => row.quick).map((row) => row.expandable), [false, false, false]);
  eq('подсвечена Главная и только она', base.filter((row) => row.selected).map((row) => row.label), ['Главная']);

  const open = new Set(['computer']);
  const withDisks = buildRows(input({ expanded: open }));
  eq('«Этот компьютер» раскрыт: диски и подключённая папка под ним', labels(withDisks).slice(8), ['Локальный диск (C:)', 'Новый том (D:)', 'Проект ВДР', 'Сеть']);
  eq('диски на уровень глубже', withDisks.filter((row) => row.label.includes('(C:)')).map((row) => row.depth), [1]);
  eq('сетевой том — под «Сетью», не под компьютером', [computerPlaces(catalog).map((p) => p.name), networkPlaces(catalog).map((p) => p.name)], [['Локальный диск (C:)', 'Новый том (D:)', 'Проект ВДР'], ['Проекты (Z:)']]);

  const kids: Record<string, Kids> = {
    [`folder\u0000disk-c\u0000`]: { status: 'done', folders: [{ name: 'Users', relativePath: 'Users', storage: 'windows', hasChildren: true }, { name: 'Только тут', relativePath: 'Только тут', storage: 'flux', draftId: 'dr', hasChildren: false }] },
    [`folder\u0000disk-c\u0000Users`]: { status: 'done', folders: [{ name: 'Анна', relativePath: 'Users/Анна', storage: 'windows' }] },
  };
  const here = placeForRef({ rootId: 'disk-c', relativePath: 'Users/Анна' }, catalog);
  const chain = expandChain(here, catalog);
  eq('цепочка раскрытия: компьютер, диск, папки-предки', chain.map((step) => step.key.replace(/\u0000/g, '|')), ['computer', 'folder|disk-c|', 'folder|disk-c|Users']);
  const tree = buildRows(input({ kids, expanded: new Set(chain.map((step) => step.key)), current: here }));
  eq('открытая папка подсвечена в дереве', tree.filter((row) => row.selected).map((row) => row.label), ['Анна']);
  eq('открытая папка стоит на нужном уровне', tree.filter((row) => row.selected).map((row) => row.depth), [3]);
  const flux = tree.find((row) => row.label === 'Только тут');
  eq('папка-черновик помечена и без стрелки', [flux?.flux, flux?.expandable], [true, false]);
  eq('настоящая папка не помечена', tree.find((row) => row.label === 'Users')?.flux, false);
  eq('подключённая папка раскрывает «компьютер» сама', expandChain(placeForRoot('vdr', catalog), catalog).map((step) => step.key), ['computer']);
  eq('Быстрый доступ не раскрывает ничего', expandChain(placeForRoot('desktop', catalog), catalog), []);

  const pinned = buildRows(input({ current: placeForRoot('documents', catalog) }));
  eq('папка из Быстрого доступа горит один раз', pinned.filter((row) => row.selected).length, 1);
  const noQuick = buildRows(input({ quickSupported: false, quick: [] }));
  eq('без Быстрого доступа Windows — известные папки', labels(noQuick).slice(2, 4), ['Рабочий стол', 'Документы']);
  eq('при отказе моста нет лишнего разделителя: Главная, ровно один после неё', labels(buildRows(input({ quickSupported: false, quick: [], catalog: { ...catalog, roots: [] } }))).filter((label) => label === '—').length, 1);
  eq('ленивая ветвь без ответа показывает «загрузка»', buildRows(input({ kids: { [`folder\u0000yandex\u0000`]: { status: 'loading' } }, expanded: new Set([`folder\u0000yandex\u0000`]) })).find((row) => row.label === 'Яндекс Диск')?.loading, true);
}

// --- Поиск
console.log('Поиск');
{
  const now = new Date(2026, 9, 7, 12, 0); // среда, 7 октября 2026
  const range = (key: any) => { const r = dateRange(key, now); return [r.from?.getDate() ?? null, r.from?.getMonth() ?? null, r.to?.getDate() ?? null, r.to?.getMonth() ?? null]; };
  eq('сегодня', range('today'), [7, 9, null, null]);
  eq('вчера — до сегодняшней полуночи', range('yesterday'), [6, 9, 7, 9]);
  eq('на этой неделе — с понедельника', range('thisWeek'), [5, 9, null, null]);
  eq('на прошлой неделе — понедельник по понедельник', range('lastWeek'), [28, 8, 5, 9]);
  eq('в прошлом месяце', range('lastMonth'), [1, 8, 1, 9]);
  eq('давно — до начала года', range('older'), [null, null, 1, 0]);
  eq('пустые фильтры в запрос не попадают', toBridgeFilters(NO_FILTERS, now), {});
  const f = toBridgeFilters({ ...NO_FILTERS, type: 'tables', size: 'small', tag: ' AHU-01 ', projectId: 'p1', onlyDrafts: true }, now);
  eq('тип «Таблицы» — файлы с расширениями Excel', [f.kind, f.extensions?.includes('xlsx')], ['file', true]);
  eq('размер «Мелкие» — от 16 КБ до 1 МБ', [f.sizeMin, f.sizeMax], [16384, 1048576]);
  eq('свойства Flux переходят как есть, тег без пробелов', [f.tag, f.projectId, f.onlyDrafts], ['AHU-01', 'p1', true]);
  eq('тип «Папки» — kind directory без расширений', toBridgeFilters({ ...NO_FILTERS, type: 'folders' }, now), { kind: 'directory' });
  eq('гигантские — только нижняя граница', (({ sizeMin, sizeMax }) => [sizeMin, sizeMax])(toBridgeFilters({ ...NO_FILTERS, size: 'giant' }, now)), [4 * 1024 ** 3, undefined]);
  eq('включённые фильтры перечислены словами', activeFilters({ ...NO_FILTERS, type: 'images', onlyDrafts: true }), ['Тип: Изображения', 'Только черновики']);
  eq('где искать: у папки — она сама', searchScopes(placeForRoot('desktop', catalog), catalog), [{ rootId: 'desktop', relativePath: '' }]);
  eq('где искать: «Этот компьютер» — диски без сетевых', searchScopes(COMPUTER, catalog).map((ref) => ref.rootId), ['disk-c', 'disk-d']);
  eq('где искать: «Сеть» — сетевые корни без повторов', searchScopes(NETWORK, catalog).map((ref) => ref.rootId), ['net']);
  eq('где искать: Главная — закреплённое', searchScopes(HOME, catalog, [{ rootId: 'desktop', relativePath: '' }]).length, 1);
}

// --- Клавиши окна
console.log('Клавиши окна');
{
  const press = (key: string, mods: Record<string, boolean> = {}, code = '') => matchShellKey({ key, code, ...mods })?.action;
  eq('Ctrl+T — новая вкладка', press('t', { ctrlKey: true }), 'newTab');
  eq('Ctrl+T при русской раскладке (key «е») — тоже', press('е', { ctrlKey: true }, 'KeyT'), 'newTab');
  eq('Ctrl+Tab и Ctrl+Shift+Tab различаются', [press('Tab', { ctrlKey: true }), press('Tab', { ctrlKey: true, shiftKey: true })], ['nextTab', 'prevTab']);
  eq('Alt+←/→/↑ — история и вверх', [press('ArrowLeft', { altKey: true }), press('ArrowRight', { altKey: true }), press('ArrowUp', { altKey: true })], ['goBack', 'goForward', 'goUp']);
  eq('стрелка без Alt — не клавиша окна', press('ArrowLeft'), undefined);
  eq('Ctrl+L, Alt+D, F4 — один и тот же адрес', [press('l', { ctrlKey: true }), press('d', { altKey: true }), press('F4')], ['address', 'address', 'address']);
  eq('Ctrl+E, Ctrl+F, F3 — поиск', [press('e', { ctrlKey: true }), press('f', { ctrlKey: true }), press('F3')], ['search', 'search', 'search']);
  eq('F5 — обновить', press('F5'), 'refresh');
  eq('Cmd на Mac читается как Ctrl', press('w', { metaKey: true }), 'closeTab');
  const sig = (b: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean }) => `${b.key.toLowerCase()}|${!!b.ctrl}|${!!b.shift}|${!!b.alt}`;
  eq('сочетания окна не повторяются', new Set(SHELL_KEYS.map(sig)).size, SHELL_KEYS.length);
  eq('сочетания окна не пересекаются с сочетаниями списка', SHELL_KEYS.filter((b) => EXPLORER_KEYS.some((k) => sig(k) === sig(b))).map((b) => b.label), []);
  eq('Backspace остаётся клавишей списка, а не окна', [matchKey({ key: 'Backspace' })?.action, matchShellKey({ key: 'Backspace' })], ['back', null]);
  eq('у каждого действия окна есть клавиша', [...new Set(SHELL_KEYS.map((b) => b.action))].sort(), ['address', 'closeTab', 'goBack', 'goForward', 'goUp', 'newTab', 'nextTab', 'prevTab', 'refresh', 'search']);
}

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
})();
