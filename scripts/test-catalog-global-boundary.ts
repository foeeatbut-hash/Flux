import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap.js';
import { setPrisma } from '../server/context.js';
import { ensureCatalog, registerCatalogRoutes } from '../server/routes/catalog.js';
import { putCatalogSetting, hashCatalogRow } from '../server/catalogWorkspace.js';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../prisma-clients/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'flux-global-catalog-'));
  const dbPath = join(dir, 'test.sqlite');
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbPath}` }) });
  let server: any;
  try {
    await bootstrapLocalDatabase(dbPath, db, readFileSync('prisma/schema.prisma', 'utf8'), () => {}); setPrisma(db); await ensureCatalog(db);
    const seed = await db.catalogFamily.findFirst(); assert.ok(seed);
    const id = 'private-family-fixture';
    const doc = { ...JSON.parse(seed.dataJson), id, code: 'SECRET-PROJECT-MODEL' };
    const row = await db.catalogFamily.create({ data: { id, projectId: 'secret-project', classId: seed.classId, manufacturerId: seed.manufacturerId, code: doc.code, status: seed.status, dataJson: JSON.stringify(doc) } });
    const rev = await db.catalogRevision.create({ data: { entity: 'family', entityId: id, action: 'before-publication', snapshotJson: JSON.stringify(row) } });
    await db.catalogLearn.create({ data: { id: 'private-learn-fixture', classId: seed.classId, familyId: id, signature: 'secret' } });
    const draft = { entity: 'family', id, document: doc, before: doc, baseHash: hashCatalogRow(row), operation: 'save', revision: 'private-revision', state: 'draft', authorId: 'owner', updatedAt: new Date().toISOString() };
    await putCatalogSetting(db, `catalog_draft:family:${id}`, draft);
    const asset = '00000000-0000-4000-8000-000000000001';
    await putCatalogSetting(db, `catalog_asset:${asset}`, { id: asset, familyId: id, complete: true, scope: {}, authorId: 'owner' });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).authUser = { id: 'owner', role: 'OWNER', isActive: true }; next(); });
    registerCatalogRoutes(app, () => true);
    server = await new Promise<any>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (url: string, method = 'GET', body?: any) => fetch(origin + url, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const url of ['/api/catalog', '/api/catalog?deleted=1', '/api/catalog/export', '/api/catalog/workspace', '/api/catalog/learn']) {
      const response = await request(url); assert.equal(response.status, 200, url); const text = await response.text(); assert.ok(!text.includes(id) && !text.includes(doc.code), url);
    }
    const stamp = await (await request('/api/catalog/stamp')).text();
    await db.catalogFamily.update({ where: { id }, data: { code: 'changed-private-model' } });
    assert.equal(await (await request('/api/catalog/stamp')).text(), stamp);
    for (const [url, method, body] of [
      [`/api/catalog/family/${id}/revisions`, 'GET', undefined],
      [`/api/catalog/family/${id}/usage`, 'GET', undefined],
      [`/api/catalog/assets/${asset}`, 'GET', undefined],
      [`/api/catalog/family/${id}`, 'PUT', doc],
      [`/api/catalog/family/${id}`, 'DELETE', {}],
      [`/api/catalog/revisions/${rev.id}/restore`, 'POST', {}],
      ['/api/catalog/import', 'POST', { format: 'flux-catalog', families: [doc] }],
      ['/api/catalog/workspace/publish', 'POST', { selections: [{ entity: 'family', id, revision: draft.revision }] }],
      ['/api/catalog/learn/private-learn-fixture', 'DELETE', {}],
    ] as const) { const response = await request(url, method, body); assert.equal(response.status, 404, `${method} ${url}: ${await response.text()}`); }
    const learned = await request('/api/catalog/learn', 'POST', { classId: seed.classId, familyId: id, signature: 'private' }); assert.equal(learned.status, 400);
    const injected = await request('/api/catalog/family/new-global', 'PUT', { ...doc, id: 'new-global', projectId: 'secret-project' }); assert.equal(injected.status, 404);
    assert.equal((await db.catalogFamily.findUnique({ where: { id } })).projectId, 'secret-project');
    console.log('✓ Общий каталог не раскрывает и не меняет проектные записи');
  } finally { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await db.$disconnect(); setPrisma(null); rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
