import { createHash, randomUUID } from 'node:crypto';
import { createIndexSql, ensureTables, getDialect, isDuplicateIndex } from './ddl.js';
import { getPrisma } from './context.js';
import { clientDialect, oncePerDatabase, withSchemaConnection } from './schemaRuntime.js';
import { inspectSchema } from './schemaInspection.js';

export const officeSha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

let schemaError: string | null = null;

/**
 * Один номер — одна выпущенная ревизия и один черновик: выпуск черновика
 * берёт его номер, поэтому статус входит в ключ. Имя — то же, что даёт схеме
 * Prisma и автомиграция (server/schema-sync.ts), чтобы ключ не завёлся дважды.
 */
export const OFFICE_REVISION_KEY = 'OfficeDocumentRevision_documentId_revision_status_key';
const OFFICE_REVISION_KEY_COLUMNS = ['documentId', 'revision', 'status'];

export interface OfficeRevisionDuplicate { documentId: string; revision: number; status: string; rows: number }

/**
 * Группы строк с одним [documentId, revision, status] — повторы, из-за которых
 * ключ нельзя создать. Только чтение: ничего не удаляется и не правится
 * (flux-data-safety), разбирать их будет человек по этому списку.
 */
export async function findOfficeRevisionDuplicates(db: any): Promise<OfficeRevisionDuplicate[]> {
  const groups = await db.officeDocumentRevision.groupBy({
    by: ['documentId', 'revision', 'status'],
    _count: { _all: true },
    having: { id: { _count: { gt: 1 } } },
  });
  return groups.map((g: any) => ({ documentId: String(g.documentId), revision: Number(g.revision), status: String(g.status), rows: Number(g._count?._all ?? g._count) }));
}

/** Для старта сервера: число групп повторов в журнал. Не падает и ничего не пишет в базу. */
export async function reportOfficeRevisionDuplicates(db: any, log: (message: string) => void): Promise<number> {
  try {
    const groups = await findOfficeRevisionDuplicates(db);
    if (groups.length) {
      const sample = groups.slice(0, 5).map(g => `${g.documentId} R${g.revision} ${g.status} ×${g.rows}`).join('; ');
      log(`[Office Revisions] Повторов номера ревизии: ${groups.length} групп (документ, номер, статус), ключ уникальности не создан, данные не тронуты. Первые: ${sample}`);
    } else log('[Office Revisions] Повторов номера ревизии нет: 0 групп.');
    return groups.length;
  } catch (e: any) {
    log(`[Office Revisions] Отчёт о повторах номеров ревизий не получен: ${e?.message || e}`);
    return 0;
  }
}

/**
 * Досоздать на уже установленной базе уникальный ключ ревизий (до него таблица
 * держала только обычный индекс). Повторы в таблице ключ не пускают: тогда ключ
 * не создаётся, причина пишется в журнал, старт не падает, строки не трогаются —
 * так же ведёт себя ensureUniqueKeys в schema-sync. Ключ, уже созданный
 * автомиграцией под тем же набором колонок, считается готовым.
 */
export async function ensureOfficeRevisionKey(db: any, log: (message: string) => void = (m) => console.warn(m)): Promise<boolean> {
  try {
    const dialect = clientDialect(db, getDialect());
    return await withSchemaConnection(db, async (connection) => {
      const table = 'OfficeDocumentRevision';
      const current = (await inspectSchema(connection, dialect, [{ table, cols: [] }])).get(table);
      const wanted = [...OFFICE_REVISION_KEY_COLUMNS].sort().join(',');
      for (const index of current?.indexes.values() || []) {
        if (index.unique && index.valid && !index.partial && [...index.columns].sort().join(',') === wanted) return true;
      }
      const duplicates = await findOfficeRevisionDuplicates(db);
      if (duplicates.length) {
        log(`[Office Revisions] Не удалось создать ключ ${OFFICE_REVISION_KEY} (${OFFICE_REVISION_KEY_COLUMNS.join(', ')}): в журнале ${duplicates.length} групп повторов. Данные не тронуты.`);
        return false;
      }
      try {
        await connection.$executeRawUnsafe(createIndexSql(dialect, table, OFFICE_REVISION_KEY, OFFICE_REVISION_KEY_COLUMNS, true));
      } catch (e: any) {
        // Автомиграция или соседний процесс успели раньше — цель достигнута
        if (!isDuplicateIndex(e?.message)) throw e;
      }
      return true;
    });
  } catch (e: any) {
    log(`[Office Revisions] Ключ ${OFFICE_REVISION_KEY} не создан: ${e?.message || e}. Данные не тронуты.`);
    return false;
  }
}

/** Нарушение уникального ключа: код Prisma или сырой текст движка. */
export function isOfficeRevisionKeyViolation(error: any): boolean {
  return error?.code === 'P2002'
    || /Unique constraint|UNIQUE constraint|duplicate key|Duplicate entry|ER_DUP_ENTRY/i.test(String(error?.message || ''));
}

/** Проигравшему гонку: номер ревизии уже занят, текущая — в ответе. */
export function officeRevisionConflict(current: number | null) {
  return Object.assign(new Error(
    `Номер ревизии уже занят: другой пользователь только что выпустил или создал ревизию этого документа${current ? ` (сейчас R${current})` : ''}. Обновите список ревизий и повторите.`,
  ), { status: 409, code: 'OFFICE_REVISION_CONFLICT', currentRevision: current });
}

/** Подстраховка для уже установленной базы, пока штатная миграция не применит модель. */
export async function ensureOfficeRevisionTable(): Promise<void> {
  const db = getPrisma();
  const error = await oncePerDatabase(db, 'office-document-revisions', async () => {
    let failure = '';
    try { await (db as any).officeDocumentRevision.count(); }
    catch {
      failure = await ensureTables(db, [{
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
          { name: 'OfficeDocumentRevision_file_status_idx', cols: ['fileId', 'status'] },
        ],
      }]);
    }
    // Ключ — отдельным шагом и не валит старт: повторы в старой таблице его не пускают
    if (!failure) await ensureOfficeRevisionKey(db);
    return failure;
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
