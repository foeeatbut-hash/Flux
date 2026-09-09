/**
 * Таблицы обращений в общей базе — страховка поверх автомиграции.
 *
 * Автомиграция (`server/schema-sync.ts`) читает схему Prisma и создаёт таблицы
 * и колонки, но **не создаёт индексов** — ни обычных, ни составных
 * уникальных. Для большинства разделов это стоило бы лишь скорости, а здесь —
 * правильности: на составных `@@unique` держится идемпотентность. Без
 * `[authorId, clientRequestId]` повторная отправка после обрыва связи завела бы
 * вторую карточку, а без `[uploadId, index]` — задвоила бы кусок файла.
 *
 * Поэтому описание таблиц продублировано здесь и создаётся через
 * `server/ddl.ts`: `CREATE TABLE IF NOT EXISTS`, затем недостающие колонки,
 * затем индексы. Всё идемпотентно, «уже есть» считается достигнутой целью.
 *
 * Расхождение с Prisma-схемой ловит `scripts/test-feedback-ddl.ts`: два списка
 * без проверки разъезжаются за пару выпусков.
 */

import { ensureTables, type Col, type TableSpec } from '../ddl.js';
import { onDatabaseSwapped } from '../context.js';

const id = (): Col => ({ name: 'id', kind: 'text', pk: true, indexed: true });
const key = (name: string): Col => ({ name, kind: 'text', notNull: true, indexed: true });
const opt = (name: string): Col => ({ name, kind: 'text', indexed: true });
const text = (name: string, def = ''): Col => ({ name, kind: 'longtext', def });
const int = (name: string, def = 0): Col => ({ name, kind: 'int', notNull: true, def });
const at = (name: string, now = true): Col => ({ name, kind: 'time', notNull: now, def: now ? 'now' : null });
const when = (name: string): Col => ({ name, kind: 'time' });

export const FEEDBACK_TABLES: TableSpec[] = [
  {
    table: 'FeedbackReport',
    cols: [
      id(),
      { name: 'number', kind: 'int', notNull: true, def: 0, indexed: true },
      key('authorId'),
      text('authorDisplayNameSnapshot'),
      key('clientRequestId'),
      key('submitHash'),
      key('type'),
      text('title'),
      text('description'),
      text('reproductionJson', '[]'),
      text('expected'),
      text('actual'),
      text('benefit'),
      key('frequency'),
      key('impact'),
      key('sectionKey'),
      opt('projectId'),
      at('incidentAt'),
      key('appVersion'),
      key('status'),
      opt('resumeStatus'),
      key('priority'),
      opt('assigneeId'),
      text('resolution'),
      opt('resolvedVersion'),
      opt('duplicateOfId'),
      int('revision', 1),
      at('createdAt'),
      at('updatedAt'),
      when('closedAt'),
      when('firstResponseAt'),
      at('lastPublicAt'),
      when('lastInternalAt'),
    ],
    indexes: [
      { name: 'FeedbackReport_number_key', cols: ['number'], unique: true },
      // На этом индексе держится «повтор не плодит карточек»
      { name: 'FeedbackReport_author_request_key', cols: ['authorId', 'clientRequestId'], unique: true },
      { name: 'FeedbackReport_author_created_idx', cols: ['authorId', 'createdAt'] },
      { name: 'FeedbackReport_queue_idx', cols: ['status', 'priority', 'createdAt'] },
      { name: 'FeedbackReport_assignee_idx', cols: ['assigneeId', 'status'] },
      { name: 'FeedbackReport_section_version_idx', cols: ['sectionKey', 'appVersion'] },
      { name: 'FeedbackReport_duplicate_idx', cols: ['duplicateOfId'] },
    ],
  },
  {
    table: 'FeedbackCounter',
    cols: [{ name: 'key', kind: 'text', pk: true, indexed: true }, int('value')],
  },
  {
    table: 'FeedbackRateWindow',
    cols: [id(), key('actorId'), key('kind'), at('windowStart'), int('count')],
    indexes: [
      // Предел считается этим индексом: без него два сервера завели бы два окна
      { name: 'FeedbackRateWindow_key', cols: ['actorId', 'kind', 'windowStart'], unique: true },
      { name: 'FeedbackRateWindow_start_idx', cols: ['windowStart'] },
    ],
  },
  {
    table: 'FeedbackComment',
    cols: [
      id(), key('reportId'), key('authorId'), key('clientRequestId'),
      key('visibility'), text('text'), at('createdAt'),
      when('redactedAt'), text('redactionReason'),
    ],
    indexes: [
      { name: 'FeedbackComment_author_request_key', cols: ['authorId', 'clientRequestId'], unique: true },
      { name: 'FeedbackComment_report_idx', cols: ['reportId', 'createdAt'] },
    ],
  },
  {
    table: 'FeedbackEvent',
    cols: [
      id(), key('reportId'), opt('actorId'), key('kind'), key('visibility'),
      int('revision'), text('dataJson', '{}'), at('createdAt'),
    ],
    indexes: [
      // Одно событие на ревизию: история не имеет ни пропусков, ни двойников
      { name: 'FeedbackEvent_report_revision_key', cols: ['reportId', 'revision'], unique: true },
      { name: 'FeedbackEvent_report_created_idx', cols: ['reportId', 'createdAt'] },
    ],
  },
  {
    table: 'FeedbackUpload',
    cols: [
      id(), key('ownerId'), key('clientRequestId'), key('draftId'), key('kind'),
      text('originalName'), opt('verifiedMime'), int('declaredBytes'), key('sha256'),
      int('chunkSize'), int('chunkCount'), key('status'), at('expiresAt'),
      at('createdAt'), at('updatedAt'), int('revision', 1), opt('reportId'),
      when('processingLeaseUntil'), opt('processingLeaseOwner'),
    ],
    indexes: [
      { name: 'FeedbackUpload_owner_request_key', cols: ['ownerId', 'clientRequestId'], unique: true },
      { name: 'FeedbackUpload_cleanup_idx', cols: ['status', 'expiresAt'] },
      { name: 'FeedbackUpload_report_idx', cols: ['reportId'] },
    ],
  },
  {
    table: 'FeedbackUploadChunk',
    cols: [
      id(), key('uploadId'),
      { name: 'index', kind: 'int', notNull: true, def: 0, indexed: true },
      key('sha256'),
      { name: 'bytes', kind: 'blob' },
      int('byteLength'), at('createdAt'),
    ],
    indexes: [
      // Повтор того же куска не должен задваивать байты файла
      { name: 'FeedbackUploadChunk_upload_index_key', cols: ['uploadId', 'index'], unique: true },
      { name: 'FeedbackUploadChunk_upload_idx', cols: ['uploadId'] },
    ],
  },
  {
    table: 'FeedbackAttachment',
    cols: [
      id(), key('reportId'), key('uploadId'), key('kind'), text('displayName'),
      key('mime'), int('byteLength'), key('sha256'),
      { name: 'width', kind: 'int' }, { name: 'height', kind: 'int' },
      opt('thumbnailOfId'), at('createdAt'), when('expiresAt'), when('expiredAt'),
    ],
    indexes: [
      { name: 'FeedbackAttachment_upload_key', cols: ['uploadId'], unique: true },
      { name: 'FeedbackAttachment_report_idx', cols: ['reportId'] },
      { name: 'FeedbackAttachment_thumb_idx', cols: ['thumbnailOfId'] },
    ],
  },
  {
    table: 'FeedbackDiagnosticBundle',
    cols: [
      id(), key('reportId'), key('attachmentId'),
      text('manifestJson', '{}'), text('summaryJson', '{}'), opt('fingerprint'), at('createdAt'),
    ],
    indexes: [
      { name: 'FeedbackDiagnosticBundle_attachment_key', cols: ['attachmentId'], unique: true },
      { name: 'FeedbackDiagnosticBundle_report_idx', cols: ['reportId'] },
    ],
  },
  {
    table: 'FeedbackReadState',
    cols: [
      id(), key('reportId'), key('userId'),
      int('lastPublicRevision'), int('lastInternalRevision'), at('updatedAt'),
    ],
    indexes: [
      { name: 'FeedbackReadState_report_user_key', cols: ['reportId', 'userId'], unique: true },
      { name: 'FeedbackReadState_user_idx', cols: ['userId'] },
    ],
  },
  {
    table: 'FeedbackMutationReceipt',
    cols: [
      id(), key('actorId'), key('clientRequestId'), key('requestHash'), key('reportId'),
      int('resultRevision'), text('resultJson', '{}'), at('createdAt'),
    ],
    indexes: [
      // Без этого индекса двойное нажатие обработчика делает действие дважды
      { name: 'FeedbackMutationReceipt_actor_request_key', cols: ['actorId', 'clientRequestId'], unique: true },
      { name: 'FeedbackMutationReceipt_created_idx', cols: ['createdAt'] },
    ],
  },
  {
    table: 'FeedbackOutbox',
    cols: [
      id(), key('dedupeKey'), key('reportId'), key('recipientId'),
      int('publicRevision'), key('kind'), text('payloadJson', '{}'), key('state'),
      int('attempt'), at('availableAt'), when('leaseUntil'), opt('leaseOwner'), at('createdAt'),
    ],
    indexes: [
      { name: 'FeedbackOutbox_dedupe_key', cols: ['dedupeKey'], unique: true },
      { name: 'FeedbackOutbox_queue_idx', cols: ['state', 'availableAt'] },
      { name: 'FeedbackOutbox_report_idx', cols: ['reportId'] },
    ],
  },
  {
    table: 'FeedbackChange',
    cols: [id(), key('reportId'), int('revision'), key('visibility'), at('createdAt')],
    indexes: [
      { name: 'FeedbackChange_report_revision_key', cols: ['reportId', 'revision'], unique: true },
      { name: 'FeedbackChange_created_idx', cols: ['createdAt'] },
    ],
  },
];

let ready = false;

/**
 * Один раз за жизнь клиента базы убедиться, что таблицы на месте.
 *
 * Проба идёт по настоящей колонке, а не по существованию таблицы: таблица,
 * созданная прошлой версией программы, бывает неполной, и «она есть» тогда
 * значит «дальше упадёт вставка». Тот же приём, что у журнала действий.
 */
export async function ensureFeedbackTables(prisma: any, log?: (m: string) => void): Promise<string> {
  if (ready) return '';
  try {
    await prisma.feedbackReport.findFirst({ select: { submitHash: true } });
    ready = true;
    return '';
  } catch (_) { /* таблицы нет или она неполная — создаём */ }
  const failure = await ensureTables(prisma, FEEDBACK_TABLES, log);
  if (!failure) ready = true;
  return failure;
}

/** Смена базы: у новой свои таблицы, и проверять их надо заново. */
export function resetFeedbackTables(): void {
  ready = false;
}

// Клиент базы пересоздаётся при переключении на другую базу, и запомненное
// «таблицы на месте» относилось бы к прежней. Тот же приём, что у системных
// папок и общего диска
onDatabaseSwapped(resetFeedbackTables);
