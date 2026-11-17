/**
 * Импорт и отмена оборудования по предпросмотру: сверка версий позиций
 * (.claude/progress/bulk-plan-guard.md, строка Q; docs/roadmap/offline-work.md,
 * решения владельца 15 ноября 2026, п. 3 и п. 7).
 *
 * Настоящая SQLite-база (schema.prisma), настоящие обработчики маршрутов, клиент
 * базы как на сервере: журнал изменений + рост версии (`withChangeFeed(withVersionBump)`).
 * Что доказывается:
 *  • предпросмотр (`import-plan`, `import-draft-plan`) несёт `seen` — версии позиций, которые он
 *    читал и собирается менять, заменять, снимать, — и `seenRows` — показанные поля;
 *  • запись (`import-draft`, в том числе с привязкой источника, и `import-to-category`) по
 *    устаревшему предпросмотру — 409 `VERSION_CONFLICT`, перечень `changed` / `gone`, а в базе НЕ
 *    изменилось ничего (в том числе позиция, стоящая в порядке записи раньше изменённой);
 *  • идентификатор позиции чужого проекта считается отсутствующим, содержимое в отказ не попадает;
 *  • запрос без `seen` (старый клиент) принимается; нечитаемый `seen` — 400 и пустая запись;
 *  • план отмены (`GET import-undo/:batch`) несёт `seen`; применение сверяет его в транзакции:
 *    изменили, удалили, а также позиция, которой человек не видел (раньше пропускалась), — 409, ничего не записано;
 *  • решения по XML-ревизии (`candidates/:id/decisions`) сверяют `seen` (версии позиций кандидата):
 *    до записи и ещё раз в самой транзакции (гонка), отказ — структурный, без записи;
 *  • версия ни одной позиции ни на одном шаге не уменьшилась (в том числе при откате XML-ревизии).
 *
 * Мутации, которыми набор проверен (каждая роняет его; прогон — scripts/mutate-plan-guard.sh в каталоге
 * проверки, не коммитится): убрать сверку в import-to-category; убрать её в import-draft; убрать в import-draft
 * с привязкой источника; писать до сверки (сверка после записи вне транзакции); не класть в план позиции
 * «будет снято»; убрать сверку в import-undo; не требовать «позиция, которой человек не видел»; не ограничивать
 * позиции проектом; убрать сверку в decisions до записи; убрать её в транзакции decisions;
 * откат XML-ревизии ставит версию назад; нечитаемый `seen` принимать как «версий нет».
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setBroadcaster, setPrisma } from '../server/context.js';
import { withVersionBump } from '../server/versionBump.js';
import { prepareChangeFeed, withChangeFeed } from '../server/changeFeed.js';
import { registerEquipmentCoreRoutes } from '../server/routes/equipmentCore.js';
import { registerEquipmentDraftRoutes } from '../server/routes/equipmentDraft.js';
import { registerEquipmentUndoRoutes } from '../server/routes/equipmentUndo.js';
import { registerEquipmentXmlSourceRoutes } from '../server/routes/equipmentXmlSources.js';
import { bulkChangedText, undoChangedText, VERSION_CONFLICT } from '../src/lib/refusalTexts.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-equipment-plan-guard-'));
const dbPath = path.join(root, 'fixture.sqlite');
const raw = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 900)}`}`);
  checks++;
  console.log(`✓ ${label}`);
};

// ── Вызов обработчиков без сети: те же функции, что регистрирует сервер ──
const routes = new Map<string, Function>();
const app: any = {
  get: (p: string, f: Function) => routes.set(`GET ${p}`, f), post: (p: string, f: Function) => routes.set(`POST ${p}`, f),
  put: (p: string, f: Function) => routes.set(`PUT ${p}`, f), delete: (p: string, f: Function) => routes.set(`DELETE ${p}`, f),
};
const ADMIN = { id: 'u-admin', name: 'Инженер', role: 'ADMIN', isActive: true };
async function call(method: string, route: string, body: any = {}, params: Record<string, string> = {}) {
  const handler = routes.get(`${method} ${route}`);
  assert.ok(handler, `нет маршрута ${method} ${route}`);
  const result: any = { status: 200, body: null };
  const res: any = { status(code: number) { result.status = code; return this; }, json(value: any) { result.body = value; return this; } };
  await handler({ params, body, query: {}, authUser: ADMIN, headers: {} } as any, res);
  return result;
}

// ── Данные ──
const PROJECT = 'P1';
const draftBlock = (name: string, value: string, equipType = 'ПРОЧЕЕ') => ({
  name, title: name, equipType, groups: [{ title: 'Параметры', params: [{ key: 'Расход', value, unit: 'м³/ч' }] }],
});
const draftUnits = (fan: string, vlv?: string, unit = 'AHU-1') => [{
  name: unit, title: unit, groups: [],
  monoblocks: [{ name: 'M1', title: '', blocks: [draftBlock('FAN-1', fan, 'ВЕНТИЛЯТОР'), ...(vlv === undefined ? [] : [draftBlock('VLV-1', vlv, 'КЛАПАН')])] }],
}];
const xmlOf = (fan: string, vlv?: string) => `<project><system name="SYS-1"><monoblock name="M1"><block name="FAN-1"><group title="Параметры"><param name="Давление" unit="Па">${fan}</param></group></block>${vlv === undefined ? '' : `<block name="VLV-1"><group title="Параметры"><param name="Давление" unit="Па">${vlv}</param></group></block>`}</monoblock></system></project>`;
const draftBody = (extra: Record<string, unknown> = {}) => ({ category: 'AHU', projectId: PROJECT, fileName: 'расчёт.pdf', ...extra });

let db: any;
const elementByCode = async (code: string, systemName = 'AHU-1') => {
  const system = await raw.equipmentSystem.findFirst({ where: { projectId: PROJECT, name: systemName } });
  const mono = system && await raw.monoblock.findFirst({ where: { systemId: system.id, name: 'M1' } });
  return mono ? raw.componentElement.findFirst({ where: { monoblockId: mono.id, itemCode: code } }) : null;
};
/** Всё, что импорт и отмена могут затронуть: сравнение «до и после» ловит любую запись, в том числе лишнюю. */
async function world() {
  return {
    systems: await raw.equipmentSystem.findMany({ orderBy: { id: 'asc' } }),
    monoblocks: await raw.monoblock.findMany({ orderBy: { id: 'asc' } }),
    components: await raw.componentElement.findMany({ orderBy: { id: 'asc' }, include: { tags: { select: { id: true }, orderBy: { id: 'asc' } } } }),
    tags: await raw.tag.findMany({ orderBy: { id: 'asc' } }),
    history: await raw.equipmentHistory.findMany({ orderBy: { id: 'asc' } }),
    candidates: await raw.equipmentXmlCandidate.findMany({ orderBy: { id: 'asc' } }),
    applications: await raw.equipmentXmlApplication.findMany({ orderBy: { id: 'asc' } }),
    sources: await raw.equipmentXmlSource.findMany({ orderBy: { id: 'asc' } }),
  };
}
const sameWorld = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Версия ни одной позиции не уменьшилась: сторож вызывается после каждого шага. */
let versionsSeen = new Map<string, number>();
async function watchVersions(step: string) {
  const now = await raw.componentElement.findMany({ select: { id: true, version: true } });
  for (const row of now) {
    const was = versionsSeen.get(row.id);
    if (was !== undefined) assert.ok(row.version >= was, `версия позиции ${row.id} уменьшилась на шаге «${step}»: ${was} → ${row.version}`);
    versionsSeen.set(row.id, row.version);
  }
  checks++;
}

/** Коллега правит позицию: клиент базы с ростом версии, как на сервере. */
const colleagueEdits = (id: string, value: string) => db.componentElement.update({
  where: { id }, data: { specs: JSON.stringify({ groups: [{ title: 'Параметры', params: [{ key: 'Расход', value, unit: 'м³/ч' }] }] }) },
});

async function main() {
  const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  await bootstrapLocalDatabase(dbPath, raw, schema, () => {});
  db = withChangeFeed(raw, (c: any) => withVersionBump(c));
  await prepareChangeFeed(db);
  setPrisma(db);
  setBroadcaster(() => {});
  registerEquipmentCoreRoutes(app);
  registerEquipmentDraftRoutes(app);
  registerEquipmentUndoRoutes(app);
  registerEquipmentXmlSourceRoutes(app);
  await raw.project.create({ data: { id: PROJECT, name: 'Проект Один' } });
  await raw.project.create({ data: { id: 'P2', name: 'Проект Два' } });
  await raw.projectMember.create({ data: { projectId: PROJECT, userId: ADMIN.id } }).catch(() => null);

  // ── 1. Первый ввоз: позиций ещё нет, `seen` пуст, запись без него идёт (старый клиент) ──
  const firstPlan = await call('POST', '/api/equipment/import-draft-plan', draftBody({ units: draftUnits('100', '10') }));
  check('первый предпросмотр: позиций в базе нет, `seen` пуст', firstPlan.status === 200 && Object.keys(firstPlan.body.plan.seen).length === 0
    && Object.keys(firstPlan.body.plan.seenRows).length === 0, firstPlan.body);
  const first = await call('POST', '/api/equipment/import-draft', draftBody({ units: draftUnits('100', '10') }));
  check('запись без `seen` (старый клиент) принимается', first.status === 200 && first.body.newBlocks >= 2, first.body);
  const fan = await elementByCode('FAN-1');
  const vlv = await elementByCode('VLV-1');
  check('позиции заведены', !!fan && !!vlv);
  await watchVersions('первый ввоз');

  // ── 2. План несёт версии и показанные поля ──
  const plan2 = await call('POST', '/api/equipment/import-draft-plan', draftBody({ units: draftUnits('200', '20') }));
  const p2 = plan2.body.plan;
  check('план: `seen` — версии позиций, которые он читал', p2.seen[fan.id] === fan.version && p2.seen[vlv.id] === vlv.version
    && Object.keys(p2.seen).filter((id) => id === fan.id || id === vlv.id).length === 2, p2.seen);
  check('план: `seenRows` — показанные поля позиции как при чтении', p2.seenRows[fan.id]?.specs === fan.specs && p2.seenRows[fan.id]?.name === fan.name
    && p2.seenRows[fan.id]?.itemCode === 'FAN-1', p2.seenRows[fan.id]);
  const before2 = await world();

  // ── 3. Устаревший предпросмотр: изменена ПЕРВАЯ по порядку записи позиция ──
  await colleagueEdits(fan.id, '150');
  await watchVersions('коллега правит FAN-1');
  const afterEdit = await world();
  const stale1 = await call('POST', '/api/equipment/import-draft', draftBody({ units: draftUnits('200', '20'), seen: p2.seen }));
  check('изменена позиция: 409 `VERSION_CONFLICT`, текст словаря, перечень `changed`', stale1.status === 409 && stale1.body.code === VERSION_CONFLICT
    && stale1.body.error === bulkChangedText() && stale1.body.changed?.length === 1 && stale1.body.changed[0].id === fan.id
    && Array.isArray(stale1.body.gone) && stale1.body.gone.length === 0, stale1.body);
  check('в отказе — запись, какой она стала (версия и характеристики)', stale1.body.changed[0].current.version === fan.version + 1
    && JSON.parse(stale1.body.changed[0].current.specs).groups[0].params[0].value === '150');
  check('по устаревшему предпросмотру в базе не изменилось ничего', sameWorld(afterEdit, await world()));

  // ── 4. Изменена ВТОРАЯ позиция: первая (FAN-1) уже не должна быть записана ──
  const plan3 = await call('POST', '/api/equipment/import-draft-plan', draftBody({ units: draftUnits('200', '20') }));
  await colleagueEdits(vlv.id, '30');
  const afterEdit2 = await world();
  const stale2 = await call('POST', '/api/equipment/import-draft', draftBody({ units: draftUnits('200', '20'), seen: plan3.body.plan.seen }));
  check('изменена вторая позиция: 409 с одной изменённой', stale2.status === 409 && stale2.body.changed.length === 1 && stale2.body.changed[0].id === vlv.id, stale2.body);
  check('«всё или ничего»: первая позиция тоже не записана, истории нет', sameWorld(afterEdit2, await world()));

  // ── 5. Изменены обе и одна удалена: перечень полный (изменённые и пропавшие) ──
  const plan4 = await call('POST', '/api/equipment/import-draft-plan', draftBody({ units: draftUnits('200', '20') }));
  await colleagueEdits(fan.id, '151');
  await db.componentElement.delete({ where: { id: vlv.id } });
  const afterEdit3 = await world();
  const stale3 = await call('POST', '/api/equipment/import-draft', draftBody({ units: draftUnits('200', '20'), seen: plan4.body.plan.seen }));
  check('изменена и удалена: `changed` и `gone` названы разом', stale3.status === 409 && stale3.body.changed.map((c: any) => c.id).join() === fan.id
    && stale3.body.gone.join() === vlv.id, stale3.body);
  check('отказ по удалённой позиции тоже ничего не записал', sameWorld(afterEdit3, await world()));
  await watchVersions('отказы');

  // ── 6. Чужой проект: идентификатор не раскрывает запись ──
  await raw.equipmentSystem.create({ data: { id: 'S-foreign', name: 'FOREIGN', projectId: 'P2' } });
  await raw.monoblock.create({ data: { id: 'M-foreign', name: 'M1', systemId: 'S-foreign' } });
  await raw.componentElement.create({ data: { id: 'C-foreign', name: 'Чужая', itemCode: 'X-1', monoblockId: 'M-foreign', version: 7, specs: '{"groups":[]}' } });
  const foreign = await call('POST', '/api/equipment/import-draft', draftBody({ units: draftUnits('200'), seen: { 'C-foreign': 7 } }));
  check('позиция чужого проекта — «пропала», её содержимое в отказ не попадает',
    foreign.status === 409 && foreign.body.gone.join() === 'C-foreign' && foreign.body.changed.length === 0 && !JSON.stringify(foreign.body).includes('Чужая'), foreign.body);

  // ── 7. Нечитаемый `seen` ──
  const worldBeforeBad = await world();
  for (const bad of [[1, 2], 'abc', { [fan.id]: -3 }, { [fan.id]: 'x' }, { '': 1 }]) {
    const r = await call('POST', '/api/equipment/import-draft', draftBody({ units: draftUnits('200'), seen: bad }));
    check(`нечитаемый seen ${JSON.stringify(bad)}: 400, ничего не записано`, r.status === 400 && !r.body.code, r.body);
  }
  check('после нечитаемых `seen` база та же', sameWorld(worldBeforeBad, await world()));

  // ── 8. Свежий предпросмотр после отказа: запись идёт, версии растут ──
  const fan2 = await elementByCode('FAN-1');
  const gone = await elementByCode('VLV-1');
  check('удалённая позиция действительно отсутствует', !gone);
  const plan5 = await call('POST', '/api/equipment/import-draft-plan', draftBody({ units: draftUnits('200', '20') }));
  check('новый план несёт актуальные версии', plan5.body.plan.seen[fan2.id] === fan2.version);
  const ok1 = await call('POST', '/api/equipment/import-draft', draftBody({ units: draftUnits('200', '20'), seen: plan5.body.plan.seen, selection: undefined }));
  check('со свежим `seen` запись проходит', ok1.status === 200 && ok1.body.batchId, ok1.body);
  const fan3 = await elementByCode('FAN-1');
  check('версия выросла, а не откатилась', fan3.version > fan2.version, [fan2.version, fan3.version]);
  await watchVersions('запись по свежему плану');

  // ── 9. Ввоз с привязкой источника: своя ветка транзакции, та же сверка ──
  const planB = await call('POST', '/api/equipment/import-draft-plan', draftBody({ units: draftUnits('300', '20') }));
  await colleagueEdits(fan3.id, '333');
  const binding = (revision: number) => ({ id: 'doc-1', kind: 'document', expectedLedgerRevision: revision, fileName: 'расчёт.pdf',
    revision: 'R1', sha256: 'a'.repeat(64), rule: { kind: 'document-name', fileName: 'расчёт.pdf' } });
  const beforeBinding = await world();
  const bound = await call('POST', '/api/equipment/import-draft', draftBody({ units: draftUnits('300', '20'), seen: planB.body.plan.seen, sourceBinding: binding(0) }));
  check('с привязкой источника: устаревший предпросмотр — 409 `VERSION_CONFLICT`', bound.status === 409 && bound.body.code === VERSION_CONFLICT
    && bound.body.changed.length === 1 && bound.body.changed[0].id === fan3.id, bound.body);
  check('с привязкой источника: в базе не изменилось ничего (и привязка не создана)', sameWorld(beforeBinding, await world())
    && !(await raw.appSetting.findFirst({ where: { key: { startsWith: 'equipment_document_bindings' } } })));
  const planB2 = await call('POST', '/api/equipment/import-draft-plan', draftBody({ units: draftUnits('300', '20') }));
  const boundOk = await call('POST', '/api/equipment/import-draft', draftBody({ units: draftUnits('300', '20'), seen: planB2.body.plan.seen, sourceBinding: binding(0) }));
  check('с привязкой источника: по свежему плану запись проходит', boundOk.status === 200 && boundOk.body.success === true, boundOk.body);
  await watchVersions('ввоз с привязкой');

  // ── 10. Файл расчёта (`import-to-category`): «будет снято» тоже под сверкой ──
  const putFile = async (id: string, text: string) => {
    await raw.fileNode.deleteMany({ where: { id } });
    await raw.fileNode.create({ data: { id, name: `${id}.xml`, filePath: `/${id}.xml`, content: Buffer.from(text, 'utf8').toString('base64'), size: text.length, scope: 'SHARED' } });
  };
  await putFile('f1', xmlOf('1', '2'));
  const fileFirst = await call('POST', '/api/equipment/import-to-category', { fileId: 'f1', category: 'AHU', projectId: PROJECT });
  check('файл: первый ввоз (без `seen`) заводит установку', fileFirst.status === 200 && fileFirst.body.newBlocks >= 2, fileFirst.body);
  const fFan = await elementByCode('FAN-1', 'SYS-1');
  const fVlv = await elementByCode('VLV-1', 'SYS-1');
  // Новая выгрузка: вентилятор изменился, клапана в ней нет — он будет снят
  await putFile('f2', xmlOf('9'));
  const filePlan = await call('POST', '/api/equipment/import-plan', { fileId: 'f2', category: 'AHU', projectId: PROJECT });
  const fp = filePlan.body.plan;
  check('файл: в `seen` — позиция, которая изменится, и позиция, которая будет снята', fp.seen[fFan.id] === fFan.version && fp.seen[fVlv.id] === fVlv.version
    && fp.missing.some((m: any) => m.id === fVlv.id && m.remove), fp.seen);
  await colleagueEdits(fVlv.id, '77');
  const beforeFile = await world();
  const fileStale = await call('POST', '/api/equipment/import-to-category', { fileId: 'f2', category: 'AHU', projectId: PROJECT, seen: fp.seen });
  check('файл: коллега правил позицию, которую импорт снял бы, — 409 `VERSION_CONFLICT`', fileStale.status === 409 && fileStale.body.code === VERSION_CONFLICT
    && fileStale.body.changed.map((c: any) => c.id).join() === fVlv.id, fileStale.body);
  check('файл: ни снятие, ни обновление вентилятора не записаны', sameWorld(beforeFile, await world()));
  const filePlan2 = await call('POST', '/api/equipment/import-plan', { fileId: 'f2', category: 'AHU', projectId: PROJECT });
  const fileOk = await call('POST', '/api/equipment/import-to-category', { fileId: 'f2', category: 'AHU', projectId: PROJECT, seen: filePlan2.body.plan.seen });
  check('файл: по свежему плану запись проходит, позиция снята', fileOk.status === 200 && fileOk.body.removedBlocks === 1 && (await raw.componentElement.findUnique({ where: { id: fVlv.id } })).status === 'REMOVED', fileOk.body);
  await watchVersions('файл расчёта');

  // ── 11. Отмена импорта: план несёт версии, применение сверяет их в транзакции ──
  const undoFirst = await call('GET', '/api/equipment/import-undo/:batchId', {}, { batchId: fileOk.body.batchId });
  check('план отмены несёт `seen` и `seenRows` позиций, которые он вернёт (снятая позиция)', undoFirst.status === 200
    && undoFirst.body.reinstate.some((r: any) => r.elementId === fVlv.id) && undoFirst.body.seen[fVlv.id] !== undefined
    && undoFirst.body.seenRows[fVlv.id]?.itemCode === 'VLV-1' && undoFirst.body.seenRows[fVlv.id]?.status === 'REMOVED', undoFirst.body);
  check('позиция, которую откат пропустит (в режиме ожидания значения не записаны), в `seen` не входит',
    undoFirst.body.skip.some((s: any) => s.elementId === fFan.id) && undoFirst.body.seen[fFan.id] === undefined, undoFirst.body.skip);
  await colleagueEdits(fVlv.id, '88');
  const beforeUndo = await world();
  const undoStale = await call('POST', '/api/equipment/import-undo', { batchId: fileOk.body.batchId, seen: undoFirst.body.seen });
  check('отмена по устаревшему плану: 409 `VERSION_CONFLICT`, перечень по позициям', undoStale.status === 409 && undoStale.body.code === VERSION_CONFLICT
    && undoStale.body.changed.some((c: any) => c.id === fVlv.id) && undoStale.body.error === undoChangedText(), undoStale.body);
  check('отмена по устаревшему плану не записала ничего', sameWorld(beforeUndo, await world()));
  // Позиция, которой человек не видел: вентилятор откат пропускал, а теперь значение вернули к записанному импортом — откат дошёл бы и до него
  const batchRows = await raw.equipmentHistory.findMany({ where: { batchId: fileOk.body.batchId, elementId: fFan.id }, orderBy: { changedAt: 'asc' } });
  const undoSkipPlan = await call('GET', '/api/equipment/import-undo/:batchId', {}, { batchId: fileOk.body.batchId });
  await db.componentElement.update({ where: { id: fFan.id }, data: { specs: batchRows[batchRows.length - 1].newSpecs } });
  const beforeExtra = await world();
  const undoExtra = await call('POST', '/api/equipment/import-undo', { batchId: fileOk.body.batchId, seen: undoSkipPlan.body.seen });
  check('в новом плане появилась позиция, которой человек не видел, — 409, её нет в подтверждённом', undoExtra.status === 409 && undoExtra.body.code === VERSION_CONFLICT
    && undoExtra.body.changed.some((c: any) => c.id === fFan.id), undoExtra.body);
  check('и отмена ничего не записала', sameWorld(beforeExtra, await world()));
  // Позиция, чью версию человек видел, изменена: сверка по версии, а не по составу плана
  const undoPlan3 = await call('GET', '/api/equipment/import-undo/:batchId', {}, { batchId: fileOk.body.batchId });
  await db.componentElement.update({ where: { id: fVlv.id }, data: { hasConflict: false } }); // версия растёт: сверка по ней
  const undoGoneBefore = await world();
  const undoVersions = await call('POST', '/api/equipment/import-undo', { batchId: fileOk.body.batchId, seen: undoPlan3.body.seen });
  check('правка снятой позиции после плана отмены — 409', undoVersions.status === 409 && undoVersions.body.changed.some((c: any) => c.id === fVlv.id), undoVersions.body);
  check('снова ничего не записано', sameWorld(undoGoneBefore, await world()));
  // Позиция пропала совсем
  const undoPlan4 = await call('GET', '/api/equipment/import-undo/:batchId', {}, { batchId: fileOk.body.batchId });
  const vlvRow = await raw.componentElement.findUnique({ where: { id: fVlv.id } });
  const vlvTags = await raw.$queryRawUnsafe('SELECT B FROM "_ComponentElementToTag" WHERE A = ?', fVlv.id);
  assert.equal(vlvTags.length, 0);
  await raw.equipmentHistory.deleteMany({ where: { elementId: fVlv.id, batchId: { not: fileOk.body.batchId } } });
  await db.componentElement.delete({ where: { id: fVlv.id } });
  const undoGone = await call('POST', '/api/equipment/import-undo', { batchId: fileOk.body.batchId, seen: undoPlan4.body.seen });
  check('позицию удалили после плана отмены — 409, она названа в `gone`', undoGone.status === 409 && undoGone.body.gone.includes(fVlv.id), undoGone.body);
  await raw.componentElement.create({ data: { id: vlvRow.id, name: vlvRow.name, itemCode: vlvRow.itemCode, monoblockId: vlvRow.monoblockId, specs: vlvRow.specs, status: 'REMOVED', conflictLog: vlvRow.conflictLog, version: vlvRow.version + 1 } });
  // Нечитаемый seen
  const undoBad = await call('POST', '/api/equipment/import-undo', { batchId: fileOk.body.batchId, seen: [1] });
  check('отмена с нечитаемым `seen` — 400', undoBad.status === 400 && !undoBad.body.code, undoBad.body);
  // Свежий план — отмена проходит, версии растут
  const undoFresh = await call('GET', '/api/equipment/import-undo/:batchId', {}, { batchId: fileOk.body.batchId });
  const undoOk = await call('POST', '/api/equipment/import-undo', { batchId: fileOk.body.batchId, seen: undoFresh.body.seen });
  check('по свежему плану отмена проходит', undoOk.status === 200 && (undoOk.body.restored + undoOk.body.reinstated) >= 1, undoOk.body);
  const undoAgain = await call('POST', '/api/equipment/import-undo', { batchId: fileOk.body.batchId });
  check('отмена без `seen` (старый клиент) принимается', undoAgain.status === 200, undoAgain.body);
  await watchVersions('отмена импорта');

  // ── 12. XML-ревизия: решения сверяют версии позиций; откат версию не уменьшает ──
  await raw.tag.create({ data: { id: 'tag-x', identifier: 'FAN-9', projectId: PROJECT, codeKey: 'FAN-9' } });
  await raw.equipmentSystem.create({ data: { id: 'sx', name: 'SYS-9', projectId: PROJECT } });
  await raw.monoblock.create({ data: { id: 'mx', name: 'M1', systemId: 'sx' } });
  const specsOf = (value: string) => JSON.stringify({ groups: [{ title: 'Параметры', params: [{ key: 'Давление', value, unit: 'Па' }] }] });
  await raw.componentElement.create({ data: { id: 'ex', name: 'FAN-9', itemCode: 'FAN-9', monoblockId: 'mx', specs: specsOf('1') } });
  await raw.$executeRawUnsafe('INSERT INTO "_ComponentElementToTag"(A,B) VALUES (?,?)', 'ex', 'tag-x');
  const xml = (value: string) => `<project><system name="SYS-9"><monoblock name="M1"><block name="FAN-9"><group title="Параметры"><param name="Давление" unit="Па">${value}</param></group></block></monoblock></system></project>`;
  const rawSource = (text: string, revision: string) => {
    const bytes = Buffer.from(text, 'utf8');
    return { fileName: 'FAN-9.xml', revision, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, base64: bytes.toString('base64'), selectedRule: { kind: 'exact-tag' } };
  };
  const locator = { folderKey: 'a'.repeat(64), anchors: [{ key: 'a'.repeat(64), relativePath: '' }] };
  const createdSource = await call('POST', '/api/equipment/projects/:projectId/sources', { tagId: 'tag-x', elementId: 'ex', targetType: 'component', locator, ...rawSource(xml('2'), 'B') }, { projectId: PROJECT });
  check('источник XML создан', createdSource.status === 201, createdSource.body);
  const sourceId = createdSource.body.source.sourceId;
  const P = { projectId: PROJECT, sourceId };
  const candidatesOf = async () => (await call('GET', '/api/equipment/projects/:projectId/sources/:sourceId/candidates', {}, P)).body.candidates;
  const decisionsRoute = '/api/equipment/projects/:projectId/sources/:sourceId/candidates/:candidateId/decisions';
  const checkRoute = '/api/equipment/projects/:projectId/sources/:sourceId/check';
  const c1 = (await call('POST', checkRoute, rawSource(xml('2'), 'B'), P)).body.candidate;
  const c1Full = (await candidatesOf()).find((c: any) => c.id === c1.id);
  check('кандидат несёт версии позиций, которые видел экран', c1Full.expectedVersions?.ex === 1, c1Full.expectedVersions);
  await db.componentElement.update({ where: { id: 'ex' }, data: { name: 'FAN-9 (поправлен)' } });
  const beforeXml = await world();
  const xmlStale = await call('POST', decisionsRoute, { expectedVersion: c1.expectedVersion, seen: c1Full.expectedVersions, decisions: [{ id: c1.changes[0].id, action: 'accept' }] }, { ...P, candidateId: c1.id });
  check('XML: позицию изменили после сравнения — 409 `VERSION_CONFLICT` с перечнем, а не общий текст', xmlStale.status === 409 && xmlStale.body.code === VERSION_CONFLICT
    && xmlStale.body.changed.map((c: any) => c.id).join() === 'ex' && xmlStale.body.changed[0].current.name === 'FAN-9 (поправлен)', xmlStale.body);
  check('XML: решение не сохранено, характеристика не записана', sameWorld(beforeXml, await world()));
  const xmlBad = await call('POST', decisionsRoute, { expectedVersion: c1.expectedVersion, seen: 'x', decisions: [{ id: c1.changes[0].id, action: 'accept' }] }, { ...P, candidateId: c1.id });
  check('XML: нечитаемый `seen` — 400', xmlBad.status === 400 && !xmlBad.body.code, xmlBad.body);
  await watchVersions('XML отказ');

  // Новое сравнение, решение по свежим версиям
  const c2 = (await call('POST', checkRoute, rawSource(xml('3'), 'C'), P)).body.candidate;
  const c2Full = (await candidatesOf()).find((c: any) => c.id === c2.id);
  const exBefore = await raw.componentElement.findUnique({ where: { id: 'ex' } });
  const xmlOk = await call('POST', decisionsRoute, { expectedVersion: c2.expectedVersion, seen: c2Full.expectedVersions, decisions: [{ id: c2.changes[0].id, action: 'accept' }] }, { ...P, candidateId: c2.id });
  const exApplied = await raw.componentElement.findUnique({ where: { id: 'ex' } });
  check('XML: по свежим версиям решение записано, версия выросла на 1', xmlOk.status === 200 && JSON.parse(exApplied.specs).groups[0].params[0].value === '3'
    && exApplied.version === exBefore.version + 1, [xmlOk.body, exBefore.version, exApplied.version]);
  await watchVersions('XML решение');

  // Откат XML-ревизии: версия растёт, а не возвращается к прежнему числу
  const undoXml = await call('POST', '/api/equipment/import-undo', { batchId: xmlOk.body.batchId });
  const exUndone = await raw.componentElement.findUnique({ where: { id: 'ex' } });
  check('XML: откат вернул характеристику', undoXml.status === 200 && undoXml.body.restored === 1 && JSON.parse(exUndone.specs).groups[0].params[0].value === '1', undoXml.body);
  check('XML: откат НЕ ставит версию назад — она выше, чем после применения', exUndone.version === exApplied.version + 1, [exBefore.version, exApplied.version, exUndone.version]);
  await watchVersions('откат XML');

  // «Хватка» без изменений: подтверждение «изменений нет» версию не двигает вовсе
  const c3 = (await call('POST', checkRoute, rawSource(xml('1'), 'D'), P)).body.candidate;
  const c3Full = (await candidatesOf()).find((c: any) => c.id === c3.id);
  const exBeforeConfirm = await raw.componentElement.findUnique({ where: { id: 'ex' } });
  await db.componentElement.update({ where: { id: 'ex' }, data: { name: 'FAN-9 (ещё раз)' } });
  const confirmStale = await call('POST', decisionsRoute, { expectedVersion: c3.expectedVersion, seen: c3Full.expectedVersions, confirmNoChanges: true }, { ...P, candidateId: c3.id });
  check('XML: подтверждение «изменений нет» по устаревшим версиям — 409 `VERSION_CONFLICT`', confirmStale.status === 409 && confirmStale.body.code === VERSION_CONFLICT, confirmStale.body);
  const c4 = (await call('POST', checkRoute, rawSource(xml('1'), 'E'), P)).body.candidate;
  const c4Full = (await candidatesOf()).find((c: any) => c.id === c4.id);
  const exBeforeConfirm2 = await raw.componentElement.findUnique({ where: { id: 'ex' } });
  // Гонка: коллега правит позицию между проверкой и транзакцией — сверка в самой транзакции
  let armed = true;
  const racing = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction' && armed) {
        return async (...args: any[]) => {
          armed = false;
          await target.componentElement.update({ where: { id: 'ex' }, data: { name: 'FAN-9 (в гонке)' } });
          return target.$transaction(...args);
        };
      }
      return Reflect.get(target, key);
    },
  });
  setPrisma(racing);
  const confirmRace = await call('POST', decisionsRoute, { expectedVersion: c4.expectedVersion, seen: c4Full.expectedVersions, confirmNoChanges: true }, { ...P, candidateId: c4.id });
  setPrisma(db);
  check('XML: гонка внутри транзакции — тот же структурный отказ, а не общий текст', confirmRace.status === 409 && confirmRace.body.code === VERSION_CONFLICT
    && confirmRace.body.changed.map((c: any) => c.id).join() === 'ex', confirmRace.body);
  const exAfterRace = await raw.componentElement.findUnique({ where: { id: 'ex' } });
  check('XML: гонка не записала решение (версия выросла только от правки коллеги)', exAfterRace.version === exBeforeConfirm2.version + 1 && exBeforeConfirm.version <= exBeforeConfirm2.version);
  await watchVersions('XML подтверждение');
  // Гонка в транзакции записи решения по характеристике (вторая транзакция маршрута)
  const c5 = (await call('POST', checkRoute, rawSource(xml('5'), 'F'), P)).body.candidate;
  const c5Full = (await candidatesOf()).find((c: any) => c.id === c5.id);
  const beforeC5 = await world();
  armed = true;
  const racing2 = new Proxy(db, {
    get(target, key) {
      if (key === '$transaction' && armed) {
        return async (...args: any[]) => {
          armed = false;
          await target.componentElement.update({ where: { id: 'ex' }, data: { name: 'FAN-9 (гонка 2)' } });
          return target.$transaction(...args);
        };
      }
      return Reflect.get(target, key);
    },
  });
  setPrisma(racing2);
  const decideRace = await call('POST', decisionsRoute, { expectedVersion: c5.expectedVersion, seen: c5Full.expectedVersions, decisions: [{ id: c5.changes[0].id, action: 'accept' }] }, { ...P, candidateId: c5.id });
  setPrisma(db);
  check('XML: гонка в транзакции решения по характеристике — структурный отказ, значение не записано', decideRace.status === 409 && decideRace.body.code === VERSION_CONFLICT
    && JSON.parse((await raw.componentElement.findUnique({ where: { id: 'ex' } })).specs).groups[0].params[0].value === '1'
    && (await raw.equipmentXmlApplication.count()) === beforeC5.applications.length, decideRace.body);
  // «Изменений нет», версии свежие: запись идёт, версия позиции не двигается вовсе (ни вверх, ни назад)
  const c6 = (await call('POST', checkRoute, rawSource(xml('1'), 'G'), P)).body.candidate;
  const c6Full = (await candidatesOf()).find((c: any) => c.id === c6.id);
  const exBeforeC6 = await raw.componentElement.findUnique({ where: { id: 'ex' } });
  const confirmOk = await call('POST', decisionsRoute, { expectedVersion: c6.expectedVersion, seen: c6Full.expectedVersions, confirmNoChanges: true }, { ...P, candidateId: c6.id });
  check('XML: подтверждение «изменений нет» по свежим версиям проходит, версия позиции не меняется', confirmOk.status === 200
    && (await raw.componentElement.findUnique({ where: { id: 'ex' } })).version === exBeforeC6.version, confirmOk.body);
  await watchVersions('XML подтверждение без изменений');

  // ── 13. Отмена — всё или ничего: сбой на второй позиции не оставляет возврата первой ──
  await raw.appSetting.create({ data: { key: 'equip_conflict_mode', userId: null, value: 'immediate' } });
  await call('POST', '/api/equipment/import-draft', draftBody({ units: draftUnits('1', '1', 'AHU-2') }));
  const aFan = await elementByCode('FAN-1', 'AHU-2');
  const aVlv = await elementByCode('VLV-1', 'AHU-2');
  const second = await call('POST', '/api/equipment/import-draft', draftBody({ units: draftUnits('2', '2', 'AHU-2') }));
  check('режим «сразу»: второй ввоз записал значения обеим позициям', second.status === 200
    && JSON.parse((await elementByCode('VLV-1', 'AHU-2')).specs).groups[0].params[0].value === '2', second.body);
  const batchPlan = await call('GET', '/api/equipment/import-undo/:batchId', {}, { batchId: second.body.batchId });
  check('план отмены: вернуть две позиции, обе в `seen`', batchPlan.body.restore.length === 2 && batchPlan.body.seen[aFan.id] !== undefined && batchPlan.body.seen[aVlv.id] !== undefined, batchPlan.body);
  await raw.$executeRawUnsafe(`CREATE TRIGGER fail_second_undo BEFORE INSERT ON EquipmentHistory WHEN NEW.changeType = 'UPDATE' AND NEW.batchId LIKE 'undo-%' AND NEW.elementId = '${aVlv.id}' BEGIN SELECT RAISE(ABORT, 'сбой на второй позиции'); END`);
  const beforeFail = await world();
  const failed = await call('POST', '/api/equipment/import-undo', { batchId: second.body.batchId, seen: batchPlan.body.seen });
  await raw.$executeRawUnsafe('DROP TRIGGER fail_second_undo');
  check('сбой на второй позиции: отмена не удалась', failed.status >= 500, failed.body);
  check('«всё или ничего»: первая позиция тоже не возвращена, истории возврата нет', sameWorld(beforeFail, await world()));
  const retried = await call('POST', '/api/equipment/import-undo', { batchId: second.body.batchId, seen: batchPlan.body.seen });
  check('без сбоя та же отмена проходит', retried.status === 200 && retried.body.restored === 2, retried.body);
  await watchVersions('отмена, всё или ничего');

  console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${checks})`);
}

main().then(async () => { await raw.$disconnect(); fs.rmSync(root, { recursive: true, force: true }); })
  .catch(async (e) => { console.error(e); await raw.$disconnect().catch(() => null); process.exit(1); });
