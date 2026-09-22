/**
 * Долговечные задания импорта: очередь, которая переживает закрытое окно.
 *
 * Заказчик приносит расчёт не одним файлом, а папкой: двадцать три выгрузки за
 * раз. До сих пор такой ввоз жил в браузере — предпросмотр держал очередь у
 * себя и писал файл за файлом. Закрыл вкладку на седьмом, ушёл на обед, связь
 * моргнула — и дальше седьмого ничего не уехало, а какие семь уже уехали,
 * узнать было неоткуда.
 *
 * Поэтому очередь переехала в базу. Постановка партии — одна запись на файл,
 * запись идёт отдельным проходом, а окно только смотрит. Окно можно закрыть.
 *
 * Идиомы взяты у очереди платформы (`server/play/outbox.ts`), и не из любви к
 * единообразию: они там уже отработаны на живых прогонах.
 *
 *   — **Аренда.** У сотрудников разные встроенные серверы на одной базе.
 *     Задание берётся условным обновлением по сроку аренды: чужое отсеется
 *     само, даже если его взяли между выборкой и захватом.
 *   — **Повтор — не второе действие.** У постановки есть ключ идемпотентности,
 *     и он уникален в базе: повторная отправка той же партии не заводит второй
 *     ввоз, а возвращает прежний.
 *   — **Отступ перед повтором растёт.** База, занятая на секунду, чинится сама.
 *   — **Падение видно.** Кончились попытки — задание становится FAILED с
 *     причиной словами, а не исчезает.
 */

import { randomUUID } from 'node:crypto';
import { getPrisma, onDatabaseSwapped } from './context.js';
import { ensureTables, type TableSpec } from './ddl.js';
import { importEquipmentToDB } from './equipmentImport.js';
import { applyEdits, filterBySelection, planEquipmentImport, type EditMap } from './equipmentPlan.js';
import { readEquipmentFile } from './equipmentFile.js';
import type { TagLink } from './equipmentTags.js';

/** Как часто заглядывать в очередь. Импорт не игра — раз в две секунды хватит. */
const TICK_MS = 2000;
/** Аренда на пять минут: файл на сорок тысяч узлов пишется не мгновенно. */
const LEASE_MS = 5 * 60_000;
/** Столько раз пробуем, потом откладываем с причиной. */
const ATTEMPTS = 3;
/** За проход берём одно задание: импорт тяжёлый, и база нужна не только ему. */
const BATCH = 1;

const backoffMs = (attempt: number): number => Math.min(60_000, 2000 * 2 ** Math.max(0, attempt - 1));

const TABLES: TableSpec[] = [
  {
    table: 'ImportBatch',
    cols: [
      { name: 'id', kind: 'text', pk: true, indexed: true },
      { name: 'projectId', kind: 'text', notNull: true, indexed: true },
      { name: 'category', kind: 'text', notNull: true, def: 'AHU' },
      { name: 'title', kind: 'text', notNull: true, def: 'Импорт' },
      { name: 'state', kind: 'text', notNull: true, def: 'RUNNING', indexed: true },
      { name: 'createdById', kind: 'text' },
      { name: 'createdAt', kind: 'time', notNull: true, def: 'now' },
      { name: 'updatedAt', kind: 'time', notNull: true, def: 'now' },
    ],
    indexes: [{ name: 'ImportBatch_projectId_createdAt_idx', cols: ['projectId', 'createdAt'] }],
  },
  {
    table: 'ImportJob',
    cols: [
      { name: 'id', kind: 'text', pk: true, indexed: true },
      { name: 'batchId', kind: 'text', notNull: true, indexed: true },
      { name: 'projectId', kind: 'text', notNull: true, indexed: true },
      { name: 'category', kind: 'text', notNull: true, def: 'AHU' },
      { name: 'fileName', kind: 'text', notNull: true, def: 'Файл' },
      { name: 'state', kind: 'text', notNull: true, def: 'QUEUED', indexed: true },
      { name: 'payloadJson', kind: 'longtext' },
      { name: 'summaryJson', kind: 'longtext' },
      { name: 'error', kind: 'longtext' },
      { name: 'attempt', kind: 'int', notNull: true, def: 0 },
      { name: 'availableAt', kind: 'time', notNull: true, def: 'now' },
      { name: 'leaseUntil', kind: 'time' },
      { name: 'leaseOwner', kind: 'text' },
      { name: 'idemKey', kind: 'text', notNull: true, def: '', indexed: true },
      { name: 'createdById', kind: 'text' },
      { name: 'createdAt', kind: 'time', notNull: true, def: 'now' },
      { name: 'updatedAt', kind: 'time', notNull: true, def: 'now' },
    ],
    indexes: [
      { name: 'ImportJob_state_availableAt_idx', cols: ['state', 'availableAt'] },
      { name: 'ImportJob_batchId_idx', cols: ['batchId'] },
      // Повтор постановки не заводит второй ввоз — это держит база, а не код
      { name: 'ImportJob_idemKey_key', cols: ['idemKey'], unique: true },
    ],
  },
];

let ready = false;
onDatabaseSwapped(() => { ready = false; });

export async function ensureImportTables(): Promise<void> {
  if (ready) return;
  await ensureTables(getPrisma(), TABLES);
  ready = true;
}

// ── Постановка ──────────────────────────────────────────────────────────────

export interface QueuedFile {
  fileName: string;
  /**
   * Файл в хранилище программы.
   *
   * Это и есть случай папки: окно не разбирает двадцать три выгрузки, чтобы
   * положить их в запрос, — оно их только называет. Разбор и план делает сам
   * проход очереди, и делает это уже после того, как окно закрыли.
   */
  fileId?: string;
  /** Разобранное дерево — когда файл пришёл через мастер распознавания */
  units?: any[];
  tagLinks?: TagLink[];
  selection?: string[] | null;
  edits?: EditMap;
}

export interface QueueResult {
  batchId: string;
  queued: number;
  /** Файлы, которые уже стояли в очереди по тому же ключу — повтор постановки */
  already: number;
}

/**
 * Поставить партию файлов в очередь.
 *
 * `idemBase` — ключ идемпотентности партии. Окно берёт его из своего сеанса
 * ввоза: нажали «Импортировать» дважды, ушли и вернулись — задания те же.
 */
export async function queueImport(
  projectId: string, category: string, title: string, files: QueuedFile[],
  idemBase: string, createdById?: string,
): Promise<QueueResult> {
  await ensureImportTables();
  const prisma = getPrisma();

  const batch = await prisma.importBatch.create({
    data: { projectId, category, title, state: 'RUNNING', createdById: createdById || null },
  });

  let queued = 0;
  let already = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const idemKey = `${idemBase}#${i}`;
    try {
      await prisma.importJob.create({
        data: {
          batchId: batch.id, projectId, category,
          fileName: String(file.fileName || `Файл ${i + 1}`).slice(0, 200),
          state: 'QUEUED',
          payloadJson: JSON.stringify({
            ...(file.fileId ? { fileId: file.fileId } : { units: file.units || [] }),
            tagLinks: file.tagLinks || [],
            selection: file.selection ?? null,
            edits: file.edits || {},
          }),
          idemKey,
          createdById: createdById || null,
        },
      });
      queued++;
    } catch (_) {
      // Уникальный ключ в базе: повтор той же постановки — не второй ввоз
      already++;
    }
  }
  return { batchId: batch.id, queued, already };
}

// ── Проход очереди ──────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let working = false;

const safeJson = (text: string): any => {
  try { return JSON.parse(text || '{}'); } catch (_) { return {}; }
};

/**
 * Один проход. Возвращает, сколько заданий выполнено, — это нужно проверкам:
 * «ноль» и «не работает» иначе неотличимы.
 */
export async function drainImportJobs(): Promise<number> {
  const prisma = getPrisma();
  if (!prisma) return 0;
  const now = new Date();
  const token = randomUUID();
  let done = 0;

  try {
    await ensureImportTables();
    const ready0 = await prisma.importJob.findMany({
      where: {
        state: 'QUEUED',
        availableAt: { lte: now },
        attempt: { lt: ATTEMPTS },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });
    if (!ready0.length) return 0;

    // Захват: условие про аренду стоит ВНУТРИ обновления, поэтому чужое
    // задание отсеется само, даже если его взяли между выборкой и захватом
    await prisma.importJob.updateMany({
      where: {
        id: { in: ready0.map((r: any) => r.id) },
        state: 'QUEUED',
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: {
        state: 'RUNNING', leaseOwner: token,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        attempt: { increment: 1 },
      },
    });

    const mine = await prisma.importJob.findMany({ where: { leaseOwner: token, state: 'RUNNING' } });
    for (const job of mine) {
      try {
        const payload = safeJson(job.payloadJson);

        /**
         * Задание по файлу разбирается здесь, а не при постановке.
         *
         * Двадцать три выгрузки — это сорок тысяч узлов каждая; разбери их окно
         * перед отправкой, и «поставить в очередь» заняло бы столько же, сколько
         * сам импорт, а смысл очереди в том, чтобы окно можно было закрыть.
         */
        let units = payload.units || [];
        let tagLinks = payload.tagLinks as TagLink[] | undefined;
        if (payload.fileId) {
          const read = await readEquipmentFile(String(payload.fileId));
          units = read.result.units;
          // Решения по тегам берутся из плана как есть: человека у экрана нет,
          // и спросить его некого. Занятый тег план не перевешивает — это его
          // же правило, и здесь оно работает ровно так же
          const plan = await planEquipmentImport(prisma, job.projectId, job.category, { units });
          tagLinks = plan.tagLinks;
        }

        const edited = applyEdits({ units }, payload.edits as EditMap | undefined);
        const sel = Array.isArray(payload.selection) ? new Set<string>(payload.selection) : null;
        const result = filterBySelection(edited, sel);
        if (!result.units.length) throw new Error('В задании не осталось ни одного блока');

        const summary = await importEquipmentToDB(
          prisma, job.projectId, job.category, job.fileName,
          result, 'wait', tagLinks,
        );
        await prisma.importJob.update({
          where: { id: job.id },
          data: {
            state: 'DONE', leaseOwner: null, leaseUntil: null, error: null,
            summaryJson: JSON.stringify(summary),
          },
        });
        done++;
      } catch (e: any) {
        const why = String(e?.message || e).slice(0, 1000);
        const spent = (job.attempt || 0) >= ATTEMPTS;
        await prisma.importJob.update({
          where: { id: job.id },
          data: {
            // Кончились попытки — падение НЕ прячется: задание остаётся с
            // причиной словами, и его видно в центре операций
            state: spent ? 'FAILED' : 'QUEUED',
            leaseOwner: null, leaseUntil: null, error: why,
            availableAt: new Date(Date.now() + backoffMs(job.attempt || 1)),
          },
        }).catch(() => { /* база недоступна — подберём следующим проходом */ });
      }
    }

    await closeFinishedBatches();
  } catch (_) { /* очередь не должна ронять сервер */ }
  return done;
}

/** Партия закрывается, когда ни одного незаконченного задания в ней не осталось. */
async function closeFinishedBatches(): Promise<void> {
  const prisma = getPrisma();
  const live = await prisma.importBatch.findMany({ where: { state: 'RUNNING' }, select: { id: true } });
  for (const b of live) {
    const left = await prisma.importJob.count({
      where: { batchId: b.id, state: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (left) continue;
    const failed = await prisma.importJob.count({ where: { batchId: b.id, state: 'FAILED' } });
    await prisma.importBatch.update({
      where: { id: b.id },
      data: { state: failed ? 'FAILED' : 'DONE' },
    });
  }
}

export function startImportJobs(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (working) return;   // проход длиннее интервала — не наслаиваем
    working = true;
    void drainImportJobs().finally(() => { working = false; });
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopImportJobs(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

onDatabaseSwapped(() => { stopImportJobs(); startImportJobs(); });

// ── Отмена ──────────────────────────────────────────────────────────────────

export interface CancelResult { cancelled: number; running: number }

/**
 * Отменить партию.
 *
 * Отменяется только то, что ещё не начали писать. Задание, которое пишется
 * прямо сейчас, не обрывается: оборванная запись оставила бы в проекте
 * полустановку, и разбирать её пришлось бы руками. Сколько таких — говорится
 * числом, а не умалчивается.
 */
export async function cancelBatch(batchId: string): Promise<CancelResult> {
  await ensureImportTables();
  const prisma = getPrisma();
  const stopped = await prisma.importJob.updateMany({
    where: { batchId, state: 'QUEUED' },
    data: { state: 'CANCELLED', leaseOwner: null, leaseUntil: null },
  });
  const running = await prisma.importJob.count({ where: { batchId, state: 'RUNNING' } });
  if (!running) await prisma.importBatch.update({ where: { id: batchId }, data: { state: 'CANCELLED' } });
  return { cancelled: stopped.count ?? 0, running };
}
