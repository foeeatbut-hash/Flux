/**
 * Что можно сделать с уже заведённым обращением.
 *
 * Видимость решается до выдачи, а не после. Внутренняя заметка обработчиков не
 * должна доходить до автора ни списком, ни счётчиком, ни поиском, ни через
 * карточку дубля — поэтому фильтр стоит условием запроса, а не проверкой над
 * готовым ответом: над ответом его однажды забудут.
 */

import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { ensureFeedbackTables } from './tables.js';
import { actorOf, fail, ok, triageRecipients, type Actor } from './policy.js';
import { applyMutation, markFirstResponse, MutationError } from './mutations.js';
import { reserveRate, refundRate, rateResetAt } from './service.js';
import { checkTransition, allowedFrom, CLOSED } from '../../feedback/transitions.js';
import {
  ERRORS, LIMITS, PRIORITIES, checkText, isUuid, type Priority, type Status,
} from '../../feedback/contracts.js';

export interface ActionDeps {
  can: (user: any, feature: string) => boolean;
}

interface Ctx { actor: Actor; prisma: any; triage: boolean; report: any; mine: boolean }

export function registerActionRoutes(app: Express, deps: ActionDeps): void {
  /** Карточка вместе с ответом на «кто я ей». */
  async function card(req: Request, res: Response): Promise<Ctx | null> {
    const actor = actorOf(req);
    if (!actor) { fail(res, ERRORS.FORBIDDEN, 'Нужно войти в программу'); return null; }
    const prisma = getPrisma();
    const failure = await ensureFeedbackTables(prisma);
    if (failure) { fail(res, ERRORS.UNAVAILABLE, failure); return null; }
    const id = String(req.params.id || '');
    if (!isUuid(id)) { fail(res, ERRORS.NOT_FOUND, 'Обращение не найдено'); return null; }
    const report = await prisma.feedbackReport.findUnique({ where: { id } });
    const triage = deps.can((req as any).authUser, 'feedback.triage');
    const mine = !!report && report.authorId === actor.id;
    if (!report || (!mine && !triage)) { fail(res, ERRORS.NOT_FOUND, 'Обращение не найдено'); return null; }
    return { actor, prisma, triage, report, mine };
  }

  /** Общее для всех изменений: ключ, ожидаемая ревизия. */
  function keyed(req: Request, res: Response): { clientRequestId: string; expectedRevision: number } | null {
    const body = (req.body || {}) as Record<string, unknown>;
    const clientRequestId = String(body.clientRequestId || '');
    if (!isUuid(clientRequestId)) { fail(res, ERRORS.VALIDATION, 'clientRequestId: ожидался UUID'); return null; }
    const expectedRevision = Number(body.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      fail(res, ERRORS.VALIDATION, 'Нужна ожидаемая ревизия карточки');
      return null;
    }
    return { clientRequestId, expectedRevision };
  }

  function refuse(res: Response, error: any): void {
    if (error instanceof MutationError) {
      const map: Record<string, any> = {
        NOT_FOUND: ERRORS.NOT_FOUND,
        REVISION_CONFLICT: ERRORS.REVISION_CONFLICT,
        IDEMPOTENCY_CONFLICT: ERRORS.IDEMPOTENCY_CONFLICT,
      };
      return fail(res, map[error.code] || ERRORS.VALIDATION, error.message, error.details);
    }
    fail(res, ERRORS.UNAVAILABLE, 'Не удалось изменить обращение');
  }

  // ── Смена состояния ───────────────────────────────────────────────────────
  app.post('/api/feedback/reports/:id/transition', async (req: Request, res: Response) => {
    const ctx = await card(req, res);
    if (!ctx) return;
    const keys = keyed(req, res);
    if (!keys) return;
    const body = (req.body || {}) as Record<string, unknown>;
    const to = String(body.to || '') as Status;
    const reason = String(body.reason || '').slice(0, LIMITS.reason);

    // Сторона определяется по карточке, а не по присланному полю: автор своего
    // обращения и обработчик чужого — разные роли с разными правами
    const side = ctx.mine && !ctx.triage ? 'author' : (ctx.triage ? 'triage' : 'author');
    const verdict = checkTransition({
      from: ctx.report.status as Status, to, actor: side,
      reason,
      assigneeId: body.assigneeId as string,
      resolvedVersion: body.resolvedVersion as string,
      noReleaseReason: body.noReleaseReason as string,
      targetReportId: body.targetReportId as string,
      resumeStatus: ctx.report.resumeStatus as Status,
    });
    if (!verdict.ok) return fail(res, ERRORS.INVALID_TRANSITION, verdict.error || 'Так менять нельзя');

    const patch: Record<string, unknown> = { status: to };
    if (to === 'IN_PROGRESS') patch.assigneeId = String(body.assigneeId || ctx.report.assigneeId || '');
    // Куда вернуться после ответа автора: работа возвращается туда, откуда её
    // увели, а не в начало разбора
    if (to === 'NEEDS_INFO') patch.resumeStatus = ctx.report.status;
    if (to === 'VERIFY') {
      patch.resolvedVersion = String(body.resolvedVersion || '') || null;
      patch.resolution = String(body.noReleaseReason || reason || '').slice(0, LIMITS.reason);
    }
    if (to === 'DUPLICATE') patch.duplicateOfId = String(body.targetReportId || '');
    if (CLOSED.includes(to)) patch.closedAt = new Date();
    else patch.closedAt = null;

    const notifyAuthor = ctx.report.authorId !== ctx.actor.id ? [ctx.report.authorId] : [];
    const notifyTriage = ctx.mine ? await triageRecipients(deps.can) : [];

    try {
      const done = await applyMutation({
        actor: ctx.actor, reportId: ctx.report.id, ...keys,
        patch, kind: 'statusChanged', visibility: 'PUBLIC',
        data: { from: ctx.report.status, to, reason },
        recipients: [...notifyAuthor, ...notifyTriage],
        notice: { number: ctx.report.number, title: ctx.report.title, status: to },
        ...(reason ? { comment: { text: reason, visibility: 'PUBLIC' as const } } : {}),
      });
      if (reason) await markFirstResponse(ctx.report.id, ctx.actor.id, ctx.report.authorId);
      ok(res, { id: ctx.report.id, status: to, revision: done.revision }, { repeat: done.repeat });
    } catch (error) { refuse(res, error); }
  });

  // ── Исполнитель ───────────────────────────────────────────────────────────
  app.post('/api/feedback/reports/:id/assign', async (req: Request, res: Response) => {
    const ctx = await card(req, res);
    if (!ctx) return;
    if (!ctx.triage) return fail(res, ERRORS.FORBIDDEN, 'Назначать исполнителя может тот, кто разбирает');
    const keys = keyed(req, res);
    if (!keys) return;
    const assigneeId = String((req.body || {}).assigneeId || '') || null;
    try {
      const done = await applyMutation({
        actor: ctx.actor, reportId: ctx.report.id, ...keys,
        patch: { assigneeId }, kind: 'assigned', visibility: 'PUBLIC',
        data: { from: ctx.report.assigneeId || null, to: assigneeId },
        recipients: assigneeId ? [assigneeId] : [],
        notice: { number: ctx.report.number, title: ctx.report.title },
      });
      ok(res, { id: ctx.report.id, assigneeId, revision: done.revision }, { repeat: done.repeat });
    } catch (error) { refuse(res, error); }
  });

  // ── Приоритет ─────────────────────────────────────────────────────────────
  app.post('/api/feedback/reports/:id/priority', async (req: Request, res: Response) => {
    const ctx = await card(req, res);
    if (!ctx) return;
    if (!ctx.triage) return fail(res, ERRORS.FORBIDDEN, 'Очередь назначает тот, кто разбирает');
    const keys = keyed(req, res);
    if (!keys) return;
    const priority = String((req.body || {}).priority || '') as Priority;
    if (!(PRIORITIES as readonly string[]).includes(priority)) {
      return fail(res, ERRORS.VALIDATION, 'Неизвестный приоритет');
    }
    try {
      const done = await applyMutation({
        actor: ctx.actor, reportId: ctx.report.id, ...keys,
        patch: { priority }, kind: 'priorityChanged',
        // Порядок разбора — дело обработчиков; автору он ничего не говорит
        visibility: 'INTERNAL',
        data: { from: ctx.report.priority, to: priority },
      });
      ok(res, { id: ctx.report.id, priority, revision: done.revision }, { repeat: done.repeat });
    } catch (error) { refuse(res, error); }
  });

  // ── Ответ или внутренняя заметка ──────────────────────────────────────────
  app.post('/api/feedback/reports/:id/comments', async (req: Request, res: Response) => {
    const ctx = await card(req, res);
    if (!ctx) return;
    const keys = keyed(req, res);
    if (!keys) return;
    const body = (req.body || {}) as Record<string, unknown>;
    const text = checkText(body.text, 'Сообщение', 1, LIMITS.comment);
    if (!text.ok) return fail(res, ERRORS.VALIDATION, text.error || 'Пустое сообщение');
    const wantsInternal = body.visibility === 'INTERNAL';
    // Автор внутренних заметок не пишет: ему их и читать нечем
    if (wantsInternal && !ctx.triage) return fail(res, ERRORS.FORBIDDEN, 'Внутренние заметки пишут те, кто разбирает');
    const visibility = wantsInternal ? 'INTERNAL' as const : 'PUBLIC' as const;

    const allowed = await reserveRate(ctx.prisma, ctx.actor.id, 'comment', LIMITS.commentsPerHour);
    if (!allowed) {
      const at = rateResetAt();
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((at.getTime() - Date.now()) / 1000))));
      return fail(res, ERRORS.RATE_LIMITED, `Больше ${LIMITS.commentsPerHour} сообщений в час не принимаем`);
    }

    // Внутренняя заметка не уходит автору никогда — даже если он же и обработчик
    const recipients = visibility === 'INTERNAL'
      ? (await triageRecipients(deps.can)).filter((id) => id !== ctx.report.authorId)
      : ctx.mine ? await triageRecipients(deps.can) : [ctx.report.authorId];

    try {
      const done = await applyMutation({
        actor: ctx.actor, reportId: ctx.report.id, ...keys,
        patch: {}, kind: 'commented', visibility,
        data: { visibility },
        comment: { text: text.value!, visibility },
        recipients,
        notice: { number: ctx.report.number, title: ctx.report.title },
      });
      if (visibility === 'PUBLIC') await markFirstResponse(ctx.report.id, ctx.actor.id, ctx.report.authorId);
      ok(res, { id: ctx.report.id, revision: done.revision }, { repeat: done.repeat });
    } catch (error) {
      await refundRate(ctx.prisma, ctx.actor.id, 'comment');
      refuse(res, error);
    }
  });

  app.get('/api/feedback/reports/:id/comments', async (req: Request, res: Response) => {
    const ctx = await card(req, res);
    if (!ctx) return;
    // Фильтр видимости — условием запроса: над готовым ответом его забудут
    const where: any = { reportId: ctx.report.id };
    if (!ctx.triage) where.visibility = 'PUBLIC';
    const rows = await ctx.prisma.feedbackComment.findMany({
      where, orderBy: { createdAt: 'asc' }, take: 500,
    });
    ok(res, rows.map((c: any) => ({
      id: c.id, authorId: c.authorId, visibility: c.visibility,
      text: c.redactedAt ? '' : c.text, redacted: !!c.redactedAt, createdAt: c.createdAt,
    })));
  });

  app.get('/api/feedback/reports/:id/events', async (req: Request, res: Response) => {
    const ctx = await card(req, res);
    if (!ctx) return;
    const where: any = { reportId: ctx.report.id };
    if (!ctx.triage) where.visibility = 'PUBLIC';
    const rows = await ctx.prisma.feedbackEvent.findMany({
      where, orderBy: { revision: 'asc' }, take: 500,
    });
    ok(res, rows.map((e: any) => ({
      id: e.id, kind: e.kind, actorId: e.actorId, revision: e.revision,
      visibility: e.visibility, data: safeJson(e.dataJson), createdAt: e.createdAt,
    })));
  });

  // ── Докуда дочитано ───────────────────────────────────────────────────────
  app.post('/api/feedback/reports/:id/read', async (req: Request, res: Response) => {
    const ctx = await card(req, res);
    if (!ctx) return;
    const body = (req.body || {}) as Record<string, unknown>;
    const publicRevision = Math.max(0, Number(body.publicRevision) || 0);
    // Внутренние ревизии автор не «дочитывает»: он их не видел
    const internalRevision = ctx.triage ? Math.max(0, Number(body.internalRevision) || 0) : 0;
    const existing = await ctx.prisma.feedbackReadState.findFirst({
      where: { reportId: ctx.report.id, userId: ctx.actor.id },
    });
    if (existing) {
      await ctx.prisma.feedbackReadState.update({
        where: { id: existing.id },
        data: {
          lastPublicRevision: Math.max(existing.lastPublicRevision, publicRevision),
          lastInternalRevision: Math.max(existing.lastInternalRevision, internalRevision),
        },
      });
    } else {
      await ctx.prisma.feedbackReadState.create({
        data: {
          reportId: ctx.report.id, userId: ctx.actor.id,
          lastPublicRevision: publicRevision, lastInternalRevision: internalRevision,
        },
      });
    }
    ok(res, { id: ctx.report.id, publicRevision, internalRevision });
  });

  /** Какие кнопки показывать: список берётся из тех же правил, что и проверка. */
  app.get('/api/feedback/reports/:id/actions', async (req: Request, res: Response) => {
    const ctx = await card(req, res);
    if (!ctx) return;
    const side = ctx.mine && !ctx.triage ? 'author' : (ctx.triage ? 'triage' : 'author');
    ok(res, allowedFrom(ctx.report.status as Status, side).map((r) => ({
      to: r.to, action: r.action,
      needs: { reason: !!r.reason, assignee: !!r.assignee, release: !!r.release, target: !!r.target },
    })));
  });
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { return {}; }
}
