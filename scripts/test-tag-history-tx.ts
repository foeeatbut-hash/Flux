/**
 * История тега и сам тег — одна транзакция (docs/roadmap/offline-work.md, 0.7).
 *
 * Раньше запись истории шла после записи тега и ошибку глотала: тег менялся, а
 * кто и что — не оставалось нигде. Теперь не записалась история — не записался
 * и тег. Настоящая SQLite-база и express с маршрутами тегов, без сервера.
 *
 * Сбой истории изображается так: таблицу TagChange переименовывают, и любая
 * запись в неё падает. Проверяем, что при этом ни один путь записи тега не
 * оставляет изменений: создание, переименование, удаление, массовая запись
 * metadata, закупки, импорт, захват и его отмена, генератор. Когда таблицу
 * возвращают, всё снова работает, а клиент вне транзакции по-прежнему
 * сбой истории не пробрасывает.
 *
 * Мутации, при каждой из которых набор обязан упасть: запись истории вне
 * транзакции; ошибка истории проглочена.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import express from 'express';
import { registerTagRoutes } from '../server/routes/tags.js';
import { registerTagProcurementRoutes } from '../server/routes/tagProcurement.js';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma, setBroadcaster } from '../server/context.js';
import { recordChangeSets, createdSet, isTransactionClient, inTagTransaction, TAG_SOURCE } from '../server/tagHistory.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-tag-history-tx-'));
const dbPath = path.join(temp, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`✓ ${label}`);
};

async function main() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.authUser = { id: 'u1', role: 'ADMIN' }; next(); });
  const io: any = { emit() {}, to() { return { emit() {} }; } };
  registerTagRoutes(app as any, { io, notifyAll: async () => {} });
  registerTagProcurementRoutes(app as any);
  const server = createServer(app);
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);
    setBroadcaster(() => {});
    await prisma.project.create({ data: { id: 'p1', name: 'История' } });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const send = async (method: string, url: string, body?: any) => {
      const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    const rows = async (tagId?: string) => (await prisma.$queryRawUnsafe(
      tagId ? 'SELECT "kind", "field" FROM "TagChange" WHERE "tagId" = ?' : 'SELECT "kind", "field" FROM "TagChange"', ...(tagId ? [tagId] : []))) as any[];
    const count = async () => (await prisma.tag.count({ where: { projectId: 'p1' } })) as number;
    const historyCount = async () => (await rows()).length;
    const breakHistory = () => prisma.$executeRawUnsafe('ALTER TABLE "TagChange" RENAME TO "TagChange_off"');
    const fixHistory = () => prisma.$executeRawUnsafe('ALTER TABLE "TagChange_off" RENAME TO "TagChange"');

    // ── Обычный путь: тег и история на месте ──
    const made = await send('POST', '/api/projects/p1/tags', { identifier: 'H-1' });
    check('создание: тег записан и в истории одна строка «создан»', made.status === 200 && (await rows(made.body.tag.id)).map((r) => r.kind).join() === 'создан', made.body);
    const id = made.body.tag.id as string;
    const renamed = await send('PUT', `/api/tags/${id}`, { identifier: 'H-1A' });
    check('переименование: в истории «изменён» по коду', renamed.status === 200 && (await rows(id)).some((r) => r.kind === 'изменён' && r.field === 'identifier'), renamed.body);
    const gen = await send('POST', '/api/tags/generate', { projectId: 'p1', prefix: 'GN-' });
    check('генератор: тег и строка истории', gen.status === 200 && (await rows(gen.body.tag.id)).length === 1, gen.body);
    check('клиент вне транзакции — не tx, транзакция — tx',
      !isTransactionClient(prisma) && await inTagTransaction(prisma, async (tx: any) => isTransactionClient(tx)));

    // ── Сбой истории: ничего не записано ──
    await breakHistory();
    try {
      const before = { tags: await count() };
      const create = await send('POST', '/api/projects/p1/tags', { identifier: 'H-2' });
      check('создание при сбое истории: не 200 и тега нет', create.status >= 500 && (await count()) === before.tags && !(await prisma.tag.findFirst({ where: { identifier: 'H-2' } })), create);

      const rename = await send('PUT', `/api/tags/${id}`, { identifier: 'H-9' });
      check('переименование при сбое истории: не 200, код прежний, ключ прежний',
        rename.status >= 500 && (await prisma.tag.findUnique({ where: { id } })).identifier === 'H-1A' && (await prisma.tag.findUnique({ where: { id } })).codeKey === 'h-1a', rename);

      const meta = await send('PUT', `/api/tags/${id}`, { metadata: { comment: 'x' } });
      check('правка metadata при сбое истории: не 200, metadata не записана', meta.status >= 500 && !String((await prisma.tag.findUnique({ where: { id } })).metadata || '').includes('comment'), meta);

      const bulkMeta = await send('PUT', '/api/tags/bulk-metadata', { updates: [{ id, metadata: { stage: 'A' } }] });
      check('массовая запись metadata при сбое истории: не 200, ничего не записано', bulkMeta.status >= 500 && !String((await prisma.tag.findUnique({ where: { id } })).metadata || '').includes('stage'), bulkMeta);

      const proc = await send('PATCH', `/api/tags/${id}/procurement`, { procurement: { stage: 'ЗАКАЗ' } });
      check('закупки при сбое истории: не 200, ничего не записано', proc.status >= 500 && !String((await prisma.tag.findUnique({ where: { id } })).metadata || '').includes('ЗАКАЗ'), proc);

      const del = await send('DELETE', `/api/tags/${id}`);
      check('удаление при сбое истории: не 200, тег на месте', del.status >= 500 && !!(await prisma.tag.findUnique({ where: { id } })), del);

      const imp = await send('POST', '/api/projects/p1/tags/bulk-import', { mode: 'add', rows: [{ identifier: 'I-1' }, { identifier: 'I-2' }] });
      check('импорт при сбое истории: не 200 и ни одного тега из файла', imp.status >= 500 && (await count()) === before.tags, imp);

      const cap = await send('POST', '/api/projects/p1/tags/capture-apply', { rows: [{ identifier: 'C-1', action: 'create' }, { identifier: 'H-1A', action: 'fill', targetId: id, brand: 'Марка' }] });
      check('захват при сбое истории: не 200, ни созданных, ни дополненных', cap.status >= 500 && (await count()) === before.tags && (await prisma.tag.findUnique({ where: { id } })).brand === null, cap);

      const undo = await send('POST', '/api/projects/p1/tags/capture-undo', { deleteIds: [gen.body.tag.id], restore: [] });
      check('отмена захвата при сбое истории: не 200, тег не удалён', undo.status >= 500 && !!(await prisma.tag.findUnique({ where: { id: gen.body.tag.id } })), undo);

      const gen2 = await send('POST', '/api/tags/generate', { projectId: 'p1', prefix: 'GN-' });
      check('генератор при сбое истории: не 200, тега нет', gen2.status >= 500 && (await count()) === before.tags, gen2);

      // Вне транзакции (старое поведение «тег важнее журнала») клиент сбой истории не пробрасывает
      const lenient = await recordChangeSets(prisma, { projectId: 'p1', userId: 'u1', source: TAG_SOURCE.tags }, [createdSet({ id: 'x', projectId: 'p1', identifier: 'X' })]);
      check('вне транзакции сбой истории не бросается (0 строк)', lenient === 0);
      let inside: any = null;
      await inTagTransaction(prisma, (tx: any) => recordChangeSets(tx, { projectId: 'p1', userId: 'u1', source: TAG_SOURCE.tags }, [createdSet({ id: 'x', projectId: 'p1', identifier: 'X' })])).catch((e: any) => { inside = e; });
      check('внутри транзакции сбой истории бросается', !!inside, inside?.message);
    } finally {
      await fixHistory();
    }

    // ── Таблицу вернули: всё снова работает ──
    const after = await send('POST', '/api/projects/p1/tags', { identifier: 'H-3' });
    check('после возврата таблицы создание снова проходит, с историей', after.status === 200 && (await rows(after.body.tag.id)).length === 1, after.body);
    const total = await historyCount();
    const imp2 = await send('POST', '/api/projects/p1/tags/bulk-import', { mode: 'add', rows: [{ identifier: 'I-1' }, { identifier: 'I-2' }] });
    check('импорт: два тега и две строки истории «создан» в одной записи', imp2.status === 200 && imp2.body.created === 2 && (await historyCount()) === total + 2, imp2.body);
    const delOk = await send('DELETE', `/api/tags/${after.body.tag.id}`);
    check('удаление с историей: тег удалён, история осталась', delOk.status === 200 && !(await prisma.tag.findUnique({ where: { id: after.body.tag.id } })) && (await rows(after.body.tag.id)).some((r) => r.kind === 'удалён'), delOk.body);

    console.log('\nИстория тега в транзакции — все проверки пройдены');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
