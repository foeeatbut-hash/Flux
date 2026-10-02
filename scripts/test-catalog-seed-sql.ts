import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCatalog } from '../server/routes/catalog';
import { syncCatalogSeed } from '../server/catalogSeed';
import { seedCatalog, SEED_VERSION } from '../catalog/seed';
import { defaultBlankTemplate } from '../catalog/blank/defaults';
import { registerSchemaClient } from '../server/schemaRuntime';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client-sqlite');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'flux-catalog-seed-'));
  const p = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${join(dir, 'fixture.sqlite')}` }), log: [{ emit: 'event', level: 'query' }] });
  registerSchemaClient(p, 'sqlite');
  const queries: string[] = [];
  p.$on('query', (event: any) => queries.push(event.query));
  try {
    await Promise.all([ensureCatalog(p), ensureCatalog(p)]);
    const seed = seedCatalog(), template = defaultBlankTemplate();
    assert.equal(await p.catalogComponent.count(), seed.components.length);
    const inserted = queries.filter(sql => /^INSERT INTO/.test(sql) && /Catalog/.test(sql));
    assert.ok(inserted.length <= 12, `затравка в ${inserted.length} INSERT вместо отдельных запросов на карточку`);
    queries.length = 0;
    await syncCatalogSeed(p, seed, SEED_VERSION, template);
    assert.equal(queries.filter(sql => /^SELECT/.test(sql)).length, 6, 'повторный запуск читает шесть снимков, независимо от числа карточек');
    assert.ok(!queries.some(sql => /^(INSERT|UPDATE)/.test(sql)), 'актуальный каталог не переписывается');

    const [manual, untouched] = seed.families;
    await p.catalogFamily.update({ where: { id: manual.id }, data: { edited: true, seedVersion: 0, code: 'ручная-правка' } });
    await p.catalogFamily.update({ where: { id: untouched.id }, data: { edited: false, seedVersion: 0, code: 'старая-затравка' } });
    await syncCatalogSeed(p, seed, SEED_VERSION, template);
    assert.equal((await p.catalogFamily.findUnique({ where: { id: manual.id } })).code, 'ручная-правка');
    assert.equal((await p.catalogFamily.findUnique({ where: { id: untouched.id } })).code, untouched.code);

    await p.catalogFamily.update({ where: { id: untouched.id }, data: { edited: false, seedVersion: 0 } });
    const racingFamily = {
      ...p,
      catalogFamily: {
        findMany: p.catalogFamily.findMany.bind(p.catalogFamily),
        createMany: p.catalogFamily.createMany.bind(p.catalogFamily),
        async updateMany(args: any) {
          await p.catalogFamily.update({ where: { id: args.where.id }, data: { edited: true, code: 'правка-после-снимка' } });
          return p.catalogFamily.updateMany(args);
        },
      },
    };
    await syncCatalogSeed(racingFamily, seed, SEED_VERSION, template);
    assert.equal((await p.catalogFamily.findUnique({ where: { id: untouched.id } })).code, 'правка-после-снимка', 'условие UPDATE защищает правку после чтения');

    const extra = { ...seed.components[0], id: 'test-component-race', code: 'из-затравки' };
    const racingComponent = {
      ...p,
      catalogComponent: {
        findMany: p.catalogComponent.findMany.bind(p.catalogComponent),
        upsert: p.catalogComponent.upsert.bind(p.catalogComponent),
        async createMany(args: any) {
          await p.catalogComponent.create({ data: { id: extra.id, code: 'другой-процесс', classId: extra.classId, kind: extra.kind, dataJson: '{}' } });
          return p.catalogComponent.createMany(args);
        },
      },
    };
    await syncCatalogSeed(racingComponent, { ...seed, components: [...seed.components, extra] }, SEED_VERSION, template);
    assert.equal((await p.catalogComponent.findUnique({ where: { id: extra.id } })).code, 'другой-процесс', 'гонка INSERT не перезаписывает уже появившуюся карточку');
    console.log(`✓ SQLite/Prisma: пакетный засев ${seed.components.length} компонентов, 6 SELECT при повторе, ручные/конкурентные правки сохранены`);
  } finally { await p.$disconnect(); rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
