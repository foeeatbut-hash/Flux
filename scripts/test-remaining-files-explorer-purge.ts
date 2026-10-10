/** Isolated Explorer recycle-bin API lifecycle on a temporary SQLite database. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { parsePrismaSchema } from '../server/schema-sync';
import { setPrisma } from '../server/context';
import { setDialect } from '../server/ddl';
import { registerExplorerRoutes } from '../server/routes/explorer';

const requireFromRepo = createRequire(join(process.cwd(), 'package.json'));
const { PrismaClient } = requireFromRepo('@prisma/client-sqlite');
const { PrismaBetterSqlite3 } = requireFromRepo('@prisma/adapter-better-sqlite3');
const temp = mkdtempSync(join(tmpdir(), 'flux-remaining-explorer-trash-'));
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${join(temp, 'explorer.sqlite')}` }) });
const handlers = new Map<string, Function>();
const app: any = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (path: string, ...fns: Function[]) => handlers.set(`${method} ${path}`, fns.at(-1)!)]));
const actor = { id: 'trash-admin', name: 'Synthetic Trash Owner', role: 'ADMIN' };
let passed = 0;
const check = (name: string, condition: boolean) => { assert.equal(condition, true, name); passed++; console.log(`✓ ${name}`); };
const call = async (method: string, path: string, params: Record<string, string>, body: any = {}) => {
  const handler = handlers.get(`${method} ${path}`);
  assert.ok(handler, `registered ${method} ${path}`);
  let status = 200, value: any;
  const res: any = { status(code: number) { status = code; return res; }, json(json: any) { value = json; return res; } };
  await handler({ authUser: actor, params, body, query: {} }, res);
  return { status, value };
};

async function main() {
  try {
    setDialect('sqlite'); setPrisma(prisma);
    const models = parsePrismaSchema('sqlite', readFileSync('prisma/schema.prisma', 'utf8'));
    for (const model of models.filter(model => ['User', 'Project', 'ProjectMember', 'Folder', 'FileNode', 'Tag', 'AppSetting'].includes(model.name))) {
      const columns = model.columns.map(column => `"${column.name}" ${column.sqlType}${column.nullable ? '' : ' NOT NULL'}${column.isId ? ' PRIMARY KEY' : ''}${column.unique ? ' UNIQUE' : ''}${column.defaultSql ? ` DEFAULT ${column.defaultSql}` : ''}`);
      const uniques = model.uniques.map(key => `UNIQUE (${key.columns.map(name => `"${name}"`).join(',')})`);
      await prisma.$executeRawUnsafe(`CREATE TABLE "${model.name}" (${[...columns, ...uniques].join(',')})`);
    }
    await prisma.$executeRawUnsafe('CREATE TABLE "_FileMainTags" ("A" TEXT NOT NULL, "B" TEXT NOT NULL, PRIMARY KEY ("A", "B"))');
    await prisma.$executeRawUnsafe('CREATE TABLE "_FileAdditionalTags" ("A" TEXT NOT NULL, "B" TEXT NOT NULL, PRIMARY KEY ("A", "B"))');
    await prisma.user.create({ data: { ...actor, symbol: 'trash-admin', password: 'synthetic', createdAt: new Date('2026-01-01T00:00:00Z') } });
    const projectA = await prisma.project.create({ data: { name: 'Synthetic trash A' } });
    const projectB = await prisma.project.create({ data: { name: 'Synthetic trash B' } });
    const folderA = await prisma.folder.create({ data: { name: 'Folder A', projectId: projectA.id, scope: 'SHARED' } });
    const folderB = await prisma.folder.create({ data: { name: 'Folder B', projectId: projectB.id, scope: 'SHARED' } });
    const fileA = await prisma.fileNode.create({ data: { id: randomUUID(), name: 'only-A.txt', filePath: '/a/only-A.txt', folderId: folderA.id, createdById: actor.id, updatedById: actor.id, type: 'TXT', size: 1 } });
    const fileB = await prisma.fileNode.create({ data: { id: randomUUID(), name: 'only-B.txt', filePath: '/b/only-B.txt', folderId: folderB.id, createdById: actor.id, updatedById: actor.id, type: 'TXT', size: 1 } });
    registerExplorerRoutes(app, { can: () => true });

    const deleteA = await call('delete', '/api/files/:id', { id: fileA.id });
    const deleteB = await call('delete', '/api/files/:id', { id: fileB.id });
    check('delete soft-removes each chosen file into recycle storage', deleteA.status === 200 && deleteA.value?.trashed === true && deleteB.status === 200 && deleteB.value?.trashed === true);
    const trashA = await call('get', '/api/projects/:projectId/trash', { projectId: projectA.id });
    const trashB = await call('get', '/api/projects/:projectId/trash', { projectId: projectB.id });
    if (!Array.isArray(trashA.value?.files) || !Array.isArray(trashB.value?.files)) console.log('trash route response:', trashA.status, trashA.value, trashB.status, trashB.value);
    check('each project recycle view includes its own deleted file only', trashA.value.files.some((file: any) => file.id === fileA.id) && !trashA.value.files.some((file: any) => file.id === fileB.id) && trashB.value.files.some((file: any) => file.id === fileB.id) && !trashB.value.files.some((file: any) => file.id === fileA.id));

    const restored = await call('post', '/api/files/:id/restore', { id: fileA.id });
    check('restore removes the selected file from trash and makes it readable', restored.status === 200 && (await prisma.fileNode.findUnique({ where: { id: fileA.id } }))?.deletedAt === null);
    const deleteAgain = await call('delete', '/api/files/:id', { id: fileA.id });
    check('restored file can be deleted again before purge', deleteAgain.status === 200 && (await prisma.fileNode.findUnique({ where: { id: fileA.id } }))?.deletedAt instanceof Date);

    const purged = await call('delete', '/api/projects/:projectId/trash', { projectId: projectA.id });
    check('purge removes the one deleted file in the selected project', purged.status === 200 && purged.value?.files === 1 && purged.value?.folders === 0 && !(await prisma.fileNode.findUnique({ where: { id: fileA.id } })));
    check('purge leaves another project’s deleted file recoverable', !!(await prisma.fileNode.findUnique({ where: { id: fileB.id } })) && (await call('get', '/api/projects/:projectId/trash', { projectId: projectB.id })).value.files.some((file: any) => file.id === fileB.id));
    console.log(`Explorer trash API: ${passed} checks PASS (temporary SQLite; synthetic projects/files)`);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
