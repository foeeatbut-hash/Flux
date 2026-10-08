/**
 * Маршруты каталога типовых решений E3: права, версии, снимки «до», откат,
 * профиль проекта.
 *
 * Базы нет — подставлена память с теми же вызовами Prisma, что делает маршрут
 * (по образцу test-e3-attributes-http). Проверяется то, что держит маршрут сам:
 * кто что может, чужая версия не перезаписывается, каждая запись оставляет
 * снимок «до», откат возвращает книгу, план ничего не пишет, профиль доступен
 * только участнику проекта.
 *
 * Запуск: npx tsx scripts/test-e3-solutions-http.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { registerE3SolutionRoutes } from '../server/routes/e3Solutions';
import { setPrisma } from '../server/context';
import { parseSolutionSheet, parseIoSheet, DEFAULT_FEATURES, DEFAULT_IO_RULES } from '../e3/solutions';
import { CLASSIFIER_HEADERS } from '../e3/solutionWorkbook';

type State = { settings: any[]; revisions: any[] };
const clone = <T,>(x: T): T => structuredClone(x);
const match = (row: any, where: any = {}) => Object.entries(where).every(([k, v]) => row[k] === v);

function mockPrisma() {
  let state: State = { settings: [], revisions: [] };
  let clock = 0;
  const database = (read: () => State) => ({
    appSetting: {
      findUnique: async ({ where }: any) => clone(read().settings.find((r) => r.id === where.id) || null),
      create: async ({ data }: any) => {
        if (read().settings.some((r) => r.id === data.id)) throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        read().settings.push(clone(data)); return clone(data);
      },
      updateMany: async ({ where, data }: any) => {
        const rows = read().settings.filter((r) => match(r, where));
        for (const r of rows) Object.assign(r, clone(data));
        return { count: rows.length };
      },
    },
    catalogRevision: {
      create: async ({ data }: any) => {
        const row = { id: `rev-${read().revisions.length + 1}`, createdAt: new Date(++clock * 1000), ...clone(data) };
        read().revisions.push(row); return clone(row);
      },
      findFirst: async ({ where }: any) => clone(read().revisions.find((r) => match(r, where)) || null),
      findMany: async ({ where, take }: any) => clone(read().revisions.filter((r) => match(r, where)).sort((a, b) => b.createdAt - a.createdAt).slice(0, take)),
    },
  });
  const root: any = database(() => state);
  // Транзакция работает на копии: при ошибке внутри ничего не остаётся
  root.$transaction = async (fn: (db: any) => Promise<any>) => {
    const working = clone(state); const result = await fn(database(() => working)); state = working; return result;
  };
  return { prisma: root, state: () => state };
}

const USERS: Record<string, any> = {
  reader: { id: 'u-reader', role: 'ENGINEER_VENT', isActive: true, perms: [] },
  importer: { id: 'u-importer', role: 'ENGINEER_VENT', isActive: true, perms: ['catalog.import'] },
  editor: { id: 'u-editor', role: 'ENGINEER_VENT', isActive: true, perms: ['catalog.edit'] },
  stranger: { id: 'u-stranger', role: 'ENGINEER_VENT', isActive: true, perms: [] },
  kip: { id: 'u-kip', role: 'ENGINEER_AUTO', isActive: true, perms: ['e3.export'] },
};
const can = (u: any, p: string) => !!u?.perms?.includes(p);
const MEMBERS: Record<string, string[]> = { p1: ['u-reader', 'u-importer', 'u-editor', 'u-kip'] };

const R = (id: string, cls: string, name: string): unknown[] => [id, cls, 'Подкласс', 'К', name, `${name} описание`, '', '', '', '', '', '', ''];
const SHEET = [CLASSIFIER_HEADERS, R('08.01.01', 'Клапаны', 'Клапан_К24'), R('08.01.03', 'Клапаны', 'Клапан_К24_КП2'), R('11.01.01', 'Начало установки', 'Начало_1УР')];
const FILE = parseSolutionSheet(SHEET, { features: DEFAULT_FEATURES, dictionary: {} }).items;
// Лист «Таблица IO» той же формы, что у владельца: двухстрочная шапка, группа в первой строке блока
const IO_SHEET = [[], [], ['', 'Полевые приборы', 'Наименование', 'Обозначение', 'DI', 'DO', 'AI', 'AO'],
  ['', 'Датчики', 'Капиллярный термостат', 'TS', 1, '', '', ''], ['', 'Приводы', 'Клапан по воздуху пружинный, с бк', '', 2, 1, '', ''], ['', '', 'Клапан по воде', '', '', '', 1, 1]];
const IO_FILE = parseIoSheet(IO_SHEET).rows;

async function main() {
  const mock = mockPrisma(); setPrisma(mock.prisma);
  const app = express();
  registerE3SolutionRoutes(app as any, can, { ensure: async () => undefined, canUseProject: async (u, id) => (MEMBERS[id] || []).includes(u.id) });
  const call = async (method: string, path: string, body?: unknown, who?: string, params: Record<string, string> = {}) => {
    const layer = (app as any)._router.stack.find((l: any) => l.route?.path === path && l.route.methods[method.toLowerCase()]);
    assert.ok(layer, `маршрут зарегистрирован: ${method} ${path}`);
    const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(v: any) { this.body = v; return this; } };
    await layer.route.stack[0].handle({ body, authUser: who ? USERS[who] : undefined, params, query: {} }, res);
    return { status: res.statusCode, body: res.body };
  };
  const BASE = '/api/catalog/e3-solutions';
  let ok = 0;
  const check = (name: string, cond: unknown) => { assert.ok(cond, name); ok++; console.log(`✓ ${name}`); };
  const status = async (name: string, r: Promise<{ status: number; body: any }>, want: number) => {
    const got = await r; assert.equal(got.status, want, `${name}: ждали ${want}, пришло ${got.status} ${JSON.stringify(got.body)}`); ok++; console.log(`✓ ${name}`); return got.body;
  };

  await status('без входа — 401', call('GET', BASE), 401);
  const empty = await status('читать может любой вошедший', call('GET', BASE, undefined, 'reader'), 200);
  check('пустая книга: версия 0, стартовые признаки и связь типов на месте', empty.version === 0 && empty.solutions.length === 0 && empty.features.length === DEFAULT_FEATURES.length && empty.classMap.КЛАПАН[0] === 'Клапаны' && empty.rules.length > 0);

  await status('план без права загрузки — 403', call('POST', `${BASE}/plan`, { items: FILE }, 'reader'), 403);
  await status('загрузка без права — 403', call('POST', `${BASE}/apply`, { items: FILE, expectedVersion: 0, missing: 'keep' }, 'editor'), 403);
  const plan = await status('план — 200', call('POST', `${BASE}/plan`, { items: FILE, dictionary: { ПП: 'Прямой пуск' } }, 'importer'), 200);
  check('план: все новые, код словаря новый', plan.added.length === FILE.length && plan.changed.length === 0 && plan.dictionaryAdded[0] === 'ПП');
  check('план ничего не пишет', mock.state().settings.length === 0 && mock.state().revisions.length === 0);
  await status('не массив — 400', call('POST', `${BASE}/plan`, { items: 'x' }, 'importer'), 400);
  await status('больше 2000 — 400', call('POST', `${BASE}/plan`, { items: Array.from({ length: 2001 }, () => FILE[0]) }, 'importer'), 400);
  await status('негодный ID — 400', call('POST', `${BASE}/plan`, { items: [{ ...FILE[0], id: 'a b' }] }, 'importer'), 400);
  await status('негодный словарь — 400', call('POST', `${BASE}/plan`, { items: FILE, dictionary: [1] }, 'importer'), 400);
  await status('загрузка без версии — 400', call('POST', `${BASE}/apply`, { items: FILE, missing: 'keep' }, 'importer'), 400);
  await status('загрузка по чужой версии — 409', call('POST', `${BASE}/apply`, { items: FILE, expectedVersion: 7, missing: 'keep' }, 'importer'), 409);
  await status('«что делать с пропавшими» — одно из двух — 400', call('POST', `${BASE}/apply`, { items: FILE, expectedVersion: 0, missing: 'drop' }, 'importer'), 400);
  check('отклонённые запросы ничего не записали', mock.state().settings.length === 0 && mock.state().revisions.length === 0);

  const applied = await status('загрузка — 200', call('POST', `${BASE}/apply`, { items: FILE, dictionary: { ПП: 'Прямой пуск' }, expectedVersion: 0, missing: 'keep' }, 'importer'), 200);
  check('версия выросла, автор записан, словарь добавлен', applied.book.version === 1 && applied.book.updatedById === 'u-importer' && applied.book.solutions.length === 3 && applied.book.dictionary.ПП === 'Прямой пуск');
  check('снимок «до» — пустая книга с пометкой вида записи', mock.state().revisions.length === 1 && JSON.parse(mock.state().revisions[0].snapshotJson).solutions.length === 0 && mock.state().revisions[0].entity === 'e3solutions' && mock.state().revisions[0].action === 'import');
  check('признаки решений сохранены вместе с книгой', applied.book.solutions[1].features['valve.limit'] === 'КП2');

  // Правка решения
  const put = (patch: unknown, over: any = {}) => call('PUT', `${BASE}/solution`, { id: '08.01.01', patch, expectedVersion: 1, ...over }, 'editor');
  await status('правка без права — 403', call('PUT', `${BASE}/solution`, { id: '08.01.01', patch: { note: 'x' }, expectedVersion: 1 }, 'importer'), 403);
  await status('правка по чужой версии — 409', put({ note: 'x' }, { expectedVersion: 0 }), 409);
  await status('правка несуществующего — 404', put({ note: 'x' }, { id: 'нет' }), 404);
  await status('поле, которое менять нельзя, — 400', put({ id: 'x' }), 400);
  await status('пустая правка — 400', put({}), 400);
  await status('признаки не строкой — 400', put({ features: { a: 1 } }), 400);
  await status('пустое название — 400', put({ name: ' ' }), 400);
  check('отклонённые правки ничего не записали', mock.state().revisions.length === 1);
  const confirmed = await status('подтверждение признаков', put({ features: { 'valve.epv': 'да' }, featuresConfirmed: true }), 200);
  const s1 = confirmed.book.solutions.find((s: any) => s.id === '08.01.01');
  check('признаки правятся, файл их не трогает: «правлено» не ставится', s1.features['valve.epv'] === 'да' && s1.features['valve.drive'] === 'К' && s1.featuresConfirmed === true && s1.edited === undefined);
  const edit = await status('правка поля файла', call('PUT', `${BASE}/solution`, { id: '08.01.01', patch: { description: 'Моё описание' }, expectedVersion: 2 }, 'editor'), 200);
  check('правка поля файла помечает «правлено»', edit.book.solutions[0].edited === true && edit.book.solutions[0].description === 'Моё описание' && edit.book.version === 3);
  const off = await status('снять решение', call('PUT', `${BASE}/solution`, { id: '08.01.03', patch: { removed: true }, expectedVersion: 3 }, 'editor'), 200);
  check('снятое помечено, не удалено', off.book.solutions.find((s: any) => s.id === '08.01.03').removed === true && off.book.solutions.length === 3);
  const on = await status('вернуть решение', call('PUT', `${BASE}/solution`, { id: '08.01.03', patch: { removed: false }, expectedVersion: 4 }, 'editor'), 200);
  check('возвращённое без пометки', on.book.solutions.find((s: any) => s.id === '08.01.03').removed === undefined);

  // Добавление вручную
  const create = (patch: unknown, over: any = {}) => call('PUT', `${BASE}/solution`, { id: '99.99.01', create: true, patch, expectedVersion: 5, ...over }, 'editor');
  await status('добавление без названия — 400', create({ mainClass: 'Клапаны' }), 400);
  await status('добавление уже существующего ID — 409', create({ mainClass: 'Клапаны', name: 'Клапан_К24' }, { id: '08.01.01' }), 409);
  const made = await status('добавление вручную', create({ mainClass: 'Клапаны', name: 'Клапан_К230_КП2', short: 'К' }), 200);
  const m1 = made.book.solutions.find((s: any) => s.id === '99.99.01');
  check('новое решение: признаки из названия предложены, подтверждения нет у неоднозначного, помечено «правлено»', m1.features['valve.voltage'] === '230' && m1.features['valve.limit'] === 'КП2' && m1.edited === true && m1.featuresConfirmed === true);

  // Признаки, правила, словарь, связь типов
  const rev0 = mock.state().revisions.length;
  const feature = { ...DEFAULT_FEATURES[0], values: [...DEFAULT_FEATURES[0].values, 'КНОВ'] };
  await status('признак без права — 403', call('PUT', `${BASE}/feature`, { feature, expectedVersion: 6 }, 'importer'), 403);
  await status('негодный признак — 400', call('PUT', `${BASE}/feature`, { feature: { ...feature, kind: 'x' }, expectedVersion: 6 }, 'editor'), 400);
  await status('признак по чужой версии — 409', call('PUT', `${BASE}/feature`, { feature, expectedVersion: 1 }, 'editor'), 409);
  const f1 = await status('признак: новый вариант ответа', call('PUT', `${BASE}/feature`, { feature, expectedVersion: 6 }, 'editor'), 200);
  check('вариант ответа записан, число признаков прежнее', f1.book.features[0].values.includes('КНОВ') && f1.book.features.length === DEFAULT_FEATURES.length);
  const f2 = await status('признак: новый', call('PUT', `${BASE}/feature`, { feature: { id: 'valve.new', mainClass: 'Клапаны', title: 'Новый', values: ['а', 'б'], kind: 'ov', hint: '' }, expectedVersion: 7 }, 'editor'), 200);
  check('новый признак добавлен', f2.book.features.length === DEFAULT_FEATURES.length + 1);
  const f3 = await status('признак: удаление вместе с правилами', call('PUT', `${BASE}/feature`, { id: 'valve.voltage', delete: true, expectedVersion: 8 }, 'editor'), 200);
  check('признак и его правило удалены', !f3.book.features.some((f: any) => f.id === 'valve.voltage') && !f3.book.rules.some((r: any) => r.featureId === 'valve.voltage'));
  const rule = { mainClass: 'Клапаны', featureId: 'valve.drives', source: { kind: 'count', role: 'ПРИВОД' }, table: [{ when: '1', answer: '1' }] };
  await status('негодное правило — 400', call('PUT', `${BASE}/rule`, { rule: { ...rule, source: { kind: 'sql' } }, expectedVersion: 9 }, 'editor'), 400);
  const r1 = await status('правило: правка', call('PUT', `${BASE}/rule`, { rule: { ...rule, otherwise: '1' }, expectedVersion: 9 }, 'editor'), 200);
  check('правило заменено, а не продублировано', r1.book.rules.filter((r: any) => r.featureId === 'valve.drives').length === 1 && r1.book.rules.find((r: any) => r.featureId === 'valve.drives').otherwise === '1');
  const r2 = await status('правило: удаление', call('PUT', `${BASE}/rule`, { rule, delete: true, expectedVersion: 10 }, 'editor'), 200);
  check('правило удалено', !r2.book.rules.some((r: any) => r.featureId === 'valve.drives'));
  await status('словарь: негодный — 400', call('PUT', `${BASE}/dictionary`, { dictionary: [] }, 'editor'), 400);
  const d1 = await status('словарь', call('PUT', `${BASE}/dictionary`, { dictionary: { ПП: 'Прямой пуск', ЗТ: 'Звезда-треугольник' }, expectedVersion: 11 }, 'editor'), 200);
  check('словарь заменён', Object.keys(d1.book.dictionary).length === 2);
  await status('связь типов: неизвестный тип — 400', call('PUT', `${BASE}/classmap`, { classMap: { НЕТ: ['Клапаны'] }, expectedVersion: 12 }, 'editor'), 400);
  const c1 = await status('связь типов', call('PUT', `${BASE}/classmap`, { classMap: { КЛАПАН: ['Клапаны', 'Коробка'] }, expectedVersion: 12 }, 'editor'), 200);
  check('связь типов записана', c1.book.classMap.КЛАПАН.length === 2 && c1.book.version === 13);
  check('каждая настройка оставила снимок «до»', mock.state().revisions.length === rev0 + 7);

  // История и откат
  const revs = await status('история', call('GET', `${BASE}/revisions`, undefined, 'reader'), 200);
  check('история: новые сверху, с числом решений «до»', revs.length === 13 && revs[0].action === 'update' && typeof revs[0].count === 'number');
  const importId = revs.find((r: any) => r.action === 'import').id;
  await status('откат без права — 403', call('POST', `${BASE}/undo`, { revisionId: importId, expectedVersion: 13 }, 'editor'), 403);
  await status('откат по чужой версии — 409', call('POST', `${BASE}/undo`, { revisionId: importId, expectedVersion: 1 }, 'importer'), 409);
  await status('откат несуществующей записи — 404', call('POST', `${BASE}/undo`, { revisionId: 'нет', expectedVersion: 13 }, 'importer'), 404);
  const undone = await status('откат загрузки', call('POST', `${BASE}/undo`, { revisionId: importId, expectedVersion: 13 }, 'importer'), 200);
  check('откат вернул книгу «до» загрузки целиком (решения, признаки, правила)', undone.book.solutions.length === 0 && undone.book.features.length === DEFAULT_FEATURES.length && undone.book.rules.some((r: any) => r.featureId === 'valve.drives') && Object.keys(undone.book.dictionary).length === 0);
  check('версия растёт и при откате', undone.book.version === 14);
  const gone = mock.state().revisions.find((r: any) => r.action === 'restore');
  check('откат сам оставил снимок «до»', !!gone && JSON.parse(gone.snapshotJson).solutions.length === 4);

  // Таблица IO, правила состава, ручной состав, «Добавить недостающее»
  check('книга после отката: таблица IO пуста, стартовые правила состава на месте', undone.book.ioTable.length === 0 && undone.book.ioRules.length === DEFAULT_IO_RULES.length);
  const revBeforePlan = mock.state().revisions.length;
  const ioPlan = await status('план с таблицей IO', call('POST', `${BASE}/plan`, { items: [], ioTable: IO_FILE }, 'importer'), 200);
  check('план: три новые строки IO, ничего не записано', ioPlan.io.added === 3 && mock.state().revisions.length === revBeforePlan);
  await status('негодная строка IO в плане — 400', call('POST', `${BASE}/plan`, { items: [], ioTable: [{ ...IO_FILE[0], di: 1.5 }] }, 'importer'), 400);
  await status('больше 500 строк IO — 400', call('POST', `${BASE}/plan`, { items: [], ioTable: Array.from({ length: 501 }, () => IO_FILE[0]) }, 'importer'), 400);
  const revBeforeIo = mock.state().revisions.length;
  const ioApplied = await status('загрузка одной таблицы IO (без решений)', call('POST', `${BASE}/apply`, { items: [], ioTable: [{ ...IO_FILE[0], component: 'чужое', edited: true }, ...IO_FILE.slice(1)], expectedVersion: 14, missing: 'keep' }, 'importer'), 200);
  check('таблица IO записана, имя изделия и пометка из файла отброшены', ioApplied.book.ioTable.length === 3 && ioApplied.book.ioTable[0].component === undefined && ioApplied.book.ioTable[0].edited === undefined);
  check('загрузка оставила снимок «до» с видом «import»', mock.state().revisions.length === revBeforeIo + 1 && mock.state().revisions.at(-1).action === 'import');

  const rowOf = (name: string) => ioApplied.book.ioTable.find((r: any) => r.name === name);
  const springRow = rowOf('Клапан по воздуху пружинный, с бк');
  const putRow = (row: unknown, v: number, who = 'editor', over: any = {}) => call('PUT', `${BASE}/io-row`, { row, expectedVersion: v, ...over }, who);
  await status('правка строки IO без права — 403', putRow(springRow, 15, 'importer'), 403);
  await status('правка строки IO по чужой версии — 409', putRow(springRow, 3), 409);
  await status('негодная строка IO — 400', putRow({ ...springRow, ao: -1 }, 15), 400);
  await status('несуществующая строка IO — 404', putRow({ ...springRow, id: 'нет::такой' }, 15), 404);
  const named = await status('имя изделия E3 у строки', putRow({ ...springRow, component: 'клапан_DIx2_DOx1' }, 15), 200);
  const springNamed = named.book.ioTable.find((r: any) => r.id === springRow.id);
  check('имя изделия записано и не помечает строку правленой (его файл не ведёт)', springNamed.component === 'клапан_DIx2_DOx1' && springNamed.edited === undefined);
  const counted = await status('правка числа сигналов', putRow({ ...springNamed, do: 2 }, 16), 200);
  const springEdited = counted.book.ioTable.find((r: any) => r.id === springRow.id);
  check('число сигналов поправлено, строка помечена правленой, имя изделия на месте', springEdited.do === 2 && springEdited.edited === true && springEdited.component === 'клапан_DIx2_DOx1');
  const reload = await status('повторная загрузка того же файла', call('POST', `${BASE}/apply`, { items: [], ioTable: IO_FILE, expectedVersion: 17, missing: 'keep' }, 'importer'), 200);
  const springAfter = reload.book.ioTable.find((r: any) => r.id === springRow.id);
  check('файл не перезаписал ни правленое, ни имя изделия', springAfter.do === 2 && springAfter.component === 'клапан_DIx2_DOx1' && reload.book.ioTable.length === 3);
  await status('добавление строки IO: уже есть — 409', putRow(springRow, 18, 'editor', { create: true }), 409);
  const added = await status('добавление строки IO', putRow({ id: 'датчики::реле-давления', group: 'Датчики', name: 'Реле давления', code: 'PS', di: 1, do: 0, ai: 0, ao: 0, notes: { di: '', do: '', ai: '', ao: '' } }, 18, 'editor', { create: true }), 200);
  check('новая строка IO помечена правленой, порядок файла сохранён', added.book.ioTable.length === 4 && added.book.ioTable[3].edited === true && added.book.ioTable[0].id === IO_FILE[0].id);
  await status('удаление строки IO без права — 403', call('PUT', `${BASE}/io-row`, { id: 'датчики::реле-давления', delete: true, expectedVersion: 19 }, 'importer'), 403);
  await status('удаление несуществующей строки IO — 404', call('PUT', `${BASE}/io-row`, { id: 'нет', delete: true, expectedVersion: 19 }, 'editor'), 404);
  const dropped = await status('удаление строки IO', call('PUT', `${BASE}/io-row`, { id: 'датчики::реле-давления', delete: true, expectedVersion: 19 }, 'editor'), 200);
  check('строка IO удалена', dropped.book.ioTable.length === 3);

  const ioRule = clone(DEFAULT_IO_RULES[0]);
  await status('правило состава без права — 403', call('PUT', `${BASE}/io-rule`, { rule: ioRule, expectedVersion: 20 }, 'importer'), 403);
  await status('негодное правило состава — 400', call('PUT', `${BASE}/io-rule`, { rule: { ...ioRule, row: {} }, expectedVersion: 20 }, 'editor'), 400);
  await status('правило состава по чужой версии — 409', call('PUT', `${BASE}/io-rule`, { rule: ioRule, expectedVersion: 2 }, 'editor'), 409);
  await status('правило состава: ключ уже есть при добавлении — 409', call('PUT', `${BASE}/io-rule`, { rule: ioRule, create: true, expectedVersion: 20 }, 'editor'), 409);
  const ruled = await status('правило состава: правка', call('PUT', `${BASE}/io-rule`, { rule: { ...ioRule, role: 'Привод клапана' }, expectedVersion: 20 }, 'editor'), 200);
  check('правило заменено, а не продублировано', ruled.book.ioRules.length === DEFAULT_IO_RULES.length && ruled.book.ioRules[0].role === 'Привод клапана');
  const fresh = await status('правило состава: новое', call('PUT', `${BASE}/io-rule`, { rule: { ...ioRule, id: 'valve.custom', title: 'Своё' }, create: true, expectedVersion: 21 }, 'editor'), 200);
  check('новое правило добавлено', fresh.book.ioRules.length === DEFAULT_IO_RULES.length + 1);
  await status('удаление несуществующего правила состава — 404', call('PUT', `${BASE}/io-rule`, { id: 'нет', delete: true, expectedVersion: 22 }, 'editor'), 404);
  const gone2 = await status('правило состава: удаление', call('PUT', `${BASE}/io-rule`, { id: 'valve.custom', delete: true, expectedVersion: 22 }, 'editor'), 200);
  check('правило удалено', gone2.book.ioRules.length === DEFAULT_IO_RULES.length);

  // Ручной состав у решения
  const mk = await status('решение для ручного состава', call('PUT', `${BASE}/solution`, { id: '99.99.02', create: true, patch: { mainClass: 'Клапаны', name: 'Клапан_К24' }, expectedVersion: 23 }, 'editor'), 200);
  const line = { role: 'Привод', row: { name: 'пружинный' }, count: 2 };
  await status('ручной состав: негодная строка — 400', call('PUT', `${BASE}/solution`, { id: '99.99.02', patch: { recipeOverride: [{ ...line, count: 0 }] }, expectedVersion: mk.book.version }, 'editor'), 400);
  await status('ручной состав: не список — 400', call('PUT', `${BASE}/solution`, { id: '99.99.02', patch: { recipeOverride: 'x' }, expectedVersion: mk.book.version }, 'editor'), 400);
  const withLines = await status('ручной состав записан', call('PUT', `${BASE}/solution`, { id: '99.99.02', patch: { recipeOverride: [line] }, expectedVersion: mk.book.version }, 'editor'), 200);
  const sol2 = withLines.book.solutions.find((s: any) => s.id === '99.99.02');
  check('ручной состав у решения; поле не из файла — «правлено» не прибавилось', sol2.recipeOverride[0].count === 2 && sol2.edited === true);
  const viaFile = await status('файл ручной состав не приносит и не стирает', call('POST', `${BASE}/apply`, { items: [{ ...sol2, recipeOverride: [{ role: 'x', row: { name: 'y' }, count: 1 }] }], expectedVersion: withLines.book.version, missing: 'keep' }, 'importer'), 200);
  check('ручной состав из файла отброшен, прежний остался', viaFile.book.solutions.find((s: any) => s.id === '99.99.02').recipeOverride[0].role === 'Привод');
  const cleared = await status('ручной состав очищен пустым списком', call('PUT', `${BASE}/solution`, { id: '99.99.02', patch: { recipeOverride: [] }, expectedVersion: viaFile.book.version }, 'editor'), 200);
  check('пустой список не хранится', cleared.book.solutions.find((s: any) => s.id === '99.99.02').recipeOverride === undefined);

  // «Добавить недостающее»
  const noDefaults = await status('недостающего нет: план пуст', call('POST', `${BASE}/defaults/plan`, {}, 'editor'), 200);
  check('у свежей книги всё стартовое есть', noDefaults.features.length === 0 && noDefaults.rules.length === 0 && noDefaults.ioRules.length === 0 && noDefaults.classMap.length === 0);
  const trimmed = await status('убрать признак датчика и правило состава', call('PUT', `${BASE}/feature`, { id: 'sensor.temp', delete: true, expectedVersion: cleared.book.version }, 'editor'), 200);
  const trimmed2 = await status('убрать правило состава датчика', call('PUT', `${BASE}/io-rule`, { id: 'sensor.temp', delete: true, expectedVersion: trimmed.book.version }, 'editor'), 200);
  const own = await status('своё правило признака сохраняется', call('PUT', `${BASE}/rule`, { rule: { mainClass: 'Нагреватель', featureId: 'heater.stages', source: { kind: 'param', name: 'Моя характеристика' }, table: [{ when: '1', answer: '1' }] }, expectedVersion: trimmed2.book.version }, 'editor'), 200);
  await status('недостающее без права — 403', call('POST', `${BASE}/defaults/plan`, {}, 'reader'), 403);
  const dp = await status('недостающее: план', call('POST', `${BASE}/defaults/plan`, {}, 'editor'), 200);
  check('в плане признак и правило состава датчика; правленое правило нагревателя не трогается', dp.features.map((f: any) => f.id).join() === 'sensor.temp' && dp.ioRules.map((r: any) => r.id).join() === 'sensor.temp'
    && dp.rules.map((r: any) => r.featureId).join() === 'sensor.temp');
  const before2 = mock.state().revisions.length;
  await status('недостающее: запись по чужой версии — 409', call('POST', `${BASE}/defaults/apply`, { expectedVersion: 2 }, 'editor'), 409);
  await status('недостающее: запись без права — 403', call('POST', `${BASE}/defaults/apply`, { expectedVersion: own.book.version }, 'importer'), 403);
  check('план и отказы ничего не записали', mock.state().revisions.length === before2);
  const dw = await status('недостающее: запись', call('POST', `${BASE}/defaults/apply`, { expectedVersion: own.book.version }, 'editor'), 200);
  check('дописано недостающее, свои настройки на месте', dw.book.features.some((f: any) => f.id === 'sensor.temp') && dw.book.ioRules.some((r: any) => r.id === 'sensor.temp')
    && dw.book.rules.find((r: any) => r.featureId === 'heater.stages').source.name === 'Моя характеристика' && mock.state().revisions.length === before2 + 1);
  const again = await status('недостающее: повторный план пуст', call('POST', `${BASE}/defaults/plan`, {}, 'editor'), 200);
  check('повтор ничего не находит', again.features.length === 0 && again.ioRules.length === 0);
  // Профиль проекта
  const PROFILE = '/api/projects/:projectId/e3-profile';
  await status('профиль без входа — 401', call('GET', PROFILE, undefined, undefined, { projectId: 'p1' }), 401);
  await status('профиль чужого проекта — 403', call('GET', PROFILE, undefined, 'stranger', { projectId: 'p1' }), 403);
  const p0 = await status('профиль: пустой', call('GET', PROFILE, undefined, 'reader', { projectId: 'p1' }), 200);
  check('пустой профиль: версия 0', p0.version === 0 && Object.keys(p0.answers).length === 0);
  const answers = { 'fan.start': { source: { kind: 'child-param', role: 'ДВИГАТЕЛЬ', name: 'Мощность', unit: 'кВт' }, steps: [{ upTo: 7.5, answer: 'ПП' }], above: 'ПЧИ' }, 'valve.limit': 'КП2' };
  await status('запись профиля чужим — 403', call('PUT', PROFILE, { answers, expectedVersion: 0 }, 'stranger', { projectId: 'p1' }), 403);
  await status('негодный профиль — 400', call('PUT', PROFILE, { answers: { a: { source: { kind: 'sql' }, steps: [], above: '' } }, expectedVersion: 0 }, 'kip', { projectId: 'p1' }), 400);
  await status('профиль без права e3.export — 403, хотя участник проекта', call('PUT', PROFILE, { answers, expectedVersion: 0 }, 'reader', { projectId: 'p1' }), 403);
  await status('права каталога профиль не открывают — 403', call('PUT', PROFILE, { answers, expectedVersion: 0 }, 'editor', { projectId: 'p1' }), 403);
  await status('профиль по чужой версии — 409', call('PUT', PROFILE, { answers, expectedVersion: 3 }, 'kip', { projectId: 'p1' }), 409);
  const pw = await status('профиль: запись инженером КИП', call('PUT', PROFILE, { answers, expectedVersion: 0 }, 'kip', { projectId: 'p1' }), 200);
  check('профиль записан с порогом, версия 1, автор', pw.version === 1 && pw.answers['fan.start'].steps[0].upTo === 7.5 && pw.updatedById === 'u-kip');
  const pr = await status('профиль читается', call('GET', PROFILE, undefined, 'editor', { projectId: 'p1' }), 200);
  check('другой участник видит тот же профиль', pr.answers['valve.limit'] === 'КП2');
  await status('профиль: повторная запись по старой версии — 409', call('PUT', PROFILE, { answers, expectedVersion: 0 }, 'kip', { projectId: 'p1' }), 409);

  // Раскладка схемы за проектом
  const LAYOUT = '/api/projects/:projectId/e3-layout';
  const l0 = await status('раскладка: пустая', call('GET', LAYOUT, undefined, 'reader', { projectId: 'p1' }), 200);
  check('пустая раскладка: версия 0', l0.version === 0 && Object.keys(l0.placed).length === 0);
  const layout = { format: 'А3', placed: { a: { rect: { x: 60, y: 30, w: 40, h: 30 }, manual: true } }, off: { b: true } };
  await status('раскладка без входа — 401', call('GET', LAYOUT, undefined, undefined, { projectId: 'p1' }), 401);
  await status('раскладка чужого проекта — 403', call('GET', LAYOUT, undefined, 'stranger', { projectId: 'p1' }), 403);
  await status('запись раскладки без права e3.export — 403', call('PUT', LAYOUT, { ...layout, expectedVersion: 0 }, 'reader', { projectId: 'p1' }), 403);
  await status('негодное положение блока — 400', call('PUT', LAYOUT, { ...layout, placed: { a: { rect: { x: 'x' }, manual: true } }, expectedVersion: 0 }, 'kip', { projectId: 'p1' }), 400);
  await status('раскладка по чужой версии — 409', call('PUT', LAYOUT, { ...layout, expectedVersion: 5 }, 'kip', { projectId: 'p1' }), 409);
  const lw = await status('раскладка: запись инженером КИП', call('PUT', LAYOUT, { ...layout, expectedVersion: 0 }, 'kip', { projectId: 'p1' }), 200);
  check('раскладка записана: версия 1, положение и флажки на месте', lw.version === 1 && lw.placed.a.rect.x === 60 && lw.off.b === true && lw.format === 'А3');
  const lr = await status('раскладку видит любой участник', call('GET', LAYOUT, undefined, 'editor', { projectId: 'p1' }), 200);
  check('участник читает ту же раскладку', lr.placed.a.manual === true);
  await status('повторная запись по старой версии — 409', call('PUT', LAYOUT, { ...layout, expectedVersion: 0 }, 'kip', { projectId: 'p1' }), 409);
  check('профиль не записывается в снимки каталога', mock.state().revisions.every((r: any) => r.entity === 'e3solutions'));

  const server = readFileSync('server.ts', 'utf8');
  check('server.ts подключает каталог решений раньше каталога', server.indexOf('registerE3SolutionRoutes(app') > 0 && server.indexOf('registerE3SolutionRoutes(app') < server.indexOf('registerCatalogRoutes(app'));
  console.log(`\nВсе проверки маршрутов каталога типовых решений E3 пройдены (${ok})`);
}
main().catch((e) => { console.error('✗', e?.message || e); process.exit(1); });
