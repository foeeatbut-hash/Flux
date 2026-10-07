/**
 * Маршруты справочника атрибутов E3: права, версии, снимки «до», откат.
 *
 * Базы нет — подставлена память с теми же вызовами Prisma, что делает
 * маршрут (по образцу test-catalog-spreadsheet-routes). Проверяется то, что
 * держит маршрут сам: кто что может, чужая версия не перезаписывается,
 * каждая запись оставляет снимок «до», откат возвращает книгу, план ничего
 * не пишет.
 *
 * Запуск: npx tsx scripts/test-e3-attributes-http.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { registerE3AttributeRoutes } from '../server/routes/e3Attributes';
import { catalogSettingRaw, claimCatalogSetting } from '../server/catalogWorkspace';
import { setPrisma } from '../server/context';
import { parseAttributeSheet } from '../e3/attributes';

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
};
const can = (u: any, p: string) => !!u?.perms?.includes(p);

const H = (name: string, cls: string, yes = 'Да', service = ''): unknown[] => [yes, name, `${name} описание`, 'Изделие', cls, service, '', '', null, '', ''];
const SHEET = [
  [null, 'Наименование атрибута E3', 'Описание атрибута Е3', 'Носитель артрибута Е3', 'Основной класс', 'Служебный атрибут (не менять!)', 'Скрипт', 'Комментарий'],
  H('GLOBAL_TAG_UNIT', 'Общий', 'Да', 'ДА'), H('MOTOR_POWER', 'Двигатели'), H('CBL_DESC', 'Кабель', ''),
];
const { items: FILE } = parseAttributeSheet(SHEET);

async function main() {
  const mock = mockPrisma(); setPrisma(mock.prisma);
  const app = express();
  registerE3AttributeRoutes(app as any, can, { ensure: async () => undefined });
  const call = async (method: string, path: string, body?: unknown, who?: string) => {
    const layer = (app as any)._router.stack.find((l: any) => l.route?.path === path && l.route.methods[method.toLowerCase()]);
    assert.ok(layer, `маршрут зарегистрирован: ${method} ${path}`);
    const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(v: any) { this.body = v; return this; } };
    await layer.route.stack[0].handle({ body, authUser: who ? USERS[who] : undefined, params: {}, query: {} }, res);
    return { status: res.statusCode, body: res.body };
  };
  const BASE = '/api/catalog/e3-attributes';
  let ok = 0;
  const check = (name: string, cond: unknown) => { assert.ok(cond, name); ok++; console.log(`✓ ${name}`); };
  const status = async (name: string, r: Promise<{ status: number; body: any }>, want: number) => {
    const got = await r; assert.equal(got.status, want, `${name}: ждали ${want}, пришло ${got.status} ${JSON.stringify(got.body)}`); ok++; console.log(`✓ ${name}`); return got.body;
  };

  await status('без входа — 401', call('GET', BASE), 401);
  const empty = await status('читать может любой вошедший', call('GET', BASE, undefined, 'reader'), 200);
  check('пустая книга: версия 0', empty.version === 0 && empty.items.length === 0);

  await status('план без права загрузки — 403', call('POST', `${BASE}/plan`, { items: FILE }, 'reader'), 403);
  await status('загрузка без права — 403', call('POST', `${BASE}/apply`, { items: FILE, expectedVersion: 0, missing: 'keep' }, 'editor'), 403);
  const plan = await status('план — 200', call('POST', `${BASE}/plan`, { items: FILE }, 'importer'), 200);
  check('план: все новые', plan.added.length === FILE.length && plan.changed.length === 0);
  check('план ничего не пишет', mock.state().settings.length === 0 && mock.state().revisions.length === 0);

  await status('не массив — 400', call('POST', `${BASE}/plan`, { items: 'x' }, 'importer'), 400);
  await status('больше 2000 — 400', call('POST', `${BASE}/plan`, { items: Array.from({ length: 2001 }, () => FILE[0]) }, 'importer'), 400);
  await status('строка длиннее 500 — 400', call('POST', `${BASE}/plan`, { items: [{ ...FILE[0], comment: 'я'.repeat(501) }] }, 'importer'), 400);
  await status('негодный источник — 400', call('POST', `${BASE}/plan`, { items: [{ ...FILE[0], source: { kind: 'sql' } }] }, 'importer'), 400);

  await status('загрузка без версии — 400', call('POST', `${BASE}/apply`, { items: FILE, missing: 'keep' }, 'importer'), 400);
  await status('загрузка по чужой версии — 409', call('POST', `${BASE}/apply`, { items: FILE, expectedVersion: 7, missing: 'keep' }, 'importer'), 409);
  await status('«что делать с пропавшими» — одно из двух — 400', call('POST', `${BASE}/apply`, { items: FILE, expectedVersion: 0, missing: 'drop' }, 'importer'), 400);
  check('отклонённые запросы ничего не записали', mock.state().settings.length === 0 && mock.state().revisions.length === 0);

  const applied = await status('загрузка — 200', call('POST', `${BASE}/apply`, { items: FILE, expectedVersion: 0, missing: 'keep' }, 'importer'), 200);
  check('версия выросла, автор записан', applied.book.version === 1 && applied.book.updatedById === 'u-importer' && applied.book.items.length === FILE.length);
  check('вернулся номер снимка «до»', typeof applied.revisionId === 'string' && mock.state().revisions.length === 1);
  check('снимок «до» — пустая книга', JSON.parse(mock.state().revisions[0].snapshotJson).items.length === 0 && mock.state().revisions[0].action === 'import');
  check('снимок помечен видом записи', mock.state().revisions[0].entity === 'e3attributes' && mock.state().revisions[0].entityId === 'book');
  check('читается из хранилища', (await call('GET', BASE, undefined, 'reader')).body.version === 1);

  // Правка одного атрибута
  const item = (patch: unknown, over: any = {}) => call('PUT', `${BASE}/item`, { name: 'MOTOR_POWER', patch, expectedVersion: 1, ...over }, 'editor');
  await status('правка без права — 403', call('PUT', `${BASE}/item`, { name: 'MOTOR_POWER', patch: { fromFlux: false }, expectedVersion: 1 }, 'importer'), 403);
  await status('правка по чужой версии — 409', item({ fromFlux: false }, { expectedVersion: 0 }), 409);
  await status('правка несуществующего — 404', item({ fromFlux: false }, { name: 'NOPE' }), 404);
  await status('поле, которое менять нельзя, — 400', item({ carrier: 'Лист' }), 400);
  await status('пустая правка — 400', item({}), 400);
  await status('негодный источник в правке — 400', item({ source: { kind: 'field', key: 'password' } }), 400);
  await status('негодный тип в правке — 400', item({ classes: ['НЕТ'] }), 400);
  await status('негодное правило спора — 400', item({ conflict: 'всегда' }), 400);
  check('отклонённые правки ничего не записали', mock.state().revisions.length === 1);
  const edited = await status('правка — 200', item({ source: { kind: 'param', name: 'Мощность', unit: 'кВт' }, classes: ['ДВИГАТЕЛЬ'], conflict: 'flux-once', title: 'Мощность двигателя' }), 200);
  const motor = edited.book.items.find((a: any) => a.name === 'MOTOR_POWER');
  check('правка записана и помечена', motor.edited === true && motor.title === 'Мощность двигателя' && motor.source.unit === 'кВт' && motor.conflict === 'flux-once' && motor.classes[0] === 'ДВИГАТЕЛЬ');
  check('версия 2, соседние атрибуты не тронуты', edited.book.version === 2 && !edited.book.items.find((a: any) => a.name === 'GLOBAL_TAG_UNIT').edited);
  check('у правки свой снимок «до»', mock.state().revisions.length === 2 && mock.state().revisions[1].action === 'update'
    && !JSON.parse(mock.state().revisions[1].snapshotJson).items.find((a: any) => a.name === 'MOTOR_POWER').edited);

  // Повторная загрузка: правленое файл не перезаписывает, пропавшее снимается по выбору
  const changed = FILE.filter((a) => a.name !== 'CBL_DESC').map((a) => (a.name === 'MOTOR_POWER' ? { ...a, title: 'Из файла' } : a));
  const plan2 = await status('план повторной загрузки', call('POST', `${BASE}/plan`, { items: changed }, 'importer'), 200);
  check('план: правленое оставлено, пропавшее названо', plan2.editedKept[0] === 'MOTOR_POWER' && plan2.missing[0] === 'CBL_DESC' && plan2.changed.length === 0);
  const second = await status('повторная загрузка, пропавшие снять', call('POST', `${BASE}/apply`, { items: changed, expectedVersion: 2, missing: 'remove' }, 'importer'), 200);
  check('правленая подпись жива', second.book.items.find((a: any) => a.name === 'MOTOR_POWER').title === 'Мощность двигателя');
  check('пропавший снят, но не удалён', second.book.items.find((a: any) => a.name === 'CBL_DESC').removed === true && second.book.items.length === FILE.length);
  const forged = await call('POST', `${BASE}/apply`, { items: [{ ...FILE[0], name: 'FORGED', removed: true, edited: true }], expectedVersion: 3, missing: 'keep' }, 'importer');
  check('пометки «правлено» и «снят» из входных данных не принимаются', forged.body.book.items.find((a: any) => a.name === 'FORGED').removed === undefined);

  // История и откат
  const revs = await status('история', call('GET', `${BASE}/revisions`, undefined, 'reader'), 200);
  check('история: новые сверху, с числом записей «до»', revs.length === 4 && revs[0].action === 'import' && revs[1].count === FILE.length && revs[3].count === 0);
  check('история: автор и время', revs[0].userId === 'u-importer' && revs[0].createdAt);
  const updateRev = revs.find((r: any) => r.action === 'update');
  await status('откат без права — 403', call('POST', `${BASE}/undo`, { revisionId: updateRev.id, expectedVersion: 4 }, 'editor'), 403);
  await status('откат по чужой версии — 409', call('POST', `${BASE}/undo`, { revisionId: updateRev.id, expectedVersion: 1 }, 'importer'), 409);
  await status('откат несуществующей записи — 404', call('POST', `${BASE}/undo`, { revisionId: 'нет', expectedVersion: 4 }, 'importer'), 404);
  const undone = await status('откат', call('POST', `${BASE}/undo`, { revisionId: updateRev.id, expectedVersion: 4 }, 'importer'), 200);
  const motorBack = undone.book.items.find((a: any) => a.name === 'MOTOR_POWER');
  check('откат вернул книгу «до» правки', motorBack.edited === undefined && motorBack.title === 'MOTOR_POWER описание' && undone.book.items.find((a: any) => a.name === 'CBL_DESC').removed === undefined);
  check('версия растёт и при откате', undone.book.version === 5);
  const after = (await call('GET', `${BASE}/revisions`, undefined, 'reader')).body;
  check('откат сам оставил снимок, его тоже можно откатить', after[0].action === 'restore' && after.length === 5);

  // Заявка по старому значению: запись по устаревшему чтению не проходит
  const raw = await catalogSettingRaw(mock.prisma, 'e3_attributes');
  await claimCatalogSetting(mock.prisma, 'e3_attributes', raw, { version: 99, items: [], updatedAt: '' }, 'конфликт');
  await assert.rejects(claimCatalogSetting(mock.prisma, 'e3_attributes', raw, { version: 100, items: [], updatedAt: '' }, 'конфликт'), (e: any) => e.status === 409 && e.message === 'конфликт');
  ok++; console.log('✓ запись по устаревшему чтению отклонена (409)');
  await assert.rejects(claimCatalogSetting(mock.prisma, 'e3_attributes', null, { version: 1, items: [], updatedAt: '' }, 'конфликт'), (e: any) => e.status === 409);
  ok++; console.log('✓ первая запись при уже существующей настройке отклонена (409)');
  await status('после чужой записи экран получает 409', call('POST', `${BASE}/apply`, { items: FILE, expectedVersion: 5, missing: 'keep' }, 'importer'), 409);

  // Маршруты должны стоять раньше каталога: его PUT /api/catalog/:entity/:id перехватил бы /item
  const server = readFileSync('server.ts', 'utf8');
  check('server.ts подключает справочник раньше каталога', server.indexOf('registerE3AttributeRoutes(app') > 0 && server.indexOf('registerE3AttributeRoutes(app') < server.indexOf('registerCatalogRoutes(app'));
  console.log(`\nВсе проверки маршрутов справочника атрибутов E3 пройдены (${ok})`);
}
main().catch((e) => { console.error('✗', e?.message || e); process.exit(1); });
