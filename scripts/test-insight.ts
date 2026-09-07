/**
 * Связи проекта: поиск упоминаний, «где используется», проверка проекта и лист
 * изменений.
 *
 * Проверяется то, что глазами в интерфейсе не увидишь: границы обозначений
 * (чтобы «бл2.1» не находился внутри «бл2.11»), состав замечаний и разбор
 * характеристик. Каждое название говорит, что именно сломается.
 */
import {
  mentions, countMentions, paramsOf, actualityOf, plainText, whereUsed, searchAll,
  type ProjectSnapshot, type ElementLite, type TagLite,
} from '../server/insight.js';
import {
  projectCheck, missingKeyParams, hasParam, diffSpecs, flatten, changeList, plural,
} from '../server/insightRules.js';
import { overrideKey } from '../server/specUtils.js';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 240) : ''));

// ── Заготовки ───────────────────────────────────────────────────────────────

const tag = (over: Partial<TagLite> = {}): TagLite => ({
  id: 't1', identifier: 'AHU-2', brand: 'Systemair', department: 'ОВ', wbs: '', fluid: '',
  mainName: 'Приточная установка', stageId: 'ordered', stageLabel: 'Заказан',
  stageSince: new Date().toISOString(), stageIsFirst: false, stageIsFinal: false,
  actuality: 'actual', supplier: 'Тепло-Сервис', qty: '1', updatedAt: null, ...over,
});

const el = (over: Partial<ElementLite> = {}): ElementLite => ({
  id: 'e1', name: 'бл2.1', itemCode: 'бл2.1', equipType: 'ВЕНТИЛЯТОР',
  systemId: 's1', systemName: 'у1', monoblockName: 'мн1',
  status: 'OK', hasConflict: false, conflictType: '', paramConflicts: [],
  params: [
    { group: 'Аэродинамика', key: 'Расход воздуха', value: '5000', unit: 'м3/ч' },
    { group: 'Аэродинамика', key: 'Полное давление', value: '850', unit: 'Па' },
  ],
  tagIds: ['t1'], tagCodes: ['AHU-2'], version: 1, updatedAt: null, ...over,
});

const snap = (over: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  projectId: 'p1', projectName: 'Азот', projects: [{ id: 'p1', name: 'Азот' }],
  tags: [tag()], elements: [el()], docs: [], files: [], vdr: [], notes: [], chat: [], mail: [],
  stages: [{ id: 'added', label: 'Добавлен' }, { id: 'ordered', label: 'Заказан' }, { id: 'purchased', label: 'Куплен' }],
  ...over,
});

// ── 1. Границы обозначений ──────────────────────────────────────────────────

console.log('1. Упоминание обозначения в тексте');
ok('находит сам код', mentions('Поставить AHU-2 в осях 3-4', 'AHU-2'));
ok('не находит внутри более длинного', !mentions('Смотри AHU-21 на плане', 'AHU-2'));
ok('кириллический код находится', mentions('Заменить бл2.1 на аналог', 'бл2.1'));
// В JS \b не считает кириллицу словом — на этом уже трижды ловились в проекте
ok('кириллический код не находится внутри длинного', !mentions('позиция бл2.11 снята', 'бл2.1'));
ok('точка с цифрой — продолжение кода', !mentions('узел бл2.1.3 переделан', 'бл2.1'));
ok('код в начале строки', mentions('AHU-2 — приточка', 'AHU-2'));
ok('код в конце строки', mentions('приточка AHU-2', 'AHU-2'));
ok('код в скобках', mentions('установка (AHU-2) заказана', 'AHU-2'));
ok('регистр не важен', mentions('заменить ahu-2', 'AHU-2'));
ok('пустой код ничего не находит', !mentions('что угодно', ''));
ok('точка в коде не значит «любой символ»', !mentions('бл2X1 это другое', 'бл2.1'));
ok('считает повторы', countMentions('AHU-2, потом AHU-2 и ещё AHU-21', 'AHU-2') === 2,
  countMentions('AHU-2, потом AHU-2 и ещё AHU-21', 'AHU-2'));

console.log('2. Разбор данных');
const specs = JSON.stringify({ groups: [{ title: 'Аэродинамика', params: [{ key: 'Расход', value: '5000', unit: 'м3/ч' }] }] });
ok('характеристики читаются', paramsOf(specs, null)[0].value === '5000');
// Ключ правки — «группа||ключ», ровно как его пишет карточка оборудования.
// Проверка раньше сама использовала одинарную черту и потому не замечала, что
// чтение с записью разошлись: защита «не затирать ручную правку» не работала.
ok('ручная правка сильнее импорта',
  paramsOf(specs, JSON.stringify({ [overrideKey('Аэродинамика', 'Расход')]: '6200' }))[0].value === '6200',
  paramsOf(specs, JSON.stringify({ [overrideKey('Аэродинамика', 'Расход')]: '6200' }))[0]);
ok('одинарная черта правкой не считается (иначе ключи снова разойдутся)',
  paramsOf(specs, JSON.stringify({ 'Аэродинамика|Расход': '6200' }))[0].value === '5000');
ok('мусор вместо JSON не роняет разбор', paramsOf('{кривой', null).length === 0);
ok('актуальность берёт худшее',
  actualityOf({ descriptions: [{ status: 'actual' }, { status: 'critical' }] }) === 'critical');
ok('без описаний — черновик', actualityOf({}) === 'draft');
ok('разметка из заметки убирается', plainText('<p>Проверить <b>AHU-2</b></p>') === 'Проверить AHU-2');

// ── 3. Где используется ─────────────────────────────────────────────────────

console.log('3. Где используется');
const rich = snap({
  docs: [
    { id: 'd1', name: 'Спецификация', kind: 'DOC', scope: 'SHARED', text: '=ТЕГ("AHU-2","brand") и ещё раз AHU-2' },
    { id: 'd2', name: 'Записка', kind: 'TEXT', scope: 'SHARED', text: 'Про AHU-21 ни слова о нужном' },
  ],
  files: [{ id: 'f1', name: 'План.dwg', folderId: 'fold1', folderName: 'Чертежи', revision: '2', statusCode: 'D', tagIds: ['t1'], refId: null, updatedAt: null }],
  vdr: [{
    id: 'v1', registerId: 'r1', registerName: 'ВДР Азот', contractorNo: 'C-01', titleRu: 'Опросный лист',
    vdrCode: 'C01', revision: 'A', status: 'DRAFT', tagCodes: ['AHU-2'], docId: 'd1', issueDate: null, dueDate: null,
  }],
  notes: [{ id: 'n1', title: 'Созвон', text: 'Уточнить расход у AHU-2' }],
  chat: [{ id: 'm1', text: 'AHU-2 приедет в мае', author: 'Раупов', at: null, elementId: null }],
  mail: [
    {
      id: 'ml1', accountId: 'acc1', folderId: 'f1', threadKey: 'th1',
      subject: 'Опросный лист AHU-2', from: 'Поставщик', text: 'Опросный лист AHU-2 просим заполнить', sentAt: null,
    },
    {
      id: 'ml2', accountId: 'acc1', folderId: 'f1', threadKey: 'th2',
      subject: 'Про AHU-21', from: 'Другой', text: 'Тут только AHU-21', sentAt: null,
    },
  ],
});
const u = whereUsed(rich, 'tag', 't1');
ok('тег найден', u.found && u.title === 'AHU-2');
const gid = (id: string) => u.groups.find(g => g.id === id);
ok('оборудование в связях', gid('elements')?.links[0].title === 'бл2.1');
ok('установка в связях', gid('systems')?.links[0].title === 'у1');
ok('файл по метке', gid('files')?.links[0].title === 'План.dwg');
// Проводник не держит все файлы разом — без папки ссылка никуда не приведёт
ok('ссылка на файл несёт папку', gid('files')?.links[0].route === '/explorer?file=f1&folder=fold1',
  gid('files')?.links[0].route);
ok('документ с формулой найден', gid('docs')?.links.length === 1, gid('docs')?.links.map(l => l.title));
ok('и посчитаны упоминания', gid('docs')?.links[0].badge === '2×', gid('docs')?.links[0].badge);
ok('чужой документ не приплетён', !gid('docs')?.links.some(l => l.title === 'Записка'));
ok('строка ВДР найдена', gid('vdr')?.links.length === 1);
ok('заметка найдена', gid('notes')?.links[0].title === 'Созвон');
ok('сообщение найдено', gid('chat')?.links.length === 1);
ok('письмо найдено', gid('mail')?.links.length === 1, gid('mail')?.links.map(l => l.title));
ok('письмо про соседний тег не приплетено', !gid('mail')?.links.some(l => l.title === 'Про AHU-21'));
ok('ссылка на письмо ведёт в ящик, папку и цепочку',
  gid('mail')?.links[0].route === '/mail?account=acc1&folder=f1&thread=th1', gid('mail')?.links[0].route);
ok('пустых групп в ответе нет', u.groups.every(g => g.links.length > 0));
ok('итог сходится с группами', u.total === u.groups.reduce((s, g) => s + g.links.length, 0));
ok('ссылка на элемент ведёт в оборудование', gid('elements')?.links[0].route === '/equipment?element=e1');
ok('несуществующий тег — не найдено', whereUsed(rich, 'tag', 'нет-такого').found === false);

const ue = whereUsed(rich, 'element', 'e1');
ok('у элемента виден его тег', ue.groups.find(g => g.id === 'tags')?.links[0].title === 'AHU-2');
const ud = whereUsed(rich, 'doc', 'd1');
ok('у документа видны теги', ud.groups.find(g => g.id === 'tags')?.links[0].title === 'AHU-2');
ok('у документа видна строка ВДР', ud.groups.find(g => g.id === 'vdr')?.links.length === 1);

// ── 4. Проверка проекта ─────────────────────────────────────────────────────

console.log('4. Проверка проекта');
const clean = projectCheck(snap());
ok('на здоровом проекте пусто по критичным', clean.critical === 0, clean.groups.map(g => g.id));
ok('и группы без замечаний не показываются', clean.groups.every(g => g.count > 0));

const ids = (r: any) => r.groups.map((g: any) => g.id);
const conflict = projectCheck(snap({ elements: [el({ hasConflict: true, conflictType: 'ORPHANED_TAG' })] }));
ok('конфликт импорта замечен', ids(conflict).includes('element-conflict'));
ok('и он критический', conflict.groups.find((g: any) => g.id === 'element-conflict')?.severity === 'critical');
ok('причина конфликта по-русски',
  /без своего элемента/.test(conflict.groups.find((g: any) => g.id === 'element-conflict')!.findings[0].subtitle));

const pconf = projectCheck(snap({
  elements: [el({ paramConflicts: [{ group: 'Аэродинамика', key: 'Расход', oldValue: '5000', newValue: '5600' }] })],
}));
ok('расхождение значений замечено', ids(pconf).includes('param-conflict'));

const dup = projectCheck(snap({ tags: [tag(), tag({ id: 't2' })], elements: [el({ tagIds: ['t1', 't2'] })] }));
ok('дубль обозначения замечен', ids(dup).includes('duplicate-tag'));
ok('дубль ведёт на панель дублей',
  dup.groups.find((g: any) => g.id === 'duplicate-tag')!.findings[0].route === '/registry?dup=AHU-2');

const orphanTag = projectCheck(snap({ tags: [tag(), tag({ id: 't9', identifier: 'FAN-7' })] }));
ok('тег без оборудования замечен', ids(orphanTag).includes('tag-without-equipment'));
ok('и только он один', orphanTag.groups.find((g: any) => g.id === 'tag-without-equipment')!.count === 1);

const orphanEl = projectCheck(snap({ elements: [el(), el({ id: 'e2', itemCode: 'бл3.1', tagIds: [], tagCodes: [] })] }));
ok('элемент без тега замечен', ids(orphanEl).includes('element-without-tag'));

console.log('5. Ключевые характеристики');
ok('вентилятор с расходом и давлением полон', missingKeyParams(el()).length === 0);
ok('без давления — не хватает', missingKeyParams(el({ params: [{ group: 'А', key: 'Расход воздуха', value: '5000', unit: '' }] })).length === 1);
ok('пустое значение — то же, что нет параметра',
  missingKeyParams(el({ params: [{ group: 'А', key: 'Расход', value: '', unit: '' }, { group: 'А', key: 'Давление', value: '850', unit: '' }] })).length === 1);
ok('подпись ищется по части слова', hasParam(el(), 'расход'));
ok('регистр и «ё» не мешают',
  hasParam(el({ params: [{ group: 'А', key: 'ОБЪЁМ', value: '3', unit: '' }] }), 'объем'));
ok('у неизвестного типа требований нет', missingKeyParams(el({ equipType: 'ПРОЧЕЕ', params: [] })).length === 0);

console.log('6. Закупка и ВДР');
const notOrdered = projectCheck(snap({ tags: [tag({ stageId: 'added', stageLabel: 'Добавлен', stageIsFirst: true })] }));
ok('незаказанная позиция замечена', ids(notOrdered).includes('not-ordered'));
const long = new Date(Date.now() - 40 * 864e5).toISOString();
const stuck = projectCheck(snap({ tags: [tag({ stageSince: long })] }));
ok('зависшая позиция замечена', ids(stuck).includes('stuck-stage'));
ok('свежая позиция не считается зависшей', !ids(projectCheck(snap())).includes('stuck-stage'));
const vdrBad = projectCheck(snap({
  vdr: [
    { id: 'v1', registerId: 'r1', registerName: 'ВДР', contractorNo: 'C-01', titleRu: 'Лист', vdrCode: 'C01', revision: 'A', status: 'REMARKS', tagCodes: [], docId: null, issueDate: null, dueDate: null },
    { id: 'v2', registerId: 'r1', registerName: 'ВДР', contractorNo: 'C-02', titleRu: 'Схема', vdrCode: 'C02', revision: '1', status: 'READY', tagCodes: [], docId: null, issueDate: null, dueDate: new Date(Date.now() - 5 * 864e5).toISOString() },
  ],
}));
ok('замечания заказчика замечены', ids(vdrBad).includes('vdr-remarks'));
ok('просрочка замечена', ids(vdrBad).includes('vdr-overdue'));
ok('готовая строка без документа замечена', ids(vdrBad).includes('vdr-without-doc'));

console.log('7. Отключение правила');
const muted = projectCheck(snap({ tags: [tag({ brand: '' })] }), { muted: ['tag-without-brand'] });
ok('отключённое правило не показывается', !ids(muted).includes('tag-without-brand'));
ok('а включённое — показывается', ids(projectCheck(snap({ tags: [tag({ brand: '' })] }))).includes('tag-without-brand'));
ok('счётчики считают только показанные группы',
  muted.total === muted.groups.reduce((s: number, g: any) => s + g.count, 0));

// ── 8. Лист изменений ───────────────────────────────────────────────────────

console.log('8. Лист изменений');
const before = JSON.stringify({ groups: [{ title: 'Аэродинамика', params: [{ key: 'Расход', value: '5000' }, { key: 'Давление', value: '800' }] }] });
const after = JSON.stringify({ groups: [{ title: 'Аэродинамика', params: [{ key: 'Давление', value: '850' }, { key: 'Расход', value: '5000' }, { key: 'Мощность', value: '3' }] }] });
const d = diffSpecs(before, after);
ok('изменённое значение найдено', d.some(x => x.key === 'Давление' && x.was === '800' && x.now === '850'));
ok('добавленное найдено', d.some(x => x.key === 'Мощность' && x.kind === 'added'));
ok('неизменное не попало в лист', !d.some(x => x.key === 'Расход'), d.map(x => x.key));
// Порядок параметров при импорте меняется — сравнение по позиции показало бы
// изменённым весь список
ok('перестановка сама по себе не изменение', d.length === 2, d.map(x => x.key));
ok('удалённое помечено', diffSpecs(before, JSON.stringify({ groups: [{ title: 'Аэродинамика', params: [{ key: 'Расход', value: '5000' }] }] }))
  .some(x => x.key === 'Давление' && x.kind === 'removed'));
ok('одинаковые группы с разными названиями не путаются',
  flatten(JSON.stringify({ groups: [{ title: 'А', params: [{ key: 'X', value: '1' }] }, { title: 'Б', params: [{ key: 'X', value: '2' }] }] }))['Б|X'].value === '2');

const byId = new Map([['e1', el()]]);
const list = changeList([
  { id: 'h1', elementId: 'e1', version: 2, changedAt: new Date().toISOString(), oldSpecs: before, newSpecs: after, changeType: 'UPDATE' },
  { id: 'h2', elementId: 'e1', version: 3, changedAt: new Date().toISOString(), oldSpecs: before, newSpecs: before, changeType: 'UPDATE' },
], null, byId as any);
ok('запись с изменениями попала в лист', list.entries.length === 1, list.entries.map(e => e.id));
ok('пустая запись выброшена', !list.entries.some(e => e.id === 'h2'));
ok('в листе видно, где элемент', list.entries[0].where === 'у1 · мн1');
ok('заведение элемента остаётся даже без разницы',
  changeList([{ id: 'h3', elementId: 'e1', version: 1, changedAt: '', oldSpecs: null, newSpecs: before, changeType: 'CREATE' }], null, byId as any).entries.length === 1);

// ── 9. Общий поиск ──────────────────────────────────────────────────────────

console.log('9. Общий поиск');
const hits = searchAll(rich, 'ahu');
ok('тег находится по части кода', hits[0].kind === 'tag' && hits[0].title === 'AHU-2', hits.slice(0, 2));
ok('однобуквенный запрос ничего не ищет', searchAll(rich, 'a').length === 0);
ok('документ находится по названию', searchAll(rich, 'специф').some(h => h.kind === 'doc'));
ok('файл находится по названию', searchAll(rich, 'план').some(h => h.kind === 'file'));
ok('заметка находится по содержимому', searchAll(rich, 'уточнить').some(h => h.kind === 'note'));
ok('точное совпадение выше частичного',
  searchAll(rich, 'бл2.1')[0].kind === 'element', searchAll(rich, 'бл2.1').slice(0, 2));
ok('у каждой находки есть куда перейти', searchAll(rich, 'ahu').every(h => h.route.startsWith('/')));
ok('проект находится по названию', searchAll(rich, 'азот').some(h => h.kind === 'project'));
ok('письмо находится по теме', searchAll(rich, 'опросный').some(h => h.kind === 'mail'));

console.log('10. Склонение в подписях');
ok('1 день', plural(1, 'день', 'дня', 'дней') === 'день');
ok('2 дня', plural(2, 'день', 'дня', 'дней') === 'дня');
ok('5 дней', plural(5, 'день', 'дня', 'дней') === 'дней');
ok('11 дней, а не 11 день', plural(11, 'день', 'дня', 'дней') === 'дней');
ok('21 день', plural(21, 'день', 'дня', 'дней') === 'день');

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
