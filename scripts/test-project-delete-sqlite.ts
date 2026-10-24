/**
 * Настоящая SQLite: DELETE /api/projects/:id уносит всё проектное и ничего чужого.
 *
 * Почему набор нужен: в локальной SQLite внешних ключей почти нет, каскад из
 * схемы Prisma не срабатывает, и удаление проекта оставляло теги, установки,
 * позиции, файлы и привязки висеть без владельца — при уведомлении «всё удалено».
 *
 * Метод — сравнение целых баз, а не выборочные проверки: сперва заводим проект B,
 * снимаем число строк в КАЖДОЙ таблице, потом заводим проект A со всем
 * проектным, удаляем A и требуем, чтобы число строк в каждой таблице снова
 * равнялось снимку. Так ловится и сирота, и лишнее удаление, и новая таблица,
 * про которую удаление не знает.
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
import { registerProjectRoutes } from '../server/routes/projects.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const Database = require('better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-project-delete-'));
const dbPath = path.join(dir, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let checks = 0;
function check(label: string, condition: unknown, detail?: unknown) { assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); checks++; console.log(`✓ ${label}`); }

/** Число строк в каждой таблице (служебные таблицы SQLite не в счёт) */
function census(): Record<string, number> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r: any) => r.name);
    const out: Record<string, number> = {};
    for (const t of tables) out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as any).n;
    return out;
  } finally { db.close(); }
}
function diff(a: Record<string, number>, b: Record<string, number>): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const t of new Set([...Object.keys(a), ...Object.keys(b)])) if ((a[t] || 0) !== (b[t] || 0)) out[t] = [a[t] || 0, b[t] || 0];
  return out;
}

/** Всё проектное: по строке в каждой таблице, которую удаление обязано знать */
async function seedProject(p: string, tag: string, userId: string) {
  const id = (s: string) => `${tag}-${s}`;
  await prisma.project.create({ data: { id: p, name: `Project ${tag}`, code: tag } });
  const t1 = await prisma.tag.create({ data: { id: id('tag1'), identifier: `AHU-${tag}`, projectId: p } });
  await prisma.tag.create({ data: { id: id('tag2'), identifier: `AHU-${tag}-2`, projectId: p } });
  await prisma.tagChange.create({ data: { id: id('tagchange'), tagId: t1.id, projectId: p, kind: 'UPDATE' } });
  const system = await prisma.equipmentSystem.create({ data: { id: id('sys'), name: 'П1', projectId: p } });
  const mono = await prisma.monoblock.create({ data: { id: id('mono'), name: 'Моноблок', systemId: system.id } });
  const el = await prisma.componentElement.create({ data: { id: id('el'), name: 'Вентилятор', itemCode: 'FAN', monoblockId: mono.id, tags: { connect: [{ id: t1.id }] } } });
  await prisma.componentElement.create({ data: { id: id('el-child'), name: 'Двигатель', itemCode: 'MOT', monoblockId: mono.id, parentElementId: el.id } });
  await prisma.equipmentHistory.create({ data: { id: id('hist'), elementId: el.id, version: 1, changeType: 'EDIT' } });
  const source = await prisma.equipmentXmlSource.create({ data: { id: id('xmlsrc'), projectId: p, tagId: t1.id, targetType: 'ELEMENT', elementId: el.id, systemId: system.id, tagIdentifier: t1.identifier } });
  const cand = await prisma.equipmentXmlCandidate.create({ data: { id: id('xmlcand'), sourceId: source.id, projectId: p, revision: 'A', fileName: 'a.xml', sha256: `sha-${tag}`, parsedSpecs: '[]', changes: '[]', expectedVersion: 1 } });
  await prisma.equipmentXmlApplication.create({ data: { id: id('xmlapp'), batchId: id('batch'), candidateId: cand.id, sourceId: source.id, elementId: el.id, oldVersion: 1, newVersion: 2, beforeDecisions: '[]', afterDecisions: '[]', beforeStatus: 'NEW', afterStatus: 'APPLIED' } });

  const folder = await prisma.folder.create({ data: { id: id('folder'), name: 'Корень', projectId: p } });
  const sub = await prisma.folder.create({ data: { id: id('subfolder'), name: 'Вложенная', projectId: p, parentId: folder.id } });
  const file = await prisma.fileNode.create({ data: { id: id('file'), name: 'a.pdf', filePath: '/a.pdf', folderId: sub.id, mainTags: { connect: [{ id: t1.id }] }, additionalTags: { connect: [{ id: t1.id }] } } });
  await prisma.fileNode.create({ data: { id: id('file-trash'), name: 'старый.pdf', filePath: '/old.pdf', folderId: folder.id, deletedAt: new Date() } });
  await prisma.fileChunk.create({ data: { id: id('chunk'), fileId: file.id, idx: 0, data: Buffer.from('x') } });
  await prisma.fileVersion.create({ data: { id: id('fver'), fileId: file.id, data: Buffer.from('x') } });
  const markup = await prisma.pdfMarkup.create({ data: { id: id('markup'), fileId: file.id } });
  await prisma.pdfMarkupTransfer.create({ data: { markupId: markup.id, fileId: file.id } });
  await prisma.officeBlock.create({ data: { id: id('oblock'), fileId: file.id, name: 'Блок' } });
  await prisma.officeDocumentRevision.create({ data: { id: id('orev'), documentId: file.id, fileId: file.id, revision: 1, status: 'READY', sha256: 'x', sourceSha: 'y', data: Buffer.from('x') } });
  await prisma.officeSession.create({ data: { fileId: file.id, key: 'k' } });
  await prisma.officeEvent.create({ data: { id: id('oevent'), fileId: file.id, seq: 1, kind: 'op' } });
  await prisma.officePeer.create({ data: { socketId: id('peer'), fileId: file.id, serverId: 's', clientId: 'c', userId } });
  await prisma.officeHolder.create({ data: { fileId: file.id } });

  const doc = await prisma.constructorDoc.create({ data: { id: id('cdoc'), projectId: p } });
  await prisma.constructorDocVersion.create({ data: { id: id('cdocver'), docId: doc.id, version: 1 } });
  const register = await prisma.docRegister.create({ data: { id: id('reg'), projectId: p } });
  const item = await prisma.docRegisterItem.create({ data: { id: id('regitem'), registerId: register.id, projectId: p, fileNodeId: file.id } });
  await prisma.docRegisterItemRevision.create({ data: { id: id('regrev'), itemId: item.id, revision: 'A' } });

  const dict = await prisma.dictionary.create({ data: { id: id('dict'), projectId: p, name: 'Справочник' } });
  const di = await prisma.dictionaryItem.create({ data: { id: id('dictitem'), dictionaryId: dict.id, code: '1', nameRu: 'Один' } });
  await prisma.dictionaryItem.create({ data: { id: id('dictitem2'), dictionaryId: dict.id, code: '1.1', nameRu: 'Один-один', parentId: di.id } });
  await prisma.tagTemplate.create({ data: { id: id('tpl'), projectId: p, schemaJson: '{}' } });
  await prisma.projectTagPolicy.create({ data: { id: id('policy'), projectId: p } });
  await prisma.docFormula.create({ data: { id: id('formula'), projectId: p, name: 'f', kind: 'k' } });

  await prisma.termEntry.create({ data: { id: id('term'), projectId: p, ru: 'клапан' } });
  await prisma.tmUnit.create({ data: { id: id('tm'), projectId: p, src: 'a', dst: 'b' } });
  await prisma.transLink.create({ data: { id: id('tlink'), projectId: p, sourceDocId: file.id } });
  const ev = await prisma.calEvent.create({ data: { id: id('event'), projectId: p, startsAt: new Date(), endsAt: new Date() } });
  await prisma.calGuest.create({ data: { id: id('guest'), eventId: ev.id, userId } });
  await prisma.assistantChat.create({ data: { id: id('asst'), ownerId: userId, projectId: p } });
  await prisma.projectMember.create({ data: { id: id('member'), projectId: p, userId } });

  const group = await prisma.chatGroup.create({ data: { id: id('group'), name: 'Чат проекта', projectId: p, members: { connect: [{ id: userId }] } } });
  const msg = await prisma.chatMessage.create({ data: { id: id('msg'), content: 'привет', senderId: userId, chatGroupId: group.id } });
  await prisma.chatAttachment.create({ data: { id: id('att'), messageId: msg.id, fileName: 'f', filePath: '/f' } });
  await prisma.guideReply.create({ data: { id: id('guide'), messageId: msg.id, projectId: p } });
  // Личное сообщение со ссылкой на проект и позицию должно пережить проект, потеряв ссылки
  await prisma.chatMessage.create({ data: { id: id('dm'), content: 'личное', senderId: userId, receiverId: userId, linkedProjectId: p, linkedElementId: el.id } });

  const batch = await prisma.importBatch.create({ data: { id: id('ibatch'), projectId: p, category: 'tags', title: 'Импорт' } });
  await prisma.importJob.create({ data: { id: id('ijob'), batchId: batch.id, projectId: p, category: 'tags', fileName: 'x.xlsx', payloadJson: '{}', idemKey: id('idem') } });
  const list = await prisma.selectionList.create({ data: { id: id('sel'), projectId: p, classId: 'shared-class' } });
  await prisma.selectionItem.create({ data: { id: id('selitem'), listId: list.id, projectId: p } });
  await prisma.selectionIssue.create({ data: { id: id('selissue'), listId: list.id, projectId: p, rev: 'A' } });
  await prisma.selectionBatch.create({ data: { id: id('selbatch'), listId: list.id, projectId: p, title: 'Партия' } });
  const e3 = await prisma.e3Project.create({ data: { id: id('e3'), fluxProjectId: p, key: 'k' } });
  await prisma.e3Export.create({ data: { id: id('e3exp'), e3ProjectId: e3.id } });
  await prisma.e3Binding.create({ data: { id: id('e3bind'), e3ProjectId: e3.id, elementId: el.id } });

  // Настройки, привязанные к проекту и его позициям, и общие журналы привязок
  const setting = (key: string, value: string, userId: string | null = null) => prisma.appSetting.create({ data: { key, userId, value } });
  await setting(`e3_profile:${p}`, '{}');
  await setting(`e3_layout:${p}`, '{}');
  await setting(`equipment_catalog_binding:${el.id}`, '{}');
  await setting(`equipment_catalog_history:${el.id}:h1`, '{}', userId);
  await setting(`equipment_catalog_history:${el.id}:h2`, '{}', userId);
  return { tag: t1, el, file };
}

async function main() {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).authUser = { id: 'admin-1', role: 'ADMIN', name: 'Admin' }; next(); });
  const notified: string[] = [];
  registerProjectRoutes(app, {
    enforce: async () => true,
    notifyAll: async (_category, title) => { notified.push(title); },
  });
  const server = createServer(app); let listening = false;
  try {
    setDialect('sqlite');
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {}); setPrisma(prisma);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); listening = true;
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const del = (id: string) => fetch(`${base}/api/projects/${id}`, { method: 'DELETE' });

    await prisma.user.create({ data: { id: 'u-1', symbol: 'u1', password: 'x', name: 'User One' } });
    await prisma.catalogClass.create({ data: { id: 'shared-class', code: 'FAN' } });
    const pA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const pB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

    // Ориентир: проект B и общие данные. После удаления A база обязана вернуться ровно к нему.
    await seedProject(pB, 'B', 'u-1');
    // Журналы привязок содержат оба проекта: чужая запись обязана остаться
    const ledger = (projectIds: string[]) => JSON.stringify({ revision: 3, bindings: projectIds.map((projectId, i) => ({ id: `bind-${i}`, locationKey: `k${i}`, projectId, label: 'L', actorId: 'admin-1', at: '2026-01-01' })), undo: [] });
    const binding = (projectId: string) => ({ id: `eb-${projectId}`, projectId, kind: 'document', fileName: 'f.xlsx' });
    await prisma.appSetting.create({ data: { key: 'explorer_project_bindings:shared:v1', userId: '__shared__', value: ledger([pB]) } });
    await prisma.appSetting.create({ data: { key: `equipment_document_bindings:project:v2:${encodeURIComponent(pB)}`, userId: '__shared__', value: JSON.stringify({ revision: 1, bindings: [binding(pB)], undo: [] }) } });
    const baseline = census();

    const seeded = await seedProject(pA, 'A', 'u-1');
    await prisma.appSetting.update({ where: { key_userId: { key: 'explorer_project_bindings:shared:v1', userId: '__shared__' } }, data: { value: ledger([pB, pA]) } });
    await prisma.appSetting.create({ data: { key: `equipment_document_bindings:project:v2:${encodeURIComponent(pA)}`, userId: '__shared__', value: JSON.stringify({ revision: 1, bindings: [binding(pA)], undo: [] }) } });
    const afterSeed = census();
    const touched = Object.keys(diff(baseline, afterSeed));
    // Страховка набора: если схема получила новую проектную таблицу, а заполнение её не знает, список ниже придётся обновить осознанно
    const expectedTables = ['Tag', 'TagChange', 'EquipmentSystem', 'Monoblock', 'ComponentElement', 'EquipmentHistory', 'EquipmentXmlSource', 'EquipmentXmlCandidate', 'EquipmentXmlApplication', 'Folder', 'FileNode', 'FileChunk', 'FileVersion', 'PdfMarkup', 'PdfMarkupTransfer', 'OfficeBlock', 'OfficeDocumentRevision', 'OfficeSession', 'OfficeEvent', 'OfficePeer', 'OfficeHolder', 'ConstructorDoc', 'ConstructorDocVersion', 'DocRegister', 'DocRegisterItem', 'DocRegisterItemRevision', 'Dictionary', 'DictionaryItem', 'TagTemplate', 'ProjectTagPolicy', 'DocFormula', 'TermEntry', 'TmUnit', 'TransLink', 'CalEvent', 'CalGuest', 'AssistantChat', 'ProjectMember', 'ChatGroup', 'ChatMessage', 'ChatAttachment', 'GuideReply', 'ImportBatch', 'ImportJob', 'SelectionList', 'SelectionItem', 'SelectionIssue', 'SelectionBatch', 'E3Project', 'E3Export', 'E3Binding', 'Project', 'AppSetting', '_ComponentElementToTag', '_FileMainTags', '_FileAdditionalTags', '_GroupMembers'];
    check('проект A заполнен во всех проектных таблицах и скрытых таблицах связей', expectedTables.every(t => touched.includes(t)), expectedTables.filter(t => !touched.includes(t)));
    check('сам проект и его данные стоят в базе до удаления', afterSeed.Project === 2 && afterSeed.Tag === 4);

    const res = await del(pA);
    const body = await res.json() as any;
    check('DELETE отвечает успехом и возвращает счёт удалённого', res.status === 200 && body.success === true && body.removed && body.removed.tag === 2 && body.removed.project === 1, body);
    check('уведомление отправлено один раз', notified.length === 1 && notified[0].includes('Project A'));

    // Личное сообщение со ссылкой на проект и позицию должно пережить проект, потеряв ссылки
    const dm = await prisma.chatMessage.findUnique({ where: { id: 'A-dm' } });
    check('личное сообщение со ссылкой на проект пережило проект и потеряло ссылки', !!dm && dm.linkedProjectId === null && dm.linkedElementId === null, dm);
    await prisma.chatMessage.delete({ where: { id: 'A-dm' } });

    const afterDelete = census();
    check('в каждой таблице строк ровно столько же, сколько до заведения проекта A', Object.keys(diff(baseline, afterDelete)).length === 0, diff(baseline, afterDelete));
    check('проект B цел: строки на месте, ссылки внутри него не потеряны', (await prisma.tag.count({ where: { projectId: pB } })) === 2
      && (await prisma.componentElement.count({ where: { monoblock: { systemId: 'B-sys' } } })) === 2
      && (await prisma.fileNode.count({ where: { folder: { projectId: pB } } })) === 2
      && (await prisma.chatMessage.count({ where: { chatGroupId: 'B-group' } })) === 1);
    check('связи проекта B в скрытых таблицах целы', afterDelete._FileMainTags === 1 && afterDelete._ComponentElementToTag === 1 && afterDelete._GroupMembers === 1, afterDelete);
    check('общий справочник и пользователь не тронуты', (await prisma.catalogClass.count({ where: { id: 'shared-class' } })) === 1 && (await prisma.user.count({ where: { id: 'u-1' } })) === 1);

    const folderLedger = JSON.parse((await prisma.appSetting.findFirst({ where: { key: 'explorer_project_bindings:shared:v1' } }))!.value);
    check('привязки папок: запись проекта A снята, запись B осталась, ревизия выросла', folderLedger.bindings.length === 1 && folderLedger.bindings[0].projectId === pB && folderLedger.revision === 4, folderLedger);
    const docLedgerA = await prisma.appSetting.count({ where: { key: `equipment_document_bindings:project:v2:${encodeURIComponent(pA)}` } });
    const docLedgerB = await prisma.appSetting.count({ where: { key: `equipment_document_bindings:project:v2:${encodeURIComponent(pB)}` } });
    check('привязки документов: журнал A снят, журнал B остался', docLedgerA === 0 && docLedgerB === 1);

    // Повторное удаление: проекта уже нет — не ошибка, и база не меняется
    const again = await del(pA);
    const againBody = await again.json() as any;
    check('повторное удаление не падает и ничего не меняет', again.status === 200 && againBody.success === true && Object.keys(diff(afterDelete, census())).length === 0, againBody);
    check('о повторном удалении никого не уведомляли', notified.length === 1);
    const never = await del('00000000-0000-4000-8000-000000000000');
    check('удаление несуществующего проекта тоже не ошибка', never.status === 200);

    // Служебный проект («Общий диск») удалять нельзя: в нём файлы всего отдела
    await prisma.project.create({ data: { id: 'sys-disk', name: 'Общий диск', system: true } });
    await prisma.folder.create({ data: { id: 'sys-folder', name: 'Диск', projectId: 'sys-disk' } });
    const sys = await del('sys-disk');
    check('служебный проект не удаляется, его папки целы', sys.status === 400 && (await prisma.project.count({ where: { id: 'sys-disk' } })) === 1 && (await prisma.folder.count({ where: { id: 'sys-folder' } })) === 1);

    // Атомарность: сбой посреди удаления откатывает всё, проект остаётся целым
    const pC = 'cccccccc-3333-4333-8333-cccccccccccc';
    await seedProject(pC, 'C', 'u-1');
    const beforeFail = census();
    const dbRaw = new Database(dbPath);
    dbRaw.exec(`CREATE TRIGGER fail_project_delete BEFORE DELETE ON "Project" BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`);
    dbRaw.close();
    const failed = await del(pC);
    check('сбой на последнем шаге даёт 500', failed.status === 500);
    check('после сбоя в базе ни одной потерянной строки', Object.keys(diff(beforeFail, census())).length === 0, diff(beforeFail, census()));
    const dbRaw2 = new Database(dbPath);
    dbRaw2.exec('DROP TRIGGER fail_project_delete');
    dbRaw2.close();
    const retried = await del(pC);
    check('после снятия сбоя удаление проходит', retried.status === 200 && (await prisma.project.count({ where: { id: pC } })) === 0);
    void seeded;
    console.log(`\nВсе проверки пройдены: ${checks}`);
  } finally {
    if (listening) await new Promise(resolve => server.close(resolve));
    await prisma.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exit(1); });
