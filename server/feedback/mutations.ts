/**
 * Изменение карточки: одна дорога для всех действий.
 *
 * Действий много — сменить статус, назначить исполнителя, поставить приоритет,
 * ответить автору, — а правил у них три, и все три ломаются тихо.
 *
 * Расписка. Двойное нажатие и повтор после обрыва связи не должны делать
 * действие дважды: комментарий не отправляется вторым, а «взял в работу» не
 * сбрасывает того, кто уже взял. Точный повтор возвращает прежний результат,
 * даже если карточка с тех пор ушла вперёд.
 *
 * Ревизия. Два обработчика, открывшие карточку одновременно, не должны молча
 * перезаписать решение друг друга. Проверка идёт условием внутри UPDATE, а не
 * отдельным чтением: между чтением и записью проходит второй обработчик.
 *
 * Событие. Пишется в той же транзакции, что и изменение, — иначе история
 * получает пропуски именно там, где потом разбираются.
 */

import { createHash, randomUUID } from 'node:crypto';
import { getPrisma } from '../context.js';
import type { Actor } from './policy.js';

export interface Mutation {
  actor: Actor;
  reportId: string;
  clientRequestId: string;
  expectedRevision: number;
  /** Что записать в карточку. */
  patch: Record<string, unknown>;
  /** Вид события истории. */
  kind: string;
  /** Что видно автору, а что только обработчикам. */
  visibility: 'PUBLIC' | 'INTERNAL';
  /** Данные события: до/после, без секретов и без тел файлов. */
  data: Record<string, unknown>;
  /** Кому сообщить. Себе о своём действии не сообщаем. */
  recipients?: string[];
  /** Что положить в уведомление: только безопасные поля. */
  notice?: Record<string, unknown>;
  /** Комментарий, который надо записать в той же транзакции. */
  comment?: { text: string; visibility: 'PUBLIC' | 'INTERNAL' };
}

export interface Applied {
  repeat: boolean;
  revision: number;
  report: any;
}

/** Отпечаток запроса: тот же ключ с другим смыслом — это не повтор. */
export function requestHashOf(m: Mutation): string {
  return createHash('sha256')
    .update(JSON.stringify([m.reportId, m.kind, m.patch, m.comment || null]))
    .digest('hex');
}

export class MutationError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

/**
 * Применить изменение.
 *
 * Порядок шагов не переставляется: расписка ищется до всего, иначе повтор
 * успевает занять место в пределе и записать второе событие.
 */
export async function applyMutation(m: Mutation): Promise<Applied> {
  const prisma = getPrisma();
  const hash = requestHashOf(m);

  const receipt = await prisma.feedbackMutationReceipt.findFirst({
    where: { actorId: m.actor.id, clientRequestId: m.clientRequestId },
  });
  if (receipt) {
    if (receipt.requestHash !== hash) {
      throw new MutationError('IDEMPOTENCY_CONFLICT', 'Этот ключ уже занят другим действием');
    }
    const report = await prisma.feedbackReport.findUnique({ where: { id: m.reportId } });
    // Прежний результат возвращается даже если карточка ушла вперёд: повтор
    // не должен ни делать действие второй раз, ни выглядеть отказом
    return { repeat: true, revision: receipt.resultRevision, report };
  }

  return prisma.$transaction(async (tx: any) => {
    const now = new Date();
    const next = m.expectedRevision + 1;
    const publicChange = m.visibility === 'PUBLIC';

    const changed = await tx.feedbackReport.updateMany({
      where: { id: m.reportId, revision: m.expectedRevision },
      data: {
        ...m.patch,
        revision: next,
        updatedAt: now,
        // Внутренняя заметка не помечает карточку новой для автора: иначе
        // счётчик у него растёт от переписки, которой он не видит
        ...(publicChange ? { lastPublicAt: now } : { lastInternalAt: now }),
      },
    });
    if (!changed.count) {
      const current = await tx.feedbackReport.findUnique({ where: { id: m.reportId } });
      if (!current) throw new MutationError('NOT_FOUND', 'Обращение не найдено');
      throw new MutationError('REVISION_CONFLICT',
        'Карточку изменил кто-то другой. Перечитайте её и повторите — набранное не потеряно',
        { revision: current.revision, status: current.status, assigneeId: current.assigneeId });
    }

    if (m.comment) {
      await tx.feedbackComment.create({
        data: {
          reportId: m.reportId, authorId: m.actor.id,
          clientRequestId: `${m.clientRequestId}:comment`,
          visibility: m.comment.visibility, text: m.comment.text,
        },
      });
    }

    await tx.feedbackEvent.create({
      data: {
        reportId: m.reportId, actorId: m.actor.id, kind: m.kind,
        visibility: m.visibility, revision: next, dataJson: JSON.stringify(m.data),
      },
    });
    await tx.feedbackChange.create({
      data: { reportId: m.reportId, revision: next, visibility: m.visibility },
    });

    for (const recipient of m.recipients || []) {
      if (recipient === m.actor.id) continue;
      await tx.feedbackOutbox.create({
        data: {
          id: randomUUID(),
          dedupeKey: `${m.kind}:${m.reportId}:${next}:${recipient}`,
          reportId: m.reportId, recipientId: recipient, publicRevision: next,
          kind: m.kind, payloadJson: JSON.stringify(m.notice || {}),
        },
      });
    }

    const report = await tx.feedbackReport.findUnique({ where: { id: m.reportId } });
    await tx.feedbackMutationReceipt.create({
      data: {
        actorId: m.actor.id, clientRequestId: m.clientRequestId, requestHash: hash,
        reportId: m.reportId, resultRevision: next,
        resultJson: JSON.stringify({ status: report?.status, revision: next }),
      },
    });
    return { repeat: false, revision: next, report };
  });
}

/**
 * Первый публичный ответ не-автора: по нему считается время реакции.
 *
 * Внутренние заметки и действия самого автора сюда не считаются — иначе
 * «ответили за минуту» означало бы, что автор минуту спустя дописал сам себе.
 */
export async function markFirstResponse(reportId: string, actorId: string, authorId: string): Promise<void> {
  if (actorId === authorId) return;
  const prisma = getPrisma();
  try {
    await prisma.feedbackReport.updateMany({
      where: { id: reportId, firstResponseAt: null },
      data: { firstResponseAt: new Date() },
    });
  } catch (_) { /* отметка времени — не условие работы */ }
}
