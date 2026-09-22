import type { Express, Request, Response } from 'express';
import { getPrisma, sendError } from '../context.js';
import {
  cancelBatch, ensureImportTables, queueImport, type QueuedFile,
} from '../importJobs.js';
import { sanitizeDraftUnits, cleanTagLinks, DRAFT_LIMITS, draftFailure } from './equipmentDraft.js';

/**
 * Центр операций: фоновый ввоз расчётов.
 *
 * Партия файлов ставится в очередь и пишется на сервере. Окно можно закрыть —
 * это и есть весь смысл: двадцать три выгрузки за раз пишутся не мгновенно, а
 * до сих пор ввоз жил во вкладке браузера и умирал вместе с ней.
 *
 * Санитайзер здесь тот же, что у мастера: присланное дерево проверяется ДО
 * постановки, а не в момент записи. Иначе кривой файл обнаружился бы через
 * полчаса в журнале заданий, а человек к тому времени уже ушёл.
 */

const authUserOf = (req: Request) => (req as any).authUser || null;

/** Сколько файлов принимаем одной партией. Переполнение — отказ с числом. */
const MAX_FILES = 100;

const toJob = (row: any) => ({
  id: row.id,
  batchId: row.batchId,
  fileName: row.fileName,
  state: row.state,
  attempt: row.attempt,
  error: row.error || '',
  summary: row.summaryJson ? safeJson(row.summaryJson) : null,
  updatedAt: row.updatedAt,
});

function safeJson(text: string): any {
  try { return JSON.parse(text || 'null'); } catch (_) { return null; }
}

export function registerImportJobRoutes(app: Express): void {
  /**
   * Поставить партию в очередь.
   *
   * `idemKey` — ключ сеанса ввоза из окна. Нажали «Импортировать» дважды,
   * закрыли и вернулись — задания те же, а не вторые.
   */
  app.post('/api/import-jobs', async (req: Request, res: Response) => {
    try {
      await ensureImportTables();
      const me = authUserOf(req);
      const body = (req.body || {}) as Record<string, any>;
      const projectId = String(body.projectId || '').trim();
      if (!projectId) {
        return res.status(400).json({
          error: 'Не выбран проект. Импорт оборудования ведётся по проекту — выберите его и повторите.',
          code: 'PROJECT_REQUIRED',
        });
      }
      const category = String(body.category || '').trim();
      if (!category) return res.status(400).json({ error: 'Не указана категория оборудования' });

      const raw = Array.isArray(body.files) ? body.files : [];
      if (!raw.length) return res.status(400).json({ error: 'В партии нет ни одного файла' });
      if (raw.length > MAX_FILES) {
        return res.status(400).json({
          error: `Файлов в партии: ${raw.length} при пределе ${MAX_FILES}. Разделите ввоз.`,
        });
      }

      const idemKey = String(body.idemKey || '').trim().slice(0, 120);
      if (!idemKey) return res.status(400).json({ error: 'Нет ключа сеанса ввоза' });

      /**
       * Два вида задания, и проверяются они по-разному.
       *
       * Файл из хранилища (`fileId`) разбирает сам проход очереди: двадцать три
       * выгрузки по сорок тысяч узлов окно не потянет, да и смысл очереди в
       * том, чтобы окно можно было закрыть. Присланное деревом приходит из
       * мастера распознавания, и его санитайзер обязателен ЗДЕСЬ: кривой файл
       * человек должен увидеть сейчас, а не через полчаса в журнале заданий.
       */
      const files: QueuedFile[] = raw.map((f: any, i: number) => {
        const common = {
          fileName: String(f?.fileName || `Файл ${i + 1}`).slice(0, 200),
          tagLinks: cleanTagLinks(f?.tagLinks),
          selection: Array.isArray(f?.selection) ? f.selection.map(String).slice(0, DRAFT_LIMITS.blocks * 10) : null,
          edits: f?.edits && typeof f.edits === 'object' ? f.edits : undefined,
        };
        const fileId = String(f?.fileId || '').trim();
        if (fileId) return { ...common, fileId: fileId.slice(0, 64) };

        const units = Array.isArray(f?.units) ? f.units : [];
        if (!units.length) throw new Error(`Файл ${i + 1}: не указан ни файл, ни результат разбора`);
        return { ...common, units: sanitizeDraftUnits(units).units };
      });

      const title = String(body.title || '').trim().slice(0, 200)
        || `Расчёт, файлов: ${files.length}`;
      const out = await queueImport(projectId, category, title, files, idemKey, me?.id);
      res.json({ ok: true, ...out });
    } catch (err: any) {
      const known = draftFailure(err);
      if (known) return res.status(400).json(known);
      sendError(res, err);
    }
  });

  /** Что сейчас в работе и чем кончилось недавнее. */
  app.get('/api/import-jobs', async (req: Request, res: Response) => {
    try {
      await ensureImportTables();
      const prisma = getPrisma();
      const projectId = String(req.query.projectId || '').trim();
      const batches = await prisma.importBatch.findMany({
        where: projectId ? { projectId } : {},
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      const ids = batches.map((b: any) => b.id);
      const jobs = ids.length
        ? await prisma.importJob.findMany({ where: { batchId: { in: ids } }, orderBy: { createdAt: 'asc' } })
        : [];

      res.json({
        batches: batches.map((b: any) => {
          const mine = jobs.filter((j: any) => j.batchId === b.id);
          const by = (state: string) => mine.filter((j: any) => j.state === state).length;
          return {
            id: b.id, title: b.title, state: b.state, category: b.category,
            createdAt: b.createdAt,
            total: mine.length,
            done: by('DONE'), failed: by('FAILED'), cancelled: by('CANCELLED'),
            running: by('RUNNING'), queued: by('QUEUED'),
            jobs: mine.map(toJob),
          };
        }),
      });
    } catch (err: any) { sendError(res, err); }
  });

  /**
   * Отменить партию.
   *
   * Что уже пишется — не обрывается: оборванная запись оставила бы в проекте
   * полуустановку. Сколько таких, сказано числом.
   */
  app.post('/api/import-jobs/:batchId/cancel', async (req: Request, res: Response) => {
    try {
      const out = await cancelBatch(String(req.params.batchId));
      res.json({
        ok: true, ...out,
        note: out.running
          ? `Отменено заданий: ${out.cancelled}. Ещё ${out.running} уже пишется — их обрывать нельзя, дождитесь конца.`
          : `Отменено заданий: ${out.cancelled}.`,
      });
    } catch (err: any) { sendError(res, err); }
  });
}
