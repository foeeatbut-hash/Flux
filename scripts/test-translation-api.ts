import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import express from 'express';
import JSZip from 'jszip';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setPrisma } from '../server/context.js';
import { setDialect } from '../server/ddl.js';
import { registerSchemaClient } from '../server/schemaRuntime.js';
import { registerOfficeFileRoutes } from '../server/routes/officeFiles.js';
import { ensureSharing } from '../server/fileSharing.js';
import { fileBytes } from '../server/routes/fileChunks.js';
import { readOfficeBindings } from '../server/officeBindings.js';
import { FLUX_PART, putFluxPart } from '../office/fluxPart.js';

const requireFromRepo = createRequire(join(process.cwd(), 'package.json'));
const Database = requireFromRepo('better-sqlite3');
const { PrismaClient } = requireFromRepo('@prisma/client-sqlite');
const { PrismaBetterSqlite3 } = requireFromRepo('@prisma/adapter-better-sqlite3');
const directory = mkdtempSync(join(tmpdir(), 'flux-translation-api-'));
const databasePath = join(directory, 'api.sqlite');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fileId = 'doc-translation-1';
const owner = { id: 'writer', role: 'ENGINEER_VENT' };
const reader = { id: 'reader', role: 'ENGINEER_VENT' };
const stranger = { id: 'stranger', role: 'ENGINEER_VENT' };
const privateFileId = 'doc-readonly-1';

function createDatabase() {
  const sql = new Database(databasePath);
  sql.exec(`
    CREATE TABLE AppSetting (id TEXT PRIMARY KEY, key TEXT NOT NULL, userId TEXT, value TEXT NOT NULL, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(key, userId));
    CREATE TABLE User (id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'ENGINEER_VENT', createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE FileNode (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, filePath TEXT NOT NULL, origin TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT 'FILE', department TEXT, statusCode TEXT NOT NULL DEFAULT 'D', revision TEXT NOT NULL DEFAULT '1',
      scope TEXT NOT NULL DEFAULT 'SHARED', ownerId TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, createdById TEXT,
      updatedById TEXT, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, content TEXT, refId TEXT, folderId TEXT, deletedAt DATETIME, deletedById TEXT
    );
    CREATE TABLE FileChunk (id TEXT PRIMARY KEY, fileId TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, UNIQUE(fileId, idx));
    CREATE TABLE FileVersion (id TEXT PRIMARY KEY, fileId TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '', data BLOB NOT NULL, createdById TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE OfficeDocumentRevision (id TEXT PRIMARY KEY, documentId TEXT NOT NULL, fileId TEXT NOT NULL, parentRevisionId TEXT, revision INTEGER NOT NULL, status TEXT NOT NULL, sha256 TEXT NOT NULL, sourceSha TEXT NOT NULL, sourceKind TEXT, sourceRevision TEXT, schemaVersion INTEGER NOT NULL DEFAULT 1, data BLOB NOT NULL, createdById TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO User (id, role) VALUES ('admin', 'ADMIN');
  `);
  sql.close();
}

function makePackage(documentText: string, bindings: any) {
  return (async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>');
    zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
    zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${documentText}</w:t></w:r></w:p></w:body></w:document>`);
    let bytes = Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
    if (bindings) bytes = Buffer.from(await putFluxPart(bytes, `<fluxOffice xmlns="urn:flux:office:v1">${JSON.stringify(bindings).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</fluxOffice>`));
    return bytes;
  })();
}

void (async () => {
  let prisma: any;
  let listener: any;
  try {
    createDatabase();
    prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}`, timeout: 15000 }) });
    setDialect('sqlite'); registerSchemaClient(prisma, 'sqlite'); setPrisma(prisma);

    const anchor = { id: 'anchor-source-1', kind: 'word-row', part: 'document', parts: [{ kind: 'text', text: 'Equipment' }] };
    const oldTranslation = { sourceId: 'prior-source', key: 'p:old', destination: 'fr', revision: 'old-rev', time: 11, mode: 'replace', scope: 'document', targetLocation: { kind: 'word', from: 1, to: 3 }, targetText: 'ancien', sourceText: 'old' };
    const originalBindings = {
      version: 1, schemaVersion: 1, sourceRevision: 'schema-r1', anchors: [anchor],
      rows: [{ entityId: 'tag-42', entityType: 'tag', sourceId: 'flux-row-source-42', sourceRevision: 'row-r1', anchorIds: [anchor.id], cells: { [anchor.id]: 'FLUXROW_0123456789abcdef' }, values: { [anchor.id]: 'AHU-42' } }],
      template: { templateId: 'template-preserved', name: 'Approved template', appliedAt: '2026-10-01T00:00:00.000Z', anchors: [anchor] },
      translations: [oldTranslation], translationBindings: [{ sourceId: 'prior-source', key: 'p:old', targetText: 'ancien' }], displayLabels: { 'prior-source:p:old': 'Ancien libellé' },
    };
    const initial = await makePackage('Original body', originalBindings);
    const edited = await makePackage('Edited body', { version: 1, schemaVersion: 1, sourceRevision: 'stale-editor-schema', anchors: [], rows: [] });

    await prisma.fileNode.create({ data: { id: fileId, name: 'commissioning.docx', filePath: '/shared/commissioning.docx', size: initial.length, type: 'DOCX', scope: 'SHARED', createdById: owner.id, updatedById: owner.id, content: null } });
    await prisma.fileChunk.create({ data: { fileId, idx: 0, data: initial } });
    await prisma.fileNode.create({ data: { id: privateFileId, name: 'private.docx', filePath: '/personal/private.docx', size: initial.length, type: 'DOCX', scope: 'PERSONAL', ownerId: owner.id, createdById: owner.id, updatedById: owner.id, content: null } });
    await prisma.fileChunk.create({ data: { fileId: privateFileId, idx: 0, data: initial } });
    await ensureSharing(prisma);
    await prisma.$executeRawUnsafe(`INSERT INTO "FileShare" ("fileId","ownerId","sourceKey","audience","permission","recipients","epoch","state","expectedSha","expectedSize","changedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?)`, privateFileId, owner.id, 'private-share', 'USERS', 'VIEW', JSON.stringify([reader.id]), 1, 'READY', sha256(initial), initial.length, Date.now());

    const app = express(); app.use(express.json());
    app.use((req: any, _res, next) => { const id = String(req.header('authorization') || '').replace(/^Bearer /, ''); req.authUser = [owner, reader, stranger].find((actor) => actor.id === id) || null; next(); });
    registerOfficeFileRoutes(app, { chunkBytes: async () => 1024, mayWrite: async () => '', holderOf: async () => null });
    listener = await new Promise<any>((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    const origin = `http://127.0.0.1:${listener.address().port}`;
    const callStage = (id: string, user: typeof owner | typeof reader | typeof stranger | null, body: any) => fetch(`${origin}/api/office/files/${id}/translations/stage`, {
      method: 'POST', headers: { ...(user ? { Authorization: `Bearer ${user.id}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const storedBefore = await fileBytes(await prisma.fileNode.findUnique({ where: { id: fileId } }));
    const fileShaBefore = sha256(storedBefore), versionCountBefore = await prisma.fileVersion.count();
    const delta = {
      records: [{ sourceId: 'new-source-1', key: 'word-unit-1', destination: 'es', revision: 'source-rev-1', time: 42, mode: 'replace', scope: 'document', targetLocation: { kind: 'word', from: 1, to: 11 }, targetText: 'Hola equipo', sourceText: 'Hello team' }],
      bindings: [{ sourceId: 'new-source-1', key: 'word-unit-1', targetText: 'Hola equipo', targetLocation: { kind: 'word', from: 1, to: 11 } }],
      displayLabels: { 'new-source-1:word-unit-1': 'Equipo' },
    };
    const stagePayload = (baseHash = fileShaBefore, nextDelta: any = delta) => ({ baseHash, delta: nextDelta });

    assert.equal((await callStage(fileId, null, stagePayload())).status, 401, 'unauthenticated stage request is rejected');
    assert.equal((await callStage(privateFileId, reader, stagePayload())).status, 404, 'shared read-only ACL cannot stage metadata');
    assert.equal((await callStage(privateFileId, stranger, stagePayload())).status, 404, 'unshared actor cannot stage a private file');
    assert.equal((await callStage(fileId, owner, stagePayload('wrong-base'))).status, 409, 'stale base is rejected before staging');
    const malformed = await callStage(fileId, owner, stagePayload(fileShaBefore, { records: [{ key: 'missing required translation fields' }] }));
    assert.equal(malformed.status, 400, 'malformed metadata is rejected before staging');
    assert.equal(await prisma.appSetting.count(), 0, 'rejected requests create no stage tokens');

    const stagedResponse = await callStage(fileId, owner, stagePayload());
    assert.equal(stagedResponse.status, 200, 'valid translation delta is staged');
    const staged = await stagedResponse.json() as any;
    assert.ok(staged.token); assert.equal(staged.baseHash, fileShaBefore);
    assert.equal(sha256(await fileBytes(await prisma.fileNode.findUnique({ where: { id: fileId } }))), fileShaBefore, 'staging does not write file bytes');
    assert.equal(await prisma.fileVersion.count(), versionCountBefore, 'staging does not create a file version');

    const put = (user: typeof owner | typeof reader, token: string, baseHash: string) => fetch(`${origin}/api/office/files/${fileId}/content`, {
      method: 'PUT', headers: { Authorization: `Bearer ${user.id}`, 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x-base-sha256': baseHash, 'x-flux-translation-token': token }, body: edited,
    });
    assert.equal((await put(reader, staged.token, fileShaBefore)).status, 409, 'another actor cannot consume a staged token');
    assert.equal((await put(owner, staged.token, 'wrong-base')).status, 409, 'content PUT rejects a token with a mismatched base');
    assert.equal(await prisma.fileVersion.count(), 0, 'actor/base failures do not write the file');

    const saved = await put(owner, staged.token, fileShaBefore);
    assert.equal(saved.status, 200, `content and translation metadata save together: ${JSON.stringify(await saved.clone().json())}`);
    const savedJson = await saved.json() as any;
    assert.ok(savedJson.sha256); assert.notEqual(savedJson.sha256, fileShaBefore);
    assert.equal(await prisma.fileVersion.count(), 1, 'one atomic save records exactly one pre-write version');
    assert.equal((await put(owner, staged.token, fileShaBefore)).status, 409, 'consumed token cannot replay');

    const persistedBytes = await fileBytes(await prisma.fileNode.findUnique({ where: { id: fileId } }));
    const packageState = await readOfficeBindings(persistedBytes);
    assert.ok(packageState);
    assert.equal(await (await JSZip.loadAsync(persistedBytes)).file('word/document.xml')!.async('string').then((xml) => xml.includes('Edited body')), true, 'edited document bytes are present');
    assert.equal(await (await JSZip.loadAsync(persistedBytes)).file(FLUX_PART)!.async('string').then((xml) => xml.includes('stale-editor-schema')), false, 'stale editor hidden part is replaced by the current server part');
    assert.equal(packageState!.template?.templateId, 'template-preserved', 'existing template snapshot survives translation merge');
    assert.equal(packageState!.rows[0].sourceId, 'flux-row-source-42', 'existing row source identity survives');
    assert.equal(packageState!.anchors[0].id, 'anchor-source-1', 'existing anchor identity survives');
    assert.deepEqual(packageState!.translations?.map((item) => item.sourceId), ['prior-source', 'new-source-1'], 'prior and new translation records survive together');
    assert.equal(packageState!.translationBindings?.find((item) => item.sourceId === 'new-source-1')?.targetText, 'Hola equipo');
    assert.equal(packageState!.displayLabels?.['new-source-1:word-unit-1'], 'Equipo');
    const readback = await fetch(`${origin}/api/office/files/${fileId}/translations`, { headers: { Authorization: `Bearer ${owner.id}` } });
    assert.equal(readback.status, 200);
    const readbackJson = await readback.json() as any;
    assert.equal(readbackJson.translations.at(-1).sourceId, 'new-source-1', 'real translations API reads back the committed record');
    assert.equal(readbackJson.baseHash, savedJson.sha256, 'readback hash matches the one content save');

    console.log('translation API: Express + SQLite stage ACL/base guards, single content+metadata write, replay protection, and package retention passed');
  } finally {
    if (listener) await new Promise<void>((resolve) => listener.close(() => resolve()));
    if (prisma) await prisma.$disconnect().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
