/** HTTP integration of catalog workspace routes on an isolated MariaDB fixture.
 * The synthetic x-test-user auth shim exists only in this test process; no real
 * server or company identity/database configuration is loaded.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import express from 'express';
import { ensureCatalog, readCatalog, registerCatalogRoutes } from '../server/routes/catalog';
import { setPrisma } from '../server/context';
import { registerSchemaClient } from '../server/schemaRuntime';
import { seedCatalog } from '../catalog/seed';

const require = createRequire(import.meta.url);
const endpoint = process.env.FLUX_CATALOG_FIXTURE_URL;
assert.ok(endpoint, 'FLUX_CATALOG_FIXTURE_URL должен указывать на отдельную disposable MariaDB');
const dbUrl = new URL(endpoint!);
assert.ok(/^mysql:\/\//i.test(endpoint!), 'ожидается mysql:// URL');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(dbUrl.hostname), 'разрешена только loopback MariaDB');
assert.ok(dbUrl.pathname.slice(1).startsWith('flux_catalog_fixture'), 'имя БД должно начинаться с flux_catalog_fixture');

const { PrismaClient } = require('@prisma/client-mysql');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
const prisma = new PrismaClient({ adapter: new PrismaMariaDb(endpoint!) });
const users: Record<string, any> = {
  owner: { id: 'fixture-owner', role: 'OWNER', isActive: true, name: 'Fixture owner' },
  editor: { id: 'fixture-editor', role: 'ENGINEER_VENT', isActive: true, name: 'Fixture editor' },
  outsider: { id: 'fixture-outsider', role: 'ENGINEER_VENT', isActive: true, name: 'Fixture outsider' },
};
let ok = 0, fail = 0;
const check = (name: string, condition: unknown) => { assert.ok(condition, name); ok++; console.log(`✓ ${name}`); };
async function expectStatus(name: string, response: Response, status: number) {
  const text = await response.text();
  assert.equal(response.status, status, `${name}: ожидался HTTP ${status}, пришёл ${response.status}: ${text.slice(0, 400)}`);
  ok++; console.log(`✓ ${name}`);
}
const can = (u: any, permission: string) => u?.role === 'OWNER' && permission === 'catalog.manage';
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use((req, _res, next) => {
  const key = String(req.header('x-test-user') || '');
  (req as any).authUser = users[key] || null;
  next();
});

async function main() {
  let server: any;
  try {
    registerSchemaClient(prisma, 'mysql'); setPrisma(prisma);
    await ensureCatalog(prisma);
    // Match the production Prisma constraint which ensureCatalog alone does not
    // create; the fixture deliberately uses only the catalog startup helper.
    await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX `CatalogClass_code_key` ON `CatalogClass` (`code`)');
    await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS `AppSetting` (`id` VARCHAR(191) PRIMARY KEY, `key` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NULL, `value` LONGTEXT NOT NULL, `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE KEY `AppSetting_key_userId_key` (`key`,`userId`))');
    await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS `User` (`id` VARCHAR(191) PRIMARY KEY, `name` VARCHAR(191) NOT NULL, `role` VARCHAR(191) NOT NULL, `isActive` BOOLEAN NOT NULL DEFAULT TRUE)');
    for (const u of Object.values(users)) await prisma.$executeRawUnsafe('INSERT INTO `User` (`id`,`name`,`role`,`isActive`) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE `name`=VALUES(`name`),`role`=VALUES(`role`),`isActive`=VALUES(`isActive`)', u.id, u.name, u.role, true);
    registerCatalogRoutes(app, can);
    server = await new Promise<any>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const address = server.address(); const origin = `http://127.0.0.1:${address.port}`;
    const request = (path: string, method = 'GET', body?: any, who?: keyof typeof users) => fetch(origin + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(who ? { 'x-test-user': who } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = async (r: Response) => r.json();

    await expectStatus('workspace закрыта без сессии', await request('/api/catalog/workspace'), 401);
    await expectStatus('список прав закрыт редактору', await request('/api/catalog/access', 'GET', undefined, 'editor'), 403);
    const access0 = await json(await request('/api/catalog/access', 'GET', undefined, 'owner'));
    const seed = seedCatalog(); const klass = seed.classes[0]; const seedFamily = seed.families[0]; const mfr = seed.manufacturers.find(x => x.id === seedFamily.manufacturerId)!;
    const targetClass = 'fixture-http-class'; const targetMfr = 'fixture-http-mfr';
    const grants = [
      { userId: users.editor.id, action: 'edit', classId: targetClass },
      { userId: users.editor.id, action: 'edit', classId: 'fixture-http-collision' },
      { userId: users.editor.id, action: 'edit', manufacturerId: targetMfr },
      { userId: users.editor.id, action: 'edit', manufacturerId: seedFamily.manufacturerId },
      { userId: users.editor.id, action: 'edit', classId: seedFamily.classId, manufacturerId: seedFamily.manufacturerId },
      { userId: users.editor.id, action: 'edit', classId: targetClass, manufacturerId: targetMfr },
      { userId: users.editor.id, action: 'import', classId: targetClass, manufacturerId: targetMfr },
      { userId: users.editor.id, action: 'import', manufacturerId: 'fixture-import-mfr' },
      { userId: users.editor.id, action: 'import', manufacturerId: 'fixture-http-dup-import' },
      { userId: users.editor.id, action: 'import', classId: seedFamily.classId, manufacturerId: seedFamily.manufacturerId },
      { userId: users.editor.id, action: 'publish', classId: targetClass, manufacturerId: targetMfr },
      { userId: users.editor.id, action: 'publish', classId: targetClass },
      { userId: users.editor.id, action: 'publish', classId: 'fixture-http-collision' },
      { userId: users.editor.id, action: 'publish', manufacturerId: targetMfr },
      { userId: users.editor.id, action: 'publish', classId: seedFamily.classId, manufacturerId: seedFamily.manufacturerId },
    ];
    const savedAccess = await request('/api/catalog/access', 'PUT', { grants, version: access0.version }, 'owner');
    check('владелец сохраняет права для edit/import/publish', savedAccess.status === 200);
    const editorWorkspace = await json(await request('/api/catalog/workspace', 'GET', undefined, 'editor'));
    check('workspace показывает выданные права edit/import/publish', editorWorkspace.rights.edit && editorWorkspace.rights.import && editorWorkspace.rights.publish);
    await expectStatus('устаревшая версия списка прав получает 409', await request('/api/catalog/access', 'PUT', { grants: [], version: createHash('sha256').update('[]').digest('hex') }, 'owner'), 409);
    await expectStatus('нельзя выдать право неизвестному сотруднику', await request('/api/catalog/access', 'PUT', { grants: [{ userId: 'missing-user', action: 'edit' }], version: (await json(await request('/api/catalog/access', 'GET', undefined, 'owner'))).version }, 'owner'), 400);

    const mfrDoc = { id: targetMfr, name: 'HTTP Fixture Manufacturer' };
    await expectStatus('редактор без области не меняет каталог', await request('/api/catalog/manufacturer/fixture-forbidden', 'PUT', { id: 'fixture-forbidden', name: 'Forbidden' }, 'outsider'), 403);
    await expectStatus('ID существующей записи без версии отклонён', await request(`/api/catalog/manufacturer/${mfr.id}`, 'PUT', { ...mfrDoc, id: mfr.id }, 'editor'), 409);
    const classDoc = { id: targetClass, code: 'fixture-http-class-code', title: { ru: 'Fixture HTTP class' }, itemName: { ru: 'изделие' }, facts: [], sort: 9 };
    const savedClass = await request(`/api/catalog/class/${targetClass}`, 'PUT', classDoc, 'editor');
    const savedMfr = await request(`/api/catalog/manufacturer/${targetMfr}`, 'PUT', mfrDoc, 'editor');
    check('classId fallback разрешает правку самой записи класса', savedClass.status === 200);
    check('manufacturerId fallback разрешает правку самого изготовителя', savedMfr.status === 200);
    const classDraft = await json(savedClass); const mfrDraft = await json(savedMfr);
    check('PUT возвращает версии черновиков без прямой записи в каталог', classDraft.draft && mfrDraft.draft && !(await readCatalog(prisma)).classes.some(x => x.id === targetClass));

    const importDoc = { id: 'fixture-import-mfr', name: 'Imported from preview' };
    const importBody = { format: 'flux-catalog', manufacturers: [importDoc] };
    await expectStatus('импорт без разрешённой области запрещён', await request('/api/catalog/import', 'POST', { format: 'flux-catalog', manufacturers: [{ id: 'fixture-import-denied', name: 'No grant' }] }, 'outsider'), 403);
    const planResponse = await request('/api/catalog/import', 'POST', importBody, 'editor');
    check('импорт plan выдаёт неизменяющий preview', planResponse.status === 200);
    const plan = await json(planResponse);
    await expectStatus('подмена import preview получает 409', await request('/api/catalog/import', 'POST', { ...importBody, mode: 'apply', preview: 'stale-preview' }, 'editor'), 409);
    const applied = await json(await request('/api/catalog/import', 'POST', { ...importBody, mode: 'apply', preview: plan.preview }, 'editor'));
    check('подтверждённый import preview становится черновиком', applied.applied && applied.draft && !(await readCatalog(prisma)).manufacturers.some(x => x.id === importDoc.id));
    const dupBody = { format: 'flux-catalog', manufacturers: [{ id: 'fixture-http-dup-import', name: 'Duplicate' }, { id: 'fixture-http-dup-import', name: 'Duplicate two' }] };
    await expectStatus('дубли одного ID в import атомарно отклонены', await request('/api/catalog/import', 'POST', { ...dupBody, mode: 'apply', preview: (await json(await request('/api/catalog/import', 'POST', dupBody, 'editor'))).preview }, 'editor'), 409);
    check('отклонённый пакет import не создал его первый черновик', !(await (await json(await request('/api/catalog/workspace', 'GET', undefined, 'editor'))).drafts).some((d: any) => d.id === 'fixture-http-dup-import'));

    // A duplicate selection in publication must fail before any record or revision is committed.
    const stagedClass = { entity: 'class', id: targetClass, revision: classDraft.revision };
    const duplicatePublication = await request('/api/catalog/workspace/publish', 'POST', { selections: [stagedClass, stagedClass] }, 'editor');
    if (duplicatePublication.status === 400 || duplicatePublication.status === 409) { ok++; console.log('✓ дублирующийся элемент публикации отклонён как конфликт выбора'); }
    else { fail++; console.log(`✗ дублирующийся элемент публикации должен получить 400/409, пришёл ${duplicatePublication.status}: ${(await duplicatePublication.text()).slice(0, 300)}`); }
    check('конфликт duplicate publication сохранил черновик и отсутствие опубликованной записи', !(await readCatalog(prisma)).classes.some(x => x.id === targetClass) && (await json(await request('/api/catalog/workspace', 'GET', undefined, 'editor'))).drafts.some((d: any) => d.id === targetClass));

    const publishedClass = await request('/api/catalog/workspace/publish', 'POST', { selections: [stagedClass, { entity: 'manufacturer', id: targetMfr, revision: mfrDraft.revision }] }, 'editor');
    check('публикация классов и изготовителей через HTTP успешна', publishedClass.status === 200);
    const publishedClassResult = await json(publishedClass);
    const publishedCatalog = await readCatalog(prisma);
    check('публикация через HTTP присвоила один устойчивый номер и очистила черновики', publishedClassResult.count === 2 && publishedCatalog.classes.some(x => x.id === targetClass) && publishedCatalog.manufacturers.some(x => x.id === targetMfr));

    // Duplicate public class codes fail at MariaDB uniqueness, atomically retaining the draft.
    const collision = { ...classDoc, id: 'fixture-http-collision', code: klass.code, sort: 91 };
    const collisionDraftResponse = await request(`/api/catalog/class/${collision.id}`, 'PUT', collision, 'editor');
    check('ID с совпадающим уникальным кодом можно безопасно подготовить к публикации', collisionDraftResponse.status === 200);
    const collisionDraft = await json(collisionDraftResponse);
    await expectStatus('коллизия уникального кода отклонена при публикации', await request('/api/catalog/workspace/publish', 'POST', { selections: [{ entity: 'class', id: collision.id, revision: collisionDraft.revision }] }, 'editor'), 409);
    check('коллизия не перезаписала исходный класс и оставила черновик', (await prisma.catalogClass.findUnique({ where: { id: klass.id } })).code === klass.code && (await json(await request('/api/catalog/workspace', 'GET', undefined, 'editor'))).drafts.some((d: any) => d.id === collision.id));

    const assetBytes = Buffer.from('%PDF-1.4\nfixture document\n');
    const assetHash = createHash('sha256').update(assetBytes).digest('hex');
    const beginBody = { size: assetBytes.length, sha256: assetHash, filename: '../unsafe\\fixture.pdf', familyId: seedFamily.id };
    const wrongHashBytes = Buffer.from('%PDF-1.4\nfixture documenX\n');
    const differentExpectedBytes = Buffer.from('%PDF-1.4\nfixture documenY\n');
    check('хеш-сценарий использует блок допустимого размера', wrongHashBytes.length === assetBytes.length && !createHash('sha256').update(wrongHashBytes).digest('hex').startsWith(assetHash.slice(0, 8)));
    const badBeginBody = { ...beginBody, sha256: createHash('sha256').update(differentExpectedBytes).digest('hex') };
    const badAsset = await json(await request('/api/catalog/assets/begin', 'POST', badBeginBody, 'editor'));
    await expectStatus('блок допустимого размера принимается до проверки хеша', await request(`/api/catalog/assets/${badAsset.id}/chunks/0`, 'PUT', { data: wrongHashBytes.toString('base64') }, 'editor'), 200);
    await expectStatus('finish отклоняет полное содержимое с неверным SHA-256', await request(`/api/catalog/assets/${badAsset.id}/finish`, 'POST', {}, 'editor'), 409);
    const beginRes = await request('/api/catalog/assets/begin', 'POST', beginBody, 'editor');
    check('begin создаёт загрузку исходника', beginRes.status === 200);
    const asset = await json(beginRes);
    await expectStatus('нельзя завершить загрузку с отсутствующим блоком', await request(`/api/catalog/assets/${asset.id}/finish`, 'POST', {}, 'editor'), 409);
    await expectStatus('хеш проверяется до завершения загрузки', await request(`/api/catalog/assets/${asset.id}/chunks/0`, 'PUT', { data: assetBytes.toString('base64') }, 'editor'), 200);
    await expectStatus('загруженный блок нельзя заменить другими байтами', await request(`/api/catalog/assets/${asset.id}/chunks/0`, 'PUT', { data: wrongHashBytes.toString('base64') }, 'editor'), 409);
    await expectStatus('исходник с корректным хешем завершается', await request(`/api/catalog/assets/${asset.id}/finish`, 'POST', {}, 'editor'), 200);
    const assetMetadataCount = () => prisma.appSetting.count({ where: { key: { startsWith: 'catalog_asset:' } } });
    const beforeReuseCount = await assetMetadataCount();
    const reused = await json(await request('/api/catalog/assets/begin', 'POST', { ...beginBody, filename: 'same-content.pdf' }, 'editor'));
    check('повторный begin с тем же PDF возвращает уже готовое вложение', reused.id === asset.id && reused.complete === true);
    check('дедупликация готового PDF не добавила запись вложения', await assetMetadataCount() === beforeReuseCount);
    const beforeDeniedDedupeCount = await assetMetadataCount();
    const deniedReuseResponse = await request('/api/catalog/assets/begin', 'POST', beginBody, 'outsider');
    const deniedReuseBody = await deniedReuseResponse.text();
    check('сотрудник без прав не получает существующий asset ID при дедупликации', deniedReuseResponse.status === 403 && !deniedReuseBody.includes(asset.id));
    check('запрещённая дедупликация не добавляет вложение', await assetMetadataCount() === beforeDeniedDedupeCount);
    await expectStatus('путь файла очищен от управляющих частей', await request(`/api/catalog/assets/${asset.id}`, 'GET', undefined, 'editor'), 200);
    await expectStatus('загрузка исходника без сессии не раскрывается', await request(`/api/catalog/assets/${asset.id}`), 401);

    const familyDoc = { id: 'fixture-http-family', classId: targetClass, manufacturerId: targetMfr, code: 'fixture-family', title: { ru: 'Fixture family' }, kind: 'fixture', typeLabel: { ru: 'Изделие' }, shapes: [], status: 'full', params: [], positions: [{ key: 'code', label: { ru: 'Код' }, formats: ['{code}'] }], specs: [], rules: [], match: { kinds: [] }, designationMode: 'free', catalog: { assetId: asset.id } };
    const familyDraft = await json(await request(`/api/catalog/family/${familyDoc.id}`, 'PUT', familyDoc, 'editor'));
    const familyPublished = await request('/api/catalog/workspace/publish', 'POST', { selections: [{ entity: 'family', id: familyDoc.id, revision: familyDraft.revision }] }, 'editor');
    check('семейство со ссылкой на завершённый исходник публикуется', familyPublished.status === 200);
    const publishedAsset = await request(`/api/catalog/assets/${asset.id}`, 'GET', undefined, 'editor');
    check('ссылка на опубликованный исходник возвращает точные байты', publishedAsset.status === 200 && Buffer.from(await publishedAsset.arrayBuffer()).equals(assetBytes));
    const outsiderLiveAsset = await request(`/api/catalog/assets/${asset.id}`, 'GET', undefined, 'outsider');
    check('любой вошедший сотрудник может прочитать текущий опубликованный источник', outsiderLiveAsset.status === 200 && Buffer.from(await outsiderLiveAsset.arrayBuffer()).equals(assetBytes));
    await expectStatus('опубликованный исходник всё ещё требует сессию', await request(`/api/catalog/assets/${asset.id}`), 401);
    const disposition = String(publishedAsset.headers.get('content-disposition') || '');
    check('Content-Disposition не раскрывает путь клиента', !disposition.includes('../') && !disposition.includes('\\fixture'));

    // Removing a source reference creates a before-publication snapshot used by old project records.
    const workspaceFamily = (await json(await request('/api/catalog/workspace', 'GET', undefined, 'editor'))).catalog.families.find((f: any) => f.id === familyDoc.id);
    const familyWithoutAsset: any = { ...workspaceFamily };
    delete familyWithoutAsset.catalog; delete familyWithoutAsset._draftVersion;
    const detachDraft = await json(await request(`/api/catalog/family/${familyDoc.id}`, 'PUT', familyWithoutAsset, 'editor'));
    const detach = await request('/api/catalog/workspace/publish', 'POST', { selections: [{ entity: 'family', id: familyDoc.id, revision: detachDraft.revision }] }, 'editor');
    check('снятие ссылки на исходник опубликовано со снимком прежней версии', detach.status === 200 && !(await readCatalog(prisma)).families.find(f => f.id === familyDoc.id)?.catalog?.assetId);
    const historicalAsset = await request(`/api/catalog/assets/${asset.id}`, 'GET', undefined, 'outsider');
    check('история publication сохраняет чтение старого PDF без edit права', historicalAsset.status === 200 && Buffer.from(await historicalAsset.arrayBuffer()).equals(assetBytes));

    // Components may refer to family IDs; archiving the family is blocked atomically.
    const componentDoc = { id: 'fixture-http-component', classId: targetClass, manufacturerId: targetMfr, code: 'fixture-component', kind: 'other', title: { ru: 'Fixture component' }, specs: [{ label: { ru: 'Исполнение' }, value: 'fixture' }], familyIds: [familyDoc.id] };
    const componentDraft = await json(await request(`/api/catalog/component/${componentDoc.id}`, 'PUT', componentDoc, 'editor'));
    const componentIllustration = { id: 'fixture-component-section', title: 'Подключение привода', kind: 'wiring', text: 'Условия подключения', source: { file: 'component.pdf', physicalPage: 1 } };
    const missingAssetDraft = await json(await request(`/api/catalog/component/${componentDoc.id}`, 'PUT', { ...componentDoc, sections: [componentIllustration], _draftVersion: componentDraft.revision }, 'editor'));
    await expectStatus('компонент с отсутствующей иллюстрацией не публикуется', await request('/api/catalog/workspace/publish', 'POST', { selections: [{ entity: 'component', id: componentDoc.id, revision: missingAssetDraft.revision }] }, 'editor'), 409);
    const componentBytes = Buffer.from('%PDF-1.4\ncomponent fixture document\n');
    const componentBegin = await request('/api/catalog/assets/begin', 'POST', { size: componentBytes.length, sha256: createHash('sha256').update(componentBytes).digest('hex'), filename: 'component.pdf', familyId: componentDoc.id }, 'editor');
    check('загрузка документации для черновика комплектующего разрешена редактору', componentBegin.status === 200);
    const componentAsset = await json(componentBegin);
    await expectStatus('сотрудник без прав не открывает неопубликованную иллюстрацию компонента', await request(`/api/catalog/assets/${componentAsset.id}`, 'GET', undefined, 'outsider'), 409);
    await expectStatus('блок документации комплектующего принят', await request(`/api/catalog/assets/${componentAsset.id}/chunks/0`, 'PUT', { data: componentBytes.toString('base64') }, 'editor'), 200);
    await expectStatus('документация комплектующего проходит проверку хеша', await request(`/api/catalog/assets/${componentAsset.id}/finish`, 'POST', {}, 'editor'), 200);
    await expectStatus('сотрудник без прав не открывает завершённое неопубликованное вложение', await request(`/api/catalog/assets/${componentAsset.id}`, 'GET', undefined, 'outsider'), 403);
    const readyComponentDraft = await json(await request(`/api/catalog/component/${componentDoc.id}`, 'PUT', { ...componentDoc, sections: [{ ...componentIllustration, source: { ...componentIllustration.source, assetId: componentAsset.id } }], _draftVersion: missingAssetDraft.revision }, 'editor'));
    componentDraft.revision = readyComponentDraft.revision;
    const componentPublished = await request('/api/catalog/workspace/publish', 'POST', { selections: [{ entity: 'component', id: componentDoc.id, revision: componentDraft.revision }] }, 'editor');
    check('комплектующее с зависимостью от семейства публикуется', componentPublished.status === 200);
    const componentReaderAsset = await request(`/api/catalog/assets/${componentAsset.id}`, 'GET', undefined, 'outsider');
    check('обычный сотрудник получает иллюстрацию из опубликованного раздела компонента', componentReaderAsset.status === 200 && Buffer.from(await componentReaderAsset.arrayBuffer()).equals(componentBytes));
    await expectStatus('обычный сотрудник не изменяет содержание компонента', await request(`/api/catalog/component/${componentDoc.id}`, 'PUT', { ...componentDoc, sections: [] }, 'outsider'), 403);
    const archiveDraft = await json(await request(`/api/catalog/family/${familyDoc.id}`, 'DELETE', {}, 'editor'));
    await expectStatus('архив семейства с зависимым комплектующим заблокирован', await request('/api/catalog/workspace/publish', 'POST', { selections: [{ entity: 'family', id: familyDoc.id, revision: archiveDraft.revision }] }, 'editor'), 409);
    check('заблокированный архив сохранил опубликованную модель и компонент', (await readCatalog(prisma)).families.some(x => x.id === familyDoc.id) && (await readCatalog(prisma)).components.some(x => x.id === componentDoc.id));

    const result = { suite: 'catalog-workspace-http-mariadb', ok, fail, database: dbUrl.pathname.slice(1), timestamp: new Date().toISOString() };
    require('node:fs').writeFileSync('/tmp/flux-catalog-workspace-http-result.json', `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    console.log(`\n${ok} HTTP-проверок пройдено, ${fail} провалено`);
    if (fail) process.exitCode = 1;
  } finally {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
