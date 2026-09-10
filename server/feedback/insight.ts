/**
 * Сводка, кандидаты в дубли и выгрузка для разработчика.
 *
 * Три разных дела в одном модуле, потому что вопрос у них общий: «что тут на
 * самом деле происходит». Сводка отвечает про поток обращений, кандидаты — про
 * то, что одно и то же прислали пятеро, выгрузка — про одну карточку целиком.
 *
 * Правила счёта названы прямо и не подгоняются под красивое число:
 *
 * — «закрыто за период» считается по ПЕРЕХОДАМ в DONE, а не по текущему
 *   состоянию. Карточка, закрытая в понедельник и снова открытая в среду, в
 *   понедельник была закрыта — и в сводке за понедельник это видно;
 * — одна карточка в числителе считается один раз, сколько бы раз её ни
 *   закрывали;
 * — выборка меньше пяти не даёт медиан: три числа складываются во что угодно, и
 *   «медиана ответа — 4 минуты» по трём случаям вводит в заблуждение сильнее,
 *   чем честное «мало данных».
 */

import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { ensureFeedbackTables } from './tables.js';
import { actorOf, fail, ok, type Actor } from './policy.js';
import { ERRORS, STATUS_NAMES, TYPE_NAMES, PRIORITY_NAMES, reportNumber, isUuid, type Status } from '../../feedback/contracts.js';
import { technicalFingerprint, titleCloseness, CLOSE_ENOUGH, checkDuplicateChain } from '../../feedback/fingerprint.js';
import { buildArchive } from './archive.js';

export interface InsightDeps {
  can: (user: any, feature: string) => boolean;
}

/** Ниже этого числа медианы не показываем, а говорим «мало данных». */
export const ENOUGH = 5;

/** Периоды сводки. Больше года не считаем: это уже не сводка, а история. */
const MAX_DAYS = 365;

export function daysOf(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(MAX_DAYS, n);
}

/**
 * Медиана в миллисекундах или `null`, когда данных мало.
 *
 * `null` здесь — значение, а не отсутствие: окно показывает «мало данных», а не
 * прочерк, и человек понимает разницу между «никто не отвечал» и «отвечали
 * трижды, и по трём случаям я считать не берусь».
 */
export function median(values: number[]): number | null {
  const list = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (list.length < ENOUGH) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : Math.round((list[middle - 1] + list[middle]) / 2);
}

/** Сколько раз встретилось каждое значение — в порядке убывания. */
export function tally(values: string[], top = 8): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value || '—';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
}

const WAITING: Status[] = ['NEEDS_INFO'];
const CLOSED: Status[] = ['DONE', 'REJECTED', 'DUPLICATE', 'WITHDRAWN'];

export function registerInsightRoutes(app: Express, deps: InsightDeps): void {
  async function ready(req: Request, res: Response, needTriage: boolean):
    Promise<{ actor: Actor; prisma: any; triage: boolean } | null> {
    const actor = actorOf(req);
    if (!actor) { fail(res, ERRORS.FORBIDDEN, 'Нужно войти в программу'); return null; }
    const prisma = getPrisma();
    const failure = await ensureFeedbackTables(prisma);
    if (failure) { fail(res, ERRORS.UNAVAILABLE, failure); return null; }
    const triage = deps.can((req as any).authUser, 'feedback.triage');
    if (needTriage && !triage) { fail(res, ERRORS.FORBIDDEN, 'Это доступно тем, кто разбирает обращения'); return null; }
    return { actor, prisma, triage };
  }

  /** Сводка по потоку обращений. Только обработчикам: это картина по всем. */
  app.get('/api/feedback/summary', async (req: Request, res: Response) => {
    const base = await ready(req, res, true);
    if (!base) return;
    const { prisma } = base;

    const days = daysOf(req.query.days);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    const arrived = await prisma.feedbackReport.findMany({ where: { createdAt: { gte: since } }, take: 5000 });
    const open = await prisma.feedbackReport.findMany({
      where: { status: { notIn: CLOSED } }, take: 5000,
    });

    // «Закрыто» — по переходам, а не по нынешнему состоянию: иначе повторно
    // открытая карточка задним числом исчезает из прошлой недели
    const closings = await prisma.feedbackEvent.findMany({
      where: { kind: 'statusChanged', createdAt: { gte: since } },
      select: { reportId: true, dataJson: true },
      take: 20000,
    });
    const closedIds = new Set<string>();
    let reopened = 0;
    for (const row of closings) {
      let data: any = {};
      try { data = JSON.parse(row.dataJson || '{}'); } catch (_) { data = {}; }
      if (data?.to === 'DONE') closedIds.add(row.reportId);
      // Возврат из закрытого в работу — отдельная метрика, а не отрицательное
      // «закрыто»: обещать «закрыли двадцать» и умолчать о трёх возвратах нечестно
      if (CLOSED.includes(data?.from) && !CLOSED.includes(data?.to)) reopened++;
    }

    const answered = arrived.filter((r: any) => r.firstResponseAt)
      .map((r: any) => new Date(r.firstResponseAt).getTime() - new Date(r.createdAt).getTime());
    const solved = arrived.filter((r: any) => r.status === 'DONE' && r.closedAt)
      .map((r: any) => new Date(r.closedAt).getTime() - new Date(r.createdAt).getTime());

    ok(res, {
      days,
      since: since.toISOString(),
      arrived: arrived.length,
      closed: closedIds.size,
      reopened,
      open: open.length,
      unassigned: open.filter((r: any) => !r.assigneeId).length,
      waitingAuthor: open.filter((r: any) => WAITING.includes(r.status)).length,
      authors: new Set(arrived.map((r: any) => r.authorId)).size,
      firstAnswerMs: median(answered),
      solveMs: median(solved),
      /** Сколько случаев стоит за медианой — без этого числу верить нельзя. */
      answeredCount: answered.length,
      solvedCount: solved.length,
      enough: ENOUGH,
      byType: tally(arrived.map((r: any) => TYPE_NAMES[r.type as keyof typeof TYPE_NAMES] || r.type)),
      bySection: tally(arrived.map((r: any) => r.sectionKey)),
      byVersion: tally(arrived.map((r: any) => r.appVersion)),
      byStatus: tally(open.map((r: any) => STATUS_NAMES[r.status as Status] || r.status)),
    }, { note: 'Закрытые считаются по переходам в «Готово», один reportId — один раз' });
  });

  /**
   * Кандидаты в дубли для одной карточки.
   *
   * Только обработчикам. Автору чужие обращения не показываются даже
   * заголовком: сегодня это «похоже на ваше», а завтра — способ прочитать, что
   * пишут коллеги.
   */
  app.get('/api/feedback/reports/:id/duplicates', async (req: Request, res: Response) => {
    const base = await ready(req, res, true);
    if (!base) return;
    const { prisma } = base;
    const id = String(req.params.id || '');
    if (!isUuid(id)) return fail(res, ERRORS.NOT_FOUND, 'Обращение не найдено');
    const one = await prisma.feedbackReport.findUnique({ where: { id } });
    if (!one) return fail(res, ERRORS.NOT_FOUND, 'Обращение не найдено');

    // Ищем среди недавних и того же вида: дубль приходит рядом по времени, а
    // «идея» и «ошибка» дублями друг друга не бывают
    const others = await prisma.feedbackReport.findMany({
      where: { id: { not: id }, type: one.type, status: { notIn: ['DUPLICATE', 'WITHDRAWN'] } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });

    const mineFingerprint = fingerprintOf(one);
    const found: any[] = [];
    for (const other of others) {
      const sameTechnical = !!mineFingerprint && fingerprintOf(other) === mineFingerprint;
      const closeness = titleCloseness(one.title, other.title);
      const sameSection = one.sectionKey && one.sectionKey === other.sectionKey;
      if (!sameTechnical && !(closeness >= CLOSE_ENOUGH && sameSection)) continue;
      found.push({
        id: other.id, number: other.number, title: other.title, status: other.status,
        createdAt: other.createdAt,
        // Почему предложено — словами: обработчик должен видеть основание, а не
        // доверять числу
        why: sameTechnical ? 'Совпал технический отпечаток' : 'Похожий заголовок в том же разделе',
        closeness: Math.round(closeness * 100),
      });
      if (found.length >= 10) break;
    }
    ok(res, found, { note: 'Это предложение, а не решение: карточки не объединяются сами' });
  });

  /**
   * Можно ли пометить одно дублем другого.
   *
   * Отдельным запросом, потому что проверка нужна ДО нажатия: узнать про кольцо
   * из отказа после — значит показать человеку ошибку там, где он ничего
   * плохого не делал.
   */
  app.get('/api/feedback/reports/:id/duplicate-check', async (req: Request, res: Response) => {
    const base = await ready(req, res, true);
    if (!base) return;
    const { prisma } = base;
    const id = String(req.params.id || '');
    const target = String(req.query.target || '');
    if (!isUuid(id) || !isUuid(target)) return fail(res, ERRORS.VALIDATION, 'Ожидались два обращения');

    const exists = await prisma.feedbackReport.findUnique({ where: { id: target }, select: { id: true } });
    if (!exists) return fail(res, ERRORS.NOT_FOUND, 'Карточка, на которую указывают, не найдена');

    // Цепочку читаем заранее: правило про кольцо общее с окном и проверками,
    // а ходить в базу оно не умеет и не должно
    const chain = new Map<string, string | null>();
    let at: string | null = target;
    for (let step = 0; step <= 21 && at; step++) {
      const row: any = await prisma.feedbackReport.findUnique({
        where: { id: at }, select: { id: true, duplicateOfId: true },
      });
      if (!row) break;
      chain.set(row.id, row.duplicateOfId || null);
      at = row.duplicateOfId || null;
    }
    const verdict = checkDuplicateChain(id, target, (of) => chain.get(of) ?? null);
    ok(res, { allowed: verdict.ok, reason: verdict.error || '' });
  });

  /**
   * Выгрузка карточки одним Markdown.
   *
   * Для разработчика: всё, что нужно, чтобы повторить сбой, — в одном месте и
   * в виде, который можно вставить куда угодно. Внутренние заметки в выгрузку
   * попадают только у того, кто и так их видит; автору выгрузка отдаёт ровно
   * то, что он видит в карточке.
   */
  app.get('/api/feedback/reports/:id/export', async (req: Request, res: Response) => {
    const base = await ready(req, res, false);
    if (!base) return;
    const { actor, prisma, triage } = base;
    const id = String(req.params.id || '');
    if (!isUuid(id)) return fail(res, ERRORS.NOT_FOUND, 'Обращение не найдено');
    const one = await prisma.feedbackReport.findUnique({ where: { id } });
    if (!one || (one.authorId !== actor.id && !triage)) {
      return fail(res, ERRORS.NOT_FOUND, 'Обращение не найдено');
    }
    const comments = await prisma.feedbackComment.findMany({
      where: triage ? { reportId: id } : { reportId: id, visibility: 'PUBLIC' },
      orderBy: { createdAt: 'asc' }, take: 500,
    });
    const attachments = await prisma.feedbackAttachment.findMany({
      where: { reportId: id },
      select: { displayName: true, kind: true, byteLength: true, mime: true },
    });
    ok(res, { markdown: toMarkdown(one, comments, attachments, triage) });
  });

  /**
   * Пакет для разработчика — одним архивом.
   *
   * Markdown отдаёт переписку и перечень имён вложений; имена — это не данные,
   * по ним сбой не воспроизвести. Здесь уезжает то, с чем можно работать:
   * опись полноты, сырые записи источников, лента событий, сводка и заготовка
   * воспроизведения.
   *
   * Право проверяется ЗДЕСЬ, а не скрытием кнопки: прямой запрос по адресу
   * никакой кнопки не спрашивает, а в записях лежит работа программы, которую
   * автору обращения видеть незачем.
   */
  app.get('/api/feedback/reports/:id/package', async (req: Request, res: Response) => {
    const base = await ready(req, res, false);
    if (!base) return;
    const { prisma } = base;
    if (!deps.can((req as any).authUser, 'feedback.diagnostics')) {
      return fail(res, ERRORS.FORBIDDEN, 'Пакет диагностики доступен по праву «Технические вложения»');
    }
    const id = String(req.params.id || '');
    if (!isUuid(id)) return fail(res, ERRORS.NOT_FOUND, 'Обращение не найдено');
    const one = await prisma.feedbackReport.findUnique({ where: { id } });
    if (!one) return fail(res, ERRORS.NOT_FOUND, 'Обращение не найдено');

    const bundle = await prisma.feedbackDiagnosticBundle.findFirst({ where: { reportId: id } });
    const attachments = await prisma.feedbackAttachment.findMany({
      where: { reportId: id },
      select: { displayName: true, kind: true, byteLength: true, uploadId: true },
    });

    // Сырые записи — только технические вложения: файлы человека в архив не
    // кладём, их скачивают из карточки отдельно и осознанно
    const sources: Record<string, string> = {};
    for (const part of attachments) {
      if (part.kind !== 'DIAGNOSTICS') continue;
      if (!/\.jsonl$/i.test(part.displayName)) continue;
      const chunks = await prisma.feedbackUploadChunk.findMany({
        where: { uploadId: part.uploadId }, orderBy: { index: 'asc' }, select: { bytes: true },
      });
      if (!chunks.length) continue;
      sources[part.displayName] = Buffer.concat(chunks.map((c: any) => Buffer.from(c.bytes))).toString('utf8');
    }

    const author = await prisma.user.findUnique({
      where: { id: one.authorId }, select: { name: true, symbol: true },
    }).catch(() => null);

    const archive = buildArchive({
      report: one,
      manifest: safeJson(bundle?.manifestJson || '{}'),
      summary: safeJson(bundle?.summaryJson || '{}'),
      sources,
      attachments: attachments.filter((a: any) => a.kind !== 'DIAGNOSTICS'),
      authorName: one.authorDisplayNameSnapshot || author?.name || author?.symbol || '—',
    });

    const name = `обращение-${String(one.number).padStart(6, '0')}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition',
      `attachment; filename="report-${String(one.number).padStart(6, '0')}.zip"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Content-Length', String(archive.length));
    res.end(Buffer.from(archive));
  });
}

/** Разбор JSON, который мог не записаться. Пустой объект — не поломка. */
function safeJson(text: string): any {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { return {}; }
}

/** Отпечаток по тому, что записано в карточке. */
function fingerprintOf(report: any): string {
  const steps = safeSteps(report.reproductionJson);
  return technicalFingerprint({
    appVersion: report.appVersion,
    sectionKey: report.sectionKey,
    // Кода ошибки отдельным полем в карточке нет: берём первую строку
    // «что получилось» — её пишут как «вылетело NotFoundError»
    errorCode: String(report.actual || '').split('\n')[0].slice(0, 64),
    frames: steps,
  });
}

function safeSteps(json: string): string[] {
  try {
    const parsed = JSON.parse(json || '[]');
    return Array.isArray(parsed) ? parsed.map((s) => String(s)) : [];
  } catch (_) { return []; }
}

/** Одна карточка человеческим текстом. */
export function toMarkdown(report: any, comments: any[], attachments: any[], triage: boolean): string {
  const at = (value: any) => (value ? new Date(value).toLocaleString('ru-RU') : '—');
  const steps = safeSteps(report.reproductionJson);
  const lines: string[] = [];

  lines.push(`# ${reportNumber(report.number)} — ${report.title}`, '');
  lines.push(`- Вид: ${TYPE_NAMES[report.type as keyof typeof TYPE_NAMES] || report.type}`);
  lines.push(`- Состояние: ${STATUS_NAMES[report.status as Status] || report.status}`);
  lines.push(`- Важность: ${PRIORITY_NAMES[report.priority as keyof typeof PRIORITY_NAMES] || report.priority}`);
  lines.push(`- Автор: ${report.authorDisplayNameSnapshot}`);
  lines.push(`- Заведено: ${at(report.createdAt)}, случилось: ${at(report.incidentAt)}`);
  lines.push(`- Версия программы: ${report.appVersion || '—'}, раздел: ${report.sectionKey || '—'}`);
  if (report.resolvedVersion) lines.push(`- Исправлено в версии: ${report.resolvedVersion}`);
  lines.push('', '## Что произошло', '', String(report.description || '—'));

  if (steps.length) {
    lines.push('', '## Что делали', '');
    steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }
  if (report.expected) lines.push('', '## Чего ждали', '', String(report.expected));
  if (report.actual) lines.push('', '## Что получилось', '', String(report.actual));
  if (report.benefit) lines.push('', '## Что это даст', '', String(report.benefit));

  if (attachments.length) {
    lines.push('', '## Вложения', '');
    for (const one of attachments) {
      lines.push(`- ${one.displayName} (${one.kind}, ${Math.max(1, Math.round(one.byteLength / 1024))} КБ)`);
    }
  }

  const shown = comments.filter((c: any) => triage || c.visibility === 'PUBLIC');
  if (shown.length) {
    lines.push('', '## Обсуждение', '');
    for (const one of shown) {
      const mark = one.visibility === 'INTERNAL' ? ' _(внутренняя заметка)_' : '';
      lines.push(`**${at(one.createdAt)}**${mark}`, '', one.redactedAt ? '_убрано_' : String(one.text || ''), '');
    }
  }
  if (report.resolution) lines.push('', '## Решение', '', String(report.resolution));
  lines.push('', '---', '', 'Выгружено из Flux. Наружу это не уходило: файл собран на сервере компании.');
  return lines.join('\n');
}
