import type { Express, Request, Response } from 'express';
import JSZip from 'jszip';
import { getPrisma, sendError } from '../context.js';
import { FILE_NOT_FOUND, canReadFile, canWriteFile } from '../fileAccess.js';
import { fileBytes } from './fileChunks.js';
import { homeOfFile, cleanName, freeName } from '../officeStore.js';
import { officeBus } from '../officeBus.js';
import { isCollaborativeFile } from './officeFiles.js';
import { readOfficeBindings } from '../officeBindings.js';
import { projectOfFile } from '../projectFields.js';
import { canSeeProject } from './members.js';
import { isPrivilegedUser } from '../accessPolicy.js';
import { blockFingerprint, cleanQuery } from '../projectSlice.js';
import { claimOfficeDocument, ensureOfficeRevisionTable, makeRevisionRow, officeSha256 } from '../officeRevisions.js';

export interface OfficeRevisionDeps {
  chunkBytes: () => Promise<number>;
  holderOf: (fileId: string) => Promise<{ userId: string; name: string } | null>;
  mayWrite?: (req: Request, fileId: string) => Promise<string>;
  /** Те же права записи, без запрета, который не даёт менять выпущенный оригинал. */
  mayWriteDraftPermissions?: (req: Request, fileId: string) => Promise<string>;
}

const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const validOfficeFile = (file: any) => /\.(docx|xlsx)$/i.test(String(file?.name || ''));
const PUBLIC_REVISION_SELECT = {
  id: true, documentId: true, fileId: true, parentRevisionId: true, revision: true, status: true, sha256: true, sourceSha: true,
  sourceKind: true, sourceRevision: true, schemaVersion: true, createdById: true, createdAt: true,
};

async function accessible(req: Request, id: string, write = false) {
  const db = getPrisma();
  const user = (req as any).authUser;
  const file = await db.fileNode.findUnique({ where: { id } });
  const allowed = file && !file.deletedAt && (write ? await canWriteFile(db, user, file) : await canReadFile(db, user, file));
  if (!allowed) return null;
  if (!validOfficeFile(file)) throw fail('Ревизии поддерживают только DOCX и XLSX', 400);
  return file;
}

async function stableForIssue(req: Request, fileId: string, deps: OfficeRevisionDeps) {
  const db = getPrisma();
  const user = (req as any).authUser;
  if (!user?.id) throw fail('Требуется вход в систему', 401);
  const checkPermission = deps.mayWriteDraftPermissions || deps.mayWrite;
  if (checkPermission) {
    const denied = await checkPermission({ authUser: user } as any, fileId);
    if (denied) throw fail(denied, 403);
  }
  const holder = await deps.holderOf(fileId);
  if (holder && holder.userId !== String(user.id)) throw fail(`Файл открыт (${holder.name}). Дождитесь освобождения документа.`, 423);
  const file = await accessible(req, fileId, true);
  if (!file) throw fail(FILE_NOT_FOUND, 404);
  if (await isCollaborativeFile(file)) {
    const session = await officeBus.session(fileId).catch(() => null);
    if (session && Number(session.dataSeq) > Number(session.savedSeq)) throw fail('Есть несохранённые общие правки. Дождитесь их сохранения.', 409);
  }
  return file;
}

function publicRevision(row: any) {
  return {
    id: row.id, documentId: row.documentId, fileId: row.fileId, parentRevisionId: row.parentRevisionId,
    revision: row.revision, status: row.status, sha256: row.sha256, sourceSha: row.sourceSha,
    sourceKind: row.sourceKind, sourceRevision: row.sourceRevision, schemaVersion: row.schemaVersion,
    createdById: row.createdById, createdAt: row.createdAt,
  };
}

async function currentSourceRevision(req: Request, file: any): Promise<string> {
  const actor = (req as any).authUser;
  const projectId = await projectOfFile(String(file.id), String(file.projectId || ''));
  // Личный документ не даёт доступа к отпечатку первого чужого проекта.
  if (!(await canSeeProject(actor.id, projectId, isPrivilegedUser(actor)))) return '';
  return blockFingerprint(projectId, cleanQuery({ entity: 'element', columns: [] }), null);
}

export function compareOfficeBindings(before: any, after: any) {
  const oldRows = new Map<string, any>((before?.rows || []).map((row: any) => [String(row.entityId), row]));
  const newRows = new Map<string, any>((after?.rows || []).map((row: any) => [String(row.entityId), row]));
  const added: any[] = [];
  const removed: any[] = [];
  const changed: any[] = [];
  for (const [id, row] of newRows) if (!oldRows.has(id)) added.push({ entityId: id, entityType: row.entityType, sourceId: row.sourceId });
  for (const [id, row] of oldRows) if (!newRows.has(id)) removed.push({ entityId: id, entityType: row.entityType, sourceId: row.sourceId });
  for (const [id, row] of newRows) {
    const old = oldRows.get(id);
    if (!old) continue;
    const anchorIds = new Set([...Object.keys(old.values || {}), ...Object.keys(row.values || {}), ...Object.keys(old.cells || {}), ...Object.keys(row.cells || {})]);
    const fields = [...anchorIds].flatMap((anchorId) => {
      const oldValue = old.values?.[anchorId] ?? old.cells?.[anchorId] ?? null;
      const newValue = row.values?.[anchorId] ?? row.cells?.[anchorId] ?? null;
      return JSON.stringify(oldValue) === JSON.stringify(newValue) ? [] : [{ anchorId, before: oldValue, after: newValue }];
    });
    if (fields.length || old.sourceRevision !== row.sourceRevision) changed.push({ entityId: id, entityType: row.entityType, sourceId: row.sourceId, fields, sourceRevision: { before: old.sourceRevision, after: row.sourceRevision } });
  }
  return { added: added.slice(0, 1000), removed: removed.slice(0, 1000), changed: changed.slice(0, 1000) };
}

function xmlText(value: string) {
  return value.replace(/<[^>]*>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&').trim();
}

/** Короткие текстовые фрагменты дают сравнение ручных правок помимо связанных строк. */
export async function officeTextParts(bytes: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((name) => /^word\/document\.xml$|^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/i.test(name)).slice(0, 300);
  const parts = new Map<string, string>();
  let total = 0;
  for (const name of names) {
    const entry = zip.file(name);
    const declared = Number((entry as any)?._data?.uncompressedSize);
    if (!entry || (Number.isFinite(declared) && declared > 8 * 1024 * 1024)) continue;
    const xml = await entry.async('string');
    total += Buffer.byteLength(xml, 'utf8');
    if (total > 16 * 1024 * 1024) break;
    parts.set(name, xml);
  }
  const output: string[] = [];
  const word = parts.get('word/document.xml');
  if (word) for (const paragraph of word.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []) {
    const text = [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => xmlText(match[1])).join('');
    if (text) output.push(text);
  }
  const shared = [...(parts.get('xl/sharedStrings.xml') || '').matchAll(/<si\b[\s\S]*?<\/si>/g)].map((match) =>
    [...match[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((text) => xmlText(text[1])).join(''));
  for (const [name, xml] of parts) if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(name)) {
    for (const cell of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const address = /\br="([A-Z]+\d+)"/i.exec(cell[1])?.[1];
      if (!address) continue;
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell[2])?.[1];
      if (raw === undefined) continue;
      const value = /\bt="s"/.test(cell[1]) ? shared[Number(raw)] : xmlText(raw);
      if (value) output.push(`${name.split('/').at(-1)}!${address}: ${value}`);
      if (output.length >= 5000) return output;
    }
  }
  return output.slice(0, 5000);
}

export function compareTextParts(before: string[], after: string[]) {
  const oldSet = new Set(before), newSet = new Set(after);
  return { added: after.filter((part) => !oldSet.has(part)).slice(0, 100), removed: before.filter((part) => !newSet.has(part)).slice(0, 100) };
}

export function registerOfficeRevisionRoutes(app: Express, deps: OfficeRevisionDeps): void {
  app.get('/api/office/revisions/:fileId', async (req: Request, res: Response) => {
    try {
      await ensureOfficeRevisionTable();
      const file = await accessible(req, String(req.params.fileId));
      if (!file) return res.status(404).json({ error: FILE_NOT_FOUND });
      const db = getPrisma() as any;
      const linked = await db.officeDocumentRevision.findFirst({ where: { fileId: file.id }, orderBy: { createdAt: 'asc' }, select: { documentId: true } });
      const documentId = linked?.documentId || file.id;
      const revisions = await db.officeDocumentRevision.findMany({ where: { documentId }, orderBy: [{ revision: 'asc' }, { createdAt: 'asc' }], select: PUBLIC_REVISION_SELECT });
      const visible = [];
      for (const row of revisions) if (await canReadFile(db, (req as any).authUser, row.fileId)) visible.push(publicRevision(row));
      res.json({ documentId, fileId: file.id, fileName: file.name, revisions: visible });
    } catch (err: any) { sendError(res, err); }
  });

  app.post('/api/office/revisions/:fileId/issue', async (req: Request, res: Response) => {
    try {
      await ensureOfficeRevisionTable();
      const db = getPrisma() as any;
      const user = (req as any).authUser;
      if (!user?.id) return res.status(401).json({ error: 'Требуется вход в систему' });
      const file = await stableForIssue(req, String(req.params.fileId), deps);
      const before = await fileBytes(file);
      const currentSha = officeSha256(before);
      if (req.body?.sourceSha !== currentSha) return res.status(409).json({ error: 'Документ изменился после чтения. Обновите ревизии.', sourceSha: currentSha });
      const existing = await db.officeDocumentRevision.findFirst({ where: { fileId: file.id, status: 'ISSUED' }, orderBy: { createdAt: 'desc' }, select: PUBLIC_REVISION_SELECT });
      if (existing?.sha256 === currentSha) return res.json({ revision: publicRevision(existing), unchanged: true });
      if (existing) return res.status(423).json({ error: 'Документ выпущен и неизменяем. Создайте черновик новой ревизии.', code: 'OFFICE_REVISION_ISSUED' });
      const draft = await db.officeDocumentRevision.findFirst({ where: { fileId: file.id, status: 'DRAFT' }, orderBy: { createdAt: 'desc' }, select: { id: true, documentId: true, revision: true, parentRevisionId: true } });
      const documentId = draft?.documentId || file.id;
      const latest = await db.officeDocumentRevision.findFirst({ where: { documentId }, orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }] });
      const max = await db.officeDocumentRevision.findFirst({ where: { documentId }, orderBy: { revision: 'desc' }, select: { revision: true } });
      const revision = draft?.revision || Number(max?.revision || 0) + 1;
      const bindings = await readOfficeBindings(before).catch(() => null);
      const sourceKinds = [...new Set([
        ...(bindings?.rows || []).map((item) => String(item.sourceId || '')),
        ...(bindings?.anchors || []).flatMap((anchor: any) => (anchor.parts || []).map((part: any) => String(part?.binding?.sourceId || ''))),
      ].filter(Boolean))].sort();
      const sourceRevision = await currentSourceRevision(req, file);
      const row = makeRevisionRow({
        documentId, fileId: file.id, parentRevisionId: draft?.parentRevisionId || latest?.id || null,
        revision, status: 'ISSUED', data: before, sourceSha: currentSha,
        sourceKind: sourceKinds.join(',').slice(0, 120) || 'document', sourceRevision,
        schemaVersion: bindings?.schemaVersion || 1, userId: String(user.id),
      });
      const saved = await db.$transaction(async (tx: any) => {
        if (!(await claimOfficeDocument(tx, file))) return false;
        await tx.officeDocumentRevision.create({ data: row });
        return true;
      }, { timeout: 120_000 });
      if (!saved) return res.status(409).json({ error: 'Документ изменился во время выпуска. Повторите после обновления.' });
      res.status(201).json({ revision: publicRevision(row) });
    } catch (err: any) { res.status(Number(err?.status) || 400).json({ error: String(err?.message || err), code: err?.code }); }
  });

  app.post('/api/office/revisions/:fileId/draft', async (req: Request, res: Response) => {
    try {
      await ensureOfficeRevisionTable();
      const db = getPrisma() as any;
      const user = (req as any).authUser;
      if (!user?.id) return res.status(401).json({ error: 'Требуется вход в систему' });
      const source = await accessible(req, String(req.params.fileId), true);
      if (!source) return res.status(404).json({ error: FILE_NOT_FOUND });
      const revisionId = String(req.body?.revisionId || '');
      const base = await db.officeDocumentRevision.findUnique({ where: { id: revisionId } });
      if (!base || base.status !== 'ISSUED' || base.fileId !== source.id) return res.status(404).json({ error: 'Выпущенная ревизия не найдена' });
      if (officeSha256(await fileBytes(source)) !== base.sha256) return res.status(409).json({ error: 'Исходный документ изменён после выпуска. Черновик не создан.' });
      const expectedSha = String(req.body?.sourceSha || '');
      if (expectedSha !== base.sha256) return res.status(409).json({ error: 'Выбранная ревизия изменилась. Обновите список.', sourceSha: base.sha256 });
      const checkDraftPermission = deps.mayWriteDraftPermissions || deps.mayWrite;
      if (checkDraftPermission) {
        const denied = await checkDraftPermission({ authUser: user } as any, source.id);
        if (denied) return res.status(403).json({ error: denied });
      }
      const home = await homeOfFile(source.id);
      if (!home) return res.status(404).json({ error: FILE_NOT_FOUND });
      const data = Buffer.from(base.data);
      const sourceRevision = await currentSourceRevision(req, source);
      const step = Math.max(64 * 1024, await deps.chunkBytes());
      const siblings = await db.fileNode.findMany({ where: { folderId: home.folderId, deletedAt: null, scope: home.scope, ownerId: home.ownerId }, select: { name: true } });
      const baseName = source.name.replace(/(\.[^.]+)?$/, ` (черновик R${Number(base.revision) + 1})$1`);
      const name = freeName(cleanName(baseName, source.name), new Set(siblings.map((item: any) => String(item.name).toLowerCase())));
      const max = await db.officeDocumentRevision.findFirst({ where: { documentId: base.documentId }, orderBy: { revision: 'desc' }, select: { revision: true } });
      const revisionNumber = Number(max?.revision || base.revision) + 1;
      const draftRow = makeRevisionRow({ documentId: base.documentId, fileId: 'pending', parentRevisionId: base.id,
        revision: revisionNumber, status: 'DRAFT', data, sourceSha: base.sha256,
        sourceKind: base.sourceKind || 'document', sourceRevision,
        schemaVersion: base.schemaVersion, userId: String(user.id) });
      const made = await db.$transaction(async (tx: any) => {
        const fresh = await tx.fileNode.findUnique({ where: { id: source.id } });
        if (!fresh || fresh.updatedAt.getTime() !== source.updatedAt.getTime()) return null;
        const claimed = await tx.fileNode.updateMany({ where: { id: fresh.id, updatedAt: fresh.updatedAt, deletedAt: null }, data: { updatedAt: new Date(Math.max(Date.now(), fresh.updatedAt.getTime() + 1)) } });
        if (Number(claimed?.count) !== 1) return null;
        const created = await tx.fileNode.create({ data: {
          name, filePath: home.dir + name, size: data.length, type: source.type, department: home.department || source.department,
          statusCode: 'D', revision: String(revisionNumber), scope: home.scope, ownerId: home.ownerId, folderId: home.folderId,
          createdById: user.id, updatedById: user.id,
        } });
        for (let i = 0, idx = 0; i < data.length; i += step, idx++) await tx.fileChunk.create({ data: { fileId: created.id, idx, data: data.subarray(i, i + step) } });
        await tx.officeDocumentRevision.create({ data: { ...draftRow, fileId: created.id } });
        return created;
      }, { timeout: 120_000 });
      if (!made) return res.status(409).json({ error: 'Исходный документ изменился во время создания черновика.' });
      res.status(201).json({ fileId: made.id, name: made.name, revision: publicRevision({ ...draftRow, fileId: made.id }), sha256: officeSha256(data) });
    } catch (err: any) { res.status(Number(err?.status) || 400).json({ error: String(err?.message || err), code: err?.code }); }
  });

  app.get('/api/office/revisions/:fileId/compare', async (req: Request, res: Response) => {
    try {
      await ensureOfficeRevisionTable();
      const db = getPrisma() as any;
      const file = await accessible(req, String(req.params.fileId));
      if (!file) return res.status(404).json({ error: FILE_NOT_FOUND });
      const from = await db.officeDocumentRevision.findUnique({ where: { id: String(req.query.from || '') } });
      const to = await db.officeDocumentRevision.findUnique({ where: { id: String(req.query.to || '') } });
      if (!from || !to || from.documentId !== to.documentId) return res.status(404).json({ error: 'Ревизии не найдены' });
      if (from.documentId !== file.id) {
        const related = await db.officeDocumentRevision.findFirst({ where: { documentId: from.documentId, fileId: file.id }, select: { id: true } });
        if (!related) return res.status(404).json({ error: 'Ревизии не найдены' });
      }
      if (!(await canReadFile(db, (req as any).authUser, from.fileId)) || !(await canReadFile(db, (req as any).authUser, to.fileId))) {
        return res.status(404).json({ error: 'Ревизии не найдены' });
      }
      const bodyFor = async (row: any) => {
        if (row.status === 'ISSUED') return Buffer.from(row.data);
        const draftFile = await accessible(req, row.fileId);
        if (!draftFile) throw fail(FILE_NOT_FOUND, 404);
        return fileBytes(draftFile);
      };
      const [beforeBytes, afterBytes] = await Promise.all([bodyFor(from), bodyFor(to)]);
      const [beforeBindings, afterBindings, beforeText, afterText] = await Promise.all([
        readOfficeBindings(beforeBytes).catch(() => null), readOfficeBindings(afterBytes).catch(() => null),
        officeTextParts(beforeBytes).catch(() => []), officeTextParts(afterBytes).catch(() => []),
      ]);
      res.json({
        from: publicRevision(from), to: publicRevision(to),
        beforeSha: officeSha256(beforeBytes), afterSha: officeSha256(afterBytes),
        documentChanged: officeSha256(beforeBytes) !== officeSha256(afterBytes),
        sourceKnown: !!from.sourceRevision && !!to.sourceRevision,
        sourceChanged: from.sourceRevision !== to.sourceRevision,
        bindings: compareOfficeBindings(beforeBindings, afterBindings),
        text: compareTextParts(beforeText, afterText),
        bindingSchemas: { before: beforeBindings?.schemaVersion ?? null, after: afterBindings?.schemaVersion ?? null },
      });
    } catch (err: any) { res.status(Number(err?.status) || 400).json({ error: String(err?.message || err) }); }
  });
}
