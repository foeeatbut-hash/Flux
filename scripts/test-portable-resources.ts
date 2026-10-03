import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const prismaResource = packageJson.build.extraResources.find((resource: any) => resource.from === 'prisma');
assert.ok(prismaResource, 'electron-builder must have a prisma extraResource');
assert.equal(prismaResource.to, 'prisma');

const filters: string[] = prismaResource.filter;
assert.deepEqual(filters, [
  '**/*.prisma',
  'migrations/**/migration.sql',
  'migrations/migration_lock.toml',
]);
const included = (file: string) => filters.some((pattern) => minimatch(file, pattern));

for (const schema of ['schema.prisma', 'schema.postgresql.prisma', 'schema.mariadb.prisma']) {
  assert.ok(existsSync(path.join(root, 'prisma', schema)), `required schema exists: ${schema}`);
  assert.ok(included(schema), `required schema is packaged: ${schema}`);
}

assert.ok(included('migrations/20261003_initial/migration.sql'), 'migration SQL is packaged');
assert.ok(included('migrations/migration_lock.toml'), 'migration lock is packaged');

// electron-builder evaluates these paths relative to the resource source root (`prisma`).
for (const localData of [
  'prisma/database.sqlite',
  'prisma/prisma/database.sqlite',
  'prisma/database.db',
  'prisma/database.sqlite-wal',
  'prisma/database.sqlite-shm',
  'config.json',
  '.env',
  'owner-key.pem',
  'update-signing.key',
]) {
  assert.equal(included(localData), false, `local data/secret path is excluded: ${localData}`);
}

console.log('Portable Prisma resource allowlist checks passed.');
