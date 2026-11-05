/**
 * ВДР: права на маршрутах (docs/docflow-integration.md, 6.4).
 *
 * Два замка:
 *  • изменение данных реестра — право `vdr.manage`, стандартов — `vdr.standards`:
 *    каждый маршрут записи, зарегистрированный в `registerVdrRoutes`, обязан
 *    попасть в таблицу `server/vdrPermissions.ts` (новый маршрут записи нельзя
 *    забыть закрыть);
 *  • чтение и запись строк и реестров — только участнику проекта: адрес несёт
 *    id реестра или строки, и общий страж проектов находит по ним проект.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import express from 'express';
import { registerVdrRoutes } from '../server/routes/vdr.js';
import { vdrPermissionFor } from '../server/vdrPermissions.js';
import { registerProjectEntityGuard, entityRefsOfRequest } from '../server/projectEntityAccess.js';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma, setBroadcaster } from '../server/context.js';

const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`✓ ${label}`);
};

// ── 1. Таблица прав покрывает все маршруты записи ──
const routes: { method: string; path: string }[] = [];
const recorder: any = { use() {}, _router: {} };
for (const method of ['get', 'post', 'put', 'delete', 'patch']) recorder[method] = (p: string) => { routes.push({ method: method.toUpperCase(), path: p }); };
registerVdrRoutes(recorder, { chunkBytes: async () => 1024 });
const concrete = (p: string) => p.replace(/:[A-Za-z]+/g, 'x1');
check('маршруты ВДР собраны', routes.length >= 20, routes.length);
for (const r of routes.filter(x => x.method !== 'GET')) {
  const rule = vdrPermissionFor(r.method, concrete(r.path));
  const want = r.path.startsWith('/api/vdr/standards') ? 'vdr.standards'
    : (r.method === 'DELETE' && /^\/api\/vdr\/(registers|items)\//.test(r.path)) ? 'vdr.delete' : 'vdr.manage';
  check(`${r.method} ${r.path} требует ${want}`, rule?.perm === want, rule);
}
check('чтение не требует права записи (его замок — проект)', routes.filter(x => x.method === 'GET').every(r => vdrPermissionFor('GET', concrete(r.path)) === null));
check('новые маршруты переноса тегов в таблице: план — чтение, применение и отмена — запись',
  routes.some(r => r.method === 'GET' && r.path === '/api/vdr/tag-links') && vdrPermissionFor('POST', '/api/vdr/tag-links/apply')?.perm === 'vdr.manage' && vdrPermissionFor('POST', '/api/vdr/tag-links/undo')?.perm === 'vdr.manage');

// ── 2. Страж проекта находит проект по реестру и строке ──
check('адрес строки и реестра называет сущность', entityRefsOfRequest('/api/vdr/items/i1/issue-revision').some(r => r.kind === 'vdrItem' && r.id === 'i1')
  && entityRefsOfRequest('/api/vdr/registers/r1/export').some(r => r.kind === 'vdrRegister' && r.id === 'r1')
  && entityRefsOfRequest('/api/vdr/items', {}, { registerId: 'r1' }).some(r => r.kind === 'vdrRegister')
  && entityRefsOfRequest('/api/vdr/items/by-tag').length === 0);

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-vdr-permissions-'));
const dbPath = path.join(temp, 'fixture.sqlite');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });

async function main() {
  const app = express();
  app.use(express.json());
  // Вошедший — по заголовку: проверяется замок проекта, а не вход
  app.use((req: any, _res, next) => { const id = String(req.headers['x-user'] || ''); req.authUser = id ? { id, role: id === 'admin' ? 'ADMIN' : 'USER' } : null; next(); });
  // Права по функциям — как в server.ts: администратор проходит, остальным нужны все права правила.
  // Набор прав человека берётся из его имени: `del` — удаление и ведение, `mgr` — только ведение (должность MANAGER без права).
  const granted: Record<string, string[]> = { del: ['vdr.manage', 'vdr.delete'], mgr: ['vdr.manage'], member: ['vdr.manage'] };
  app.use((req: any, res, next) => {
    const user = req.authUser;
    const rule = user && user.role !== 'ADMIN' ? vdrPermissionFor(req.method, req.path) : null;
    if (rule && [rule, ...(rule.also || [])].some(x => !(granted[user.id] || []).includes(x.perm))) return res.status(403).json({ error: 'Недостаточно прав' });
    next();
  });
  registerProjectEntityGuard(app as any);
  registerVdrRoutes(app as any, { chunkBytes: async () => 1024 });
  const server = createServer(app);
  try {
    await bootstrapLocalDatabase(dbPath, prisma, fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8'), () => {});
    setPrisma(prisma);
    setBroadcaster(() => {});
    await prisma.project.create({ data: { id: 'closed', name: 'Закрытый' } });
    await prisma.projectMember.create({ data: { projectId: 'closed', userId: 'member' } });
    await prisma.docRegister.create({ data: { id: 'r-closed', projectId: 'closed', name: 'ВДР' } });
    await prisma.docRegisterItem.create({ data: { id: 'i-closed', registerId: 'r-closed', projectId: 'closed', contractorNo: 'D-1' } });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const call = async (user: string, method: string, url: string, body?: any) => {
      const r = await fetch(`http://127.0.0.1:${address.port}${url}`, { method, headers: { 'Content-Type': 'application/json', 'x-user': user }, body: body === undefined ? undefined : JSON.stringify(body) });
      return r.status;
    };
    const cases: [string, string, any?][] = [
      ['GET', '/api/vdr/items?registerId=r-closed'],
      ['GET', '/api/vdr/items/i-closed/revisions'],
      ['PUT', '/api/vdr/items/i-closed', { titleRu: 'x' }],
      ['POST', '/api/vdr/items/i-closed/issue-revision', { kind: 'next' }],
      ['POST', '/api/vdr/items', { registerId: 'r-closed', titleRu: 'x' }],
      ['PUT', '/api/vdr/registers/r-closed', { vendor: 'x' }],
      ['POST', '/api/vdr/registers/r-closed/revision-up', {}],
      ['DELETE', '/api/vdr/registers/r-closed'],
      ['GET', '/api/vdr/registers?projectId=closed'],
      ['GET', '/api/vdr/tag-links?projectId=closed'],
      ['POST', '/api/vdr/tag-links/apply', { projectId: 'closed', digest: 'x' }],
    ];
    // Удаление: администратор — всегда; остальные — только с vdr.delete. Должность MANAGER сама по себе не даёт
    await prisma.project.create({ data: { id: 'open', name: 'Открытый' } });
    await prisma.projectMember.createMany({ data: ['del', 'mgr', 'admin'].map(userId => ({ projectId: 'open', userId })) });
    const mkReg = async (n: string) => { await prisma.docRegister.create({ data: { id: `r-${n}`, projectId: 'open', name: n } }); await prisma.docRegisterItem.create({ data: { id: `i-${n}`, registerId: `r-${n}`, projectId: 'open', contractorNo: n } }); };
    for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) await mkReg(n);
    check('без права vdr.delete: удаление строки — 403', await call('mgr', 'DELETE', '/api/vdr/items/i-a') === 403);
    check('без права vdr.delete: удаление реестра — 403', await call('mgr', 'DELETE', '/api/vdr/registers/r-a') === 403);
    check('строка и реестр целы после отказов', !!(await prisma.docRegisterItem.findUnique({ where: { id: 'i-a' } })) && !!(await prisma.docRegister.findUnique({ where: { id: 'r-a' } })));
    check('с правом vdr.delete: удаление строки — 200', await call('del', 'DELETE', '/api/vdr/items/i-b') === 200);
    check('с правом vdr.delete: удаление реестра — 200', await call('del', 'DELETE', '/api/vdr/registers/r-c') === 200);
    check('администратор удаляет строку — 200', await call('admin', 'DELETE', '/api/vdr/items/i-d') === 200);
    check('администратор удаляет реестр — 200', await call('admin', 'DELETE', '/api/vdr/registers/r-e') === 200);
    check('удалённое действительно удалено', !(await prisma.docRegisterItem.findUnique({ where: { id: 'i-b' } })) && !(await prisma.docRegister.findUnique({ where: { id: 'r-c' } })));

    for (const [method, url, body] of cases) {
      check(`не участник проекта: ${method} ${url} — 403`, await call('stranger', method, url, body) === 403);
    }
    check('участник проекта читает строки реестра', await call('member', 'GET', '/api/vdr/items?registerId=r-closed') === 200);
    check('участник проекта правит строку', await call('member', 'PUT', '/api/vdr/items/i-closed', { titleRu: 'Правка' }) === 200);
    check('администратор видит любой проект', await call('admin', 'GET', '/api/vdr/items?registerId=r-closed') === 200);
    check('строка осталась как была после отказов чужому', (await prisma.docRegisterItem.findUnique({ where: { id: 'i-closed' } })).titleRu === 'Правка');
    console.log('\nВДР: права — все проверки пройдены');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
