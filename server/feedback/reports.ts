/**
 * Обращения: завести, найти своё, прочитать карточку.
 *
 * Права проверяются в самом запросе к базе, а не после выборки. Разница не в
 * скорости: отфильтровать «уже прочитанное из базы» — значит один раз забыть
 * фильтр и отдать чужое, а условие внутри запроса забыть нельзя, оно и есть
 * запрос.
 */

import type { Express, Request, Response } from 'express';
import { developerModules, moduleHandler, moduleFix, moduleRecipients, developerPackage, feedbackRoot, type ModuleFeedbackDeps } from './modules.js';
import { openEnvelope } from '../../modules/trust/envelope.js';
import { parseReleaseClaim } from '../../modules/trust/claims.js';
import { safeModuleDiagnostics } from '../../feedback/moduleContext.js';
import { getPrisma } from '../context.js';
import { intParam } from '../queryParams.js';
import { ensureFeedbackTables } from './tables.js';
import { actorOf, fail, ok, settings, triageRecipients, type Actor } from './policy.js';
import { createReport, reserveRate, refundRate, rateResetAt } from './service.js';
import { scheduleBundle } from './bundle.js';
import { ERRORS, LIMITS, STATUSES, validateSubmit, isUuid, type Status } from '../../feedback/contracts.js';

export interface ReportDeps extends ModuleFeedbackDeps {
  can: (user: any, feature: string) => boolean;
  appVersion: () => string;
}

/** Что из карточки видно этому человеку. */
function visible(report: any, actor: Actor, triage: boolean, dataIssue?: unknown) {
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
    moduleId: report.moduleId, moduleVersion: report.moduleVersion, moduleChannel: report.moduleChannel,
    moduleApiVersion: report.moduleApiVersion, moduleDeveloper: report.moduleDeveloper,
    moduleDiagnostics: safeModuleDiagnostics(safeParse(report.moduleDiagnosticsJson)),
    moduleKnown: report.moduleKnown, moduleWorkaround: report.moduleWorkaround, moduleForwarded: report.moduleForwarded,
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
    // Поле передаётся только после авторизации карточки; детали источника
    // каталога видны автору собственного обращения и сотруднику триажа.
    ...(dataIssue ? { dataIssue } : {}),
    capabilities: { mine, triage },
  };
}

/** Автоматические сведения Flux не становятся частью карточки разработчика. */
function moduleView(report: any) {
  return {
    ...developerPackage(report), id: report.id, number: report.number, type: report.type,
    status: report.status, priority: report.priority, revision: report.revision,
    assigneeId: report.assigneeId, resolvedVersion: report.resolvedVersion,
    moduleKnown: report.moduleKnown, moduleWorkaround: report.moduleWorkaround, moduleForwarded: report.moduleForwarded,
    createdAt: report.createdAt, updatedAt: report.updatedAt,
    projectId: null, capabilities: { mine: false, triage: true },
  };
}

/** Разбор записанного JSON: испорченная строка не должна ронять карточку. */
function safeParse(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { return {}; }
}

function safeList(json: string): string[] {
  try {
    const parsed = JSON.parse(json || '[]');
    return Array.isArray(parsed) ? parsed.map((s) => String(s)).slice(0, LIMITS.steps) : [];
  } catch (_) { return []; }
}

/** Контекст кладётся в уже существующее событие создания, чтобы не мигрировать таблицу. */
async function issueContexts(prisma: any, reportIds: string[]): Promise<Map<string, unknown>> {
  const found = new Map<string, unknown>();
  if (!reportIds.length) return found;
  const events = await prisma.feedbackEvent.findMany({
    where: { reportId: { in: reportIds }, kind: 'created' },
    select: { reportId: true, dataJson: true },
  });
  for (const event of events) {
    const issue = safeParse(event.dataJson).dataIssue;
    if (issue && typeof issue === 'object' && (issue as any).namespace === 'catalogDataIssue') {
      found.set(event.reportId, issue);
    }
  }
  return found;
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

    if (submit.moduleId) {
      const release = await prisma.moduleRelease.findUnique({ where: { moduleId_version: { moduleId: submit.moduleId, version: submit.moduleVersion } } });
      const claim = release && parseReleaseClaim(openEnvelope('release', release.signature, feedbackRoot(deps)));
      if (!claim || claim.moduleId !== submit.moduleId || claim.version !== submit.moduleVersion) return fail(res, ERRORS.VALIDATION, 'Подпрограмма или подписанный выпуск не найдены');
    }

    const conf = await settings();
    if (submit.deploymentId !== conf.deploymentId) {
      // Черновик, начатый в другом контуре, сюда попасть не должен: у него
      // чужие вложения и чужие идентификаторы
      return fail(res, ERRORS.VALIDATION, 'Это обращение начато в другой базе');
    }

    // Место в пределе занимается до записи и возвращается, если запись не
    // удалась: иначе всплеск одновременных отправок проскочит целиком
    const allowed = await reserveRate(prisma, actor.id, 'report', LIMITS.reportsPerMinute);
    if (!allowed) {
      const wait = Math.max(1, Math.ceil((rateResetAt().getTime() - Date.now()) / 1000));
      res.setHeader('Retry-After', String(wait));
      return fail(res, ERRORS.RATE_LIMITED,
        `Слишком много обращений подряд (не больше ${LIMITS.reportsPerMinute} в минуту). Подождите ${wait} с`);
    }

    try {
      const recipients = [...new Set([...(await triageRecipients(deps.can)), ...(submit.moduleId ? await moduleRecipients(prisma, submit.moduleId, feedbackRoot(deps)) : [])])];
      const made = await createReport(actor, submit, deps.appVersion(), recipients);
      if (made.repeat) await refundRate(prisma, actor.id, 'report');
      // Сборка пакета ставится в очередь, а не делается здесь: обращение
      // важнее сводки, а чтение журналов держало бы ответ. Работа лежит в базе
      // строкой с арендой и переживает перезапуск сервера — раньше это был
      // вызов без ожидания, и перезапуск в неудачный момент означал, что пакет
      // не соберётся уже никогда
      if (!made.repeat) await scheduleBundle(made.report.id);
      res.status(made.repeat ? 200 : 201);
      return ok(res, visible(made.report, actor, base.triage, submit.dataIssue), { repeat: made.repeat });
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
    const contexts = await issueContexts(prisma, [found.id]);
    ok(res, visible(found, actor, base.triage, contexts.get(found.id)));
  });

  // ── Список ────────────────────────────────────────────────────────────────
  app.get('/api/feedback/reports', async (req: Request, res: Response) => {
    const base = await ready(req, res);
    if (!base) return;
    const { actor, prisma, triage } = base;

    const scope = String(req.query.scope || 'mine');
    const ownModules = scope === 'modules' ? await developerModules(prisma, actor.id, feedbackRoot(deps)) : [];
    if (scope !== 'mine' && scope !== 'modules' && !triage) {
      return fail(res, ERRORS.FORBIDDEN, 'Очередь обращений доступна тем, кто их разбирает');
    }
    const limit = intParam(req.query.limit, 50, 1, 100);
    const status = String(req.query.status || '');
    const type = String(req.query.type || '');

    // Право — условием запроса, а не фильтром после выборки: забыть условие
    // внутри запроса нельзя, оно и есть запрос
    const where: any = scope === 'mine' ? { authorId: actor.id } : scope === 'modules' ? { moduleId: { in: ownModules }, moduleForwarded: false } : {};
    if (String(req.query.modules || '') === '1') where.moduleId = { ...(where.moduleId || {}), not: null };
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
    const contexts = await issueContexts(prisma, rows.map((r: any) => r.id));
    ok(res, await Promise.all(rows.map(async (r: any) => ({ ...(scope === 'modules' && !triage && r.authorId !== actor.id ? moduleView(r) : visible(r, actor, triage, contexts.get(r.id))),
      capabilities: { mine: r.authorId === actor.id, triage: triage || (scope === 'modules' && !r.moduleForwarded) },
      ...(r.authorId === actor.id ? await moduleFix(prisma, (req as any).authUser, r, feedbackRoot(deps)) : {}),
    }))), { count: rows.length, scope });
  });

  app.get('/api/feedback/reports/:id/module-package', async (req: Request, res: Response) => {
    const base = await ready(req, res);
    if (!base) return;
    const found = await base.prisma.feedbackReport.findUnique({ where: { id: String(req.params.id) } });
    if (!found?.moduleId || !(base.triage || found.authorId === base.actor.id || await moduleHandler(base.prisma, base.actor.id, found, feedbackRoot(deps)))) {
      return fail(res, ERRORS.NOT_FOUND, 'Обращение не найдено');
    }
    ok(res, developerPackage(found));
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
    const developer = !triage && found?.authorId !== actor.id && await moduleHandler(prisma, actor.id, found, feedbackRoot(deps));
    if (!found || (found.authorId !== actor.id && !triage && !developer)) {
      return fail(res, ERRORS.NOT_FOUND, 'Обращение не найдено');
    }
    const attachments = developer ? [] : await prisma.feedbackAttachment.findMany({
      where: { reportId: id },
      select: { id: true, kind: true, displayName: true, mime: true, byteLength: true, createdAt: true, expiredAt: true },
    });
    /**
     * Сводка по приложенным записям — отдельным правом.
     *
     * Автор её не видит намеренно: он приложил записи, чтобы помочь разобрать
     * поломку, а не чтобы читать разбор чужой работы программы. Право названо
     * `feedback.diagnostics` и по умолчанию не выдано.
     */
    let diagnostics: any[] = [];
    if (!developer && deps.can((req as any).authUser, 'feedback.diagnostics')) {
      const bundles = await prisma.feedbackDiagnosticBundle.findMany({
        where: { reportId: id },
        select: {
          id: true, attachmentId: true, manifestJson: true, summaryJson: true, fingerprint: true,
          state: true, snapshotId: true, attempt: true, createdAt: true,
        },
      });
      diagnostics = bundles.map((b: any) => ({
        id: b.id, attachmentId: b.attachmentId,
        // Состояние сборки — отдельным полем, а не догадкой по пустой сводке:
        // «собирается» и «собрать не удалось» разбирающий обязан различать
        state: b.state || 'PENDING',
        snapshotId: b.snapshotId || '',
        attempt: b.attempt || 0,
        manifest: safeParse(b.manifestJson), summary: safeParse(b.summaryJson),
        fingerprint: b.fingerprint || '',
      }));
    }
    /**
     * Докуда человек может отметить прочитанным.
     *
     * Границы отдаёт сервер, а не выдумывает окно: публичная — по изменениям,
     * которые автору видны; внутренняя — только разбирающему. Отмечать
     * невидимое прочитанным нечестно, и раньше окно вообще ничего не отмечало:
     * слало `seenRevision: 0`, которого сервер не знает, и красный кружок у
     * автора не гас после прочтения ни разу.
     */
    const publicChange = await prisma.feedbackChange.findFirst({
      where: { reportId: id, visibility: 'PUBLIC' },
      orderBy: { revision: 'desc' }, select: { revision: true },
    });
    const publicRevision = Number(publicChange?.revision || 0);
    const internalRevision = triage ? Number(found.revision || 0) : 0;

    const contexts = await issueContexts(prisma, [found.id]);
    ok(res, {
      ...(developer ? moduleView(found) : visible(found, actor, triage, contexts.get(found.id))),
      capabilities: { mine: found.authorId === actor.id, triage: triage || developer },
      ...(found.authorId === actor.id ? await moduleFix(prisma, (req as any).authUser, found, feedbackRoot(deps)) : {}),
      attachments, diagnostics, publicRevision, internalRevision,
    });
  });
}
