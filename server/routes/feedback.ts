/**
 * Маршруты обращений: только подключение и порядок.
 *
 * Логика живёт в `server/feedback/*`, здесь — сборка. Разделение не ради
 * красоты: `server.ts` вплотную к своей планке размера, и класть туда домен
 * целиком нельзя, а маршруты одного домена должны читаться одним списком.
 *
 * Всё подключается ПОСЛЕ проверки входа: разбор двоичного тела до неё дал бы
 * неизвестному отправителю бесплатный способ занять память сервера.
 */

import type { Express, Request, Response } from 'express';
import { getPrisma } from '../context.js';
import { ensureFeedbackTables } from '../feedback/tables.js';
import { actorOf, fail, ok, settings } from '../feedback/policy.js';
import { registerUploadRoutes, type UploadDeps } from '../feedback/uploads.js';
import { registerReportRoutes } from '../feedback/reports.js';
import { registerActionRoutes } from '../feedback/actions.js';
import { startOutbox } from '../feedback/outbox.js';
import { unreadFor } from '../feedback/unread.js';
import {
  ERRORS, LIMITS, TYPES, STATUSES, PRIORITIES, IMPACTS, FREQUENCIES,
  TYPE_NAMES, STATUS_NAMES, IMPACT_NAMES, FREQUENCY_NAMES, PRIORITY_NAMES,
} from '../../feedback/contracts.js';

export interface FeedbackDeps extends UploadDeps {
  /** Право по функции: то же, что у остальных разделов. */
  can: (user: any, feature: string) => boolean;
  /** Версия программы: пишется в карточку, чтобы знать, где это ломалось. */
  appVersion: () => string;
}

export function registerFeedbackRoutes(app: Express, deps: FeedbackDeps): void {
  /**
   * Что окну надо знать до первого действия: признак контура, свои права и
   * пределы. Пределы отдаёт сервер, а не зашивает окно, — иначе после
   * изменения на сервере старое окно продолжит показывать прежние числа.
   */
  app.get('/api/feedback/meta', async (req: Request, res: Response) => {
    const actor = actorOf(req);
    if (!actor) return fail(res, ERRORS.FORBIDDEN, 'Нужно войти в программу');
    const failure = await ensureFeedbackTables(getPrisma());
    if (failure) return fail(res, ERRORS.UNAVAILABLE, failure);
    const conf = await settings();
    const user = (req as any).authUser;
    ok(res, {
      deploymentId: conf.deploymentId,
      chunkSize: await deps.feedbackChunkBytes(),
      rights: {
        create: deps.can(user, 'feedback.create'),
        triage: deps.can(user, 'feedback.triage'),
        diagnostics: deps.can(user, 'feedback.diagnostics'),
        manage: deps.can(user, 'feedback.manage'),
      },
      limits: LIMITS,
      dictionary: {
        types: TYPES, statuses: STATUSES, priorities: PRIORITIES,
        impacts: IMPACTS, frequencies: FREQUENCIES,
        names: {
          type: TYPE_NAMES, status: STATUS_NAMES,
          impact: IMPACT_NAMES, frequency: FREQUENCY_NAMES, priority: PRIORITY_NAMES,
        },
      },
    });
  });

  /** Сколько мест ждут этого человека. */
  app.get('/api/feedback/unread', async (req: Request, res: Response) => {
    const actor = actorOf(req);
    if (!actor) return fail(res, ERRORS.FORBIDDEN, 'Нужно войти в программу');
    const failure = await ensureFeedbackTables(getPrisma());
    if (failure) return fail(res, ERRORS.UNAVAILABLE, failure);
    ok(res, await unreadFor(actor.id, deps.can((req as any).authUser, 'feedback.triage')));
  });

  // Разбор очереди уведомлений: запись в базе — способ доставки, сокет только
  // ускоряет. Проход берёт записи в аренду, поэтому несколько встроенных
  // серверов на одной базе не разошлют одно и то же дважды
  startOutbox();

  // Порядок важен: «by-request» должен разбираться раньше, чем «:id»
  registerReportRoutes(app, deps);
  registerActionRoutes(app, deps);
  registerUploadRoutes(app, deps);
}
