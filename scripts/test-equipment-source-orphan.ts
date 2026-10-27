/**
 * Привязка XML и удаление установки (SQLite, настоящие маршруты).
 *
 * Сценарий владельца: установку удалили, привязка XML осталась. Проверка и
 * повторный импорт того же файла отвечали 409. Здесь два пути:
 *  - новое удаление само снимает привязку и её запись в журнале;
 *  - привязку, осиротевшую раньше, импорт переиспользует, а проверка и список
 *    называют причину вместо 409.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setBroadcaster, setPrisma } from '../server/context.js';
import { registerEquipmentSourceImportRoutes } from '../server/routes/equipmentSourceImport.js';
import { registerEquipmentDocumentBindingRoutes } from '../server/routes/equipmentDocumentBindings.js';
import { registerEquipmentXmlSourceRoutes } from '../server/routes/equipmentXmlSources.js';
import { registerEquipmentDraftRoutes } from '../server/routes/equipmentDraft.js';
import { registerTagRoutes } from '../server/routes/tags.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-equipment-source-orphan-'));
const dbPath = path.join(root, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
const check = (label: string, value: unknown) => { assert.ok(value, label); checks++; console.log(`✓ ${label}`); };
const PROJECT = 'orphan-project';

const makeBody = (tagIdentifier: string, fileName: string, value = '1200') => {
  const xml = `<root><system name="${tagIdentifier}" title="${tagIdentifier}"><group title="Основные"><param name="Расход установки" unit="м³/ч">1200</param></group><monoblock name="M1"><block name="B1" title="Вентилятор"><param name="Расход" unit="м³/ч">${value}</param></block></monoblock></system></root>`;
  const bytes = Buffer.from(xml, 'utf8');
  return { projectId: PROJECT, category: 'AHU', tagIdentifier, fileName, revision: 'B', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
};

async function main() {
  let server: any;
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);
    setBroadcaster(() => {});
    await prisma.project.create({ data: { id: PROJECT, name: 'Orphan fixture' } });
    const app = express(); app.use(express.json({ limit: '24mb' }));
    app.use((req, _res, next) => { (req as any).authUser = { id: 'orphan-user', role: 'ADMIN', isActive: true }; next(); });
    registerEquipmentSourceImportRoutes(app);
    registerEquipmentDocumentBindingRoutes(app);
    registerEquipmentXmlSourceRoutes(app);
    registerEquipmentDraftRoutes(app);
    const io: any = { emit() {}, to() { return io; }, in() { return io; } };
    registerTagRoutes(app, { io, notifyAll: async () => {} } as any);
    server = await new Promise<any>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const json = (method: string, url: string, body?: unknown) => fetch(`${origin}${url}`, {
      method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const importXml = async (body: ReturnType<typeof makeBody>) => {
      const preview = await json('POST', '/api/equipment/source-import/preview', body);
      assert.equal(preview.status, 200, (await preview.clone().text()).slice(0, 400));
      const planned = await preview.json();
      const applied = await json('POST', '/api/equipment/source-import/apply', { ...body, previewToken: planned.previewToken });
      return { planned, applied, body: await applied.clone().json().catch(() => ({})) };
    };
    const bindings = async () => (await json('GET', `/api/equipment/projects/${PROJECT}/document-bindings`)).json();

    // ── Новое удаление: привязка уходит вместе с установкой ───────────────────
    const a = makeBody('3700-B01-AS-001A', '3700-B01-AS-001A-B.xml');
    const first = await importXml(a);
    assert.equal(first.applied.status, 200, JSON.stringify(first.body));
    const firstSource = first.body.source;
    check('первый импорт создал установку, привязку XML и запись в журнале', !!firstSource.sourceId
      && (await bindings()).bindings.some((row: any) => row.xmlSourceId === firstSource.sourceId));
    const beforeDelete = await bindings();

    const removed = await json('DELETE', `/api/systems/${firstSource.systemId}`);
    assert.equal(removed.status, 200, (await removed.clone().text()).slice(0, 300));
    const removedBody = await removed.json();
    check('удаление установки сообщает, какие привязки сняты', removedBody.detachedSources?.some((row: any) => row.sourceId === firstSource.sourceId && row.elementId === firstSource.elementId));
    const goneSource = await prisma.equipmentXmlSource.findUnique({ where: { id: firstSource.sourceId } });
    check('привязка снята отметкой, а не стёрта: история ревизий остаётся', !!goneSource?.deletedAt);
    const afterDelete = await bindings();
    check('запись привязки ушла из журнала, а журнал сохранил прежнее состояние для возврата', afterDelete.bindings.length === 0
      && afterDelete.revision === beforeDelete.revision + 1
      && (await prisma.appSetting.findFirst({ where: { key: { startsWith: 'equipment_document_bindings:project:v2:' } } }))!.value.includes(firstSource.sourceId));
    const listed = await (await json('GET', `/api/equipment/projects/${PROJECT}/sources`)).json();
    check('окно обновлений не видит ни источника, ни сироты', listed.sources.length === 0 && listed.orphans.length === 0);

    const again = await importXml(a);
    assert.equal(again.applied.status, 200, JSON.stringify(again.body));
    check('тот же XML после удаления установки загружается заново', again.body.source.sourceId !== firstSource.sourceId && again.body.source.systemId !== firstSource.systemId);
    check('новая привязка получила базовую ревизию B', (await prisma.equipmentXmlSource.findUnique({ where: { id: again.body.source.sourceId } }))?.lastImportedRevision === 'B');
    check('в журнале ровно одна живая привязка этой установки', (await bindings()).bindings.filter((row: any) => row.xmlSourceId === again.body.source.sourceId).length === 1);

    // ── Осиротевшая раньше привязка: установка удалена без снятия привязки ─────
    const secondSystem = again.body.source;
    const monoIds = (await prisma.monoblock.findMany({ where: { systemId: secondSystem.systemId } })).map((row: any) => row.id);
    await prisma.$transaction(async (tx: any) => {
      await tx.componentElement.deleteMany({ where: { monoblockId: { in: monoIds } } });
      await tx.monoblock.deleteMany({ where: { systemId: secondSystem.systemId } });
      await tx.equipmentSystem.delete({ where: { id: secondSystem.systemId } });
    });
    check('исходное состояние владельца: установки нет, привязка есть', !(await prisma.equipmentSystem.findUnique({ where: { id: secondSystem.systemId } }))
      && !(await prisma.equipmentXmlSource.findUnique({ where: { id: secondSystem.sourceId } }))!.deletedAt);

    const checkOrphan = await json('POST', `/api/equipment/projects/${PROJECT}/sources/${secondSystem.sourceId}/check`, { ...a, revision: 'B' });
    const checkText = (await checkOrphan.json()).error as string;
    check('проверка сироты отвечает не 409 и называет причину', checkOrphan.status === 410 && /Установка этого источника удалена/.test(checkText));
    const orphanList = await (await json('GET', `/api/equipment/projects/${PROJECT}/sources`)).json();
    check('список источников отдаёт сироту отдельно, как «Установка удалена»', orphanList.sources.length === 0
      && orphanList.orphans.length === 1 && orphanList.orphans[0].sourceId === secondSystem.sourceId);

    const rePreview = await json('POST', '/api/equipment/source-import/preview', a);
    assert.equal(rePreview.status, 200, (await rePreview.clone().text()).slice(0, 400));
    const rePlan = await rePreview.json();
    check('предпросмотр заранее сообщает, что прежняя привязка будет заменена', rePlan.replacesOrphanBinding?.sourceId === secondSystem.sourceId);
    const reApply = await json('POST', '/api/equipment/source-import/apply', { ...a, previewToken: rePlan.previewToken });
    const reBody = await reApply.json();
    assert.equal(reApply.status, 200, JSON.stringify(reBody));
    check('повторный импорт того же XML проходит при осиротевшей привязке', reBody.success === true && reBody.source.systemId !== secondSystem.systemId);
    check('привязка переиспользована: тот же ID, новая установка и позиция', reBody.source.sourceId === secondSystem.sourceId);
    const reused = await prisma.equipmentXmlSource.findUnique({ where: { id: secondSystem.sourceId } });
    check('после переиспользования привязка указывает на живую установку и несёт базу ревизии', reused?.systemId === reBody.source.systemId
      && reused?.elementId === reBody.source.elementId && reused?.lastImportedSha256 === a.sha256 && !reused?.deletedAt);
    const afterReuse = await (await json('GET', `/api/equipment/projects/${PROJECT}/sources`)).json();
    check('после повторного импорта источник снова обычный, сирот нет', afterReuse.sources.length === 1 && afterReuse.orphans.length === 0);
    check('в журнале по-прежнему одна запись этого источника', (await bindings()).bindings.filter((row: any) => row.xmlSourceId === secondSystem.sourceId).length === 1);

    // ── «Убрать привязку»: DELETE источника сироты чистит и журнал ────────────
    const third = reBody.source;
    const thirdMonos = (await prisma.monoblock.findMany({ where: { systemId: third.systemId } })).map((row: any) => row.id);
    await prisma.$transaction(async (tx: any) => {
      await tx.componentElement.deleteMany({ where: { monoblockId: { in: thirdMonos } } });
      await tx.monoblock.deleteMany({ where: { systemId: third.systemId } });
      await tx.equipmentSystem.delete({ where: { id: third.systemId } });
    });
    const removeBinding = await json('DELETE', `/api/equipment/projects/${PROJECT}/sources/${third.sourceId}`);
    assert.equal(removeBinding.status, 200, (await removeBinding.clone().text()).slice(0, 300));
    const finalList = await (await json('GET', `/api/equipment/projects/${PROJECT}/sources`)).json();
    check('«Убрать привязку» снимает сироту из списка и из журнала', finalList.orphans.length === 0
      && !(await bindings()).bindings.some((row: any) => row.xmlSourceId === third.sourceId));

    console.log(`\nПроверок: ${checks}`);
  } finally {
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
