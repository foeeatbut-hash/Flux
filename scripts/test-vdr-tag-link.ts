/**
 * ВДР ↔ теги по id (docs/docflow-integration.md, этап A) на настоящей SQLite.
 *
 * Что держим:
 *  • схема: таблица связей создаётся, пара (строка, тег) уникальна;
 *  • перенос `equipmentTags` → связи: план (что свяжется, что нет — счётчик
 *    «не сопоставлено»), применение по отпечатку плана, повтор без дублей, отмена;
 *  • код без тега остаётся в строке и в счётчике, код с двумя тегами не угадывается;
 *  • переименование тега связь не рвёт: копия кода и JSON строки обновились,
 *    «Документы» у тега находят строку по id;
 *  • удалённый тег: связь остаётся с пометкой, строка цела;
 *  • правка кодов строки приводит связи к ним; удаление строки и реестра чистит связи;
 *  • обратный показ у тега и «на все позиции».
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import express from 'express';
import { registerVdrRoutes } from '../server/routes/vdr.js';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma, setBroadcaster } from '../server/context.js';
import { writeTag } from '../server/tagWrite.js';
import { judgeItemCodes, codesOfItem } from '../server/vdrTags.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-vdr-tag-link-'));
const dbPath = path.join(temp, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`✓ ${label}`);
};

async function main() {
  const app = express();
  app.use(express.json());
  registerVdrRoutes(app as any, { chunkBytes: async () => 1024 });
  const server = createServer(app);
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);
    setBroadcaster(() => {});

    // ── чистые правила ──
    {
      const tags = new Map([['ahu-2', [{ id: 't1', identifier: 'AHU-2' }]], ['dup-1', [{ id: 'a', identifier: 'DUP-1' }, { id: 'b', identifier: 'dup-1' }]]]);
      const v = judgeItemCodes(codesOfItem('[" ahu-2 ","AHU2","DUP-1","All items","все позиции",""]'), tags, []);
      check('«AHU-2» с пробелами и другим регистром находит тег, «AHU2» — нет (сходство по написанию не угадывается)',
        v.toLink.length === 1 && v.toLink[0].tagId === 't1' && v.unmatched.join() === 'AHU2', v);
      check('два тега под одним кодом — неоднозначность, не связь; «на все позиции» — не тег', v.ambiguous.join() === 'DUP-1' && v.generic === 2, v);
    }

    await prisma.project.create({ data: { id: 'p1', name: 'Проект 1' } });
    await prisma.project.create({ data: { id: 'p2', name: 'Проект 2' } });
    const tag = (id: string, identifier: string, projectId = 'p1') => prisma.tag.create({ data: { id, identifier, projectId } });
    await tag('t-ahu2', 'AHU-2'); await tag('t-ahu3', 'AHU-3'); await tag('t-dup-a', 'DUP-1'); await tag('t-dup-b', 'dup-1');
    await tag('t-other', 'AHU-2', 'p2'); // тот же код в другом проекте — не наш

    // Старые данные: строки с кодами в JSON и без связей (так лежало до этапа A)
    const reg = await prisma.docRegister.create({ data: { id: 'r1', projectId: 'p1', name: 'ВДР 1' } });
    const legacy = (id: string, no: string, tags: string[]) => prisma.docRegisterItem.create({ data: { id, registerId: reg.id, projectId: 'p1', contractorNo: no, titleRu: `Док ${no}`, equipmentTags: JSON.stringify(tags) } });
    await legacy('i1', 'D-1', ['AHU-2', 'FAN-9']);
    await legacy('i2', 'D-2', ['All items']);
    await legacy('i3', 'D-3', ['ahu-3']);
    await legacy('i4', 'D-4', ['DUP-1']);
    await legacy('i5', 'D-5', []);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const send = async (method: string, url: string, body?: any) => {
      const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    const links = async () => (await prisma.docRegisterItemTag.findMany({ orderBy: [{ itemId: 'asc' }, { tagId: 'asc' }] })).map((l: any) => `${l.itemId}:${l.tagId}`);
    const itemsOf = async () => (await send('GET', '/api/vdr/items?registerId=r1')).body.items as any[];

    // ── схема ──
    check('таблица связей создана, связей пока нет', (await links()).length === 0);
    await prisma.docRegisterItemTag.create({ data: { itemId: 'i5', tagId: 't-ahu2', tagIdentifier: 'AHU-2' } });
    let dupFailed = false;
    try { await prisma.docRegisterItemTag.create({ data: { itemId: 'i5', tagId: 't-ahu2', tagIdentifier: 'AHU-2' } }); } catch { dupFailed = true; }
    await prisma.docRegisterItemTag.deleteMany({ where: { itemId: 'i5' } });
    check('пара (строка, тег) уникальна', dupFailed);

    // ── план ──
    const planned = (await send('GET', '/api/vdr/tag-links?projectId=p1')).body.plan;
    check('план: связать AHU-2 (строка D-1) и ahu-3 (D-3)', planned.toLink.map((l: any) => `${l.itemNo}:${l.identifier}`).sort().join() === 'D-1:AHU-2,D-3:AHU-3', planned.toLink);
    check('план: счётчик «не сопоставлено» — FAN-9, а DUP-1 отдельно как неоднозначный', planned.unmatched.map((u: any) => u.code).join() === 'FAN-9' && planned.ambiguous.map((u: any) => u.code).join() === 'DUP-1', planned);
    check('план: «All items» не считается несопоставленным; строк с кодами 4', planned.generic === 1 && planned.items === 4, planned);
    check('план ничего не записал', (await links()).length === 0);

    // ── применение ──
    const wrong = await send('POST', '/api/vdr/tag-links/apply', { projectId: 'p1', digest: 'устарело' });
    check('применение с чужим отпечатком — 409 и новый план, ничего не записано', wrong.status === 409 && wrong.body.plan?.digest === planned.digest && (await links()).length === 0, wrong.body);
    const noDigest = await send('POST', '/api/vdr/tag-links/apply', { projectId: 'p1' });
    check('применение без отпечатка плана — 400', noDigest.status === 400);
    const applied = await send('POST', '/api/vdr/tag-links/apply', { projectId: 'p1', digest: planned.digest });
    check('применение: созданы две связи, у строк тот же JSON', applied.status === 200 && applied.body.created.length === 2
      && (await links()).join() === 'i1:t-ahu2,i3:t-ahu3' && JSON.parse((await prisma.docRegisterItem.findUnique({ where: { id: 'i1' } })).equipmentTags).join() === 'AHU-2,FAN-9', applied.body);
    check('после применения в плане нечего связывать, несопоставленное осталось', applied.body.plan.toLink.length === 0 && applied.body.plan.unmatched.length === 1 && applied.body.plan.alreadyLinked === 2);
    const again = await send('POST', '/api/vdr/tag-links/apply', { projectId: 'p1', digest: applied.body.plan.digest });
    check('повторное применение не создаёт дублей', again.status === 200 && again.body.created.length === 0 && (await links()).length === 2);
    const shown = (await itemsOf()).find((i: any) => i.id === 'i1');
    check('строка отдаёт связи и несопоставленные коды', shown.tagLinks.length === 1 && shown.tagLinks[0].tagId === 't-ahu2' && shown.unmatchedTags.join() === 'FAN-9', shown);

    // ── отмена ──
    const undone = await send('POST', '/api/vdr/tag-links/undo', { projectId: 'p1', created: applied.body.created });
    check('отмена снимает ровно созданные связи', undone.status === 200 && undone.body.removed === 2 && (await links()).length === 0 && undone.body.plan.toLink.length === 2, undone.body);
    const undoForeign = await send('POST', '/api/vdr/tag-links/undo', { projectId: 'p2', created: [{ itemId: 'i1', tagId: 't-ahu2' }] });
    check('отмена не трогает строки чужого проекта', undoForeign.body.removed === 0);
    await send('POST', '/api/vdr/tag-links/apply', { projectId: 'p1', digest: undone.body.plan.digest });
    check('связи применены заново', (await links()).join() === 'i1:t-ahu2,i3:t-ahu3');

    // ── обратный показ ──
    const byId = await send('GET', '/api/vdr/items/by-tag?projectId=p1&tagId=t-ahu2');
    check('у тега по id: строка D-1 и строка «на все позиции» D-2', byId.body.items.map((i: any) => i.contractorNo).sort().join() === 'D-1,D-2', byId.body.items);
    const byCode = await send('GET', '/api/vdr/items/by-tag?projectId=p1&tag=ahu-3');
    check('прежним клиентам: по коду сводится к тегу проекта', byCode.body.items.map((i: any) => i.contractorNo).sort().join() === 'D-2,D-3', byCode.body.items);

    // ── переименование ──
    await writeTag(prisma, 't-ahu2', { fields: { identifier: 'AHU-2A' } });
    check('переименование: копия кода в связи обновилась, связь по id цела',
      (await prisma.docRegisterItemTag.findFirst({ where: { tagId: 't-ahu2' } })).tagIdentifier === 'AHU-2A' && (await links()).includes('i1:t-ahu2'));
    check('переименование: код в JSON строки обновился, соседний код не тронут',
      JSON.parse((await prisma.docRegisterItem.findUnique({ where: { id: 'i1' } })).equipmentTags).join() === 'AHU-2A,FAN-9');
    const afterRename = await send('GET', '/api/vdr/items/by-tag?projectId=p1&tagId=t-ahu2');
    check('после переименования «Документы» у тега по-прежнему находят строку D-1', afterRename.body.items.some((i: any) => i.contractorNo === 'D-1'));
    check('и строка не считается несопоставленной (кроме FAN-9)', (await itemsOf()).find((i: any) => i.id === 'i1').unmatchedTags.join() === 'FAN-9');
    check('связи тега из другого проекта не затронуты переименованием', (await prisma.docRegisterItemTag.count({ where: { tagId: 't-other' } })) === 0);

    // ── удаление тега ──
    await prisma.tag.delete({ where: { id: 't-ahu3' } });
    const planGone = (await send('GET', '/api/vdr/tag-links?projectId=p1')).body.plan;
    check('удалённый тег: связь осталась с пометкой, строка цела', (await links()).includes('i3:t-ahu3') && planGone.orphaned === 1 && !!(await prisma.docRegisterItem.findUnique({ where: { id: 'i3' } })));
    check('удалённый тег: строка по-прежнему покрыта связью, не «несопоставлена»', !planGone.unmatched.some((u: any) => u.itemId === 'i3'));

    // ── правка кодов строки ──
    const edit = await send('PUT', '/api/vdr/items/i3', { equipmentTags: JSON.stringify(['AHU-2A', 'NEW-7']) });
    check('правка кодов: связь с тегом, чей код убрали, снята; найденный код связан; новый — несопоставлен',
      edit.status === 200 && (await links()).filter(l => l.startsWith('i3:')).join() === 'i3:t-ahu2' && edit.body.item.id === 'i3', await links());
    check('несопоставленный код виден в ответе строки списка', (await itemsOf()).find((i: any) => i.id === 'i3').unmatchedTags.join() === 'NEW-7');
    const made = await send('POST', '/api/vdr/items', { registerId: 'r1', contractorNo: 'D-6', titleRu: 'Новый', equipmentTags: JSON.stringify(['AHU-2A']) });
    check('новая строка с кодом сразу получает связь', (await links()).includes(`${made.body.item.id}:t-ahu2`));

    // ── удаление строки и реестра ──
    await send('DELETE', `/api/vdr/items/${made.body.item.id}`);
    check('удаление строки снимает её связи', !(await links()).some(l => l.startsWith(made.body.item.id)));
    const before = (await links()).length;
    check('перед удалением реестра связи есть', before > 0);
    await send('DELETE', '/api/vdr/registers/r1');
    check('удаление реестра снимает связи его строк', (await links()).length === 0);

    console.log('\nВДР ↔ теги по id: все проверки пройдены');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
