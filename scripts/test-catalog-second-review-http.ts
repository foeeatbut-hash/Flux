/** Second-review workflow on an isolated loopback MariaDB and synthetic HTTP identities. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import express from 'express';
import { ensureCatalog, readCatalog } from '../server/routes/catalog';
import { registerCatalogWorkspaceRoutes } from '../server/routes/catalogWorkspace';
import { setPrisma } from '../server/context';
import { registerSchemaClient } from '../server/schemaRuntime';
import { seedCatalog } from '../catalog/seed';
import { putCatalogSetting } from '../server/catalogWorkspace';

const require = createRequire(import.meta.url);
const endpoint = process.env.FLUX_CATALOG_FIXTURE_URL;
assert.ok(endpoint, 'FLUX_CATALOG_FIXTURE_URL должен указывать на disposable MariaDB fixture');
const dbUrl = new URL(endpoint!);
assert.ok(/^mysql:\/\//i.test(endpoint!), 'ожидается mysql:// URL');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(dbUrl.hostname), 'разрешена только loopback MariaDB');
assert.ok(dbUrl.pathname.slice(1).startsWith('flux_catalog_fixture'), 'имя БД должно начинаться с flux_catalog_fixture');

const { PrismaClient } = require('@prisma/client-mysql');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
const prisma = new PrismaClient({ adapter: new PrismaMariaDb(endpoint!) });
const identities: Record<string, any> = {
  owner: { id: 'review-fixture-owner', role: 'OWNER', isActive: true },
  author: { id: 'review-fixture-author', role: 'ENGINEER_VENT', isActive: true },
  reviewer: { id: 'review-fixture-reviewer', role: 'ENGINEER_VENT', isActive: true },
};
const can = (user: any, permission: string) => user?.role === 'OWNER' && permission === 'catalog.manage';
let checks = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log(`✓ ${name}`); };
async function status(name: string, response: Response, expected: number) {
  const body = await response.text();
  assert.equal(response.status, expected, `${name}: получен ${response.status}: ${body.slice(0, 300)}`);
  checks++; console.log(`✓ ${name}`);
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, _res, next) => { (req as any).authUser = identities[String(req.header('x-test-user') || '')] || null; next(); });

async function main() {
  let server: any;
  try {
    registerSchemaClient(prisma, 'mysql'); setPrisma(prisma);
    await ensureCatalog(prisma);
    await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS `AppSetting` (`id` VARCHAR(191) PRIMARY KEY, `key` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NULL, `value` LONGTEXT NOT NULL, `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE KEY `AppSetting_key_userId_key` (`key`,`userId`))');
    const seed = seedCatalog(); const model = seed.families[0];
    const scope = { classId: model.classId, manufacturerId: model.manufacturerId };
    await putCatalogSetting(prisma, 'catalog_grants', [
      ...['author', 'reviewer'].flatMap(key => [
        { userId: identities[key].id, action: 'edit', ...scope },
        { userId: identities[key].id, action: 'publish', ...scope },
      ]),
    ]);
    await putCatalogSetting(prisma, 'catalog_policy', { requireSecondReview: false });
    registerCatalogWorkspaceRoutes(app, { ensure: ensureCatalog, read: readCatalog, can });
    server = await new Promise<any>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (path: string, method = 'GET', body?: any, who?: keyof typeof identities) => fetch(origin + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(who ? { 'x-test-user': who } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = async (r: Response) => r.json();

    await status('владелец включает обязательную вторую проверку', await request('/api/catalog/policy', 'PUT', { requireSecondReview: true }, 'owner'), 200);
    check('режим второй проверки виден в workspace', (await json(await request('/api/catalog/workspace', 'GET', undefined, 'author'))).policy.requireSecondReview === true);

    const family = {
      id: 'fixture-review-family', classId: scope.classId, manufacturerId: scope.manufacturerId,
      code: 'review-family', title: { ru: 'Review family' }, kind: 'fixture', typeLabel: { ru: 'Изделие' },
      shapes: [], status: 'full', params: [], positions: [{ key: 'code', label: { ru: 'Код' }, formats: ['{code}'] }],
      specs: [], rules: [], match: { kinds: [] }, designationMode: 'free',
    };
    await status('строгий валидатор отвергает неподдерживаемый статус family', await request('/api/catalog/family/fixture-invalid-family', 'PUT', { ...family, id: 'fixture-invalid-family', status: 'published' }, 'author'), 400);
    const created = await request(`/api/catalog/family/${family.id}`, 'PUT', family, 'author');
    check('author создаёт family черновик', created.status === 200);
    const initial = await json(created);
    await status('family без approval нельзя опубликовать', await request('/api/catalog/workspace/publish', 'POST', { selections: [{ entity: 'family', id: family.id, revision: initial.revision }] }, 'author'), 409);
    await status('автор не может сам подтвердить family', await request('/api/catalog/workspace/approve', 'POST', { entity: 'family', id: family.id, revision: initial.revision }, 'author'), 409);
    const afterSelfApproval = await json(await request('/api/catalog/workspace', 'GET', undefined, 'author'));
    check('self-approval не записала проверяющего', !afterSelfApproval.drafts.find((d: any) => d.id === family.id)?.reviewedById);
    await status('другой publisher подтверждает family', await request('/api/catalog/workspace/approve', 'POST', { entity: 'family', id: family.id, revision: initial.revision }, 'reviewer'), 200);
    const approved = (await (await json(await request('/api/catalog/workspace', 'GET', undefined, 'reviewer'))).drafts).find((d: any) => d.id === family.id);
    check('approval фиксирует другого reviewer и сохраняет автора', approved?.reviewedById === identities.reviewer.id && approved?.authorId === identities.author.id && approved?.state === 'review');
    const familyPublished = await request('/api/catalog/workspace/publish', 'POST', { selections: [{ entity: 'family', id: family.id, revision: approved.revision }] }, 'reviewer');
    check('reviewer после approval публикует family', familyPublished.status === 200 && (await readCatalog(prisma)).families.some(f => f.id === family.id));

    const component = {
      id: 'fixture-review-component', classId: scope.classId, manufacturerId: scope.manufacturerId,
      code: 'review-component', kind: 'other', title: { ru: 'Review component' },
      specs: [{ label: { ru: 'Исполнение' }, value: 'fixture' }], familyIds: [family.id],
    };
    const componentCreated = await request(`/api/catalog/component/${component.id}`, 'PUT', component, 'author');
    check('author создаёт component черновик', componentCreated.status === 200);
    const componentInitial = await json(componentCreated);
    await status('component без approval нельзя опубликовать', await request('/api/catalog/workspace/publish', 'POST', { selections: [{ entity: 'component', id: component.id, revision: componentInitial.revision }] }, 'author'), 409);
    await status('автор не может сам подтвердить component', await request('/api/catalog/workspace/approve', 'POST', { entity: 'component', id: component.id, revision: componentInitial.revision }, 'author'), 409);
    await status('другой publisher подтверждает component', await request('/api/catalog/workspace/approve', 'POST', { entity: 'component', id: component.id, revision: componentInitial.revision }, 'reviewer'), 200);
    const componentApproved = (await (await json(await request('/api/catalog/workspace', 'GET', undefined, 'reviewer'))).drafts).find((d: any) => d.id === component.id);
    check('component approval хранит reviewer', componentApproved?.reviewedById === identities.reviewer.id);

    const edited = { ...component, title: { ru: 'Edited after approval' }, _draftVersion: componentApproved.revision };
    await status('author редактирует согласованный component по версии', await request(`/api/catalog/component/${component.id}`, 'PUT', edited, 'author'), 200);
    const afterEdit = (await (await json(await request('/api/catalog/workspace', 'GET', undefined, 'reviewer'))).drafts).find((d: any) => d.id === component.id);
    check('новая правка очищает reviewedById и возвращает draft state', !afterEdit?.reviewedById && afterEdit?.state === 'draft' && afterEdit?.authorId === identities.author.id);
    await status('после новой правки публикация снова требует approval', await request('/api/catalog/workspace/publish', 'POST', { selections: [{ entity: 'component', id: component.id, revision: afterEdit.revision }] }, 'reviewer'), 409);
    await status('reviewer повторно подтверждает изменённый component', await request('/api/catalog/workspace/approve', 'POST', { entity: 'component', id: component.id, revision: afterEdit.revision }, 'reviewer'), 200);
    const reapproved = (await (await json(await request('/api/catalog/workspace', 'GET', undefined, 'reviewer'))).drafts).find((d: any) => d.id === component.id);
    const componentPublished = await request('/api/catalog/workspace/publish', 'POST', { selections: [{ entity: 'component', id: component.id, revision: reapproved.revision }] }, 'reviewer');
    check('повторно согласованный component публикуется', componentPublished.status === 200 && (await readCatalog(prisma)).components.some(c => c.id === component.id));

    const result = { suite: 'catalog-second-review-http-mariadb', ok: checks, fail: 0, database: dbUrl.pathname.slice(1), timestamp: new Date().toISOString() };
    require('node:fs').writeFileSync('/tmp/flux-catalog-second-review-result.json', `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    console.log(`\n${checks} проверок второй публикации пройдено, 0 провалено`);
  } finally {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
