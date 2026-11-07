import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { translatedDocflowPermissions } from '../shared/docflowPermissions';
import { can, defaultPermissions, offEntry } from '../src/lib/permissions';
import { migrateDocflowPermissions } from '../server/docflowPermissionMigration';
import { bootstrapLocalDatabase } from '../server/databaseBootstrap';
import { vdrPermissionFor } from '../server/vdrPermissions';

let completed = false, passed = 0;
process.on('exit', () => { if (!completed) process.exitCode = 1; });
function check(name: string, condition: unknown) { assert.ok(condition, name); passed++; console.log(`✓ ${name}`); }
async function main() {
  const grant = { enabled: true, until: '2099-01-01' };
  const deny = { enabled: false, until: null };
  const legacy = Object.freeze({ 'vdr.manage': grant, 'vdr.standards': deny, other: grant });
  const moved = translatedDocflowPermissions(legacy);
  check('правка и выпуск сохраняют прежний срок', moved['docflow.edit'] === grant && moved['docflow.issue'] === grant);
  check('запрет настройки сохранён, посторонние права не тронуты', moved['docflow.settings'] === deny && moved.other === grant);
  check('старые имена убраны без изменения исходной карты', !('vdr.manage' in moved) && 'vdr.manage' in legacy);
  check('новый явный запрет сильнее старого разрешения',
    translatedDocflowPermissions({ 'vdr.manage': grant, 'docflow.edit': deny })['docflow.edit'] === deny);
  check('перенос не даёт права назначать файлы', !('docflow.files' in moved));
  const user = { role: 'ENGINEER_VENT', permissions: legacy };
  check('старая карта работает до завершения переноса', can(user, 'docflow.edit') && can(user, 'docflow.issue'));
  check('личный новый запрет не обходится старым разрешением', !can({ ...user, permissions: { ...legacy, 'docflow.edit': deny } }, 'docflow.edit'));
  check('просроченное разрешение не оживает', !can({ ...user, permissions: { 'vdr.manage': { enabled: true, until: '2000-01-01' } } }, 'docflow.edit'));
  check('просмотр по умолчанию сохраняет доступ участника проекта', can({ role: 'USER' }, 'docflow.view'));
  check('просмотр можно явно отнять', !can({ role: 'USER', permissions: { 'docflow.view': offEntry('docflow.view')! } }, 'docflow.view'));
  check('новый сотрудник не получает docflow.files', !defaultPermissions()['docflow.files'] && !can(user, 'docflow.files'));
  check('администратор назначает файлы', can({ role: 'ADMIN' }, 'docflow.files'));
  check('выпуск требует отдельное право', vdrPermissionFor('POST', '/api/vdr/items/a/issue-revision')?.perm === 'docflow.issue');
  check('старый адрес выпуска также защищён', vdrPermissionFor('POST', '/api/vdr/items/a/revision-up')?.perm === 'docflow.issue');
  const require = createRequire(import.meta.url);
  const { PrismaClient } = require('../prisma-clients/client-sqlite');
  const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-docflow-permissions-'));
  const filename = path.join(temp, 'fixture.sqlite');
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${filename}` }) });
  try {
    await bootstrapLocalDatabase(filename, db, fs.readFileSync('prisma/schema.prisma', 'utf8'), () => {});
    await db.role.create({ data: { id: 'role', code: 'CUSTOM', name: 'Инженер', permissions: JSON.stringify(legacy) } });
    await db.user.create({ data: { id: 'user', symbol: 'fixture', name: 'Тест', password: 'unused', role: 'CUSTOM',
      permissions: JSON.stringify({ 'vdr.manage': deny, 'docflow.files': grant }) } });
    await db.role.create({ data: { id: 'broken', code: 'BROKEN', name: 'Ошибка', permissions: '{' } });
    await assert.rejects(() => migrateDocflowPermissions(db));
    check('ошибка переноса не оставляет половину изменённых прав',
      (await db.role.findUnique({ where: { id: 'role' } })).permissions === JSON.stringify(legacy)
      && !(await db.appSetting.findFirst({ where: { key: 'migration:docflow.permissions.v1' } })));
    await db.role.delete({ where: { id: 'broken' } });
    await migrateDocflowPermissions(db);
    const role = JSON.parse((await db.role.findUnique({ where: { id: 'role' } })).permissions);
    const personal = JSON.parse((await db.user.findUnique({ where: { id: 'user' } })).permissions);
    check('настоящая база переводит роль без потери срока', role['docflow.edit'].until === grant.until && !('vdr.manage' in role));
    check('личный запрет и ранее назначенное право файлов сохраняются', personal['docflow.edit'].enabled === false && personal['docflow.files'].enabled === true);
    const marker = await db.appSetting.findFirst({ where: { key: 'migration:docflow.permissions.v1' } });
    check('снимок исходных прав записан одной транзакцией с переносом', JSON.parse(marker.value).before.length === 2);
    await db.role.update({ where: { id: 'role' }, data: { permissions: '{}' } });
    await migrateDocflowPermissions(db);
    check('повторный запуск не возвращает снятые администратором права', (await db.role.findUnique({ where: { id: 'role' } })).permissions === '{}');
  } finally { await db.$disconnect(); fs.rmSync(temp, { recursive: true, force: true }); }
  completed = true;
  console.log(`${passed} проверок прав документооборота пройдено`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
