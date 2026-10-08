/**
 * Маршруты выгрузки в E3: права, состояния выгрузки, журнал шагов, связи,
 * продолжение, «убрать сделанное», ожидание при занятом проекте E3 (С18).
 *
 * Базы нет: маршруты работают с хранилищем в памяти, а Prisma-хранилище
 * проверяется на тех же вызовах через подставной клиент (по образцу
 * test-e3-solutions-http). Ход выгрузки между окном и сервером идёт так же, как
 * в программе: создать → начать → шаги → итог.
 *
 * Запуск: npx tsx scripts/test-e3-export-http.ts
 */
import assert from 'node:assert/strict';
import express from 'express';
import { registerE3ExportRoutes, STALE_MS } from '../server/routes/e3Exports';
import { memoryStore, prismaStore } from '../server/e3ExportStore';
import { setPrisma } from '../server/context';

const USERS: Record<string, any> = {
  kip: { id: 'u-kip', role: 'ENGINEER_AUTO', isActive: true, perms: ['e3.export'] },
  kip2: { id: 'u-kip2', role: 'ENGINEER_AUTO', isActive: true, perms: ['e3.export'] },
  reader: { id: 'u-reader', role: 'ENGINEER_VENT', isActive: true, perms: [] },
  stranger: { id: 'u-stranger', role: 'ENGINEER_AUTO', isActive: true, perms: ['e3.export'] },
};
const can = (u: any, p: string) => !!u?.perms?.includes(p);
const MEMBERS: Record<string, string[]> = { p1: ['u-kip', 'u-kip2', 'u-reader'], p2: ['u-stranger'] };
const KEY = '5b0c6f04-aaaa-4bbb-8ccc-0123456789ab';

const steps = (...ids: string[]) => ids.flatMap((id) => [
  { kind: 'place', positionId: id, detail: `Поставить ${id}`, block: 'Клапан', mark: `x:${id}` },
  { kind: 'link', positionId: id, detail: `Связь ${id}`, ver: 'v1#1' },
]);
const plan = (...ids: string[]) => ({ steps: steps(...ids), summary: { place: ids.length, update: 0, replace: 0, remove: 0 }, actions: ids.map((elementId) => ({ elementId, kind: 'place' })) });
const binding = (id: string, extra: Record<string, unknown> = {}) => ({ elementId: id, solutionId: '08.01.03', designation: id, sheet: 'Лист 12', x: 60, y: 30, rotation: 0, sentVersion: 'v1', sentAttrs: { '|A': '1' }, state: 'PLACED', lastExportId: '', ...extra });

async function main() {
  // Журнал действий и история позиций — то, что маршрут пишет после выгрузки (8.3)
  const logged: any[] = []; const history: any[] = [];
  setPrisma({ actionLog: { create: async ({ data }: any) => { logged.push(data); } }, equipmentHistory: { create: async ({ data }: any) => { history.push(data); } } } as any);
  let skew = 0; // часы сервера уходят вперёд, не заставляя тест ждать
  const store = memoryStore();
  const app = express();
  registerE3ExportRoutes(app as any, can, { ensure: async () => undefined, store: () => store, canUseProject: async (u, id) => (MEMBERS[id] || []).includes(u.id), now: () => Date.now() + skew });
  const call = async (method: string, path: string, body?: unknown, who?: string, params: Record<string, string> = {}) => {
    const layer = (app as any)._router.stack.find((l: any) => l.route?.path === path && l.route.methods[method.toLowerCase()]);
    assert.ok(layer, `маршрут зарегистрирован: ${method} ${path}`);
    const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(v: any) { this.body = v; return this; } };
    await layer.route.stack[0].handle({ body, authUser: who ? USERS[who] : undefined, params, query: {} }, res);
    return { status: res.statusCode, body: res.body };
  };
  let ok = 0;
  const check = (name: string, cond: unknown) => { assert.ok(cond, name); ok++; console.log(`✓ ${name}`); };
  const status = async (name: string, r: Promise<{ status: number; body: any }>, want: number) => {
    const got = await r; assert.equal(got.status, want, `${name}: ждали ${want}, пришло ${got.status} ${JSON.stringify(got.body)}`); ok++; console.log(`✓ ${name}`); return got.body;
  };
  const P = '/api/projects/:projectId/e3';
  const X = (suffix = '') => `/api/e3-exports/:id${suffix}`;

  console.log('Права и связь проекта');
  await status('без входа — 401', call('GET', `${P}/projects`, undefined, undefined, { projectId: 'p1' }), 401);
  await status('писать без права e3.export — 403', call('PUT', `${P}/link`, { key: KEY }, 'reader', { projectId: 'p1' }), 403);
  await status('чужой проект — 403', call('GET', `${P}/projects`, undefined, 'reader', { projectId: 'p2' }), 403);
  await status('ключ связи негодный — 400', call('PUT', `${P}/link`, { key: 'x' }, 'kip', { projectId: 'p1' }), 400);
  const link = await status('связать проект E3 — 200', call('PUT', `${P}/link`, { key: KEY, name: 'Корпус 3 — ВК', e3Version: '2025' }, 'kip', { projectId: 'p1' }), 200);
  const again = await status('повторная связь тем же ключом — тот же проект E3', call('PUT', `${P}/link`, { key: KEY, name: 'Корпус 3 — ВК (копия)' }, 'kip', { projectId: 'p1' }), 200);
  check('одна связь, а не две', again.id === link.id && (await call('GET', `${P}/projects`, undefined, 'reader', { projectId: 'p1' })).body.length === 1);
  const ep = { projectId: 'p1', e3ProjectId: link.id };
  await status('проект E3 чужого проекта Flux — 404', call('GET', `${P}/projects/:e3ProjectId/bindings`, undefined, 'stranger', { projectId: 'p2', e3ProjectId: link.id }), 404);

  console.log('Состояния выгрузки');
  await status('план без шагов — 400', call('POST', `${P}/projects/:e3ProjectId/exports`, { plan: { steps: [] }, sheet: 'Лист 12' }, 'kip', ep), 400);
  await status('шаг негодного вида — 400', call('POST', `${P}/projects/:e3ProjectId/exports`, { plan: { steps: [{ kind: 'drop', positionId: 'a', detail: '' }] }, sheet: 'Лист 12' }, 'kip', ep), 400);
  await status('создать без права — 403', call('POST', `${P}/projects/:e3ProjectId/exports`, { plan: plan('a'), sheet: 'Лист 12' }, 'reader', ep), 403);
  const e1 = await status('создать выгрузку — PLANNED', call('POST', `${P}/projects/:e3ProjectId/exports`, { plan: plan('a', 'b'), sheet: 'Лист 12', classifierVersion: 3 }, 'kip', ep), 200);
  check('создана запись PLANNED с планом, журнал пуст', e1.state === 'PLANNED' && e1.plan.steps.length === 4 && e1.journal.length === 0 && e1.classifierVersion === 3 && e1.by === 'u-kip');
  const id1 = { id: e1.id };
  await status('шаги в невыполняемую выгрузку — 409', call('POST', X('/steps'), { results: [{ i: 0, ok: true }] }, 'kip', id1), 409);
  await status('итог до начала — 409', call('POST', X('/finish'), { state: 'DONE' }, 'kip', id1), 409);
  const run = await status('начать — RUNNING', call('POST', X('/start'), {}, 'kip', id1), 200);
  check('состояние RUNNING', run.state === 'RUNNING');
  await status('начать повторно — 409', call('POST', X('/start'), {}, 'kip', id1), 409);

  console.log('С18: вторая выгрузка в тот же проект E3 ждёт');
  const e2 = await status('вторая запись создаётся', call('POST', `${P}/projects/:e3ProjectId/exports`, { plan: plan('c'), sheet: 'Лист 12' }, 'kip2', ep), 200);
  const busy = await status('вторая не стартует, пока идёт первая — 409', call('POST', X('/start'), {}, 'kip2', { id: e2.id }), 409);
  check('ответ говорит «занято» и называет выгрузку', busy.busy === true && busy.exportId === e1.id);
  skew += STALE_MS + 1000;
  const take = await status('брошенная RUNNING не держит проект — вторая стартует', call('POST', X('/start'), {}, 'kip2', { id: e2.id }), 200);
  check('брошенная первая стала прерванной', take.state === 'RUNNING' && (await call('GET', X(), undefined, 'kip', id1)).body.state === 'INTERRUPTED');
  await status('вторая заканчивает', call('POST', X('/steps'), { results: [{ i: 0, ok: true }, { i: 1, ok: true }] }, 'kip2', { id: e2.id }), 200);
  await status('и записывает связь', call('POST', X('/finish'), { state: 'DONE', bindings: [binding('c')] }, 'kip2', { id: e2.id }), 200);

  console.log('Журнал, итог, продолжение');
  await status('шаг с номером за пределами плана — 400', call('POST', X('/resume'), {}, 'kip', id1).then(async (r) => (r.status === 200 ? call('POST', X('/steps'), { results: [{ i: 99, ok: true }] }, 'kip', id1) : r)), 400);
  const j1 = await status('шаги пишутся в журнал', call('POST', X('/steps'), { results: [{ i: 0, ok: true }, { i: 1, ok: true }, { i: 2, ok: false, message: 'нет блока' }] }, 'kip', id1), 200);
  check('журнал хранит результаты по номерам', j1.journal.length === 3 && j1.journal[2].message === 'нет блока');
  await status('итог DONE при невыполненных шагах — 409', call('POST', X('/finish'), { state: 'DONE', bindings: [binding('a')] }, 'kip', id1), 409);
  const cut = await status('прервана — INTERRUPTED, без связей', call('POST', X('/finish'), { state: 'INTERRUPTED', report: { error: 'E3 закрыт' } }, 'kip', id1), 200);
  check('состояние INTERRUPTED, связей по узлам a и b нет', cut.state === 'INTERRUPTED' && (await call('GET', `${P}/projects/:e3ProjectId/bindings`, undefined, 'kip', ep)).body.every((b: any) => b.elementId === 'c'));
  const list = (await call('GET', `${P}/projects/:e3ProjectId/exports`, undefined, 'reader', ep)).body;
  check('в списке прерванная: сделано 2 из 4, без журнала и плана целиком', list.find((x: any) => x.id === e1.id).done === 2 && list.find((x: any) => x.id === e1.id).steps === 4 && !('journal' in list[0] && list[0].journal));
  const res = await status('продолжить — RUNNING и невыполненные шаги', call('POST', X('/resume'), {}, 'kip', id1), 200);
  check('осталось два шага: 2 и 3', JSON.stringify(res.remaining) === '[2,3]' && res.export.state === 'RUNNING');
  await status('повтор шага заменяет запись, а не дублирует', call('POST', X('/steps'), { results: [{ i: 2, ok: true }, { i: 3, ok: true }] }, 'kip', id1), 200);
  check('в журнале по записи на шаг', (await call('GET', X(), undefined, 'kip', id1)).body.journal.length === 4);
  await status('связь по узлу вне плана — 400', call('POST', X('/finish'), { state: 'DONE', bindings: [binding('zzz')] }, 'kip', id1), 400);
  await status('связь без ID узла — 400', call('POST', X('/finish'), { state: 'DONE', bindings: [{ ...binding('a'), elementId: '' }] }, 'kip', id1), 400);
  await status('итог без права — 403', call('POST', X('/finish'), { state: 'DONE', bindings: [] }, 'reader', id1), 403);
  const done = await status('итог DONE — связи записаны вместе с итогом', call('POST', X('/finish'), { state: 'DONE', bindings: [binding('a'), binding('b')] }, 'kip', id1), 200);
  const binds = (await call('GET', `${P}/projects/:e3ProjectId/bindings`, undefined, 'reader', ep)).body;
  check('три связи, у a и b — эта выгрузка', done.state === 'DONE' && binds.length === 3 && binds.find((b: any) => b.elementId === 'a').lastExportId === e1.id);
  await status('продолжить выполненную — 409', call('POST', X('/resume'), {}, 'kip', id1), 409);

  console.log('После выгрузки: журнал, история позиций, сводка, копия проекта');
  check('журнал действий: одна запись на выгрузку', logged.filter((l) => l.what === 'Выгрузка в E3').length === 2 && logged[0].userId === 'u-kip2' && logged[0].target.includes('Корпус 3 — ВК (копия)'));
  check('история позиции: «выгружена в E3» с проектом, листом и обозначением', history.some((h) => h.elementId === 'a' && h.changeType === 'E3_EXPORT' && JSON.parse(h.newSpecs).e3.designation === 'a' && JSON.parse(h.newSpecs).e3.sheet === 'Лист 12'));
  const sum = await status('сводка «в схеме E3» для Оборудования', call('GET', `${P}/summary`, undefined, 'reader', { projectId: 'p1' }), 200);
  check('в сводке узлы с версией, листом и обозначением', sum.length === 3 && sum.find((s: any) => s.elementId === 'a').sentVersion === 'v1' && sum.find((s: any) => s.elementId === 'a').project.startsWith('Корпус 3'));
  await status('сводка чужого проекта — 403', call('GET', `${P}/summary`, undefined, 'reader', { projectId: 'p2' }), 403);
  const copy = await status('С13: новый проект E3 с копией связей', call('PUT', `${P}/link`, { key: '9a8b7c6d-1111-4222-8333-abcdefabcdef', name: 'Корпус 3 — ВК, ред. 2', copyFrom: link.id }, 'kip', { projectId: 'p1' }), 200);
  const copied = (await call('GET', `${P}/projects/:e3ProjectId/bindings`, undefined, 'kip', { projectId: 'p1', e3ProjectId: copy.id })).body;
  check('связи скопированы, а не общие', copied.length === 3 && (await call('GET', `${P}/projects/:e3ProjectId/bindings`, undefined, 'kip', ep)).body.length === 3 && copy.id !== link.id);
  await status('копировать из чужого проекта E3 — 404', call('PUT', `${P}/link`, { key: '1a8b7c6d-1111-4222-8333-abcdefabcdef', copyFrom: 'нет такого' }, 'kip', { projectId: 'p1' }), 404);
  await status('с шагом-отвязкой план без шагов — 200', call('POST', `${P}/projects/:e3ProjectId/exports`, { plan: { steps: [], actions: [{ elementId: 'a', kind: 'detach' }], runId: 'r' }, sheet: 'Лист 12' }, 'kip', ep), 200);

  console.log('Убрать сделанное');
  await status('снять то, что поставила не эта выгрузка — 400', call('POST', X('/undo'), { removed: ['c'] }, 'kip', id1), 400);
  await status('отмена без права — 403', call('POST', X('/undo'), { removed: ['a'] }, 'reader', id1), 403);
  // узел b позже обновила другая выгрузка
  const e3 = (await call('POST', `${P}/projects/:e3ProjectId/exports`, { plan: plan('b'), sheet: 'Лист 12' }, 'kip', ep)).body;
  await call('POST', X('/start'), {}, 'kip', { id: e3.id });
  await call('POST', X('/steps'), { results: [{ i: 0, ok: true }, { i: 1, ok: true }] }, 'kip', { id: e3.id });
  await call('POST', X('/finish'), { state: 'DONE', bindings: [binding('b', { sentVersion: 'v2' })] }, 'kip', { id: e3.id });
  const undone = await status('убрать сделанное', call('POST', X('/undo'), { removed: ['a', 'b'], kept: [{ positionId: 'x', reason: 'сдвинут' }] }, 'kip', id1), 200);
  check('UNDONE; связь a снята, связь b осталась — её обновила другая выгрузка', undone.state === 'UNDONE'
    && undone.report.removed.length === 1 && undone.report.removed[0] === 'a' && undone.report.kept.length === 2);
  const after = (await call('GET', `${P}/projects/:e3ProjectId/bindings`, undefined, 'reader', ep)).body;
  check('в базе остались b (от второй выгрузки) и c', after.map((b: any) => b.elementId).sort().join() === 'b,c' && after.find((b: any) => b.elementId === 'b').sentVersion === 'v2');
  await status('убрать дважды — 409', call('POST', X('/undo'), { removed: ['a'] }, 'kip', id1), 409);

  console.log('Prisma-хранилище на тех же вызовах');
  const rows: Record<string, any[]> = { e3Project: [], e3Export: [], e3Binding: [] };
  let seq = 0;
  const match = (r: any, w: any = {}) => Object.entries(w).every(([k, v]) => r[k] === v);
  const delegate = (name: string) => ({
    findFirst: async ({ where }: any) => structuredClone(rows[name].find((r) => match(r, where)) || null),
    findUnique: async ({ where }: any) => structuredClone(rows[name].find((r) => match(r, where)) || null),
    findMany: async ({ where, take }: any = {}) => structuredClone(rows[name].filter((r) => match(r, where)).slice(0, take || 1000)),
    create: async ({ data }: any) => { const r = { id: `r${++seq}`, at: new Date(), updatedAt: new Date(), lastSeenAt: new Date(), ...data }; rows[name].push(r); return structuredClone(r); },
    update: async ({ where, data }: any) => { const r = rows[name].find((x) => match(x, where)); Object.assign(r, data); return structuredClone(r); },
    deleteMany: async ({ where }: any) => { rows[name] = rows[name].filter((r) => !match(r, where)); },
  });
  const db: any = { e3Project: delegate('e3Project'), e3Export: delegate('e3Export'), e3Binding: delegate('e3Binding'), $transaction: async (fn: any) => fn(db) };
  const ps = prismaStore(db);
  const p = await ps.upsertProject({ fluxProjectId: 'p1', key: KEY, name: 'A', path: '', e3Version: '', partsDb: '' });
  const p2 = await ps.upsertProject({ fluxProjectId: 'p1', key: KEY, name: 'B', path: '', e3Version: '', partsDb: '' });
  check('Prisma: связь проекта одна, имя обновилось', p.id === p2.id && p2.name === 'B' && rows.e3Project.length === 1);
  const ex = await ps.createExport({ e3ProjectId: p.id, sheet: 'Лист', by: 'u', state: 'PLANNED', classifierVersion: 1, profile: { a: 1 }, plan: { steps: [1] }, journal: [], report: {} });
  const saved = await ps.saveExport(ex.id, { state: 'RUNNING', journal: [{ i: 0, ok: true }] });
  check('Prisma: план и журнал — JSON туда и обратно', saved.state === 'RUNNING' && saved.journal[0].ok === true && saved.plan.steps[0] === 1 && (saved.profile as any).a === 1);
  await ps.saveBinding(p.id, binding('a', { sentAttrs: { '|K': 'v' } }) as any);
  await ps.saveBinding(p.id, binding('a', { sentVersion: 'v9' }) as any);
  const bs = await ps.listBindings(p.id);
  check('Prisma: связь по узлу одна, значения читаются обратно', bs.length === 1 && bs[0].sentVersion === 'v9' && rows.e3Binding.length === 1);
  await ps.deleteBinding(p.id, 'a');
  check('Prisma: связь удалена по точному ключу', (await ps.listBindings(p.id)).length === 0);
  check('Prisma: идущие выгрузки находятся по состоянию', (await ps.runningExports(p.id)).length === 1);

  console.log(`\nВсе проверки маршрутов выгрузки в E3 пройдены (${ok})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
