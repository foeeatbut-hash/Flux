/** Живая проверка черновиков и публикации каталога на отдельной MariaDB.
 * Запуск: FLUX_CATALOG_FIXTURE_URL=mysql://...@127.0.0.1:port/flux_catalog_fixture... npx tsx scripts/test-catalog-publication.ts
 * Скрипт не читает настройки Flux и откажется подключаться не к loopback fixture.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { ensureCatalog, readCatalog } from '../server/routes/catalog';
import { setPrisma, getPrisma } from '../server/context';
import { registerSchemaClient } from '../server/schemaRuntime';
import { seedCatalog, SEED_VERSION } from '../catalog/seed';
import { syncCatalogSeed } from '../server/catalogSeed';
import { defaultBlankTemplate } from '../catalog/blank/defaults';
import { catalogAllowed, catalogSetting, listCatalogDrafts, publishCatalogDrafts, stageCatalogDraft } from '../server/catalogWorkspace';
import { catalogDocumentProblem, overlayCatalog } from '../catalog/publication';
import type { CatalogEntity } from '../catalog/publication';

const require = createRequire(import.meta.url);
const endpoint = process.env.FLUX_CATALOG_FIXTURE_URL;
assert.ok(endpoint, 'FLUX_CATALOG_FIXTURE_URL должен указывать на отдельную disposable MariaDB');
const url = new URL(endpoint!);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'разрешена только loopback MariaDB');
assert.ok(url.pathname.slice(1).startsWith('flux_catalog_fixture'), 'имя БД должно начинаться с flux_catalog_fixture');
assert.ok(/^mysql:\/\//i.test(endpoint!), 'ожидается mysql:// URL');

const { PrismaClient } = require('@prisma/client-mysql');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');
const prisma = new PrismaClient({ adapter: new PrismaMariaDb(endpoint!) });
let ok = 0;
const check = (name: string, condition: unknown) => { assert.ok(condition, name); ok++; console.log(`✓ ${name}`); };
const rejectsStatus = async (name: string, work: () => Promise<unknown>, status: number) => {
  await assert.rejects(work, (e: any) => e?.status === status, name); ok++; console.log(`✓ ${name}`);
};
const user = (id: string, role = 'ENGINEER_VENT') => ({ id, role, isActive: true });
const can = (u: any, p: string) => u?.id === 'publisher' && p === 'catalog.publish';
const entityExists = async (entity: CatalogEntity, id: string) => {
  const model = ({ family: prisma.catalogFamily, component: prisma.catalogComponent, tagRule: prisma.catalogTagRule, class: prisma.catalogClass, manufacturer: prisma.catalogManufacturer } as any)[entity];
  return !!await model.findUnique({ where: { id } });
};

async function main() {
  try {
    registerSchemaClient(prisma, 'mysql');
    setPrisma(prisma);
    check('контекст лениво возвращает текущий Prisma клиента', getPrisma() === prisma);
    await ensureCatalog(getPrisma());
    // ensureCatalog owns catalog tables; AppSetting is a pre-existing app table and
    // this isolated fixture provisions only its MariaDB shape, without a schema change.
    await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS `AppSetting` (`id` VARCHAR(191) PRIMARY KEY, `key` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NULL, `value` LONGTEXT NOT NULL, `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE KEY `AppSetting_key_userId_key` (`key`,`userId`))');
    const seed = seedCatalog();
    check('ensureCatalog подготовил MariaDB и полную затравку', await prisma.catalogComponent.count() === seed.components.length);

    // Неизменённые и правленные образцы должны пережить повторную загрузку затравки.
    const manual = seed.families[0];
    await prisma.catalogFamily.update({ where: { id: manual.id }, data: { edited: true, code: 'manual-preserved', seedVersion: 0 } });
    await syncCatalogSeed(prisma, seed, SEED_VERSION, defaultBlankTemplate());
    check('повторная затравка не перезаписала ручную правку', (await prisma.catalogFamily.findUnique({ where: { id: manual.id } })).code === 'manual-preserved');

    const baseline = await readCatalog(prisma);
    const projectBefore = { id: 'fixture-project', name: 'Fixture project', code: 'FP-1', description: 'unchanged' };
    await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS `Project` (`id` VARCHAR(191) PRIMARY KEY, `name` VARCHAR(191), `code` VARCHAR(191), `description` TEXT)');
    await prisma.$executeRawUnsafe("INSERT INTO `Project` (`id`,`name`,`code`,`description`) VALUES ('fixture-project','Fixture project','FP-1','unchanged') ON DUPLICATE KEY UPDATE `name`=VALUES(`name`)");
    const projectSnapshot = async () => (await prisma.$queryRawUnsafe("SELECT `id`,`name`,`code`,`description` FROM `Project` WHERE `id`='fixture-project'"))[0];
    assert.deepEqual(await projectSnapshot(), projectBefore);

    const newClass = { id: 'fixture-pub-class', code: 'fixture-class', title: { ru: 'Fixture class' }, itemName: { ru: 'изделие' }, facts: [], sort: 912 };
    const newManufacturer = { id: 'fixture-pub-mfr', name: 'Fixture Manufacturer' };
    const newFamily = { id: 'fixture-pub-family', classId: newClass.id, manufacturerId: newManufacturer.id, code: 'fixture-model', title: { ru: 'Fixture model' }, kind: 'fixture', typeLabel: { ru: 'Изделие' }, shapes: [], status: 'full', params: [], positions: [{ key: 'code', label: { ru: 'Код' }, formats: ['{code}'] }], specs: [], rules: [], match: { kinds: [] }, designationMode: 'free' };
    for (const [entity, doc] of [['class', newClass], ['manufacturer', newManufacturer], ['family', newFamily]] as const) {
      assert.equal(catalogDocumentProblem(entity, doc), '', `${entity} fixture must satisfy the actual catalog contract`);
      assert.equal(await entityExists(entity, doc.id), false);
    }
    const drafts = await Promise.all([
      stageCatalogDraft(prisma, 'class', newClass.id, newClass, 'editor-a'),
      stageCatalogDraft(prisma, 'manufacturer', newManufacturer.id, newManufacturer, 'editor-a'),
      stageCatalogDraft(prisma, 'family', newFamily.id, newFamily, 'editor-a'),
    ]);
    check('черновики не попадают в опубликованное чтение', !(await readCatalog(prisma)).classes.some(x => x.id === newClass.id) && !(await readCatalog(prisma)).families.some(x => x.id === newFamily.id));
    const overlay = overlayCatalog(baseline, drafts);
    check('рабочая область показывает подготовленные черновики', overlay.classes.some(x => x.id === newClass.id) && overlay.families.some(x => x.id === newFamily.id));
    const beforeNumber = (await catalogSetting(prisma, 'catalog_publication', { number: 0 })).number;
    const publication = await publishCatalogDrafts(prisma, drafts.map(d => ({ entity: d.entity, id: d.id, revision: d.revision })), user('publisher'), can, readCatalog);
    const afterNumber = (await catalogSetting(prisma, 'catalog_publication', { number: 0 })).number;
    check('несколько сущностей опубликованы одним атомарным номером', publication.count === 3 && publication.publication === beforeNumber + 1 && afterNumber === publication.publication);
    check('класс, изготовитель и модель видны после публикации', await entityExists('class', newClass.id) && await entityExists('manufacturer', newManufacturer.id) && await entityExists('family', newFamily.id));

    // Optimistic revision check prevents an old editor from overwriting a newer draft.
    const staleDoc = { ...newManufacturer, id: 'fixture-stale-draft', name: 'First edit' };
    const first = await stageCatalogDraft(prisma, 'manufacturer', staleDoc.id, staleDoc, 'editor-a');
    const second = await stageCatalogDraft(prisma, 'manufacturer', staleDoc.id, { ...staleDoc, name: 'Second edit' }, 'editor-b', 'save', first.revision);
    await rejectsStatus('устаревшая правка черновика получает 409', () => stageCatalogDraft(prisma, 'manufacturer', staleDoc.id, staleDoc, 'editor-a', 'save', first.revision), 409);
    check('последняя версия черновика сохранена', (await listCatalogDrafts(prisma)).find(d => d.id === staleDoc.id)?.revision === second.revision);

    // A concurrent direct change to the published row invalidates the staged base hash.
    const stalePublish = { ...newManufacturer, id: 'fixture-stale-publish', name: 'Before concurrent change' };
    const stale = await stageCatalogDraft(prisma, 'manufacturer', stalePublish.id, stalePublish, 'editor-a');
    await prisma.catalogManufacturer.create({ data: { id: stalePublish.id, name: 'Concurrent published change', dataJson: JSON.stringify({ ...stalePublish, name: 'Concurrent published change' }) } });
    const headBeforeConflict = (await catalogSetting(prisma, 'catalog_publication', { number: 0 })).number;
    await rejectsStatus('устаревшая публикация получает 409', () => publishCatalogDrafts(prisma, [{ entity: 'manufacturer', id: stale.id, revision: stale.revision }], user('publisher'), can, readCatalog), 409);
    check('конфликт публикации не сдвинул номер', (await catalogSetting(prisma, 'catalog_publication', { number: 0 })).number === headBeforeConflict);

    // A failed member in a selection must roll back every preceding write and revision.
    const atomicMfr = { id: 'fixture-atomic-mfr', name: 'Should roll back' };
    const a = await stageCatalogDraft(prisma, 'manufacturer', atomicMfr.id, atomicMfr, 'editor-a');
    const inUseClass = seed.classes[0];
    const b = await stageCatalogDraft(prisma, 'class', inUseClass.id, JSON.parse((await prisma.catalogClass.findUnique({ where: { id: inUseClass.id } })).dataJson), 'editor-a', 'archive');
    const revBefore = await prisma.catalogRevision.count();
    const headBefore = (await catalogSetting(prisma, 'catalog_publication', { number: 0 })).number;
    await rejectsStatus('архивирование используемого класса отклонено', () => publishCatalogDrafts(prisma, [{ entity: 'manufacturer', id: a.id, revision: a.revision }, { entity: 'class', id: b.id, revision: b.revision }], user('publisher'), can, readCatalog), 409);
    check('ошибка пакета откатила все изменения и номера', !(await entityExists('manufacturer', atomicMfr.id) && await prisma.catalogRevision.count() > revBefore) && (await catalogSetting(prisma, 'catalog_publication', { number: 0 })).number === headBefore);
    check('архивный черновик остался для разрешения конфликта', (await listCatalogDrafts(prisma)).some(d => d.id === inUseClass.id && d.operation === 'archive'));
    const inUseManufacturer = seed.manufacturers[0];
    const manufacturerArchive = await stageCatalogDraft(prisma, 'manufacturer', inUseManufacturer.id, JSON.parse((await prisma.catalogManufacturer.findUnique({ where: { id: inUseManufacturer.id } })).dataJson), 'editor-a', 'archive');
    await rejectsStatus('архивирование используемого изготовителя отклонено', () => publishCatalogDrafts(prisma, [{ entity: 'manufacturer', id: inUseManufacturer.id, revision: manufacturerArchive.revision }], user('publisher'), can, readCatalog), 409);
    check('запись используемого изготовителя осталась опубликована', await entityExists('manufacturer', inUseManufacturer.id));

    // Access grants are scoped independently by action, class and manufacturer.
    const editor = user('scoped-editor');
    const grants = [
      { userId: editor.id, action: 'edit' as const, classId: newClass.id, manufacturerId: newManufacturer.id },
      { userId: editor.id, action: 'import' as const, classId: newClass.id, manufacturerId: newManufacturer.id },
      { userId: editor.id, action: 'publish' as const, classId: newClass.id, manufacturerId: newManufacturer.id },
    ];
    const { putCatalogSetting } = await import('../server/catalogWorkspace');
    await putCatalogSetting(prisma, 'catalog_grants', grants);
    const scoped = { classId: newClass.id, manufacturerId: newManufacturer.id };
    check('выданные права работают отдельно для правки, импорта и публикации', await catalogAllowed(prisma, editor, 'edit', scoped, can) && await catalogAllowed(prisma, editor, 'import', scoped, can) && await catalogAllowed(prisma, editor, 'publish', scoped, can));
    check('грант не действует за пределами класса или изготовителя', !await catalogAllowed(prisma, editor, 'edit', { classId: 'elsewhere', manufacturerId: newManufacturer.id }, can) && !await catalogAllowed(prisma, editor, 'import', { classId: newClass.id, manufacturerId: 'elsewhere' }, can));
    check('роль владельца получает права каталога через проверку роли', await catalogAllowed(prisma, user('owner', 'OWNER'), 'edit', {}, (u, p) => u.role === 'OWNER' && p === 'catalog.manage'));
    await rejectsStatus('неактивному сотруднику право не выдаётся', async () => { if (await catalogAllowed(prisma, { ...editor, isActive: false }, 'edit', scoped, can)) throw { status: 200 }; throw { status: 403 }; }, 403);

    check('небезопасные ключи JSON отклоняются до записи', !!catalogDocumentProblem('manufacturer', JSON.parse('{"id":"unsafe","name":"M","constructor":{"prototype":{"polluted":true}}}')));
    check('NaN/Infinity в JSON-подобной записи отклоняется', !!catalogDocumentProblem('manufacturer', { id: 'bad-number', name: 'M', price: Number.POSITIVE_INFINITY }));

    check('все проверки каталога оставили проектный снимок без изменений', JSON.stringify(await projectSnapshot()) === JSON.stringify(projectBefore));
    const result = { suite: 'catalog-publication-mariadb', ok, fail: 0, database: url.pathname.slice(1), timestamp: new Date().toISOString() };
    writeFileSync('/tmp/flux-catalog-publication-result.json', `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    console.log(`\n${ok} проверок пройдено, 0 провалено`);
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
