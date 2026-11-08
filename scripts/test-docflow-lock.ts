/**
 * Замочек связанного файла на сервере (docs/docflow-program.md, 3.7): новая связь
 * заблокирована, замок снимается и ставится из строки, история ограничена,
 * нарушение (изменён, перемещён, удалён при блокировке) видно в списке и в сверке.
 * Настоящая SQLite-база и настоящий express.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import express from 'express';
import { registerVdrRoutes } from '../server/routes/vdr.js';
import { registerDocflowRoutes } from '../server/routes/docflow.js';
import { registerDocflowLinkRoutes } from '../server/routes/docflowLinks.js';
import { registerProjectFolderBindingRoutes } from '../server/routes/projectFolderBindings.js';
import { vdrPermissionFor } from '../server/vdrPermissions.js';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma, setBroadcaster } from '../server/context.js';
import { lockViolationOf } from '../shared/docflow/links.js';
import { reconcile } from '../shared/docflow/reconcile.js';
import { normalizeDocflowConfig } from '../shared/docflow/config.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-docflow-lock-'));
const dbPath = path.join(temp, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
let passed = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  passed++;
};
const WORK = 'a'.repeat(64); const RETURNS = 'b'.repeat(64);

async function main() {
  const base = { locked: true, lostAt: null, sha256: 'x', lockedSha256: 'x', relativePath: 'A/f.pdf', lockedPath: 'A/f.pdf' };
  check('без изменений — нарушения нет', lockViolationOf(base) === '');
  check('другой отпечаток при блокировке — «изменён»', lockViolationOf({ ...base, sha256: 'y' }) === 'changed');
  check('другой путь — «перемещён», пропажа — «удалён»', lockViolationOf({ ...base, relativePath: 'A/g.pdf' }) === 'moved' && lockViolationOf({ ...base, lostAt: new Date() }) === 'lost');
  check('снятый замок нарушением не считается', lockViolationOf({ ...base, locked: false, sha256: 'y', lostAt: new Date() }) === '');
  check('замок меняет только владелец права docflow.files', vdrPermissionFor('POST', '/api/docflow/links/lock')?.perm === 'docflow.files');

  const app = express();
  app.use(express.json());
  let actor: any = { id: 'admin', role: 'ADMIN' };
  app.use((req, _res, next) => { (req as any).authUser = actor; next(); });
  registerVdrRoutes(app as any, { chunkBytes: async () => 1024 });
  registerDocflowRoutes(app as any);
  registerDocflowLinkRoutes(app as any);
  registerProjectFolderBindingRoutes(app as any, { mayManage: async () => true });
  const server = createServer(app);
  try {
    const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    await bootstrapLocalDatabase(dbPath, prisma, schema, () => {});
    setPrisma(prisma);
    setBroadcaster(() => {});
    await prisma.project.create({ data: { id: 'p-a', name: 'A' } });
    await prisma.user.create({ data: { id: 'admin', symbol: 'adm', name: 'Админ Иванов', password: 'x', role: 'ADMIN' } });
    await prisma.user.create({ data: { id: 'stranger', symbol: 'str', name: 'Чужой', password: 'x', role: 'USER' } });
    await prisma.projectMember.create({ data: { projectId: 'p-a', userId: 'admin' } });
    await prisma.docRegister.create({ data: { id: 'reg-a', projectId: 'p-a', name: 'ВДР', poNumber: '3700' } });
    await prisma.docRegisterItem.create({ data: { id: 'i1', registerId: 'reg-a', projectId: 'p-a', contractorNo: '3700-B01-E02-001', vdrCode: 'E02', revision: 'A', titleRu: 'i1' } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
    const send = async (method: string, url: string, body?: any) => {
      const r = await fetch(`${baseUrl}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    const settings = (await send('GET', '/api/docflow/settings?projectId=p-a')).body;
    await send('PUT', '/api/docflow/settings', { projectId: 'p-a', config: { ...settings.config, vdrTypes: [{ code: 'E02', titleRu: 'Общий вид', titleEn: '' }] }, expectedUpdatedAt: null });
    const ledger = async () => (await send('GET', '/api/explorer/project-bindings')).body;
    const upsert = async (binding: any) => send('POST', '/api/explorer/project-bindings', { expectedRevision: (await ledger()).revision, operation: { kind: 'upsert', binding } });
    const locator = (k: string) => ({ folderKey: k, anchors: [{ key: k, relativePath: '' }] });
    await upsert({ locationKey: WORK, projectId: 'p-a', label: 'Рабочая', purpose: 'work', locator: locator(WORK) });
    await upsert({ locationKey: RETURNS, projectId: 'p-a', label: 'Возвраты', purpose: 'returns' });

    const made = await send('POST', '/api/docflow/links', { itemId: 'i1', role: 'file', folderKey: WORK, relativePath: 'E02/3700-B01-E02-001_A.pdf', fileName: '3700-B01-E02-001_A.pdf', sha256: '1'.repeat(64), size: 10 });
    const link = made.body.link;
    check('новая связь заблокирована сразу, видно кто и когда', made.status === 200 && link.locked === true && !!link.lockedAt && link.lockViolation === '', made.body);
    await prisma.docRegisterItemRevision.create({ data: { itemId: 'i1', revision: 'A', reason: 'IFR', linkId: link.id, issuedKey: 'seed-lock' } });
    const ret = await send('POST', '/api/docflow/links', { itemId: 'i1', role: 'remarks', toLinkId: link.id, folderKey: RETURNS, relativePath: 'i1/Замечания.pdf', fileName: 'Замечания.pdf', receivedAt: '2026-11-05', timeZone: 'Europe/Moscow', reviewCode: '' });
    check('файл возврата тоже заблокирован', ret.status === 200 && ret.body.link.locked === true, ret.body);
    const listed = (await send('GET', '/api/docflow/links?projectId=p-a')).body.links.find((l: any) => l.id === link.id);
    check('список отдаёт замок и имя поставившего', listed.locked && listed.lockedByName === 'Админ Иванов', listed);

    // ── Права и проект ──
    actor = { id: 'stranger', role: 'USER' };
    check('участник другого проекта замок не меняет — 403', (await send('POST', '/api/docflow/links/lock', { itemId: 'i1', linkId: link.id, locked: false })).status === 403);
    actor = { id: 'admin', role: 'ADMIN' };
    check('неизвестная строка — 404, связь чужой строки — 404, нет флага — 400',
      (await send('POST', '/api/docflow/links/lock', { itemId: 'нет', linkId: link.id, locked: false })).status === 404
      && (await send('POST', '/api/docflow/links/lock', { itemId: 'i1', linkId: 'нет', locked: false })).status === 404
      && (await send('POST', '/api/docflow/links/lock', { itemId: 'i1', linkId: link.id })).status === 400);
    check('замок не поменялся от отказов', (await prisma.docFileLink.findUnique({ where: { id: link.id } })).locked === true);

    // ── Снять и поставить ──
    const off = await send('POST', '/api/docflow/links/lock', { itemId: 'i1', linkId: link.id, locked: false });
    const row = await prisma.docFileLink.findUnique({ where: { id: link.id } });
    check('замок снят, записаны кто и когда', off.status === 200 && off.body.link.locked === false && row.unlockedById === 'admin' && !!row.unlockedAt && JSON.parse(row.lockLog).length === 2);
    check('повторное снятие безопасно и не плодит записей', (await send('POST', '/api/docflow/links/lock', { itemId: 'i1', linkId: link.id, locked: false })).status === 200
      && JSON.parse((await prisma.docFileLink.findUnique({ where: { id: link.id } })).lockLog).length === 2);
    const on = await send('POST', '/api/docflow/links/lock', { itemId: 'i1', linkId: link.id, locked: true });
    check('замок поставлен обратно, baseline — текущий отпечаток и путь', on.status === 200 && on.body.link.locked === true
      && (await prisma.docFileLink.findUnique({ where: { id: link.id } })).lockedSha256 === '1'.repeat(64));
    for (let n = 0; n < 30; n++) await send('POST', '/api/docflow/links/lock', { itemId: 'i1', linkId: link.id, locked: n % 2 === 0 ? false : true });
    check('история замка ограничена 20 записями', JSON.parse((await prisma.docFileLink.findUnique({ where: { id: link.id } })).lockLog).length === 20);
    await send('POST', '/api/docflow/links/lock', { itemId: 'i1', linkId: link.id, locked: true });
    const concurrent = await Promise.all([false, false, false].map((locked) => send('POST', '/api/docflow/links/lock', { itemId: 'i1', linkId: link.id, locked })));
    check('одновременное снятие: без 500, итог — снят', concurrent.every((r) => r.status === 200 || r.status === 409) && (await prisma.docFileLink.findUnique({ where: { id: link.id } })).locked === false, concurrent.map((r) => r.status));
    await send('POST', '/api/docflow/links/lock', { itemId: 'i1', linkId: link.id, locked: true });

    // ── Нарушение при блокировке ──
    const track = (update: any) => send('POST', '/api/docflow/links/track', { updates: [{ itemId: 'i1', linkId: link.id, ...update }] });
    check('слежение без перемен — нарушения нет', (await track({ sha256: '1'.repeat(64), size: 10 })).body.links[0].lockViolation === '');
    check('файл изменён вне Flux — «изменён», при том что выпуск помечается отдельно', (await track({ sha256: '2'.repeat(64), size: 11 })).body.links[0].lockViolation === 'changed');
    const rec = reconcile(normalizeDocflowConfig({}), [{ id: 'i1', registerId: 'reg-a', title: 'i1', status: 'ISSUED', row: { contractorNo: '3700-B01-E02-001', vdrCode: 'E02', revision: 'A' } }],
      [{ folderKey: WORK, relativePath: 'E02/3700-B01-E02-001_A.pdf', name: '3700-B01-E02-001_A.pdf' }], (await send('GET', '/api/docflow/links?projectId=p-a')).body.links);
    check('Сверка показывает нарушение блокировки', rec.diverged.some((d) => d.reason === 'lock' && /нарушена блокировка: изменён при блокировке/.test(d.problems[0])), rec.diverged);
    check('файл пропал — «удалён»', (await track({ lost: true })).body.links[0].lockViolation === 'lost');
    check('замок снят — нарушения нет', (await send('POST', '/api/docflow/links/lock', { itemId: 'i1', linkId: link.id, locked: false })).body.link.lockViolation === '');
    check('поставили заново — отсчёт от текущего состояния', (await send('POST', '/api/docflow/links/lock', { itemId: 'i1', linkId: link.id, locked: true })).body.link.lockViolation === 'lost');
    await track({ sha256: '2'.repeat(64), size: 11, relativePath: 'E02/3700-B01-E02-001_A.pdf' });
    check('вернулся на место — baseline обновлён при постановке', (await send('GET', '/api/docflow/links?projectId=p-a')).body.links.find((l: any) => l.id === link.id).lockViolation === '');
    const moved = await track({ relativePath: 'E02/Другая/3700-B01-E02-001_A.pdf', fileName: '3700-B01-E02-001_A.pdf', sha256: '2'.repeat(64) });
    check('файл перенесён вне Flux — «перемещён»', moved.body.links[0].lockViolation === 'moved', moved.body);

    // ── Отвязанная связь замка не имеет ──
    await prisma.docRegisterItemRevision.update({ where: { issuedKey: 'seed-lock' }, data: { issuedKey: null } });
    await prisma.docFileLink.updateMany({ where: { toLinkId: link.id }, data: { unlinkedAt: new Date(), pathKey: null } });
    const un = await send('POST', '/api/docflow/links/unlink', { itemId: 'i1', linkId: link.id });
    check('отвязанный файл: замок не меняется (409), нарушения нет', un.status === 200 && (await send('POST', '/api/docflow/links/lock', { itemId: 'i1', linkId: link.id, locked: false })).body.error?.startsWith('Связь снята') && un.body.links[0].lockViolation === '');
  } finally { await new Promise((r) => server.close(r)); await prisma.$disconnect(); fs.rmSync(temp, { recursive: true, force: true }); }
  console.log(`docflow-lock: ${passed} проверок прошли`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
