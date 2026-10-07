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
import { parseSolutionSheet, DEFAULT_FEATURES } from '../e3/solutions';
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
};
const can = (u: any, p: string) => !!u?.perms?.includes(p);
const MEMBERS: Record<string, string[]> = { p1: ['u-reader', 'u-importer', 'u-editor'] };

const R = (id: string, cls: string, name: string): unknown[] => [id, cls, 'Подкласс', 'К', name, `${name} описание`, '', '', '', '', '', '', ''];
const SHEET = [CLASSIFIER_HEADERS, R('08.01.01', 'Клапаны', 'Клапан_К24'), R('08.01.03', 'Клапаны', 'Клапан_К24_КП2'), R('11.01.01', 'Начало установки', 'Начало_1УР')];
const FILE = parseSolutionSheet(SHEET, { features: DEFAULT_FEATURES, dictionary: {} }).items;

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

  // Профиль проекта
  const PROFILE = '/api/projects/:projectId/e3-profile';
  await status('профиль без входа — 401', call('GET', PROFILE, undefined, undefined, { projectId: 'p1' }), 401);
  await status('профиль чужого проекта — 403', call('GET', PROFILE, undefined, 'stranger', { projectId: 'p1' }), 403);
  const p0 = await status('профиль: пустой', call('GET', PROFILE, undefined, 'reader', { projectId: 'p1' }), 200);
  check('пустой профиль: версия 0', p0.version === 0 && Object.keys(p0.answers).length === 0);
  const answers = { 'fan.start': { source: { kind: 'child-param', role: 'ДВИГАТЕЛЬ', name: 'Мощность', unit: 'кВт' }, steps: [{ upTo: 7.5, answer: 'ПП' }], above: 'ПЧИ' }, 'valve.limit': 'КП2' };
  await status('запись профиля чужим — 403', call('PUT', PROFILE, { answers, expectedVersion: 0 }, 'stranger', { projectId: 'p1' }), 403);
  await status('негодный профиль — 400', call('PUT', PROFILE, { answers: { a: { source: { kind: 'sql' }, steps: [], above: '' } }, expectedVersion: 0 }, 'reader', { projectId: 'p1' }), 400);
  await status('профиль по чужой версии — 409', call('PUT', PROFILE, { answers, expectedVersion: 3 }, 'reader', { projectId: 'p1' }), 409);
  const pw = await status('профиль: запись участником проекта', call('PUT', PROFILE, { answers, expectedVersion: 0 }, 'reader', { projectId: 'p1' }), 200);
  check('профиль записан с порогом, версия 1, автор', pw.version === 1 && pw.answers['fan.start'].steps[0].upTo === 7.5 && pw.updatedById === 'u-reader');
  const pr = await status('профиль читается', call('GET', PROFILE, undefined, 'editor', { projectId: 'p1' }), 200);
  check('другой участник видит тот же профиль', pr.answers['valve.limit'] === 'КП2');
  await status('профиль: повторная запись по старой версии — 409', call('PUT', PROFILE, { answers, expectedVersion: 0 }, 'editor', { projectId: 'p1' }), 409);
  check('профиль не записывается в снимки каталога', mock.state().revisions.every((r: any) => r.entity === 'e3solutions'));

  const server = readFileSync('server.ts', 'utf8');
  check('server.ts подключает каталог решений раньше каталога', server.indexOf('registerE3SolutionRoutes(app') > 0 && server.indexOf('registerE3SolutionRoutes(app') < server.indexOf('registerCatalogRoutes(app'));
  console.log(`\nВсе проверки маршрутов каталога типовых решений E3 пройдены (${ok})`);
}
main().catch((e) => { console.error('✗', e?.message || e); process.exit(1); });
