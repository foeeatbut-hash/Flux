/**
 * Часть Flux принадлежит серверу: сохранение из редактора не откатывает схему,
 * а запись только части Flux не сбрасывает сеанс и сообщает окнам новый хеш.
 * Изолированная база sqlite, без сервера.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { makeDocx, makeXlsx } from './officeHarness';
import { parsePrismaSchema } from '../server/schema-sync';
import { setPrisma } from '../server/context';
import { setDialect } from '../server/ddl';
import { registerOfficeFileRoutes, writeOfficeFile, onOfficeFluxPartWritten } from '../server/routes/officeFiles';
import { fileBytes } from '../server/routes/fileChunks';
import { createFileFromBytes } from '../server/officeStore';
import { officeBus } from '../server/officeBus';
import { readOfficeBindings, writeOfficeBindings, type OfficePackageBindings } from '../server/officeBindings';

const reqModule = createRequire(join(process.cwd(), 'package.json'));
const { PrismaClient } = reqModule('@prisma/client-sqlite');
const { PrismaBetterSqlite3 } = reqModule('@prisma/adapter-better-sqlite3');
const dir = mkdtempSync(join(tmpdir(), 'flux-part-'));
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${join(dir, 'part.sqlite')}` }) });
const owner = { id: 'owner', name: 'Владелец', role: 'USER' };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const schema = (title: string): OfficePackageBindings => ({
  version: 1, schemaVersion: 1, sourceRevision: 'R1',
  anchors: [{ id: 'a1', kind: 'word-row', parts: [{ kind: 'text', text: title }] }], rows: [],
});
/** Правка документа так, как её сделал бы редактор: меняется тело, часть Flux остаётся прежней */
async function edited(bytes: Buffer, text: string, bodyPart: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  zip.file(bodyPart, `${await zip.file(bodyPart)!.async('string')}<!-- ${text} -->`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function main() {
  try {
    setDialect('sqlite'); setPrisma(prisma);
    const models = parsePrismaSchema('sqlite', readFileSync('prisma/schema.prisma', 'utf8'));
    for (const model of models.filter((m) => ['User', 'FileNode', 'FileChunk', 'FileVersion'].includes(m.name))) {
      const columns = model.columns.map((c) => `"${c.name}" ${c.sqlType}${c.nullable ? '' : ' NOT NULL'}${c.isId ? ' PRIMARY KEY' : ''}${c.unique ? ' UNIQUE' : ''}${c.defaultSql ? ` DEFAULT ${c.defaultSql}` : ''}`);
      const uniques = model.uniques.map((k) => `UNIQUE (${k.columns.map((n) => `"${n}"`).join(',')})`);
      await prisma.$executeRawUnsafe(`CREATE TABLE "${model.name}" (${[...columns, ...uniques].join(',')})`);
    }
    await prisma.user.create({ data: { ...owner, symbol: owner.id, password: 'test-only' } });
    registerOfficeFileRoutes({ get() {}, post() {}, put() {}, delete() {} } as any, { chunkBytes: async () => 65536, mayWrite: async () => '' });
    const home = { folderId: null, scope: 'PERSONAL' as const, ownerId: owner.id, dir: '/personal/' };
    const make = async (name: string, body: Buffer) => (await createFileFromBytes({ name, body, home, userId: owner.id, chunkBytes: 65536 })).id;
    const save = (fileId: string, body: Buffer, baseSha: string, extra: object = {}) => writeOfficeFile({ fileId, body, baseSha, user: owner, ...extra });

    let dropped = 0;
    (officeBus as any).dropSession = async () => { dropped++; };
    const notified: Array<[string, string, string]> = [];
    onOfficeFluxPartWritten((id, from, to) => notified.push([id, from, to]));

    for (const [kind, plain, bodyPart] of [['docx', await makeDocx(), 'word/document.xml'], ['xlsx', await makeXlsx(), 'xl/worksheets/sheet1.xml']] as const) {
      // Редактор открыл файл со схемой A
      const opened = await writeOfficeBindings(plain, schema('A'));
      const id = await make(`схема.${kind}`, opened);
      const openedSha = sha(opened);

      // Сервер записал схему B, окно об этом не знает и продолжает править
      const withB = await writeOfficeBindings(opened, schema('B'));
      dropped = 0; notified.length = 0;
      const rec = await save(id, withB, openedSha, { server: true, fluxPartOnly: true });
      assert.equal(rec.status, 200, `${kind}: запись схемы`);
      assert.equal(dropped, 0, `${kind}: запись только части Flux не сбрасывает сеанс`);
      assert.deepEqual(notified, [[id, openedSha, rec.json.sha256]], `${kind}: окна получают новый хеш`);

      // Сохранение редактора: тело со старой схемой A и правкой текста
      const fromEditor = await edited(opened, 'правка', bodyPart);
      const stale = await save(id, fromEditor, openedSha);
      assert.equal(stale.status, 409, `${kind}: старый хеш по-прежнему отвергается`);
      const ok = await save(id, fromEditor, rec.json.sha256);
      assert.equal(ok.status, 200, `${kind}: сохранение редактора с новым хешем`);
      const stored = await fileBytes(await prisma.fileNode.findUnique({ where: { id } }));
      assert.equal(sha(stored), ok.json.sha256, `${kind}: ответ называет хеш записанных байтов`);
      assert.equal(((await readOfficeBindings(stored))?.anchors[0].parts[0] as { text: string }).text, 'B', `${kind}: схема сервера не откатилась`);
      assert.ok((await (await JSZip.loadAsync(stored)).file(bodyPart)!.async('string')).includes('<!-- правка -->'), `${kind}: правка редактора записана`);
      assert.equal(dropped, 0, `${kind}: сохранение редактора сеанс не трогает`);

      // Редактор вернул документ в прежнее состояние со старой схемой: схема сервера всё равно остаётся
      const back = await save(id, opened, ok.json.sha256);
      assert.equal(back.status, 200);
      assert.equal(((await readOfficeBindings(await fileBytes(await prisma.fileNode.findUnique({ where: { id } }))))?.anchors[0].parts[0] as { text: string }).text, 'B', `${kind}: повторное сохранение тоже не откатывает схему`);

      // Обычная серверная запись (восстановление, «Обновить поля») сеанс сбрасывает
      const srv = await save(id, await edited(stored, 'сервер', bodyPart), back.json.sha256, { server: true });
      assert.equal(srv.status, 200);
      assert.equal(dropped, 1, `${kind}: запись, меняющая содержимое, сбрасывает сеанс`);
      assert.equal(notified.length, 1, `${kind}: окна не пересчитываются без fluxPartOnly`);
    }

    // Файл без схемы, не пакет и не docx/xlsx: тело не трогается
    const plainDocx = await makeDocx();
    const id = await make('без-схемы.docx', plainDocx);
    const body = await edited(plainDocx, 'x', 'word/document.xml');
    assert.equal((await save(id, body, sha(plainDocx))).json.sha256, sha(body), 'без схемы в файле тело записывается как есть');
    const idRaw = await make('мусор.docx', Buffer.from('не zip, но с customXml/itemFluxOffice.xml внутри'));
    const raw = Buffer.from('другое содержимое');
    assert.equal((await save(idRaw, raw, sha(Buffer.from('не zip, но с customXml/itemFluxOffice.xml внутри')))).json.sha256, sha(raw), 'повреждённый пакет не роняет сохранение');
    console.log('test-office-flux-part: все проверки пройдены');
  } finally {
    await prisma.$disconnect().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
