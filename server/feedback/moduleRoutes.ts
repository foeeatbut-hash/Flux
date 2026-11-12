import type { Express, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { getPrisma } from '../context.js';
import { actorOf, fail, ok } from './policy.js';
import { ERRORS, isUuid, LIMITS } from '../../feedback/contracts.js';
import { developerModules, moduleHandler, developerPackage, feedbackRoot, type ModuleFeedbackDeps } from './modules.js';
import { validCrashBatch, MODULE_CRASH_BATCHES_PER_MINUTE } from '../../feedback/moduleCrashes.js';
import { CRASH_PREFIX, moduleSignals, confirmedKnownProblems } from './moduleSignals.js';
import { applyMutation, MutationError } from './mutations.js';
import { reserveRate } from './service.js';
import { ensureFeedbackTables } from './tables.js';
import { openEnvelope } from '../../modules/trust/envelope.js';
import { parseReleaseClaim, MODULE_ID, MODULE_VERSION } from '../../modules/trust/claims.js';

interface Deps extends ModuleFeedbackDeps { can: (user: any, feature: string) => boolean }
export function registerModuleFeedbackRoutes(app: Express, deps: Deps) {
  app.post('/api/modules/crashes', async (req: Request, res: Response) => {
    const actor = actorOf(req); if (!actor) return fail(res, ERRORS.FORBIDDEN, 'Нужно войти');
    if (!validCrashBatch(req.body)) return fail(res, ERRORS.VALIDATION, 'Нужен обезличенный пакет счётчиков');
    const db = getPrisma(), batch = req.body;
    const failure = await ensureFeedbackTables(db);
    if (failure) return fail(res, ERRORS.UNAVAILABLE, failure);
    const id = `module-crash-${batch.id}`, value = JSON.stringify(batch);
    const previous = await db.appSetting.findUnique({ where: { id } });
    if (previous) return previous.value === value ? ok(res, { accepted: true, repeat: true }) : fail(res, ERRORS.IDEMPOTENCY_CONFLICT, 'Ключ счётчиков уже занят');
    const pairs = [...new Map(batch.events.map((e) => [`${e.moduleId}@${e.version}`, { moduleId: e.moduleId, version: e.version }])).values()];
    const releases = await db.moduleRelease.findMany({ where: { OR: pairs }, select: { moduleId: true, version: true, signature: true } });
    const existing = new Set(releases.flatMap((r: any) => {
      const claim = parseReleaseClaim(openEnvelope('release', r.signature, feedbackRoot(deps)));
      return claim && claim.moduleId === r.moduleId && claim.version === r.version ? [`${r.moduleId}@${r.version}`] : [];
    }));
    if (pairs.some((p) => !existing.has(`${p.moduleId}@${p.version}`))) return fail(res, ERRORS.VALIDATION, 'Программа или подписанный выпуск не найдены');
    if (!await reserveRate(db, actor.id, 'moduleCrash', MODULE_CRASH_BATCHES_PER_MINUTE)) return fail(res, ERRORS.RATE_LIMITED, 'Слишком много пакетов счётчиков');
    try {
      // Единственная запись — и расписка, и сами счётчики: повтор после обрыва
      // не прибавляет их второй раз. Ни пользователя, ни данных здесь нет.
      await db.appSetting.create({ data: { id, key: CRASH_PREFIX + batch.id, userId: null, value } });
      ok(res, { accepted: true });
    } catch (e: any) {
      if (e.code === 'P2002') {
        const saved = await db.appSetting.findUnique({ where: { id } });
        return saved?.value === value ? ok(res, { accepted: true, repeat: true }) : fail(res, ERRORS.IDEMPOTENCY_CONFLICT, 'Ключ счётчиков уже занят');
      }
      fail(res, ERRORS.UNAVAILABLE, 'Счётчики пока не записаны');
    }
  });
  app.get('/api/modules/crashes', async (req: Request, res: Response) => {
    const actor = actorOf(req); if (!actor) return fail(res, ERRORS.FORBIDDEN, 'Нужно войти');
    const db = getPrisma(), admin = deps.can((req as any).authUser, 'feedback.triage');
    const allowed = admin ? null : await developerModules(db, actor.id, feedbackRoot(deps));
    const { counts } = await moduleSignals(db, feedbackRoot(deps));
    ok(res, counts.filter((e) => !allowed || allowed.includes(e.moduleId)));
  });

  for (const action of ['module-routing', 'module-known'] as const) {
    app.post(`/api/feedback/reports/:id/${action}`, async (req: Request, res: Response) => {
      const actor = actorOf(req); if (!actor) return fail(res, ERRORS.FORBIDDEN, 'Нужно войти');
      const db = getPrisma(); await ensureFeedbackTables(db);
      const report = await db.feedbackReport.findUnique({ where: { id: String(req.params.id) } });
      const admin = deps.can((req as any).authUser, 'feedback.triage');
      const dev = !admin && await moduleHandler(db, actor.id, report, feedbackRoot(deps));
      if (!report || (!admin && !dev)) return fail(res, ERRORS.NOT_FOUND, 'Обращение не найдено');
      const b = req.body || {};
      if (!isUuid(b.clientRequestId) || !Number.isSafeInteger(b.expectedRevision) || b.expectedRevision < 1) return fail(res, ERRORS.VALIDATION, 'Нужны ключ действия и ревизия');
      const patch: Record<string, unknown> = {};
      if (action === 'module-routing') {
        if (!String(b.reason || '').trim() || String(b.reason).length > LIMITS.reason) return fail(res, ERRORS.VALIDATION, 'Объясните переадресацию');
        if (b.toFlux === true && report.moduleId) patch.moduleForwarded = true;
        else if (admin && MODULE_ID.test(String(b.moduleId)) && MODULE_VERSION.test(String(b.moduleVersion)) && ['test', 'production'].includes(b.moduleChannel)) {
          const release = await db.moduleRelease.findUnique({ where: { moduleId_version: { moduleId: b.moduleId, version: b.moduleVersion } } });
          const c = release && parseReleaseClaim(openEnvelope('release', release.signature, feedbackRoot(deps)));
          if (!c || c.moduleId !== b.moduleId || c.version !== b.moduleVersion) return fail(res, ERRORS.VALIDATION, 'Нужен подписанный выпуск');
          Object.assign(patch, { moduleId: c.moduleId, moduleVersion: c.version, moduleChannel: b.moduleChannel, moduleForwarded: false });
        } else return fail(res, ERRORS.FORBIDDEN, 'Разработчик может передать обращение команде Flux');
        patch.assigneeId = null;
      } else {
        if (!report.moduleId || typeof b.known !== 'boolean') return fail(res, ERRORS.VALIDATION, 'Нужно обращение по программе');
        patch.moduleKnown = b.known;
        patch.moduleWorkaround = String(b.workaround || '').slice(0, LIMITS.reason);
      }
      try {
        const done = await applyMutation({ actor, reportId: report.id, clientRequestId: b.clientRequestId, expectedRevision: b.expectedRevision,
          patch, kind: action, visibility: 'PUBLIC', data: { ...patch, ...(b.reason ? { reason: b.reason } : {}) } });
        ok(res, { revision: done.revision });
      } catch (e: any) { fail(res, e instanceof MutationError ? ERRORS.REVISION_CONFLICT : ERRORS.UNAVAILABLE, 'Карточка изменилась — перечитайте её'); }
    });
  }
  app.get('/api/feedback/modules/:moduleId/similar', async (req: Request, res: Response) => {
    if (!actorOf(req)) return fail(res, ERRORS.FORBIDDEN, 'Нужно войти');
    const db = getPrisma(), known = await confirmedKnownProblems(db, feedbackRoot(deps));
    ok(res, known.filter((r: any) => r.moduleId === req.params.moduleId).map((r: any) => ({ id: r.id, number: r.number, title: r.title, workaround: r.moduleWorkaround })));
  });
  app.post('/api/feedback/reports/:id/affected', async (req: Request, res: Response) => {
    const actor = actorOf(req); if (!actor) return fail(res, ERRORS.FORBIDDEN, 'Нужно войти');
    const db = getPrisma(), report = await db.feedbackReport.findUnique({ where: { id: String(req.params.id) } });
    const known = await confirmedKnownProblems(db, feedbackRoot(deps));
    if (!report?.moduleId || !known.some((r: any) => r.id === report.id)) return fail(res, ERRORS.NOT_FOUND, 'Известная проблема не найдена');
    const id = createHash('sha256').update(`module-affected:${report.id}:${actor.id}`).digest('hex');
    await db.appSetting.upsert({ where: { id }, update: {}, create: { id, key: `modules.affected.${report.id}`, userId: null, value: '1' } });
    ok(res, { count: await db.appSetting.count({ where: { key: `modules.affected.${report.id}` } }) });
  });
}
