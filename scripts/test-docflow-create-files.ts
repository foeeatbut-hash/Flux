/** Создание файлов ДО: HTTP, настоящий журнал папок и отдельная SQLite. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setBroadcaster, setPrisma } from '../server/context.js';
import { registerProjectFolderBindingRoutes } from '../server/routes/projectFolderBindings.js';
import { registerDocflowCreateFileRoutes } from '../server/routes/docflowCreateFiles.js';
import { vdrPermissionFor } from '../server/vdrPermissions.js';
import { pathKeyOf } from '../server/docflowLinks.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-docflow-create-files-'));
const file = path.join(dir, 'fixture.sqlite');
const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
let passed = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`✓ ${name}`); };
const WORK = 'a'.repeat(64); const FOREIGN = 'b'.repeat(64);
const grants = (view: boolean, files: boolean) => JSON.stringify({ 'docflow.view': { enabled: view, until: null }, 'docflow.files': { enabled: files, until: null }, 'docflow.edit': { enabled: false, until: null } });

async function main() {
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => {
    const id = String(req.headers['x-user'] || 'admin');
    req.authUser = id === 'admin' ? { id, role: 'ADMIN' } : { id, role: 'USER', permissions: grants(id !== 'no-view' && id !== 'files-no-view', id !== 'no-view' && id !== 'view-only') };
    next();
  });
  registerProjectFolderBindingRoutes(app, { mayManage: async () => true });
  registerDocflowCreateFileRoutes(app);
  const server = await new Promise<any>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (method: string, url: string, body?: any, user = 'admin') => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-user': user }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) as any };
  };
  const endpoint = '/api/docflow/create-files';
  const post = (action: string, body: any, user = 'editor') => send('POST', `${endpoint}/${action}`, body, user);
  const payload = { projectId: 'a', itemIds: ['i1', 'i2'], format: 'docx' };
  const bytes = (ids: string[]) => ids.map(itemId => ({ itemId, sha256: 'c'.repeat(64), size: 123 }));
  try {
    await bootstrapLocalDatabase(file, db, fs.readFileSync('prisma/schema.prisma', 'utf8'), () => {});
    setPrisma(db); setBroadcaster(() => {});
    await db.project.createMany({ data: [{ id: 'a', name: 'А' }, { id: 'b', name: 'Б' }] });
    await db.projectMember.createMany({ data: ['no-view', 'files-no-view', 'view-only', 'editor', 'editor2'].map(userId => ({ projectId: 'a', userId })).concat([{ projectId: 'b', userId: 'foreign' }]) });
    await db.docRegister.createMany({ data: [{ id: 'reg-a', projectId: 'a', name: 'А', poNumber: '3700' }, { id: 'reg-b', projectId: 'b', name: 'Б' }] });
    for (const [id, projectId, registerId, contractorNo] of [['i1', 'a', 'reg-a', '3700-B01-E02-001'], ['i2', 'a', 'reg-a', '3700-B01-E02-002'], ['foreign', 'b', 'reg-b', '3700-B01-E02-003']] as const)
      await db.docRegisterItem.create({ data: { id, projectId, registerId, contractorNo, vdrCode: 'E02', revision: 'A' } });
    await db.docflowSettings.create({ data: { projectId: 'a', config: JSON.stringify({ vdrTypes: [{ code: 'E02', titleRu: 'Вид', titleEn: '', template: 'templates/fixture.docx' }] }) } });
    const locator = (key: string) => ({ folderKey: key, anchors: [{ key, relativePath: '' }] });
    for (const [index, projectId, locationKey] of [[0, 'a', WORK], [1, 'b', FOREIGN]] as const) {
      const r = await send('POST', '/api/explorer/project-bindings', { expectedRevision: index, operation: { kind: 'upsert', binding: { locationKey, projectId, label: 'Рабочая', purpose: 'work', locator: locator(locationKey) } } });
      check(`штатная привязка рабочей папки ${projectId}`, r.status === 200);
    }
    for (const action of ['plan', 'claim', 'complete', 'state', 'undo-plan', 'undo', 'cancel']) {
      const method = action === 'state' ? 'GET' : 'POST';
      const rule = vdrPermissionFor(method, `${endpoint}/${action}`);
      check(`таблица прав ${action}: files + view`, rule?.perm === 'docflow.files' && rule.also?.some(x => x.perm === 'docflow.view') && !rule.also?.some(x => x.perm === 'docflow.edit'));
      const url = action === 'state' ? `${endpoint}/state?projectId=a&planId=missing` : `${endpoint}/${action}`;
      const body = action === 'plan' ? payload : { projectId: 'a', planId: 'missing', files: [] };
      check(`нет просмотра: ${action}`, (await send(method, url, method === 'GET' ? undefined : body, 'no-view')).status === 403);
      check(`право файлов без просмотра: ${action}`, (await send(method, url, method === 'GET' ? undefined : body, 'files-no-view')).status === 403);
      check(`нет права файлов: ${action}`, (await send(method, url, method === 'GET' ? undefined : body, 'view-only')).status === 403);
    }
    await db.project.create({ data: { id: 'c', name: 'Без рабочей папки' } });
    await db.projectMember.create({ data: { projectId: 'c', userId: 'editor' } });
    await db.docRegister.create({ data: { id: 'reg-c', projectId: 'c', name: 'C' } });
    await db.docRegisterItem.create({ data: { id: 'item-c', projectId: 'c', registerId: 'reg-c', contractorNo: '3700-B01-E02-004', vdrCode: 'E02', revision: 'A' } });
    check('чужая рабочая папка не используется для проекта без папки', (await post('plan', { ...payload, projectId: 'c', itemIds: ['item-c'] })).status === 422);
    check('чужой проект закрыт', (await post('plan', { ...payload, projectId: 'b', itemIds: ['foreign'] })).status === 403);
    check('чужая строка в плане закрыта', (await post('plan', { ...payload, itemIds: ['foreign'] })).status === 403);
    check('несуществующий проект отклоняется', (await post('plan', { ...payload, projectId: 'missing-project' })).status === 404);
    check('несуществующий план отклоняется', (await post('complete', { projectId: 'a', planId: 'missing' })).status === 404);
    check('несуществующая строка отклоняется', (await post('plan', { ...payload, itemIds: ['missing-item'] })).status === 404);
    check('неизвестный формат отклоняется', (await post('plan', { ...payload, format: 'exe' })).status === 400);
    const noTemplate = await post('plan', { ...payload, format: 'xlsx', useTemplates: false });
    check('отказ от шаблона использует выбранный формат', noTemplate.status === 200 && noTemplate.body.rows.every((row: any) => row.template === '' && row.format === 'xlsx' && row.fileName.endsWith('_A.xlsx')));
    for (const format of ['pdf', 'txt']) { const candidate = await post('plan', { ...payload, format, useTemplates: false }); check(`выбранный ${format} сохраняется`, candidate.status === 200 && candidate.body.rows.every((row: any) => row.format === format && row.fileName.endsWith(`_A.${format}`))); }
    const plan = await post('plan', payload);
    check('план доступен с files без edit', plan.status === 200 && typeof plan.body.id === 'string' && plan.body.rows.length === 2);
    check('план не создаёт ссылки', await db.docFileLink.count() === 0 && plan.body.rows.every((row: any) => row.action === 'create' && row.folderKey === WORK && row.fileName.endsWith('_A.docx')));
    check('маска, ревизия и шаблон определяют точный путь', plan.body.rows.every((row: any) => row.template === 'templates/fixture.docx' && row.relativePath === `E02/${row.fileName}` && row.revision === 'A' && row.format === 'docx'));
    check('чужой автор не видит план', (await send('GET', `${endpoint}/state?projectId=a&planId=${plan.body.id}`, undefined, 'editor2')).status === 403);
    check('план нельзя использовать в чужом проекте', (await post('claim', { projectId: 'b', planId: plan.body.id, files: bytes(['i1', 'i2']) }, 'admin')).status === 403);
    check('чужой item в резерве отклонён', (await post('claim', { projectId: 'a', planId: plan.body.id, files: bytes(['i1', 'foreign']) })).status >= 400 && await db.docFileLink.count() === 0);
    check('некорректная контрольная сумма отклонена', (await post('claim', { projectId: 'a', planId: plan.body.id, files: [{ itemId: 'i1', sha256: 'bad', size: 12 }, ...bytes(['i2'])] })).status === 400);

    const claim = await post('claim', { projectId: 'a', planId: plan.body.id, files: bytes(['i1', 'i2']) });
    check('резерв не создаёт ссылки', claim.status === 200 && await db.docFileLink.count() === 0);
    check('повтор резерва идемпотентен', (await post('claim', { projectId: 'a', planId: plan.body.id, files: bytes(['i1', 'i2']) })).status === 200 && await db.docflowPlan.count({ where: { kind: 'file-create-claim' } }) === 4);
    check('подмена байтов после резерва отклонена', (await post('claim', { projectId: 'a', planId: plan.body.id, files: [{ itemId: 'i1', sha256: 'd'.repeat(64), size: 123 }, ...bytes(['i2'])] })).status === 409);

    const state = await send('GET', `${endpoint}/state?projectId=a&planId=${plan.body.id}`, undefined, 'editor');
    check('state показывает незавершённый резерв', state.status === 200 && state.body.state === 'preview' && state.body.rows.length === 2);
    const complete = await post('complete', { projectId: 'a', planId: plan.body.id });
    check('подтверждение атомарно создаёт две связи', complete.status === 200 && complete.body.count === 2 && await db.docFileLink.count({ where: { unlinkedAt: null } }) === 2);
    const lastOwn = await send('GET', `${endpoint}/state?projectId=a&last=1`, undefined, 'editor');
    const lastItem = await send('GET', `${endpoint}/state?projectId=a&last=1&itemId=i1`, undefined, 'editor');
    const lastOther = await send('GET', `${endpoint}/state?projectId=a&last=1&itemId=i1`, undefined, 'editor2');
    check('последний пакет доступен автору после открытия окна', lastOwn.status === 200 && lastOwn.body.id === plan.body.id && lastItem.body.id === plan.body.id);
    check('другой автор не видит последний пакет', lastOther.status === 200 && lastOther.body === null);
    check('последний пакет не раскрывает чужую строку', (await send('GET', `${endpoint}/state?projectId=a&last=1&itemId=foreign`, undefined, 'editor')).status === 403);

    check('повтор подтверждения идемпотентен', (await post('complete', { projectId: 'a', planId: plan.body.id })).status === 200 && await db.docFileLink.count() === 2);
    const again = await post('plan', payload);
    check('уже связанные файлы открываются', again.status === 200 && again.body.rows.every((row: any) => row.action === 'open'));
    check('отмена применённого плана невозможна через cancel', (await post('cancel', { projectId: 'a', planId: plan.body.id })).status !== 200);
    check('предпросмотр отмены доступен', (await post('undo-plan', { projectId: 'a', planId: plan.body.id })).status === 200);
    check('отмена сохраняет историю связей', (await post('undo', { projectId: 'a', planId: plan.body.id })).status === 200 && await db.docFileLink.count({ where: { unlinkedAt: null } }) === 0 && await db.docFileLink.count() === 2);
    for (const id of ['path-one', 'path-two']) await db.docRegisterItem.create({ data: { id, projectId: 'a', registerId: 'reg-a', contractorNo: '3700-B01-E02-099', vdrCode: 'E02', revision: 'A' } });
    const pathFirst = await post('plan', { ...payload, itemIds: ['path-one'] }, 'editor');
    const pathSecond = await post('plan', { ...payload, itemIds: ['path-two'] }, 'editor2');
    check('разные строки дают одинаковый целевой путь', pathFirst.status === 200 && pathSecond.status === 200 && pathFirst.body.rows[0].relativePath === pathSecond.body.rows[0].relativePath);
    check('резерв первого пути создаётся', (await post('claim', { projectId: 'a', planId: pathFirst.body.id, files: bytes(['path-one']) }, 'editor')).status === 200);
    check('резерв того же пути для другого item заблокирован', (await post('claim', { projectId: 'a', planId: pathSecond.body.id, files: bytes(['path-two']) }, 'editor2')).status === 409);
    check('первый файл подтверждён', (await post('complete', { projectId: 'a', planId: pathFirst.body.id }, 'editor')).status === 200);
    check('путь занятой связью строки нельзя планировать повторно', (await post('plan', { ...payload, itemIds: ['path-two'] }, 'editor2')).status === 409);
    check('отмена освобождает занятый путь', (await post('undo', { projectId: 'a', planId: pathFirst.body.id }, 'editor')).status === 200);
    await db.docRegisterItem.create({ data: { id: 'issued', projectId: 'a', registerId: 'reg-a', contractorNo: '3700-B01-E02-098', vdrCode: 'E02', revision: 'A', status: 'ISSUED' } });
    check('новый файл выданной строки не создаётся', (await post('plan', { ...payload, itemIds: ['issued'] })).status === 409);
    const racePayload = { ...payload, itemIds: ['i1'] };
    const p1 = await post('plan', racePayload, 'editor');
    const p2 = await post('plan', racePayload, 'editor2');
    check('оба автора видят новый план', p1.status === 200 && p2.status === 200 && p1.body.rows[0].action === 'create' && p2.body.rows[0].action === 'create');
    const races = await Promise.all([
      post('claim', { projectId: 'a', planId: p1.body.id, files: bytes(['i1']) }, 'editor'),
      post('claim', { projectId: 'a', planId: p2.body.id, files: bytes(['i1']) }, 'editor2'),
    ]);
    check('одновременный резерв получает один автор', races.map(r => r.status).sort().join(',') === '200,409' && await db.docFileLink.count({ where: { unlinkedAt: null } }) === 0);
    check('резервирует и item/revision, и путь', await db.docflowPlan.count({ where: { kind: 'file-create-claim' } }) === 2);
    const winning = races[0].status === 200 ? { plan: p1, actor: 'editor' } : { plan: p2, actor: 'editor2' };
    const prepare = await post('cancel', { projectId: 'a', planId: winning.plan.body.id, prepareOnly: true }, winning.actor);
    check('предварительная отмена сохраняет оба резерва', prepare.status === 200 && await db.docflowPlan.count({ where: { kind: 'file-create-claim' } }) === 2);
    const target = winning.plan.body.rows[0];
    await db.docFileLink.create({ data: { id: 'manual-path', itemId: 'i2', projectId: 'a', revision: 'A', role: 'file', folderKey: target.folderKey, relativePath: target.relativePath.toUpperCase(), fileName: target.fileName.toUpperCase(), pathKey: pathKeyOf(target.folderKey, target.relativePath.toUpperCase()) } });
    check('preflight видит назначенный путь без учёта регистра', (await post('cancel', { projectId: 'a', planId: winning.plan.body.id, prepareOnly: true }, winning.actor)).status === 409 && await db.docflowPlan.count({ where: { kind: 'file-create-claim' } }) === 2);
    check('cancel повторно проверяет занятый путь', (await post('cancel', { projectId: 'a', planId: winning.plan.body.id }, winning.actor)).status === 409 && await db.docflowPlan.count({ where: { kind: 'file-create-claim' } }) === 2);
    await db.docFileLink.delete({ where: { id: 'manual-path' } });

    check('cancel снимает резервы без ссылки', (await post('cancel', { projectId: 'a', planId: winning.plan.body.id }, winning.actor)).status === 200 && await db.docflowPlan.count({ where: { kind: 'file-create-claim' } }) === 0 && await db.docFileLink.count({ where: { unlinkedAt: null } }) === 0);
    const expired = await post('plan', racePayload);
    check('план для проверки срока создан', expired.status === 200);
    const stored = await db.docflowPlan.findUnique({ where: { id: expired.body.id } });
    check('срок предпросмотра 15 минут', Math.abs(stored.expiresAt.getTime() - stored.createdAt.getTime() - 15 * 60000) < 2000);
    await db.docflowPlan.update({ where: { id: expired.body.id }, data: { expiresAt: new Date(0) } });
    check('истёкший план нельзя резервировать', (await post('claim', { projectId: 'a', planId: expired.body.id, files: bytes(['i1']) })).status === 410);
    const oldReserve = await post('plan', racePayload, 'editor');
    check('план устаревающего резерва создан', oldReserve.status === 200 && (await post('claim', { projectId: 'a', planId: oldReserve.body.id, files: bytes(['i1']) }, 'editor')).status === 200);
    await db.docflowPlan.updateMany({ where: { kind: 'file-create-claim' }, data: { expiresAt: new Date(0) } });
    const afterExpiry = await post('plan', racePayload, 'editor2');
    check('новый план удаляет только истёкшие резервы', afterExpiry.status === 200 && await db.docflowPlan.count({ where: { kind: 'file-create-claim' } }) === 0);
    check('освобождённый после срока путь доступен другому автору', (await post('claim', { projectId: 'a', planId: afterExpiry.body.id, files: bytes(['i1']) }, 'editor2')).status === 200);
    check('устаревший автор не подтверждает чужой резерв', (await post('complete', { projectId: 'a', planId: oldReserve.body.id }, 'editor')).status >= 400 && await db.docFileLink.count({ where: { unlinkedAt: null } }) === 0);
    check('новый резерв отменяется', (await post('cancel', { projectId: 'a', planId: afterExpiry.body.id }, 'editor2')).status === 200);

    for (const [id, no] of [['atomic1', '010'], ['atomic2', '011'], ['changed-row', '012'], ['changed-file', '013'], ['changed-revision', '014'], ['changed-issued', '015']] as const)
      await db.docRegisterItem.create({ data: { id, projectId: 'a', registerId: 'reg-a', contractorNo: `3700-B01-E02-${no}`, vdrCode: 'E02', revision: 'A' } });
    const atomic = await post('plan', { ...payload, itemIds: ['atomic1', 'atomic2'] });
    check('план для проверки атомарности подготовлен', atomic.status === 200);
    check('резерв партии подготовлен', (await post('claim', { projectId: 'a', planId: atomic.body.id, files: bytes(['atomic1', 'atomic2']) })).status === 200);
    await db.docRegisterItem.update({ where: { id: 'atomic2' }, data: { titleRu: 'Новая правка', updatedAt: new Date(Date.now() + 1000) } });
    check('изменение второй строки откатывает всю запись партии', (await post('complete', { projectId: 'a', planId: atomic.body.id })).status === 409 && await db.docFileLink.count({ where: { itemId: { in: ['atomic1', 'atomic2'] } } }) === 0);
    for (const [id, no] of [['fault1', '016'], ['fault2', '017']] as const)
      await db.docRegisterItem.create({ data: { id, projectId: 'a', registerId: 'reg-a', contractorNo: `3700-B01-E02-${no}`, vdrCode: 'E02', revision: 'A' } });
    const injectedPlan = await post('plan', { ...payload, itemIds: ['fault1', 'fault2'] });
    check('план для ошибки внутри транзакции создан', injectedPlan.status === 200 && (await post('claim', { projectId: 'a', planId: injectedPlan.body.id, files: bytes(['fault1', 'fault2']) })).status === 200);
    const beforeFault = await db.docRegisterItem.findMany({ where: { id: { in: ['fault1', 'fault2'] } }, orderBy: { id: 'asc' }, select: { id: true, updatedAt: true } });
    let inserted = 0; let injected = false; let transactions = 0;
    const faultModel = (delegate: any) => new Proxy(delegate, { get(model, method, receiver) {
      if (method !== 'create') return Reflect.get(model, method, receiver);
      return async (args: any) => {
        if (inserted === 1) { injected = true; throw new Error('fixture: второй файл не записан'); }
        const result = await model.create(args); inserted++; return result;
      };
    } });
    const proxy = new Proxy(db, { get(target, property, receiver) {
      if (property === 'docFileLink') return faultModel(target.docFileLink);
      if (property !== '$transaction') return Reflect.get(target, property, receiver);
      return (callback: (tx: any) => Promise<any>, options: any) => (transactions++, target.$transaction((tx: any) => callback(new Proxy(tx, { get(txTarget, txProperty, txReceiver) {
        if (txProperty === '$transaction') return undefined;
        return txProperty === 'docFileLink' ? faultModel(txTarget.docFileLink) : Reflect.get(txTarget, txProperty, txReceiver);
      } })), options));
    } });
    setPrisma(proxy);
    let injectedResponse;
    try { injectedResponse = await post('complete', { projectId: 'a', planId: injectedPlan.body.id }); }
    finally { setPrisma(db); }
    const afterFault = await db.docRegisterItem.findMany({ where: { id: { in: ['fault1', 'fault2'] } }, orderBy: { id: 'asc' }, select: { id: true, updatedAt: true } });
    const remainingFaultLinks = await db.docFileLink.count({ where: { itemId: { in: ['fault1', 'fault2'] } } });
    assert.deepEqual({ status: injectedResponse.status, inserted, injected, remainingFaultLinks, transactions }, { status: 500, inserted: 1, injected: true, remainingFaultLinks: 0, transactions: 1 }, 'реальная первая вставка откатывается при ошибке второй'); passed++; console.log('✓ реальная первая вставка откатывается при ошибке второй');
    check('ошибка второй вставки откатывает версии обеих строк', JSON.stringify(afterFault) === JSON.stringify(beforeFault));
    check('после ошибки план и резервы сохранены для повтора', (await db.docflowPlan.findUnique({ where: { id: injectedPlan.body.id } })).state === 'preview' && await db.docflowPlan.count({ where: { kind: 'file-create-claim', actorId: 'editor' } }) >= 4);
    for (const id of ['changed-row', 'changed-file', 'changed-revision', 'changed-issued']) {
      const p = await post('plan', { ...payload, itemIds: [id] });
      check(`план для ${id}`, p.status === 200 && p.body.rows[0].action === 'create');
      check(`резерв для ${id}`, (await post('claim', { projectId: 'a', planId: p.body.id, files: bytes([id]) })).status === 200);
      check(`создание для ${id}`, (await post('complete', { projectId: 'a', planId: p.body.id })).status === 200);
      if (id === 'changed-row') await db.docRegisterItem.update({ where: { id }, data: { titleRu: 'Правка', updatedAt: new Date(Date.now() + 1000) } });
      if (id === 'changed-file') await db.docFileLink.updateMany({ where: { itemId: id, unlinkedAt: null }, data: { sha256: 'd'.repeat(64) } });
      if (id === 'changed-revision') await db.docRegisterItem.update({ where: { id }, data: { revision: 'B', updatedAt: new Date(Date.now() + 1000) } });
      if (id === 'changed-issued') await db.docRegisterItem.update({ where: { id }, data: { status: 'ISSUED', updatedAt: new Date(Date.now() + 1000) } });
      check(`последующая правка ${id} запрещает отмену`, (await post('undo', { projectId: 'a', planId: p.body.id })).status === 409 && await db.docFileLink.count({ where: { itemId: id, unlinkedAt: null } }) === 1);
    }


  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.$disconnect(); fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`Создание файлов ДО: ${passed} проверок прошли`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
