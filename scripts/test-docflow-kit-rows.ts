/** Строки комплектов: настоящий HTTP и одноразовая SQLite. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setBroadcaster, setPrisma } from '../server/context.js';
import { registerDocflowKitRoutes } from '../server/routes/docflowKits.js';
import { readSettings, writeSettings, copyPlan, applyCopy, undoLast } from '../server/docflowSettings.js';
import { normalizeDocflowConfig } from '../shared/docflow/config.js';
import { checkName } from '../shared/docflow/nameMask.js';
import { itemContext, rowForCheck } from '../server/docflowLinks.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-docflow-kits-'));
const database = path.join(directory, 'fixture.sqlite');
const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${database}` }) });
let passed = 0;
const check = (name: string, condition: unknown) => { assert.ok(condition, name); passed++; console.log(`✓ ${name}`); };
const grants = (view: boolean, edit: boolean) => JSON.stringify({
  'docflow.view': { enabled: view, until: null }, 'docflow.edit': { enabled: edit, until: null },
});
const item = (docType: string, unit = 'tag') => ({
  docType, stage: 'Р', unit, necessity: 'required', responsibleRole: '', milestone: '', workdays: 0, condition: null,
});

async function main() {
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => {
    const id = String(req.headers['x-user'] || 'admin');
    req.authUser = id === 'admin' ? { id, role: 'ADMIN' } : { id, role: 'USER', permissions: grants(id !== 'no-view', id !== 'no-view' && id !== 'view-only') };
    next();
  });
  registerDocflowKitRoutes(app);
  const server = await new Promise<any>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (method: string, url: string, body?: any, user = 'admin') => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-user': user }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) as any };
  };
  try {
    await bootstrapLocalDatabase(database, db, fs.readFileSync('prisma/schema.prisma', 'utf8'), () => {});
    setPrisma(db); setBroadcaster(() => {});
    await db.project.createMany({ data: [{ id: 'a', name: 'А' }, { id: 'b', name: 'Б' }] });
    await db.projectMember.createMany({ data: ['no-view', 'view-only', 'editor', 'editor2'].map(userId => ({ projectId: 'a', userId })).concat([{ projectId: 'b', userId: 'foreign' }]) });
    await db.docRegister.createMany({ data: [{ id: 'reg-a', projectId: 'a', name: 'Реестр А', poNumber: 'PO' }, { id: 'reg-b', projectId: 'b', name: 'Реестр Б' }] });
    await db.catalogClass.create({ data: { id: 'fan-class', code: 'FAN' } });
    await db.equipment.create({ data: { id: 'fan', type: 'FAN', catalogClassId: 'fan-class' } });
    await db.docflowSettings.create({ data: { projectId: 'a', config: JSON.stringify({
      vdrTypes: [{ code: 'E02', titleRu: 'Общий вид', titleEn: '', stage: 'Р' }, { code: 'C32', titleRu: 'Опросный лист', titleEn: '', stage: 'Р' }],
      kits: [{ classId: 'fan-class', items: [item('E02'), item('C32')] }],
    }) } });
    await db.tag.createMany({ data: [
      { id: 'a1', identifier: 'A-1', projectId: 'a', equipmentId: 'fan' },
      { id: 'a2', identifier: 'A-2', projectId: 'a', equipmentId: 'fan' },
      { id: 'b1', identifier: 'B-1', projectId: 'b', equipmentId: 'fan' },
    ] });
    check('создание тегов не создаёт строки ВДР', await db.docRegisterItem.count() === 0 && await db.docflowKitRow.count() === 0);
    const list = '/api/docflow/tags?projectId=a';
    const request = { projectId: 'a', registerId: 'reg-a', tagIds: ['a1'], stage: 'Р', fields: { 'установка': 'UNIT' } };
    const planPath = '/api/docflow/kits/plan';
    check('без просмотра список тегов закрыт', (await send('GET', list, undefined, 'no-view')).status === 403);
    for (const action of ['plan', 'apply', 'undo']) {
      const body = action === 'plan' ? request : { projectId: 'a', planId: 'missing' };
      check(`без просмотра ${action} закрыт`, (await send('POST', `/api/docflow/kits/${action}`, body, 'no-view')).status === 403);
      check(`без редактирования ${action} закрыт`, (await send('POST', `/api/docflow/kits/${action}`, body, 'view-only')).status === 403);
    }
    check('чужой проект закрыт', (await send('GET', '/api/docflow/tags?projectId=b', undefined, 'editor')).status === 403);
    check('чужой тег в плане закрыт', (await send('POST', planPath, { ...request, tagIds: ['b1'] }, 'editor')).status === 403);
    check('чужой реестр в плане закрыт', (await send('POST', planPath, { ...request, registerId: 'reg-b' }, 'editor')).status === 403);
    const before = await db.docRegisterItem.count();
    const plan = await send('POST', planPath, request, 'editor');
    check('план создан без записи строк и связей', plan.status === 200 && typeof plan.body.id === 'string' && await db.docRegisterItem.count() === before && await db.docflowKitRow.count() === 0 && await db.docRegisterItemTag.count() === 0);
    check('предпросмотр предлагает недостающие документы', plan.body.rows.filter((row: any) => row.action === 'create').length === 2);
    const applied = await send('POST', '/api/docflow/kits/apply', { projectId: 'a', planId: plan.body.id }, 'editor');
    check('применение создаёт две строки', applied.status === 200 && await db.docRegisterItem.count() === 2 && await db.docflowKitRow.count() === 2);
    const ownerLast = await send('GET', list, undefined, 'editor');
    const otherLast = await send('GET', list, undefined, 'editor2');
    check('последний план показывается только автору', ownerLast.body.lastPlanId === plan.body.id && otherLast.body.lastPlanId === null);
    await db.docRegisterItemTag.create({ data: { itemId: applied.body.changes[0].itemId, tagId: 'deleted-tag', tagIdentifier: 'Удалённый тег' } });
    const removedOverview = await send('GET', list, undefined, 'editor');
    check('удалённый тег сохраняет историческую строку', removedOverview.body.tags.some((t: any) => t.id === 'deleted-tag' && t.removed === true && t.identifier === 'Удалённый тег' && t.items.some((i: any) => i.id === applied.body.changes[0].itemId)));
    await db.docRegisterItemTag.deleteMany({ where: { tagId: 'deleted-tag' } });

    check('новые строки связаны с тегом', await db.docRegisterItemTag.count({ where: { tagId: 'a1' } }) === 2);
    check('повтор применения не плодит строки', (await send('POST', '/api/docflow/kits/apply', { projectId: 'a', planId: plan.body.id }, 'editor')).status === 200 && await db.docRegisterItem.count() === 2);
    check('отмена удаляет только созданные строки', (await send('POST', '/api/docflow/kits/undo', { projectId: 'a', planId: plan.body.id }, 'editor')).status === 200 && await db.docRegisterItem.count() === 0 && await db.docflowKitRow.count() === 0);
    const overview = await send('GET', `${list}&tagId=a1`, undefined, 'view-only');
    check('просмотр возвращает выбранный тег и нужные документы', overview.status === 200 && overview.body.tags.length === 1 && overview.body.tags[0].requirements.length === 2 && overview.body.totals.needed === 2);
    check('чужой тег в просмотре закрыт', (await send('GET', `${list}&tagId=b1`, undefined, 'editor')).status === 403);
    const first = await send('POST', planPath, request, 'editor');
    const second = await send('POST', planPath, request, 'editor2');
    const raced = await Promise.all([
      send('POST', '/api/docflow/kits/apply', { projectId: 'a', planId: first.body.id }, 'editor'),
      send('POST', '/api/docflow/kits/apply', { projectId: 'a', planId: second.body.id }, 'editor2'),
    ]);
    check('одновременные планы создают строки только один раз', raced.map(r => r.status).sort().join(',') === '200,409' && await db.docflowKitRow.count() === 2 && await db.docRegisterItem.count() === 2);
    const winner = raced[0].status === 200 ? { plan: first, actor: 'editor' } : { plan: second, actor: 'editor2' };
    check('чужой автор не может отменить план', (await send('POST', '/api/docflow/kits/undo', { projectId: 'a', planId: winner.plan.body.id }, winner.actor === 'editor' ? 'editor2' : 'editor')).status === 403);
    check('чужой проект не может использовать план', (await send('POST', '/api/docflow/kits/apply', { projectId: 'b', planId: winner.plan.body.id }, 'admin')).status === 403);
    check('отмена победившего плана', (await send('POST', '/api/docflow/kits/undo', { projectId: 'a', planId: winner.plan.body.id }, winner.actor)).status === 200);
    await db.docRegisterItem.create({ data: { id: 'manual', projectId: 'a', registerId: 'reg-a', vdrCode: 'E02', contractorNo: 'MANUAL', titleRu: 'Ручная строка' } });
    await db.docRegisterItemTag.create({ data: { itemId: 'manual', tagId: 'a1', tagIdentifier: 'A-1' } });
    const reuse = await send('POST', planPath, request, 'editor');
    check('существующая ручная строка распознана', reuse.status === 200 && reuse.body.rows.some((r: any) => r.docType === 'E02' && r.action === 'keep' && r.itemId === 'manual'));
    check('применение не дублирует ручную строку', (await send('POST', '/api/docflow/kits/apply', { projectId: 'a', planId: reuse.body.id }, 'editor')).status === 200 && await db.docRegisterItem.count() === 2);
    check('отмена сохраняет ручную строку', (await send('POST', '/api/docflow/kits/undo', { projectId: 'a', planId: reuse.body.id }, 'editor')).status === 200 && !!await db.docRegisterItem.findUnique({ where: { id: 'manual' } }));
    await db.docRegisterItemTag.deleteMany({ where: { itemId: 'manual' } }); await db.docRegisterItem.delete({ where: { id: 'manual' } });
    const stalePlan = await send('POST', planPath, request, 'editor');
    await db.tag.update({ where: { id: 'a1' }, data: { brand: 'Новая марка' } });
    check('устаревший план не применяется', (await send('POST', '/api/docflow/kits/apply', { projectId: 'a', planId: stalePlan.body.id }, 'editor')).status === 409 && await db.docRegisterItem.count() === 0);
    const changed = await send('POST', planPath, request, 'editor');
    const changedApply = await send('POST', '/api/docflow/kits/apply', { projectId: 'a', planId: changed.body.id }, 'editor');
    const changedId = changedApply.body.changes[0].itemId;
    await db.docRegisterItem.update({ where: { id: changedId }, data: { titleRu: 'Ручная правка', updatedAt: new Date(Date.now() + 1000) } });
    check('отмена не затирает последующую правку и атомарна', (await send('POST', '/api/docflow/kits/undo', { projectId: 'a', planId: changed.body.id }, 'editor')).status === 409 && await db.docRegisterItem.count() === 2 && (await db.docRegisterItem.findUnique({ where: { id: changedId } })).titleRu === 'Ручная правка');
    await db.docRegisterItemTag.deleteMany({}); await db.docflowKitRow.deleteMany({}); await db.docRegisterItem.deleteMany({});
    const filePlan = await send('POST', planPath, request, 'editor');
    const fileApply = await send('POST', '/api/docflow/kits/apply', { projectId: 'a', planId: filePlan.body.id }, 'editor');
    check('план файла применяется', fileApply.status === 200 && fileApply.body.changes?.length === 2);
    const fileItem = fileApply.body.changes[0].itemId;
    check('строка без файла не считается документом', (await send('GET', `${list}&tagId=a1`, undefined, 'editor')).body.totals.existing === 0);
    const fileLink = await db.docFileLink.create({ data: { itemId: fileItem, projectId: 'a', revision: 'A', folderKey: 'f'.repeat(64), relativePath: 'fixture.pdf', fileName: 'fixture.pdf' } });
    check('файл текущей ревизии считается документом', (await send('GET', `${list}&tagId=a1`, undefined, 'editor')).body.totals.existing === 1);
    await db.docFileLink.update({ where: { id: fileLink.id }, data: { lostAt: new Date() } });
    check('потерянный файл не считается документом', (await send('GET', `${list}&tagId=a1`, undefined, 'editor')).body.totals.existing === 0);
    await db.docFileLink.update({ where: { id: fileLink.id }, data: { lostAt: null } });
    check('отмена не удаляет строки с привязанным файлом', (await send('POST', '/api/docflow/kits/undo', { projectId: 'a', planId: filePlan.body.id }, 'editor')).status === 409 && await db.docRegisterItem.count() === 2);
    await db.docFileLink.deleteMany({}); await db.docRegisterItemTag.deleteMany({}); await db.docflowKitRow.deleteMany({}); await db.docRegisterItem.deleteMany({});
    // Шифр имени использует код реестра, как и последующая проверка файла.
    const filenameConfig = normalizeDocflowConfig({ vdrTypes: [{ code: 'E02', titleRu: 'Вид', titleEn: '' }],
      kits: [{ classId: 'fan-class', items: [item('E02')] }], masks: { file: '{проект}_{шифр}_{ред}' } });
    await db.project.update({ where: { id: 'a' }, data: { code: 'PROJECT' } });
    await db.docRegister.update({ where: { id: 'reg-a' }, data: { contractorProjectNo: 'REGISTER' } });
    await db.docflowSettings.update({ where: { projectId: 'a' }, data: { config: JSON.stringify(filenameConfig) } });
    const fileNamePlan = await send('POST', planPath, request, 'editor');
    check('план с полем проекта в имени создан', fileNamePlan.status === 200 && fileNamePlan.body.rows[0]?.action === 'create');
    const fileNameApply = await send('POST', '/api/docflow/kits/apply', { projectId: 'a', planId: fileNamePlan.body.id }, 'editor');
    check('план с полем проекта применён', fileNameApply.status === 200);
    const actualContext = await itemContext(db, fileNameApply.body.changes[0].itemId);
    const nameCheck = checkName(filenameConfig, fileNamePlan.body.rows[0].fileName, rowForCheck(actualContext));
    check('имя из предпросмотра совпадает с кодом проекта реестра', nameCheck.fields.some(field => field.field === 'проект' && field.state === 'match'));
    check('тестовая строка с именем отменена', (await send('POST', '/api/docflow/kits/undo', { projectId: 'a', planId: fileNamePlan.body.id }, 'editor')).status === 200);
    const noGroupConfig = normalizeDocflowConfig({ vdrTypes: [{ code: 'E02', titleRu: 'Вид', titleEn: '' }], kits: [{ classId: 'fan-class', items: [item('E02', 'group')] }] });
    await db.docflowSettings.update({ where: { projectId: 'a' }, data: { config: JSON.stringify(noGroupConfig) } });
    const noGroup = await send('POST', planPath, { ...request, tagIds: ['a1', 'a2'] }, 'editor');
    check('неизвестная установка даёт отдельную строку отказа каждому тегу', noGroup.status === 200 && noGroup.body.rows.length === 2 && noGroup.body.rows.every((row: any) => row.action === 'skip' && row.tagIds.length === 1 && row.problem) && noGroup.body.rows.flatMap((row: any) => row.tagIds).sort().join(',') === 'a1,a2');
    await db.role.create({ data: { code: 'KIT_ENGINEER', name: 'Исполнитель' } });
    await db.user.create({ data: { id: 'assigned', symbol: 'assigned', name: 'Исполнитель', password: 'fixture', role: 'KIT_ENGINEER' } });
    await db.projectMember.create({ data: { projectId: 'a', userId: 'assigned' } });
    await db.equipmentSystem.create({ data: { id: 'group-a', name: 'U1', projectId: 'a' } });
    await db.monoblock.create({ data: { id: 'mono-a', name: 'M1', systemId: 'group-a' } });
    for (const id of ['a1', 'a2']) await db.componentElement.create({ data: { id: `component-${id}`, name: id, itemCode: id, monoblockId: 'mono-a', equipType: 'FAN', specs: JSON.stringify({ groups: [{ title: 'Двигатель', params: [{ key: 'Мощность', value: '1' }] }] }), tags: { connect: { id } } } });
    const config = normalizeDocflowConfig({
      vdrTypes: [{ code: 'E02', titleRu: 'Общий вид', titleEn: '', stage: 'Р' }, { code: 'C32', titleRu: 'Опросный лист', titleEn: '', stage: 'Р' }, { code: 'E03', titleRu: 'Группа', titleEn: '', stage: 'Р' }, { code: 'E04', titleRu: 'Проект', titleEn: '', stage: 'Р' }],
      kits: [{ classId: 'fan-class', items: [item('E02'), { ...item('C32'), stage: 'П' }, { ...item('E03', 'group'), condition: { parameter: 'Двигатель||Мощность', operator: 'equals', value: '1' }, responsibleRole: 'KIT_ENGINEER', milestone: 'M', workdays: 2 }, item('E04', 'project')] }],
      deadlines: { milestones: [{ code: 'M', label: 'Поставка', date: '2026-11-06' }], byType: [] },
    });
    await db.docflowSettings.update({ where: { projectId: 'a' }, data: { config: JSON.stringify(config) } });
    const groupReq = { ...request, tagIds: ['a1', 'a2'] };
    const groupPlan = await send('POST', planPath, groupReq, 'editor');
    check('стадия Р исключает документы стадии П', groupPlan.status === 200 && !groupPlan.body.rows.some((r: any) => r.docType === 'C32'));
    const groupRow = groupPlan.body.rows.find((r: any) => r.docType === 'E03');
    const projectRow = groupPlan.body.rows.find((r: any) => r.docType === 'E04');
    check('группа и проект дают по одной строке на два тега', groupPlan.body.rows.filter((r: any) => r.docType === 'E03').length === 1 && groupRow.scopeId === 'group-a' && groupRow.tagIds.length === 2 && groupPlan.body.rows.filter((r: any) => r.docType === 'E04').length === 1 && projectRow.scopeId === 'a' && projectRow.tagIds.length === 2);
    check('условие, ответственный и два рабочих дня', groupRow.action === 'create' && groupRow.assigneeId === 'assigned' && groupRow.dueDate === '2026-11-10T00:00:00.000Z');
    const groupApply = await send('POST', '/api/docflow/kits/apply', { projectId: 'a', planId: groupPlan.body.id }, 'editor');
    check('групповые и проектные строки связываются с обоими тегами', groupApply.status === 200 && await db.docRegisterItemTag.count() === 6 && await db.docflowKitRow.count() === 4);
    const reservation = await db.docflowKitRow.findFirst({ where: { projectId: 'a', docType: 'E03' } });
    await db.docRegisterItem.create({ data: { id: 'unique-probe', projectId: 'a', registerId: 'reg-a' } });
    await assert.rejects(db.docflowKitRow.create({ data: { projectId: 'a', unit: reservation.unit, scopeId: reservation.scopeId, docType: reservation.docType, itemId: 'unique-probe', cipher: 'OTHER' } })); passed++; console.log('✓ БД отклоняет повтор unit/scope/type');
    await assert.rejects(db.docflowKitRow.create({ data: { projectId: 'a', unit: 'tag', scopeId: 'other', docType: 'OTHER', itemId: 'unique-probe', cipher: reservation.cipher } })); passed++; console.log('✓ БД отклоняет повтор шифра в проекте');
    await assert.rejects(db.docflowKitRow.create({ data: { projectId: 'a', unit: 'tag', scopeId: 'other', docType: 'OTHER', itemId: reservation.itemId, cipher: 'OTHER' } })); passed++; console.log('✓ БД не резервирует одну строку дважды');
    await db.docRegisterItem.delete({ where: { id: 'unique-probe' } });

    check('групповая операция отменяется', (await send('POST', '/api/docflow/kits/undo', { projectId: 'a', planId: groupPlan.body.id }, 'editor')).status === 200);
    const conditional = structuredClone(config);
    assert.ok(conditional.kits[0].items[2].condition);
    conditional.kits[0].items[2].condition.value = '2';
    await db.docflowSettings.update({ where: { projectId: 'a' }, data: { config: JSON.stringify(conditional) } });
    const skipped = await send('POST', planPath, groupReq, 'editor');
    check('невыполненное условие не создаёт документ', skipped.status === 200 && skipped.body.rows.find((r: any) => r.docType === 'E03')?.action === 'skip');
    const stageP = await send('POST', planPath, { ...request, stage: 'П' }, 'editor');
    check('стадия П выбирает только её документы', stageP.status === 200 && stageP.body.rows.length === 1 && stageP.body.rows[0].docType === 'C32');
    const overviewP = await send('GET', `${list}&tagId=a1&stage=П`, undefined, 'editor');
    check('стадия П фильтрует обзор', overviewP.status === 200 && overviewP.body.tags[0].requirements.length === 1 && overviewP.body.tags[0].requirements[0].docType === 'C32');
    check('неизвестная стадия обзора отклоняется', (await send('GET', `${list}&stage=X`, undefined, 'editor')).status === 400);
    for (const [label, change] of [
      ['лишнее поле комплекта', (c: any) => { c.kits[0].items[0].unknown = true; }],
      ['неизвестная должность', (c: any) => { c.kits[0].items[0].responsibleRole = 'UNKNOWN_ROLE'; }],
      ['неизвестная веха', (c: any) => { c.kits[0].items[0].milestone = 'UNKNOWN_MILESTONE'; }],
      ['неизвестный тип документа', (c: any) => { c.kits[0].items[0].docType = 'UNKNOWN_DOC'; }],
    ] as const) {
      const invalid: any = structuredClone(config); change(invalid);
      await assert.rejects(writeSettings(db, { projectId: 'a', config: invalid, expected: (await readSettings(db, 'a')).updatedAt, actorId: 'admin' }), (e: any) => e.status === 400, label);
      passed++; console.log(`✓ ${label} отклоняется при записи`);
    }

    const broken = structuredClone(config); broken.kits[0].classId = 'missing-class';
    await db.docflowSettings.update({ where: { projectId: 'a' }, data: { config: JSON.stringify(broken) } });
    check('чтение отклоняет ссылку на неизвестный класс', (await send('GET', list, undefined, 'editor')).status === 400);
    const brokenVersion = (await readSettings(db, 'a')).updatedAt;
    await assert.rejects(writeSettings(db, { projectId: 'a', config: broken, expected: brokenVersion, actorId: 'admin' }), (error: any) => error.status === 400); passed++; console.log('✓ запись настроек с неизвестным классом отклоняется');
    await assert.rejects(copyPlan(db, 'b', { projectId: 'a' }, ['kits']), (error: any) => error.status === 400); passed++; console.log('✓ перенос не копирует неизвестный класс');
    await db.docflowSettings.update({ where: { projectId: 'a' }, data: { config: JSON.stringify(config) } });
    await db.docflowSettings.create({ data: { projectId: 'b', config: JSON.stringify({ ...config, kits: [] }) } });
    const beforeCopy = await readSettings(db, 'b');
    const copied = await applyCopy(db, { projectId: 'b', from: { projectId: 'a' }, sections: ['kits'], expected: beforeCopy.updatedAt, actorId: 'admin' });
    check('перенос сохраняет комплект и возможность отмены', copied.config.kits.length === 1 && copied.config.kits[0].items.length === 4 && copied.canUndo);
    const undoCopy = await undoLast(db, 'b', 'admin');
    check('отмена переноса возвращает прежний комплект', undoCopy.config.kits.length === 0);



  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.$disconnect(); fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(`Строки комплектов: ${passed} проверок прошли`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
