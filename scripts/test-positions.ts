/**
 * Должности и уровень доступа: настоящая SQLite, настоящие маршруты сотрудников и справочника.
 *
 * Проверяется то, на чём держится разделение «кем работает» и «кто администратор»:
 * основная должность обязательна, дополнительные — без дублей и без основной,
 * «администратор» и «владелец» должностью не бывают, уровень назначает только
 * владелец, права дополнительных должностей только расширяют, справочник ведёт
 * владелец или администратор с правом «Должности: справочник», а назначенную
 * должность — хоть как дополнительную — удалить нельзя.
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
import { registerUserRoutes } from '../server/routes/users.js';
import { positionPermissionsString } from '../server/positionPermissions.js';
import { credentialStamp } from '../server/authSessions.js';
import { mapEmployeeRows, positionKey } from '../server/usersImport.js';
import { accessLevelOf, checkPositions, extraPositionCodes, mergePositionPermissions, primaryPositionCode, stripAdminPermissions } from '../shared/positions.js';
import { can } from '../src/lib/permissions.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-positions-'));
const dbPath = path.join(dir, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
function check(label: string, condition: unknown, detail?: unknown) { assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); checks++; console.log(`✓ ${label}`); }

const perms = (...keys: string[]) => JSON.stringify(Object.fromEntries(keys.map((k) => [k, { enabled: true }])));
const ACTORS: Record<string, any> = {
  owner: { id: 'owner-1', role: 'OWNER', name: 'Владелец', isActive: true },
  // Администратор, который заводит и правит сотрудников, но справочник не ведёт
  admin: { id: 'admin-1', role: 'ADMIN', name: 'Админ', isActive: true, permissions: perms('admin.users.manage', 'admin.users.create') },
  // Тот же, плюс право «Должности: справочник»
  keeper: { id: 'admin-2', role: 'ADMIN', name: 'Админ справочника', isActive: true, permissions: perms('admin.users.manage', 'admin.users.create', 'admin.roles.manage') },
  eng: { id: 'eng-1', role: 'ENGINEER_VENT', name: 'Инженер', isActive: true },
};

async function main() {
  const app = express(); app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => { (req as any).authUser = ACTORS[String(req.headers['x-actor'] || 'admin')]; next(); });
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
    const grant = (...ids: string[]) => JSON.stringify(Object.fromEntries(ids.map((id) => [id, { enabled: true, until: null }])));
    const row = (code: string) => prisma.user.findFirst({ where: { symbol: code } });

    console.log('1. Чистые правила (shared/positions)');
    check('основная должность — сохранённая, а у старой записи — код из role', primaryPositionCode({ role: 'MANAGER' }) === 'MANAGER' && primaryPositionCode({ role: 'ADMIN', positionCode: 'ENGINEER_VENT' }) === 'ENGINEER_VENT');
    check('у администратора без записанной должности основной нет', primaryPositionCode({ role: 'ADMIN' }) === null && primaryPositionCode({ role: 'OWNER' }) === null);
    check('уровень доступа берётся из role', accessLevelOf({ role: 'OWNER' }) === 'OWNER' && accessLevelOf({ role: 'ADMIN' }) === 'ADMIN' && accessLevelOf({ role: 'MANAGER' }) === 'EMPLOYEE');
    check('дополнительные: без дублей, без основной, без уровней', extraPositionCodes({ role: 'A', positionCode: 'A', extraPositions: JSON.stringify(['B', 'B', 'A', 'ADMIN', 'C']) }).join() === 'B,C');
    check('мусор в колонке дополнительных — пустой список', extraPositionCodes({ role: 'A', extraPositions: '{не json' }).length === 0);
    const known = new Set(['A', 'B', 'C']);
    check('проверка: основная обязательна', checkPositions('', [], known).ok === false && checkPositions(undefined, [], known).ok === false);
    check('проверка: ADMIN и OWNER — не должности', checkPositions('ADMIN', [], known).ok === false && checkPositions('A', ['OWNER'], known).ok === false);
    check('проверка: дубль и основная среди дополнительных — отказ', checkPositions('A', ['B', 'B'], known).ok === false && checkPositions('A', ['A'], known).ok === false);
    check('проверка: неизвестный код — отказ', checkPositions('Z', [], known).ok === false && checkPositions('A', ['Z'], known).ok === false);
    check('проверка: верный набор проходит', JSON.stringify(checkPositions('A', ['B', 'C'], known)) === JSON.stringify({ ok: true, primary: 'A', extras: ['B', 'C'] }));

    console.log('2. Права набора должностей: дополнительные только расширяют');
    const primary = JSON.stringify({ 'tags.manage': { enabled: true, until: null }, 'builder.edit': { enabled: false, until: null }, 'files.delete': { enabled: true, mode: 'DENY' } });
    const extra = JSON.stringify({ 'equipment.manage': { enabled: true, until: null }, 'builder.edit': { enabled: true, until: null }, 'files.delete': { enabled: true, until: null }, 'procurement.manage': { enabled: false, until: null }, 'admin.users.manage': { enabled: true } });
    const merged = mergePositionPermissions(primary, [extra]);
    check('включённое право дополнительной добавляется', merged['equipment.manage']?.enabled === true);
    check('запрет основной дополнительная не снимает (явный запрет и DENY)', merged['builder.edit']?.enabled === false && merged['files.delete']?.mode === 'DENY');
    check('выключенное у дополнительной ничего не отнимает и не добавляет', !('procurement.manage' in merged) && merged['tags.manage']?.enabled === true);
    check('права admin.* из должностей отбрасываются', !('admin.users.manage' in merged) && Object.keys(stripAdminPermissions(extra)).every((k) => !k.startsWith('admin.')));
    const until = mergePositionPermissions(JSON.stringify({ x: { enabled: true, until: '2030-01-01' } }), [JSON.stringify({ x: { enabled: true, until: null } })]);
    check('если право включено и там и там, срок берётся более длинный (бессрочное)', until.x.until === null);

    console.log('3. Справочник должностей: кто видит и кто меняет');
    for (const [code, name, rights] of [['ENGINEER_VENT', 'Инженер ОВиК', grant('tags.manage')], ['MANAGER', 'Менеджер проектов', grant('project.manage')], ['ENGINEER_AUTO', 'Инженер КИПиА', grant('equipment.manage', 'e3.export')]] as const) {
      await prisma.role.create({ data: { code, name, permissions: rights, isSystem: true } });
    }
    await prisma.role.create({ data: { code: 'OWNER', name: 'Владелец Flux', level: 0, isSystem: true } });
    await prisma.role.create({ data: { code: 'ADMIN', name: 'Администратор', level: 1, isSystem: true } });
    const listed = (await call('GET', '/api/roles', undefined, 'eng')).json.roles.map((r: any) => r.code);
    check('в справочнике нет OWNER и ADMIN — это уровни, а не должности', !listed.includes('OWNER') && !listed.includes('ADMIN') && listed.includes('MANAGER'), listed);
    check('читать справочник может любой вошедший', (await call('GET', '/api/roles', undefined, 'eng')).status === 200);
    check('сотрудник справочник не ведёт', (await call('POST', '/api/roles', { name: 'Левая' }, 'eng')).status === 403);
    check('администратор без права «Должности: справочник» не ведёт', (await call('POST', '/api/roles', { name: 'Левая' }, 'admin')).status === 403);
    const made = await call('POST', '/api/roles', { name: 'Конструктор', code: 'cad', permissions: grant('tags.manage', 'admin.users.manage', 'admin.roles.manage') }, 'keeper');
    check('администратор с правом заводит должность', made.status === 200 && made.json.role.code === 'CAD', made.json);
    check('права admin.* в должности не сохраняются', !('admin.users.manage' in JSON.parse(made.json.role.permissions)) && !('admin.roles.manage' in JSON.parse(made.json.role.permissions)) && 'tags.manage' in JSON.parse(made.json.role.permissions), made.json.role.permissions);
    const upd = await call('PUT', `/api/roles/${made.json.role.id}`, { permissions: grant('files.upload', 'admin.backup.run') }, 'keeper');
    check('при правке должности admin.* тоже вычищаются', upd.status === 200 && Object.keys(JSON.parse(upd.json.role.permissions)).join() === 'files.upload', upd.json);
    check('владелец тоже ведёт справочник', (await call('POST', '/api/roles', { name: 'Расчётчик', code: 'CALC' }, 'owner')).status === 200);
    check('код OWNER и ADMIN для должности зарезервирован', (await call('POST', '/api/roles', { name: 'Хозяин', code: 'OWNER' }, 'owner')).status === 403 && (await call('POST', '/api/roles', { name: 'Админ', code: 'ADMIN' }, 'keeper')).status === 403);
    const adminRow = await prisma.role.findUnique({ where: { code: 'ADMIN' } });
    check('строки уровней через справочник не меняются и не удаляются', (await call('PUT', `/api/roles/${adminRow.id}`, { name: 'Х' }, 'owner')).status === 403 && (await call('DELETE', `/api/roles/${adminRow.id}`, undefined, 'owner')).status === 403);

    console.log('4. Сотрудник: основная должность обязательна, role = должность');
    const noPos = await call('POST', '/api/users', { symbol: 'e0', lastName: 'Без', firstName: 'Должности', password: 'p' });
    check('без основной должности — 400', noPos.status === 400 && /должност/i.test(noPos.json.message), noPos.json);
    check('ADMIN как должность — 400', (await call('POST', '/api/users', { symbol: 'e0', lastName: 'А', firstName: 'Б', password: 'p', positionCode: 'ADMIN' })).status === 400);
    check('несуществующая должность — 400', (await call('POST', '/api/users', { symbol: 'e0', lastName: 'А', firstName: 'Б', password: 'p', positionCode: 'NOPE' })).status === 400);
    check('дополнительная совпала с основной — 400', (await call('POST', '/api/users', { symbol: 'e0', lastName: 'А', firstName: 'Б', password: 'p', positionCode: 'MANAGER', extraPositions: ['MANAGER'] })).status === 400);
    check('дубль среди дополнительных — 400', (await call('POST', '/api/users', { symbol: 'e0', lastName: 'А', firstName: 'Б', password: 'p', positionCode: 'MANAGER', extraPositions: ['CAD', 'CAD'] })).status === 400);
    check('уровень в дополнительных — 400', (await call('POST', '/api/users', { symbol: 'e0', lastName: 'А', firstName: 'Б', password: 'p', positionCode: 'MANAGER', extraPositions: ['ADMIN'] })).status === 400);
    check('ничего из отказанного не записано', (await prisma.user.count({ where: { symbol: 'e0' } })) === 0);
    const okUser = await call('POST', '/api/users', { symbol: 'e1', lastName: 'Иванов', firstName: 'Иван', password: 'p', positionCode: 'ENGINEER_VENT', extraPositions: ['ENGINEER_AUTO'] });
    const e1 = await row('e1');
    check('сотрудник заведён: role = основная должность, дополнительные в JSON', okUser.status === 200 && e1.role === 'ENGINEER_VENT' && e1.positionCode === 'ENGINEER_VENT' && e1.extraPositions === '["ENGINEER_AUTO"]', e1);
    const oldStyle = await call('POST', '/api/users', { symbol: 'e2', lastName: 'Петров', firstName: 'Пётр', password: 'p', role: 'MANAGER' });
    check('старый вызов с role читается как основная должность', oldStyle.status === 200 && (await row('e2')).positionCode === 'MANAGER');

    console.log('5. Уровень доступа назначает только владелец');
    check('администратор не заводит администратора (accessLevel)', (await call('POST', '/api/users', { symbol: 'a0', lastName: 'А', firstName: 'Б', password: 'p', positionCode: 'MANAGER', accessLevel: 'ADMIN' }, 'keeper')).status === 403);
    check('администратор не заводит администратора (role)', (await call('POST', '/api/users', { symbol: 'a0', lastName: 'А', firstName: 'Б', password: 'p', positionCode: 'MANAGER', role: 'ADMIN' }, 'keeper')).status === 403);
    check('администратор не повышает сотрудника', (await call('PUT', `/api/users/${e1.id}`, { accessLevel: 'ADMIN' }, 'keeper')).status === 403 && (await row('e1')).role === 'ENGINEER_VENT');
    check('администратор не выдаёт admin.* сотруднику', (await call('PUT', `/api/users/${e1.id}`, { permissions: grant('admin.users.manage') }, 'keeper')).status === 403);
    check('владелец заведёт администратора, но должность обязательна и у него', (await call('POST', '/api/users', { symbol: 'a1', lastName: 'Админов', firstName: 'Адм', password: 'p', accessLevel: 'ADMIN' }, 'owner')).status === 400);
    const adm = await call('POST', '/api/users', { symbol: 'a1', lastName: 'Админов', firstName: 'Адм', password: 'p', positionCode: 'MANAGER', accessLevel: 'ADMIN', permissions: grant('admin.users.manage') }, 'owner');
    const a1 = await row('a1');
    check('владелец заводит администратора: role ADMIN, должность — в positionCode', adm.status === 200 && a1.role === 'ADMIN' && a1.positionCode === 'MANAGER' && JSON.parse(a1.permissions)['admin.users.manage']?.enabled === true, a1);
    check('администратор не меняет администратора и не снимает с него уровень', (await call('PUT', `/api/users/${a1.id}`, { accessLevel: 'EMPLOYEE' }, 'keeper')).status === 403 && (await row('a1')).role === 'ADMIN');
    const changePos = await call('PUT', `/api/users/${a1.id}`, { positionCode: 'ENGINEER_AUTO' }, 'owner');
    check('смена должности администратора не меняет его уровень', changePos.status === 200 && (await row('a1')).role === 'ADMIN' && (await row('a1')).positionCode === 'ENGINEER_AUTO');
    const demote = await call('PUT', `/api/users/${a1.id}`, { accessLevel: 'EMPLOYEE' }, 'owner');
    const a1d = await row('a1');
    check('владелец снимает уровень: role := основная должность, admin.* стираются', demote.status === 200 && a1d.role === 'ENGINEER_AUTO' && a1d.positionCode === 'ENGINEER_AUTO' && !JSON.parse(a1d.permissions || '{}')['admin.users.manage'], a1d);
    check('повышение сотрудника владельцем сохраняет должности', (await call('PUT', `/api/users/${a1.id}`, { accessLevel: 'ADMIN' }, 'owner')).status === 200 && (await row('a1')).role === 'ADMIN' && (await row('a1')).positionCode === 'ENGINEER_AUTO');
    await call('PUT', `/api/users/${a1.id}`, { accessLevel: 'EMPLOYEE' }, 'owner');
    const legacyAdmin = await prisma.user.create({ data: { id: 'old-admin', symbol: 'old-admin', password: 'x', name: 'Старый Админ', role: 'ADMIN' } });
    check('старого администратора без должности нельзя снять с уровня, не назвав должность', (await call('PUT', `/api/users/${legacyAdmin.id}`, { accessLevel: 'EMPLOYEE' }, 'owner')).status === 400);
    check('правка без должностей (срок, активность) старого администратора не трогает', (await call('PUT', `/api/users/${legacyAdmin.id}`, { isActive: true }, 'owner')).status === 200 && (await row('old-admin')).role === 'ADMIN');
    check('сотрудник не меняет собственные должности', (await call('PUT', `/api/users/${e1.id}`, { positionCode: 'MANAGER' }, 'eng')).status === 403);

    console.log('6. Правка должностей сотрудника');
    const patch = await call('PUT', `/api/users/${e1.id}`, { positionCode: 'MANAGER', extraPositions: ['ENGINEER_VENT', 'CAD'] });
    const e1b = await row('e1');
    check('основная и дополнительные меняются вместе, role следует за основной', patch.status === 200 && e1b.role === 'MANAGER' && e1b.extraPositions === '["ENGINEER_VENT","CAD"]', e1b);
    check('основная, ставшая дополнительной, — отказ', (await call('PUT', `/api/users/${e1.id}`, { positionCode: 'CAD' })).status === 400);
    check('старый вызов с role меняет основную должность', (await call('PUT', `/api/users/${e1.id}`, { role: 'ENGINEER_AUTO', extraPositions: ['ENGINEER_VENT'] })).status === 200 && (await row('e1')).role === 'ENGINEER_AUTO');
    const cleared = await call('PUT', `/api/users/${e1.id}`, { extraPositions: [] });
    check('пустой список снимает дополнительные', cleared.status === 200 && (await row('e1')).extraPositions === null);
    await call('PUT', `/api/users/${e1.id}`, { positionCode: 'ENGINEER_VENT', extraPositions: ['ENGINEER_AUTO'] });

    console.log('7. Права набора должностей на сервере и штамп сессии');
    const loader = async (code: string) => (await prisma.role.findUnique({ where: { code } }))?.permissions ?? null;
    const e1c = await row('e1');
    const eff = JSON.parse((await positionPermissionsString(e1c, loader)) || '{}');
    check('основная даёт своё, дополнительная добавляет своё', eff['tags.manage']?.enabled && eff['equipment.manage']?.enabled && eff['e3.export']?.enabled, eff);
    const list = (await call('GET', '/api/users')).json as any[];
    const listed1 = JSON.parse(list.find((u) => u.id === e1c.id).rolePermissions);
    check('список сотрудников отдаёт права набора должностей', listed1['equipment.manage']?.enabled === true && listed1['tags.manage']?.enabled === true);
    check('профиль с этими правами проходит can() для расширенного права', can({ ...e1c, rolePermissions: JSON.stringify(eff) } as any, 'equipment.manage') && !can({ ...e1c, rolePermissions: JSON.stringify(eff) } as any, 'project.manage'));
    const stamp1 = credentialStamp(e1c, await positionPermissionsString(e1c, loader));
    await call('PUT', `/api/users/${e1c.id}`, { extraPositions: ['MANAGER'] });
    const e1d = await row('e1');
    const stamp2 = credentialStamp(e1d, await positionPermissionsString(e1d, loader));
    check('смена дополнительных должностей меняет штамп — сессия и кэш сбрасываются', stamp1 !== stamp2);
    const legacyPlain = await prisma.user.create({ data: { id: 'legacy-1', symbol: 'legacy-1', password: 'x', name: 'Старый Сотрудник', role: 'MANAGER' } });
    check('у записи до разделения штамп и права как раньше (без должностей в штампе)', (await positionPermissionsString(legacyPlain, loader)) === grant('project.manage') && credentialStamp(legacyPlain, grant('project.manage')) === credentialStamp({ ...legacyPlain, positionCode: null, extraPositions: null }, grant('project.manage')));

    console.log('8. Удаление должности: назначенную — нельзя, хоть как дополнительную');
    const cad = await prisma.role.findUnique({ where: { code: 'CAD' } });
    await call('PUT', `/api/users/${e1c.id}`, { extraPositions: ['CAD'] });
    const blockedExtra = await call('DELETE', `/api/roles/${cad.id}`, undefined, 'keeper');
    check('назначена дополнительной — удалить нельзя', blockedExtra.status === 400 && /дополнительной/.test(blockedExtra.json.message), blockedExtra.json);
    await call('PUT', `/api/users/${e1c.id}`, { extraPositions: [] });
    const calc = await prisma.role.findUnique({ where: { code: 'CALC' } });
    await prisma.user.create({ data: { id: 'calc-1', symbol: 'calc-1', password: 'x', name: 'Расчётчик', role: 'CALC', positionCode: 'CALC' } });
    check('назначена основной — удалить нельзя', (await call('DELETE', `/api/roles/${calc.id}`, undefined, 'keeper')).status === 400);
    await prisma.user.create({ data: { id: 'calc-2', symbol: 'calc-2', password: 'x', name: 'Старый расчётчик', role: 'CALC' } });
    await prisma.user.delete({ where: { id: 'calc-1' } });
    check('запись до разделения (только role) тоже считается назначением', (await call('DELETE', `/api/roles/${calc.id}`, undefined, 'keeper')).status === 400);
    await prisma.user.delete({ where: { id: 'calc-2' } });
    check('после снятия со всех — удаляется', (await call('DELETE', `/api/roles/${calc.id}`, undefined, 'keeper')).status === 200 && (await call('DELETE', `/api/roles/${cad.id}`, undefined, 'owner')).status === 200);
    const mgr = await prisma.role.findUnique({ where: { code: 'MANAGER' } });
    check('встроенную должность не удалить, даже свободную', (await call('DELETE', `/api/roles/${(await prisma.role.findUnique({ where: { code: 'ENGINEER_AUTO' } })).id}`, undefined, 'owner')).status === 400 && !!mgr);

    console.log('9. Импорт: колонка «Должность» сопоставляется с названием');
    check('названия сравниваются без регистра и е/ё', positionKey('  ИНЖЕНЕР  овик ') === positionKey('инженер ОВиК') && positionKey('Ёлка') === positionKey('елка'));
    const positionRows = [{ code: 'ENGINEER_VENT', name: 'Инженер ОВиК' }, { code: 'MANAGER', name: 'Менеджер проектов' }];
    const mapped = mapEmployeeRows([['Логин', 'Фамилия', 'Имя', 'Должность'], ['i1', 'А', 'Б', 'инженер овик'], ['i2', 'В', 'Г', 'Главный энергетик'], ['i3', 'Д', 'Е', 'Менеджер ПРОЕКТОВ']], { symbol: 0, lastName: 1, firstName: 2, position: 3 }, [], 'ENGINEER_VENT', 'create', 'OWNER', positionRows);
    check('совпало с названием — основная должность (код), текста подписи нет', mapped[0].values.role === 'ENGINEER_VENT' && mapped[0].values.position === '' && mapped[2].values.role === 'MANAGER');
    check('нет совпадения — как раньше: текст подписи, должность по умолчанию', mapped[1].values.position === 'Главный энергетик' && mapped[1].values.role === 'ENGINEER_VENT');
    const adminImport = mapEmployeeRows([['Логин', 'Фамилия', 'Имя', 'Роль'], ['i4', 'А', 'Б', 'ADMIN']], { symbol: 0, lastName: 1, firstName: 2, role: 3 }, [], 'ENGINEER_VENT', 'create', 'OWNER', positionRows);
    check('импорт не назначает уровень администратора, даже владельцу', !!adminImport[0].error);
    const matrix = [['Логин', 'Фамилия', 'Имя', 'Должность'], ['imp1', 'Импортов', 'Иван', 'менеджер проектов'], ['imp2', 'Импортов', 'Пётр', 'Кладовщик']];
    const mapping = { symbol: 0, lastName: 1, firstName: 2, position: 3 };
    const preview = await call('POST', '/api/users/import/preview', { rows: matrix, mapping, mode: 'create', defaultRole: 'ENGINEER_VENT' }, 'owner');
    check('предпросмотр импорта: две строки без ошибок', preview.status === 200 && preview.json.rows.length === 2 && preview.json.rows.every((r: any) => !r.error), preview.json);
    check('ADMIN как должность по умолчанию — отказ', (await call('POST', '/api/users/import/preview', { rows: matrix, mapping, mode: 'create', defaultRole: 'ADMIN' }, 'owner')).status === 400);
    const applied = await call('POST', '/api/users/import/apply', { rows: matrix, mapping, mode: 'create', defaultRole: 'ENGINEER_VENT', selected: [2, 3], createDepartments: [] }, 'owner');
    const imp1 = await row('imp1'); const imp2 = await row('imp2');
    check('импорт: совпавшая должность — positionCode и role, не совпавшая — текст position и должность по умолчанию',
      applied.status === 200 && imp1.positionCode === 'MANAGER' && imp1.role === 'MANAGER' && !imp1.position && imp2.position === 'Кладовщик' && imp2.positionCode === 'ENGINEER_VENT', { applied: applied.json, imp1, imp2 });

    console.log(`\nПройдено проверок: ${checks}`);
  } finally {
    if (listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
