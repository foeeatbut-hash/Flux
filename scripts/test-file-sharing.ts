/** Изолированная база: права, целостность снимка, отзыв во время записи и две шины одной компании. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { parsePrismaSchema } from '../server/schema-sync';
import { setPrisma } from '../server/context';
import { setDialect } from '../server/ddl';
import { registerFileSharingRoutes } from '../server/routes/fileSharing';
import { registerFileChunkRoutes, fileBytes } from '../server/routes/fileChunks';
import { registerOfficeFileRoutes, writeOfficeFile } from '../server/routes/officeFiles';
import { canReadFile, canWriteFile, canManageFile } from '../server/fileAccess';
import { ensureSharing, shareHash, shareOf, ShareDenied } from '../server/fileSharing';
import { OfficeBus } from '../server/officeBus';
import { CollabBook, CollabShared } from '../server/officeCollab';
import { OfficeRoomHub } from '../server/officeRooms';
import * as Y from 'yjs';

const reqModule = createRequire(join(process.cwd(), 'package.json'));
const { PrismaClient } = reqModule('@prisma/client-sqlite');
const { PrismaBetterSqlite3 } = reqModule('@prisma/adapter-better-sqlite3');
const dir = mkdtempSync(join(tmpdir(), 'flux-sharing-'));
const makeClient = (name: string) => new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${join(dir, name)}` }) });
const prisma = makeClient('company.sqlite');
const other = makeClient('other.sqlite');
const owner = { id: 'owner', name: 'Владелец', role: 'USER' };
const anna = { id: 'anna', name: 'Анна', role: 'USER' };
const boris = { id: 'boris', name: 'Борис', role: 'USER' };
const handlers = new Map<string, Function>();
const app: any = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (path: string, ...fns: Function[]) => handlers.set(`${method} ${path}`, fns.at(-1)!)]));
const call = async (method: string, path: string, user = owner, body: any = {}, params: any = {}) => {
  let status = 200, value: any;
  const res: any = { status: (code: number) => { status = code; return res; }, json: (json: any) => { value = json; return res; }, setHeader: () => {}, end: (bytes?: Buffer) => { value = bytes; return res; }, write: () => {} };
  await handlers.get(`${method} ${path}`)!({ authUser: user, params, body }, res);
  return { status, value };
};
let buses: OfficeBus[] = [];

async function main() {
  try {
    setDialect('sqlite'); setPrisma(prisma);
    const models = parsePrismaSchema('sqlite', readFileSync('prisma/schema.prisma', 'utf8'));
    for (const model of models.filter(model => ['User', 'FileNode', 'FileChunk', 'FileVersion'].includes(model.name))) {
      const columns = model.columns.map(column => `"${column.name}" ${column.sqlType}${column.nullable ? '' : ' NOT NULL'}${column.isId ? ' PRIMARY KEY' : ''}${column.unique ? ' UNIQUE' : ''}${column.defaultSql ? ` DEFAULT ${column.defaultSql}` : ''}`);
      const uniques = model.uniques.map(key => `UNIQUE (${key.columns.map(name => `"${name}"`).join(',')})`);
      await prisma.$executeRawUnsafe(`CREATE TABLE "${model.name}" (${[...columns, ...uniques].join(',')})`);
    }
    for (const user of [owner, anna, boris]) await prisma.user.create({ data: { ...user, symbol: user.id, password: 'test-only' } });
    // Подготовка одного клиента не делает второй готовым — даже без setPrisma.
    await Promise.all([ensureSharing(prisma), ensureSharing(other)]);
    assert.equal(Number((await other.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "FileShare"'))[0].n), 0);
    registerFileSharingRoutes(app, { chunkBytes: async () => 16 });
    registerFileChunkRoutes(app, { chunkBytes: async () => 16, mayWrite: async () => '' });
    registerOfficeFileRoutes(app, { chunkBytes: async () => 65536, mayWrite: async () => '' });
    const original = Buffer.from('Общий исходник с несколькими частями');
    const sourceKey = shareHash(Buffer.from('opaque-local-reference'));
    let s = (await call('post', '/api/file-sharing/publications', owner, { sourceKey, name: 'План.bin', size: original.length, sha256: shareHash(original) })).value;
    assert.equal(s.state, 'PENDING');
    assert.equal(await canReadFile(prisma, anna, s.fileId), false);
    let denied = await call('put', '/api/file-sharing/:id/access', owner, { epoch: s.epoch, audience: 'ALL', permission: 'EDIT' }, { id: s.fileId });
    assert.equal(denied.status, 409, 'неполный снимок не публикуется');
    for (let offset = 0, idx = 0; offset < original.length; offset += 16, idx++) {
      const uploaded = await call('put', '/api/file-sharing/:id/chunks/:idx', owner, { base64: original.subarray(offset, offset + 16).toString('base64'), epoch: s.epoch }, { id: s.fileId, idx });
      assert.equal(uploaded.status, 200);
    }
    const access = async (audience: string, permission = 'EDIT', recipients: string[] = [], epoch = s.epoch) => {
      const response = await call('put', '/api/file-sharing/:id/access', owner, { audience, permission, recipients, epoch }, { id: s.fileId });
      if (response.status === 200) s = response.value;
      return response;
    };
    assert.equal((await access('USERS', 'EDIT', [anna.id])).status, 200);
    assert.equal(await canReadFile(prisma, anna, s.fileId), true);
    assert.equal(await canWriteFile(prisma, anna, s.fileId), true);
    assert.equal(await canManageFile(prisma, anna, s.fileId), false);
    assert.equal(await canReadFile(prisma, boris, s.fileId), false);
    assert.equal((await call('get', '/api/file-sharing/received', anna)).value.files.length, 1);
    assert.equal((await call('post', '/api/file-sharing/:id/hide', anna, {}, { id: s.fileId })).status, 200);
    assert.equal((await call('get', '/api/file-sharing/received', anna)).value.files.length, 0);
    assert.equal(await canReadFile(prisma, anna, s.fileId), true, 'скрыть у себя не отзывает права');
    assert.equal((await access('USERS', 'VIEW', [anna.id])).status, 200);
    assert.equal((await call('get', '/api/file-sharing/received', anna)).value.files.length, 1, 'повторная выдача возвращает скрытую ссылку');
    assert.equal(await canWriteFile(prisma, anna, s.fileId), false);
    assert.equal((await writeOfficeFile({ fileId: s.fileId, user: anna, body: Buffer.from('подмена'), baseSha: shareHash(original) })).status, 404);
    assert.equal((await call('post', '/api/files/:id/chunk', owner, { idx: 0, data: 'eA==' }, { id: s.fileId })).status, 409);
    const oldEpoch = s.epoch;
    await access('ALL');
    assert.equal((await access('NONE', 'EDIT', [], oldEpoch)).status, 409, 'устаревшее окно не меняет права');
    assert.equal(await canWriteFile(prisma, boris, s.fileId), true);
    const a = new OfficeBus({ prisma: () => prisma, dialect: () => 'sqlite', url: () => '', log: () => {} });
    const b = new OfficeBus({ prisma: () => prisma, dialect: () => 'sqlite', url: () => '', log: () => {} });
    buses = [a, b];
    const fence = { actorId: anna.id, epoch: s.epoch };
    const seq = await a.publish(s.fileId, { kind: 'x', fromSocket: 'anna-socket', data: Buffer.from('первая') }, { guard: fence });
    assert.equal(seq, 1);
    await access('NONE');
    assert.equal((await call('get', '/api/file-sharing/received', anna)).value.files.length, 0);
    assert.equal(await canReadFile(prisma, anna, s.fileId), false);
    const rawDenied = await call('get', '/api/files/:id/raw', anna, {}, { id: s.fileId });
    assert.equal(rawDenied.status, 404);
    await assert.rejects(() => b.publish(s.fileId, { kind: 'x', data: Buffer.from('опоздавшая') }, { guard: fence }), ShareDenied);
    assert.equal((await b.session(s.fileId))!.lastSeq, 1, 'отказ не тратит номер журнала');
    const docs = new CollabShared(b, new CollabBook(), new OfficeRoomHub(b));
    const document = await docs.session(s.fileId, async () => original);
    const sender = new Y.Doc(); sender.getText('body').insert(0, 'Отозванная правка');
    await assert.rejects(() => docs.accept(s.fileId, 'anna-socket', Y.encodeStateAsUpdate(sender), fence), ShareDenied);
    assert.equal(document.ydoc.getText('body').toString(), '', 'отозванная Y-правка не попадает даже в память сервера');
    sender.destroy(); docs.book.drop(s.fileId);
    await access('USERS', 'EDIT', [anna.id]);
    await assert.rejects(() => a.patchSession({ fileId: s.fileId }, { savedSha: 'подмена' }, fence), ShareDenied, 'повторная выдача не оживляет прежний пакет');
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(r => { entered = r; });
    const resume = new Promise<void>(r => { release = r; });
    registerOfficeFileRoutes(app, { mayWrite: async () => '', chunkBytes: async () => { entered(); await resume; return 65536; } });
    const saving = writeOfficeFile({ fileId: s.fileId, user: anna, body: Buffer.from('запись после отзыва'), baseSha: shareHash(original) });
    await waiting;
    await access('NONE');
    release();
    assert.equal((await saving).status, 403, 'отзыв между проверкой и транзакцией запрещает запись');
    assert.equal(shareHash(await fileBytes(await prisma.fileNode.findUnique({ where: { id: s.fileId } }))), shareHash(original));
    assert.equal(await prisma.fileVersion.count(), 0, 'отказ не оставляет фиктивной версии');
    await access('ALL');
    registerOfficeFileRoutes(app, { chunkBytes: async () => 65536, mayWrite: async () => '' });
    assert.equal((await writeOfficeFile({ fileId: s.fileId, user: owner, body: Buffer.from('локальная версия'), baseSha: shareHash(original) })).json.pendingSharedEdits, true, 'синхронизация исходника не затирает несохранённый журнал');
    await a.patchSession({ fileId: s.fileId }, { savedSeq: 1 }, { actorId: owner.id, epoch: s.epoch });
    const saves = await Promise.all([anna, boris].map(user => writeOfficeFile({ fileId: s.fileId, user, body: Buffer.from(user.name), baseSha: shareHash(original) })));
    assert.deepEqual(saves.map(r => r.status).sort(), [200, 409], 'два сохранения одной ревизии: один победитель');
    assert.equal(await prisma.fileVersion.count(), 1);
    assert.equal((await prisma.fileVersion.findFirst()).sha256, shareHash(original), 'откат хранит прежнюю версию');
    // Незавершённую загрузку можно начать с новым снимком; её старые части уже не проходят.
    const pendingKey = shareHash(Buffer.from('interrupted'));
    const p = (await call('post', '/api/file-sharing/publications', owner, { sourceKey: pendingKey, name: 'Повтор.bin', size: 1, sha256: shareHash(Buffer.from('a')) })).value;
    const restarted = await call('post', '/api/file-sharing/publications', owner, { sourceKey: pendingKey, name: 'Повтор.bin', size: 1, sha256: shareHash(Buffer.from('b')), epoch: p.epoch });
    assert.equal(restarted.status, 200);
    assert.equal(restarted.value.epoch, p.epoch + 1);
    assert.equal((await call('put', '/api/file-sharing/:id/chunks/:idx', owner, { base64: 'YQ==', epoch: p.epoch }, { id: p.fileId, idx: 0 })).status, 409);
    assert.equal((await shareOf(prisma, s.fileId))!.ownerId, owner.id);
    console.log('✓ Личный оригинал, получатели, отзыв, версии и две шины: изолированная SQLite');
  } finally {
    await Promise.all(buses.map(bus => bus.stop()));
    await Promise.all([prisma.$disconnect(), other.$disconnect()]);
    rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
