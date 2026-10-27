/**
 * Подразделения (этап 1, docs/departments.md): настоящая SQLite, настоящие маршруты.
 *
 * Проверяется то, на чём держится справочник: дерево и счётчики, запрет кольца и
 * неверной вложенности, права, перевод людей с предпросмотром, историей и
 * откатом, архив с переводом, мастер переноса старых текстов и импорт с
 * созданием подразделений галочкой — вместе с откатом созданного.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setDialect } from '../server/ddl.js';
import { setPrisma } from '../server/context.js';
import { registerDepartmentRoutes } from '../server/routes/departments.js';
import { registerUserRoutes } from '../server/routes/users.js';
import Database from 'better-sqlite3';
import { createTableSql } from '../server/ddl.js';
import { ensureDepartmentSchema, departmentTableSpecs } from '../server/departmentsSchema.js';
import { ensureRemoteSchema, parsePrismaSchema } from '../server/schema-sync.js';
import { buildDepartmentTree, canNest, departmentLabel, normalizeDepartmentName, splitDepartmentPath, wouldCycle } from '../shared/departments.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-departments-'));
const dbPath = path.join(dir, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
function check(label: string, condition: unknown, detail?: unknown) { assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); checks++; console.log(`✓ ${label}`); }

const perms = (...keys: string[]) => JSON.stringify(Object.fromEntries(keys.map((k) => [k, { enabled: true }])));
const ACTORS: Record<string, any> = {
  owner: { id: 'owner-1', role: 'OWNER', name: 'Владелец', isActive: true },
  admin: { id: 'admin-1', role: 'ADMIN', name: 'Админ', isActive: true, permissions: perms('admin.users.manage', 'admin.users.create') },
  weak: { id: 'admin-2', role: 'ADMIN', name: 'Админ без права', isActive: true, permissions: perms('admin.users.create') },
  eng: { id: 'eng-1', role: 'ENGINEER_VENT', name: 'Инженер', isActive: true },
};

async function main() {
  const app = express(); app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => { (req as any).authUser = ACTORS[String(req.headers['x-actor'] || 'admin')]; next(); });
  registerDepartmentRoutes(app);
  registerUserRoutes(app, { hashPassword: (p) => `h:${p}`, invalidateRolePerms: () => {}, invalidateAuthUser: () => {} });
  const server = createServer(app); let listening = false;
  try {
    setDialect('sqlite');
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {}); setPrisma(prisma);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); listening = true;
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const call = async (method: string, url: string, body?: unknown, actor = 'admin') => {
      const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-actor': actor }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* не JSON */ }
      return { status: r.status, json };
    };
    const tree = async (archived = false) => (await call('GET', `/api/departments${archived ? '?archived=1' : ''}`)).json;
    const mkUser = (id: string, extra: any = {}) => prisma.user.create({ data: { id, symbol: id, password: 'x', name: `Сотрудник ${id}`, role: 'ENGINEER_VENT', ...extra } });

    console.log('1. Чистые правила (shared/departments)');
    check('имена сравниваются без регистра, пробелов и ё', normalizeDepartmentName('  Отдел  ОВиК ') === 'отдел овик' && normalizeDepartmentName('Ёлка') === normalizeDepartmentName('елка'));
    check('путь «Город / Отдел» делится на части', splitDepartmentPath('Новосибирск / ОВиК').join('|') === 'Новосибирск|ОВиК' && splitDepartmentPath('ОВиК').length === 1);
    check('вложенность: город только в компанию, группа не содержит отдел', canNest('company', 'branch') && !canNest('division', 'branch') && canNest('division', 'group') && !canNest('group', 'division') && !canNest('division', 'company'));
    const sample = [{ id: 'a', name: 'A', kind: 'company', parentId: null }, { id: 'b', name: 'B', kind: 'branch', parentId: 'a' }, { id: 'c', name: 'C', kind: 'division', parentId: 'b' }];
    check('кольцо: в себя и в потомка нельзя, в соседа можно', wouldCycle(sample, 'b', 'c') && wouldCycle(sample, 'b', 'b') && !wouldCycle(sample, 'c', 'a'));
    check('дерево строится по плоскому списку', buildDepartmentTree(sample)[0].children[0].children[0].dept.id === 'c' && departmentLabel(sample, 'c') === 'B / C');

    console.log('2. Дерево, создание, правка');
    const first = await tree();
    check('корень «Компания» создаётся сам', first.departments.length === 1 && first.departments[0].kind === 'company' && first.departments[0].name === 'Компания' && first.rootId === first.departments[0].id, first);
    const root = first.rootId;
    const again = await tree();
    check('повторный запрос не создаёт второй корень', again.departments.length === 1);
    const nsk = (await call('POST', '/api/departments', { name: 'Новосибирск', timezone: 'Asia/Novosibirsk' })).json;
    check('под компанией по умолчанию создаётся город с городом и поясом', nsk.kind === 'branch' && nsk.city === 'Новосибирск' && nsk.timezone === 'Asia/Novosibirsk' && nsk.parentId === root, nsk);
    const msk = (await call('POST', '/api/departments', { name: 'Москва', timezone: 'Europe/Moscow' })).json;
    const ovik = (await call('POST', '/api/departments', { name: 'ОВиК', parentId: nsk.id })).json;
    check('под городом по умолчанию создаётся отдел', ovik.kind === 'division', ovik);
    const grp = (await call('POST', '/api/departments', { name: 'Бригада 1', parentId: ovik.id })).json;
    check('под отделом по умолчанию создаётся группа', grp.kind === 'group', grp);
    const dupe = await call('POST', '/api/departments', { name: ' овик ', parentId: nsk.id });
    check('одинаковое имя в одном месте — отказ 409', dupe.status === 409, dupe);
    const sameElsewhere = await call('POST', '/api/departments', { name: 'ОВиК', parentId: msk.id });
    check('то же имя в другом городе допустимо', sameElsewhere.status === 200, sameElsewhere);
    const mskOvik = sameElsewhere.json;
    check('город нельзя вложить в отдел', (await call('POST', '/api/departments', { name: 'Томск', kind: 'branch', parentId: ovik.id })).status === 400);
    check('без названия — отказ', (await call('POST', '/api/departments', { name: '   ' })).status === 400);
    check('несуществующий родитель — 404', (await call('POST', '/api/departments', { name: 'X', parentId: 'nope' })).status === 404);
    check('неизвестный часовой пояс — отказ', (await call('PUT', `/api/departments/${nsk.id}`, { timezone: 'Mars/Olympus' })).status === 400);
    const renamed = await call('PUT', `/api/departments/${ovik.id}`, { name: 'ОВиК и климат', shortName: 'ОВиК', sortOrder: 5 });
    check('переименование, краткое имя и порядок', renamed.json.name === 'ОВиК и климат' && renamed.json.shortName === 'ОВиК' && renamed.json.sortOrder === 5, renamed.json);
    check('переименование в занятое имя — 409', (await call('PUT', `/api/departments/${msk.id}`, { name: 'Новосибирск' })).status === 409);
    await call('PUT', `/api/departments/${ovik.id}`, { name: 'ОВиК' });

    console.log('3. Перенос и запрет кольца');
    check('перенос в собственного потомка — отказ', (await call('PUT', `/api/departments/${nsk.id}/move`, { parentId: grp.id })).status === 400);
    check('перенос в себя — отказ', (await call('PUT', `/api/departments/${ovik.id}/move`, { parentId: ovik.id })).status === 400);
    check('корень не переносится', (await call('PUT', `/api/departments/${root}/move`, { parentId: msk.id })).status === 400);
    check('город под отдел не переносится', (await call('PUT', `/api/departments/${msk.id}/move`, { parentId: ovik.id })).status === 400);
    await call('POST', '/api/departments', { name: 'Бригада 1', parentId: mskOvik.id });
    check('перенос на занятое имя в новом месте — 409', (await call('PUT', `/api/departments/${grp.id}/move`, { parentId: mskOvik.id })).status === 409);
    await prisma.department.deleteMany({ where: { name: 'Бригада 1', parentId: mskOvik.id } });
    const moved = await call('PUT', `/api/departments/${grp.id}/move`, { parentId: mskOvik.id });
    check('группа переносится в отдел другого города', moved.status === 200 && moved.json.parentId === mskOvik.id, moved);
    await call('PUT', `/api/departments/${grp.id}/move`, { parentId: ovik.id });

    console.log('4. Права');
    check('читать дерево может любой вошедший', (await call('GET', '/api/departments', undefined, 'eng')).status === 200);
    check('администратор без «Управление сотрудниками» не создаёт', (await call('POST', '/api/departments', { name: 'Тест' }, 'weak')).status === 403);
    check('инженер не переводит', (await call('POST', '/api/departments/assign', { userIds: ['x'], departmentId: ovik.id }, 'eng')).status === 403);
    check('мастер переноса закрыт для инженера', (await call('GET', '/api/departments/legacy/plan', undefined, 'eng')).status === 403);
    check('владелец управляет без явного права', (await call('POST', '/api/departments', { name: 'Казань', timezone: 'Europe/Moscow' }, 'owner')).status === 200);

    console.log('5. Перевод людей: предпросмотр → применение → отмена');
    await prisma.role.create({ data: { code: 'ENGINEER_VENT', name: 'Инженер' } });
    await mkUser('u1'); await mkUser('u2'); await mkUser('u3'); await mkUser('adm', { role: 'ADMIN' }); await mkUser('svc', { role: 'SERVICE' });
    const prev = (await call('POST', '/api/departments/assign/preview', { userIds: ['u1', 'u2', 'adm', 'svc', 'ghost'], departmentId: ovik.id })).json;
    const st = (id: string) => prev.items.find((i: any) => i.userId === id)?.status;
    check('предпросмотр: двое переводятся, администратор, служебная и несуществующая — пропуск', st('u1') === 'move' && st('u2') === 'move' && st('adm') === 'skip' && st('svc') === 'skip' && st('ghost') === 'skip', prev.items);
    check('предпросмотр ничего не пишет', (await prisma.user.count({ where: { departmentId: { not: null } } })) === 0 && (await prisma.userDepartmentHistory.count()) === 0);
    const apply = (await call('POST', '/api/departments/assign', { userIds: ['u1', 'u2', 'adm'], departmentId: ovik.id, reason: 'Реорганизация' })).json;
    check('применение: переведено двое, администратор пропущен, выдан токен отмены', apply.moved === 2 && apply.skipped.length === 1 && typeof apply.undoToken === 'string', apply);
    check('у людей проставлено подразделение, история записана с исполнителем и причиной', (await prisma.user.findUnique({ where: { id: 'u1' } })).departmentId === ovik.id
      && (await prisma.userDepartmentHistory.count({ where: { toId: ovik.id, by: 'admin-1', reason: 'Реорганизация', batchId: apply.undoToken } })) === 2);
    check('повторный перевод в то же — «без изменений», токена нет', await (async () => { const r = (await call('POST', '/api/departments/assign', { userIds: ['u1'], departmentId: ovik.id })).json; return r.moved === 0 && r.same === 1 && r.undoToken === null; })());
    check('владелец может перевести администратора', (await call('POST', '/api/departments/assign', { userIds: ['adm'], departmentId: nsk.id }, 'owner')).json.moved === 1);
    const counted = await tree();
    const row = (id: string) => counted.departments.find((d: any) => d.id === id);
    check('счётчики: в отделе 2, в городе 3 (с администратором), у корня все', row(ovik.id).people === 2 && row(nsk.id).total === 3 && row(root).total === 3 && counted.unassigned === 1, counted.departments.map((d: any) => [d.name, d.people, d.total]));
    check('GET /api/users отдаёт departmentId', ((await call('GET', '/api/users')).json as any[]).find((u) => u.id === 'u1').departmentId === ovik.id);
    const hist = (await call('GET', '/api/departments/history/u1')).json;
    check('история человека читается', hist.length === 1 && hist[0].toId === ovik.id && hist[0].fromId === null, hist);
    // отмена не должна затирать чужие правки
    await call('POST', '/api/departments/assign', { userIds: ['u2'], departmentId: mskOvik.id });
    const refuse = await call('POST', '/api/departments/undo', { undoToken: apply.undoToken });
    check('отмена, когда человека уже перевели дальше, — 409 и ничего не меняет', refuse.status === 409 && (await prisma.user.findUnique({ where: { id: 'u1' } })).departmentId === ovik.id, refuse);
    const apply2 = (await call('POST', '/api/departments/assign', { userIds: ['u3'], departmentId: grp.id })).json;
    const undone = await call('POST', '/api/departments/undo', { undoToken: apply2.undoToken });
    check('отмена перевода возвращает прежнее и пишет обратную строку истории', undone.status === 200 && (await prisma.user.findUnique({ where: { id: 'u3' } })).departmentId === null
      && (await prisma.userDepartmentHistory.count({ where: { userId: 'u3' } })) === 2);
    check('вторая отмена того же токена — 404', (await call('POST', '/api/departments/undo', { undoToken: apply2.undoToken })).status === 404);
    check('чужой токен отмены не подходит', (await call('POST', '/api/departments/undo', { undoToken: apply2.undoToken }, 'owner')).status === 404);
    await call('POST', '/api/departments/assign', { userIds: ['u2'], departmentId: ovik.id });

    console.log('6. Архив');
    const need = await call('POST', `/api/departments/${nsk.id}/archive`, {});
    check('в городе есть люди, перевода нет — 409 с подсказкой', need.status === 409 && need.json.needMoveTo === true, need);
    check('переводить в архивируемое поддерево нельзя', (await call('POST', `/api/departments/${nsk.id}/archive`, { moveTo: grp.id })).status === 409);
    check('компанию в архив отправить нельзя', (await call('POST', `/api/departments/${root}/archive`, { moveTo: msk.id })).status === 400);
    const blockedAdmin = await call('POST', `/api/departments/${nsk.id}/archive`, { moveTo: msk.id });
    check('администратор компании не переводит архивом администратора (это делает владелец)', blockedAdmin.status === 403 && (await prisma.department.findUnique({ where: { id: nsk.id } })).archivedAt === null, blockedAdmin);
    const arch = (await call('POST', `/api/departments/${nsk.id}/archive`, { moveTo: msk.id }, 'owner')).json;
    check('архив города с переводом людей одной операцией', arch.archived === 3 && arch.moved === 3 && typeof arch.undoToken === 'string', arch);
    const live = await tree();
    check('архивные не видны в дереве, люди в Москве', !live.departments.some((d: any) => d.id === nsk.id) && live.departments.find((d: any) => d.id === msk.id).people === 3, live.departments.map((d: any) => [d.name, d.people]));
    check('архивные видны по запросу', (await tree(true)).departments.some((d: any) => d.id === nsk.id && d.archivedAt));
    check('переводить в архивное нельзя', (await call('POST', '/api/departments/assign', { userIds: ['u1'], departmentId: ovik.id })).status === 409);
    check('в архивное нельзя перенести и создать', (await call('POST', '/api/departments', { name: 'Новый', parentId: nsk.id })).status === 409);
    const undoArch = await call('POST', '/api/departments/undo', { undoToken: arch.undoToken }, 'owner');
    check('отмена архива возвращает подразделения и людей', undoArch.status === 200 && (await prisma.user.findUnique({ where: { id: 'u1' } })).departmentId === ovik.id && !(await prisma.department.findUnique({ where: { id: ovik.id } })).archivedAt);
    const empty = (await call('POST', '/api/departments', { name: 'Пустой', parentId: msk.id })).json;
    const archEmpty = (await call('POST', `/api/departments/${empty.id}/archive`, {})).json;
    check('пустое подразделение архивируется без перевода', archEmpty.archived === 1 && archEmpty.moved === 0, archEmpty);
    check('возврат из архива', (await call('POST', `/api/departments/${empty.id}/restore`)).status === 200 && !(await prisma.department.findUnique({ where: { id: empty.id } })).archivedAt);
    await call('POST', `/api/departments/${nsk.id}/archive`, { moveTo: msk.id }, 'owner');
    check('возврат ветки из архива не возвращает людей назад', (await call('POST', `/api/departments/${grp.id}/restore`)).status === 409, 'потомок возвращается только вместе с родителем');
    const restored = await call('POST', `/api/departments/${nsk.id}/restore`);
    check('возврат города возвращает и вложенные, архивированные вместе с ним', restored.status === 200 && restored.json.restored === 3 && (await prisma.user.findUnique({ where: { id: 'u1' } })).departmentId === msk.id, restored);
    for (const id of ['u1', 'u2', 'adm']) await prisma.user.update({ where: { id }, data: { departmentId: null } });
    await prisma.userDepartmentHistory.deleteMany({});

    console.log('7. Мастер переноса старых текстов');
    await mkUser('t1', { department: 'Отдел ОВиК' }); await mkUser('t2', { department: ' отдел  овик ' }); await mkUser('t3', { department: 'ОВиК' });
    await mkUser('t4', { department: 'Новосибирск / Автоматика' }); await mkUser('t5', { department: 'Бухгалтерия' }); await mkUser('t6', { department: '' });
    const plan = (await call('GET', '/api/departments/legacy/plan')).json;
    const g = (key: string) => plan.groups.find((x: any) => x.key === key);
    check('план группирует написания одного текста и считает людей', g('отдел овик').count === 2 && plan.withoutText >= 1, plan.groups.map((x: any) => [x.key, x.count, x.match.status]));
    check('«ОВиК» есть в двух городах — не угадывается, а помечается неоднозначным', g('овик').count === 1 && g('овик').match.status === 'ambiguous' && g('овик').match.candidates.length === 2, g('овик'));
    check('«Город / Отдел» без отдела предлагает создать цепочку', g('новосибирск/автоматика').match.status === 'create' && g('новосибирск/автоматика').match.chain.join('|') === 'Автоматика', g('новосибирск/автоматика'));
    check('предпросмотр мастера ничего не пишет', (await prisma.department.count()) === (await tree(true)).departments.length && (await prisma.user.count({ where: { departmentId: { not: null } } })) === 0);
    const wiz = await call('POST', '/api/departments/legacy/apply', { choices: [
      { key: 'отдел овик', action: 'map', departmentId: ovik.id },
      { key: 'новосибирск/автоматика', action: 'create' },
      { key: 'бухгалтерия', action: 'create', parentId: msk.id },
      { key: 'овик', action: 'skip' },
    ] });
    check('применение мастера', wiz.status === 200 && wiz.json.assigned === 4 && wiz.json.created === 2 && typeof wiz.json.undoToken === 'string', wiz);
    const autom = await prisma.department.findFirst({ where: { name: 'Автоматика' } });
    const buh = await prisma.department.findFirst({ where: { name: 'Бухгалтерия' } });
    check('созданы Автоматика в Новосибирске и Бухгалтерия в Москве', autom?.parentId === nsk.id && buh?.parentId === msk.id && buh?.kind === 'division', [autom, buh]);
    check('люди разложены, пропущенный остался без подразделения', (await prisma.user.findUnique({ where: { id: 't1' } })).departmentId === ovik.id && (await prisma.user.findUnique({ where: { id: 't4' } })).departmentId === autom.id && (await prisma.user.findUnique({ where: { id: 't3' } })).departmentId === null);
    check('старый текст не тронут', (await prisma.user.findUnique({ where: { id: 't1' } })).department === 'Отдел ОВиК');
    const wizUndo = await call('POST', '/api/departments/undo', { undoToken: wiz.json.undoToken });
    check('отмена мастера убирает и созданные подразделения', wizUndo.status === 200 && wizUndo.json.removed === 2 && !(await prisma.department.findFirst({ where: { name: 'Автоматика' } })) && (await prisma.user.findUnique({ where: { id: 't1' } })).departmentId === null);
    const wiz2 = (await call('POST', '/api/departments/legacy/apply', { choices: [{ key: 'бухгалтерия', action: 'create' }] })).json;
    await call('POST', '/api/departments/assign', { userIds: ['u1'], departmentId: (await prisma.department.findFirst({ where: { name: 'Бухгалтерия' } })).id });
    const wizUndo2 = await call('POST', '/api/departments/undo', { undoToken: wiz2.undoToken });
    check('созданное мастером нельзя убрать, если в нём уже появились другие люди', wizUndo2.status === 409 && !!(await prisma.department.findFirst({ where: { name: 'Бухгалтерия' } })) && (await prisma.user.findUnique({ where: { id: 't5' } })).departmentId !== null, wizUndo2);
    await prisma.user.updateMany({ where: { id: { in: ['t1', 't2', 't3', 't4', 't5', 't6', 'u1'] } }, data: { departmentId: null } });
    await prisma.department.deleteMany({ where: { name: 'Бухгалтерия' } });

    console.log('8. Карточка сотрудника');
    const created = await call('POST', '/api/users', { symbol: 'card1', name: 'Карточкин Иван', lastName: 'Карточкин', firstName: 'Иван', role: 'ENGINEER_VENT', departmentId: ovik.id });
    check('сотрудник создаётся сразу в подразделении, история пишется', created.status === 200 && created.json.departmentId === ovik.id && (await prisma.userDepartmentHistory.count({ where: { userId: created.json.id, toId: ovik.id } })) === 1, created);
    check('несуществующее подразделение — отказ', (await call('POST', '/api/users', { symbol: 'card2', name: 'Иванов Пётр', lastName: 'Иванов', firstName: 'Пётр', departmentId: 'nope' })).status === 400);
    const put = await call('PUT', `/api/users/${created.json.id}`, { departmentId: msk.id });
    check('правка карточки переводит и пишет историю', put.status === 200 && put.json.user.departmentId === msk.id && (await prisma.userDepartmentHistory.count({ where: { userId: created.json.id } })) === 2, put);
    check('без права «Управление сотрудниками» подразделение в карточке не меняется', (await call('PUT', `/api/users/${created.json.id}`, { departmentId: ovik.id }, 'weak')).status === 403);
    check('снять подразделение можно', (await call('PUT', `/api/users/${created.json.id}`, { departmentId: null })).json.user.departmentId === null);

    console.log('9. Импорт с подразделениями');
    const rows = [['Логин', 'ФИО', 'Отдел'], ['imp1', 'Импортов Иван Иванович', 'ОВиК и климат'], ['imp2', 'Импортова Анна Сергеевна', 'Москва / ОВиК'], ['imp3', 'Новиков Олег Петрович', 'Отдел ВК'], ['imp4', 'Новикова Ольга Петровна', 'отдел вк'], ['imp5', 'Без Отдела Иванович', '']];
    await call('PUT', `/api/departments/${ovik.id}`, { name: 'ОВиК и климат' });
    const mapping = { symbol: 0, name: 1, department: 2 };
    const imp = (await call('POST', '/api/users/import/preview', { rows, mapping, mode: 'create', defaultRole: 'ENGINEER_VENT' })).json;
    const r = (n: number) => imp.rows.find((x: any) => x.values.symbol === `imp${n}`);
    check('предпросмотр: совпало по названию и по пути, остальное — к созданию', r(1).dept.status === 'match' && r(2).dept.status === 'match' && r(3).dept.status === 'create' && r(5).dept.status === 'none', imp.rows.map((x: any) => x.dept));
    check('предпросмотр предлагает создать одно подразделение на два написания', imp.departmentsToCreate.length === 1 && imp.departmentsToCreate[0].count === 2, imp.departmentsToCreate);
    check('предпросмотр импорта ничего не создал', !(await prisma.department.findFirst({ where: { name: 'Отдел ВК' } })) && !(await prisma.user.findUnique({ where: { id: 'imp1' } })));
    const key = imp.departmentsToCreate[0].key;
    const before = await prisma.department.count();
    const applied = await call('POST', '/api/users/import/apply', { rows, mapping, mode: 'create', defaultRole: 'ENGINEER_VENT', selected: imp.rows.map((x: any) => x.row), createDepartments: [key], departmentParentId: msk.id });
    check('применение: пять сотрудников и одно новое подразделение', applied.status === 200 && applied.json.imported === 5 && applied.json.departmentsCreated === 1 && (await prisma.department.count()) === before + 1, applied);
    const vk = await prisma.department.findFirst({ where: { name: 'Отдел ВК' } });
    const byLogin = (s: string) => prisma.user.findUnique({ where: { symbol: s } });
    check('люди в подразделениях, новое — в выбранном городе', (await byLogin('imp1')).departmentId === ovik.id && (await byLogin('imp2')).departmentId === mskOvik.id && (await byLogin('imp3')).departmentId === vk.id && (await byLogin('imp4')).departmentId === vk.id && (await byLogin('imp5')).departmentId === null && vk.parentId === msk.id, vk);
    check('история импорта записана', (await prisma.userDepartmentHistory.count({ where: { batchId: applied.json.undoToken } })) === 4);
    const undoImp = await call('POST', '/api/users/import/undo', { undoToken: applied.json.undoToken });
    check('откат импорта убирает сотрудников, их историю и созданное подразделение', undoImp.status === 200 && !(await byLogin('imp1')) && !(await prisma.department.findFirst({ where: { name: 'Отдел ВК' } })) && (await prisma.userDepartmentHistory.count({ where: { batchId: applied.json.undoToken } })) === 0, undoImp);
    const notTicked = await call('POST', '/api/users/import/apply', { rows, mapping, mode: 'create', defaultRole: 'ENGINEER_VENT', selected: [2, 3, 4, 5, 6], createDepartments: [] });
    check('без галочки подразделение не создаётся, человек остаётся без него', notTicked.status === 200 && !(await prisma.department.findFirst({ where: { name: 'Отдел ВК' } })) && (await byLogin('imp3')).departmentId === null && (await byLogin('imp3')).department === 'Отдел ВК');
    await call('POST', '/api/users/import/undo', { undoToken: notTicked.json.undoToken });
    // режим обновления: подразделение меняется у существующих, откат возвращает прежнее
    await mkUser('upd1', { departmentId: mskOvik.id });
    const updRows = [['Логин', 'Отдел'], ['upd1', 'ОВиК и климат']];
    const updApply = await call('POST', '/api/users/import/apply', { rows: updRows, mapping: { symbol: 0, department: 1 }, mode: 'update', selected: [2] });
    check('импорт-обновление переводит существующего', updApply.status === 200 && (await byLogin('upd1')).departmentId === ovik.id && (await prisma.userDepartmentHistory.count({ where: { userId: 'upd1', fromId: mskOvik.id, toId: ovik.id } })) === 1, updApply);
    await call('POST', '/api/users/import/undo', { undoToken: updApply.json.undoToken });
    check('откат обновления возвращает прежнее подразделение', (await byLogin('upd1')).departmentId === mskOvik.id);
    // неоднозначное название
    const dup = (await call('POST', '/api/departments', { name: 'Дубль', parentId: nsk.id })).json;
    await call('POST', '/api/departments', { name: 'Дубль', parentId: msk.id });
    void dup;
    const amb = (await call('POST', '/api/users/import/preview', { rows: [['Логин', 'ФИО', 'Отдел'], ['amb1', 'Двойной Иван Иванович', 'Дубль']], mapping, mode: 'create', defaultRole: 'ENGINEER_VENT' })).json;
    check('одинаковое имя в двух городах — ошибка строки, а не угадывание', amb.rows[0].dept.status === 'ambiguous' && /неоднозначно/.test(amb.rows[0].error), amb.rows[0]);

    console.log('10. Схема на трёх СУБД (разбор схем и DDL; живых PostgreSQL и MariaDB в контейнере нет)');
    const files: Array<['sqlite' | 'postgresql' | 'mysql', string]> = [['sqlite', 'schema.prisma'], ['postgresql', 'schema.postgresql.prisma'], ['mysql', 'schema.mariadb.prisma']];
    const shape = new Map<string, string>();
    for (const [dialect, file] of files) {
      const text = fs.readFileSync(path.join(process.cwd(), 'prisma', file), 'utf8');
      const models = parsePrismaSchema(dialect, text);
      const dep = models.find((m) => m.name === 'Department');
      const hist = models.find((m) => m.name === 'UserDepartmentHistory');
      const user = models.find((m) => m.name === 'User');
      const names = (m: any) => (m?.columns || []).map((c: any) => c.name).join(',');
      check(`${file}: Department и UserDepartmentHistory описаны`, names(dep) === 'id,name,shortName,kind,city,timezone,parentId,sortOrder,archivedAt,createdAt,createdBy' && names(hist) === 'id,userId,fromId,toId,by,at,reason,batchId', [names(dep), names(hist)]);
      const dcol = user?.columns.find((c: any) => c.name === 'departmentId');
      check(`${file}: User.departmentId необязательное, рядом старый текст department`, !!dcol && dcol.nullable && user!.columns.some((c: any) => c.name === 'department'));
      const varchar = (m: any, c: string) => /VARCHAR/i.test(m?.columns.find((x: any) => x.name === c)?.sqlType || '');
      check(`${file}: индексы объявлены, а у MariaDB их поля — VARCHAR (TEXT не индексируется)`, /@@index\(\[departmentId\]\)/.test(text) && /@@index\(\[parentId\]\)/.test(text) && /@@index\(\[userId, at\]\)/.test(text)
        && (dialect !== 'mysql' || (varchar(user, 'departmentId') && varchar(dep, 'parentId') && varchar(hist, 'userId') && varchar(hist, 'batchId'))), dcol);
      shape.set(file, JSON.stringify([dep?.columns.map((c: any) => [c.name, c.nullable]), hist?.columns.map((c: any) => [c.name, c.nullable])]));
    }
    check('допустимость пустых значений в трёх схемах одинакова', new Set(shape.values()).size === 1);
    for (const d of ['postgresql', 'mysql'] as const) {
      const sql = departmentTableSpecs().map((t) => createTableSql(d, t.table, t.cols)).join('\n');
      const quote = d === 'mysql' ? '`by`' : '"by"';
      check(`${d}: DDL подразделений собирается с кавычками движка (в т. ч. служебное слово by)`, sql.includes(quote) && sql.includes(d === 'mysql' ? 'DATETIME(3)' : 'TIMESTAMP(3)') && sql.includes(d === 'mysql' ? 'ENGINE=InnoDB' : 'CREATE TABLE IF NOT EXISTS "Department"'), sql);
    }
    // База старой версии: есть User без departmentId и нет таблиц подразделений
    const asPrisma = (db: Database.Database) => ({ $queryRawUnsafe: async (q: string) => db.prepare(q).all(), $executeRawUnsafe: async (q: string) => { db.exec(q); return 0; } });
    const oldDb = new Database(path.join(dir, 'old.sqlite'));
    oldDb.exec('CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "symbol" TEXT NOT NULL, "position" TEXT, "department" TEXT, "email" TEXT)');
    oldDb.exec(`INSERT INTO "User" ("id","symbol","department") VALUES ('x1','x1','Отдел')`);
    const schemaText = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await ensureRemoteSchema(asPrisma(oldDb), 'sqlite', schemaText, () => {});
    const cols = (t: string) => (oldDb.prepare(`PRAGMA table_info("${t}")`).all() as any[]).map((c) => c.name);
    check('автомиграция общей базы добавляет User.departmentId и обе таблицы, данные целы', cols('User').includes('departmentId') && cols('Department').length === 11 && cols('UserDepartmentHistory').length === 8 && (oldDb.prepare('SELECT department FROM "User"').get() as any).department === 'Отдел');
    const oldDb2 = new Database(path.join(dir, 'old2.sqlite'));
    oldDb2.exec('CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "symbol" TEXT NOT NULL)');
    await ensureDepartmentSchema(asPrisma(oldDb2));
    const cols2 = (t: string) => (oldDb2.prepare(`PRAGMA table_info("${t}")`).all() as any[]).map((c) => c.name);
    check('подстраховка ensureDepartmentSchema достраивает колонку и таблицы без автомиграции', cols2('User').includes('departmentId') && cols2('Department').length === 11 && cols2('UserDepartmentHistory').length === 8);
    oldDb.close(); oldDb2.close();

    console.log('Проверено: ' + checks);
  } finally {
    if (listening) await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error('✗', error); process.exit(1); });
