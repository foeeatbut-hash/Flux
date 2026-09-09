/**
 * Обращения: завести, найти своё, прочитать карточку.
 *
 * Права проверяются в самом запросе к базе, а не после выборки. Разница не в
 * скорости: отфильтровать «уже прочитанное из базы» — значит один раз забыть
 * фильтр и отдать чужое, а условие внутри запроса забыть нельзя, оно и есть
 * запрос.
 */

import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { ensureFeedbackTables } from './tables.js';
import { actorOf, fail, ok, settings, triageRecipients, type Actor } from './policy.js';
import { createReport, reserveRate, refundRate, rateResetAt } from './service.js';
import { ERRORS, LIMITS, STATUSES, validateSubmit, isUuid, type Status } from '../../feedback/contracts.js';

export interface ReportDeps {
  can: (user: any, feature: string) => boolean;
  appVersion: () => string;
}

/** Что из карточки видно этому человеку. */
function visible(report: any, actor: Actor, triage: boolean) {
  const mine = report.authorId === actor.id;
  return {
    id: report.id,
    number: report.number,
    type: report.type,
    title: report.title,
    description: report.description,
    reproduction: safeList(report.reproductionJson),
    expected: report.expected,
    actual: report.actual,
    benefit: report.benefit,
    frequency: report.frequency,
    impact: report.impact,
    sectionKey: report.sectionKey,
    appVersion: report.appVersion,
    status: report.status,
    priority: report.priority,
    assigneeId: report.assigneeId,
    resolution: report.resolution,
    resolvedVersion: report.resolvedVersion,
    duplicateOfId: report.duplicateOfId,
    revision: report.revision,
    author: { id: report.authorId, name: report.authorDisplayNameSnapshot },
    incidentAt: report.incidentAt,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    closedAt: report.closedAt,
    // Проект называется только тем, кому он и так доступен: карточка не должна
    // выдавать права на связанный проект
    projectId: mine || triage ? report.projectId : null,
    capabilities: { mine, triage },
  };
}

function safeList(json: string): string[] {
  try {
    const parsed = JSON.parse(json || '[]');
    return Array.isArray(parsed) ? parsed.map((s) => String(s)).slice(0, LIMITS.steps) : [];
  } catch (_) { return []; }
}

export function registerReportRoutes(app: Express, deps: ReportDeps): void {
  async function ready(req: Request, res: Response): Promise<{ actor: Actor; prisma: any; triage: boolean } | null> {
    const actor = actorOf(req);
    if (!actor) { fail(res, ERRORS.FORBIDDEN, 'Нужно войти в программу'); return null; }
    const prisma = getPrisma();
    const failure = await ensureFeedbackTables(prisma);
    if (failure) { fail(res, ERRORS.UNAVAILABLE, failure); return null; }
    return { actor, prisma, triage: deps.can((req as any).authUser, 'feedback.triage') };
  }

  // ── Завести обращение ─────────────────────────────────────────────────────
  app.post('/api/feedback/reports', async (req: Request, res: Response) => {
    const base = await ready(req, res);
    if (!base) return;
    const { actor, prisma } = base;

    const checked = validateSubmit(req.body);
    if (!checked.ok) return fail(res, ERRORS.VALIDATION, checked.error || 'Обращение не принято');
    const submit = checked.value!;

    const conf = await settings();
    if (submit.deploymentId !== conf.deploymentId) {
      // Черновик, начатый в другом контуре, сюда попасть не должен: у него
      // чужие вложения и чужие идентификаторы
      return fail(res, ERRORS.VALIDATION, 'Это обращение начато в другой базе');
    }

    // Место в пределе занимается до записи и возвращается, если запись не
    // удалась: иначе всплеск одновременных отправок проскочит целиком
    const allowed = await reserveRate(prisma, actor.id, 'report', LIMITS.reportsPerHour);
    if (!allowed) {
      const at = rateResetAt();
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((at.getTime() - Date.now()) / 1000))));
      return fail(res, ERRORS.RATE_LIMITED,
        `Больше ${LIMITS.reportsPerHour} обращений в час не принимаем. Следующее — после ${at.toLocaleTimeString('ru-RU')}`);
    }

    try {
      const recipients = await triageRecipients(deps.can);
      const made = await createReport(actor, submit, deps.appVersion(), recipients);
      if (made.repeat) await refundRate(prisma, actor.id, 'report');
      res.status(made.repeat ? 200 : 201);
      return ok(res, visible(made.report, actor, base.triage), { repeat: made.repeat });
    } catch (error: any) {
      await refundRate(prisma, actor.id, 'report');
      const code = error?.code;
      if (code === 'IDEMPOTENCY_CONFLICT') {
        return fail(res, ERRORS.IDEMPOTENCY_CONFLICT,
          'Этот ключ отправки уже занят другим обращением. Начните новую отправку');
      }
      if (code === 'FORBIDDEN') return fail(res, ERRORS.FORBIDDEN, error.message);
      if (code === 'TOO_LARGE') return fail(res, ERRORS.TOO_LARGE, error.message);
      if (code === 'VALIDATION') return fail(res, ERRORS.VALIDATION, error.message);
      return fail(res, ERRORS.UNAVAILABLE, 'Не удалось записать обращение');
    }
  });

  // Ищется по ключу отправки — до маршрута с идентификатором, иначе
  // «by-request» будет принят за идентификатор карточки
  app.get('/api/feedback/reports/by-request/:clientRequestId', async (req: Request, res: Response) => {
    const base = await ready(req, res);
    if (!base) return;
    const { actor, prisma } = base;
    const key = String(req.params.clientRequestId || '');
    if (!isUuid(key)) return fail(res, ERRORS.VALIDATION, 'Ожидался UUID');
    // Ответ на «дошло ли»: связь оборвалась, и окно спрашивает, что вышло
    const found = await prisma.feedbackReport.findFirst({ where: { authorId: actor.id, clientRequestId: key } });
    if (!found) return fail(res, ERRORS.NOT_FOUND, 'Такого обращения нет');
    ok(res, visible(found, actor, base.triage));
  });

  // ── Список ────────────────────────────────────────────────────────────────
  app.get('/api/feedback/reports', async (req: Request, res: Response) => {
    const base = await ready(req, res);
    if (!base) return;
    const { actor, prisma, triage } = base;

    const scope = String(req.query.scope || 'mine');
    if (scope !== 'mine' && !triage) {
      return fail(res, ERRORS.FORBIDDEN, 'Очередь обращений доступна тем, кто их разбирает');
    }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const status = String(req.query.status || '');
    const type = String(req.query.type || '');

    // Право — условием запроса, а не фильтром после выборки: забыть условие
    // внутри запроса нельзя, оно и есть запрос
    const where: any = scope === 'mine' ? { authorId: actor.id } : {};
    if (status && (STATUSES as readonly string[]).includes(status)) where.status = status as Status;
    if (type) where.type = type;
    if (String(req.query.assignee || '') === 'me') where.assigneeId = actor.id;
    if (String(req.query.assignee || '') === 'none') where.assigneeId = null;

    const rows = await prisma.feedbackReport.findMany({
      where,
      orderBy: scope === 'mine'
        ? [{ createdAt: 'desc' }]
        // Очередь: сначала по важности, потом по давности — старое не должно
        // тонуть под новым
        : [{ priority: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });
    ok(res, rows.map((r: any) => visible(r, actor, triage)), { count: rows.length, scope });
  });

  // ── Одна карточка ─────────────────────────────────────────────────────────
  app.get('/api/feedback/reports/:id', async (req: Request, res: Response) => {
    const base = await ready(req, res);
    if (!base) return;
    const { actor, prisma, triage } = base;
    const id = String(req.params.id || '');
    if (!isUuid(id)) return fail(res, ERRORS.NOT_FOUND, 'Обращение не найдено');
    const found = await prisma.feedbackReport.findUnique({ where: { id } });
    // Чужая карточка без права разбора отвечает «не найдено», а не «нельзя»:
    // иначе по ответу перебирается, какие обращения существуют
    if (!found || (found.authorId !== actor.id && !triage)) {
      return fail(res, ERRORS.NOT_FOUND, 'Обращение не найдено');
    }
    const attachments = await prisma.feedbackAttachment.findMany({
      where: { reportId: id },
      select: { id: true, kind: true, displayName: true, mime: true, byteLength: true, createdAt: true, expiredAt: true },
    });
    ok(res, { ...visible(found, actor, triage), attachments });
  });
}
