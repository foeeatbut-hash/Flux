import { createHash, randomUUID } from 'node:crypto';
import { ensureTables } from './ddl.js';
import { getPrisma } from './context.js';
import { oncePerDatabase } from './schemaRuntime.js';

export const officeSha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

let schemaError: string | null = null;

/** Подстраховка для уже установленной базы, пока штатная миграция не применит модель. */
export async function ensureOfficeRevisionTable(): Promise<void> {
  const db = getPrisma();
  const error = await oncePerDatabase(db, 'office-document-revisions', async () => {
    try { await (db as any).officeDocumentRevision.count(); return ''; }
    catch {
      return ensureTables(db, [{
        table: 'OfficeDocumentRevision',
        cols: [
          { name: 'id', kind: 'text', pk: true },
          { name: 'documentId', kind: 'text', notNull: true, def: '', indexed: true },
          { name: 'fileId', kind: 'text', notNull: true, def: '', indexed: true },
          { name: 'parentRevisionId', kind: 'text' },
          { name: 'revision', kind: 'int', notNull: true, def: 1 },
          { name: 'status', kind: 'text', notNull: true, def: 'DRAFT', indexed: true },
          { name: 'sha256', kind: 'text', notNull: true, def: '' },
          { name: 'sourceSha', kind: 'text', notNull: true, def: '' },
          { name: 'sourceKind', kind: 'text' },
          { name: 'sourceRevision', kind: 'text' },
          { name: 'schemaVersion', kind: 'int', notNull: true, def: 1 },
          { name: 'data', kind: 'blob', notNull: true },
          { name: 'createdById', kind: 'text' },
          { name: 'createdAt', kind: 'time', notNull: true, def: 'now' },
        ],
        indexes: [
          { name: 'OfficeDocumentRevision_document_revision_idx', cols: ['documentId', 'revision'] },
          { name: 'OfficeDocumentRevision_file_status_idx', cols: ['fileId', 'status'] },
        ],
      }]);
    }
  });
  if (error) schemaError = error;
  else schemaError = null;
  if (schemaError) throw new Error(`Не удалось подготовить журнал ревизий Office: ${schemaError}`);
}

/** Сохранение уже выпущенного документа запрещается во всех путях записи. */
export async function isIssuedOfficeFile(db: any, fileId: string): Promise<boolean> {
  try {
    return !!(await db.officeDocumentRevision.findFirst({ where: { fileId, status: 'ISSUED' }, select: { id: true } }));
  } catch (error: any) {
    if (schemaError) throw new Error(`Журнал ревизий Office недоступен: ${schemaError}`);
    throw error;
  }
}

export function immutableOfficeFileError() {
  return Object.assign(new Error('Документ выпущен и неизменяем. Создайте черновик новой ревизии.'), { status: 423, code: 'OFFICE_REVISION_ISSUED' });
}

/** Захватывает актуальную строку документа; вызывается внутри транзакции. */
export async function claimOfficeDocument(tx: any, file: any): Promise<boolean> {
  const stamp = new Date(Math.max(Date.now(), new Date(file.updatedAt).getTime() + 1));
  const claimed = await tx.fileNode.updateMany({
    where: { id: file.id, updatedAt: file.updatedAt, deletedAt: null },
    data: { updatedAt: stamp },
  });
  return Number(claimed?.count) === 1;
}

export function makeRevisionRow(a: {
  documentId: string; fileId: string; parentRevisionId?: string | null; revision: number; status: 'ISSUED' | 'DRAFT';
  data: Buffer; sourceSha: string; sourceKind?: string; sourceRevision?: string; schemaVersion?: number; userId: string;
}) {
  return {
    id: randomUUID(), documentId: a.documentId, fileId: a.fileId, parentRevisionId: a.parentRevisionId || null,
    revision: a.revision, status: a.status, data: Buffer.from(a.data), sha256: officeSha256(a.data), sourceSha: a.sourceSha,
    sourceKind: a.sourceKind || null, sourceRevision: a.sourceRevision || null, schemaVersion: a.schemaVersion || 1,
    createdById: a.userId, createdAt: new Date(),
  };
}
