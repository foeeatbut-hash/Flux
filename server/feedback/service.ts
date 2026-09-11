/**
 * Заведение обращения: номер, идемпотентность и предел частоты.
 *
 * Три вещи, каждая из которых ломается тихо.
 *
 * Идемпотентность. Связь рвётся ровно между «сервер записал» и «окно узнало»,
 * и окно повторяет отправку. Без общего ключа это вторая карточка, и обе
 * попадают в очередь разбора. Ключ придумывает окно один раз на подтверждённую
 * отправку, а уникальный индекс в базе делает повтор невозможным даже при
 * одновременной отправке из двух окон.
 *
 * Номер. Выдаётся счётчиком внутри транзакции, а не как «максимум плюс один»:
 * два встроенных сервера, спросив максимум одновременно, выдали бы один номер
 * двоим. Пропуски в нумерации допустимы, повторы — нет.
 *
 * Предел частоты. Считается в общей базе, а не в памяти: иначе три сервера
 * пропустят втрое больше. Место занимается ДО записи и возвращается, если
 * запись не удалась, — иначе всплеск из пятидесяти одновременных отправок
 * проскочит целиком.
 */

import { createHash, randomUUID } from 'node:crypto';
import { getPrisma } from '../context.js';
import { snapshotName, type Actor } from './policy.js';
import { LIMITS, type SubmitFeedbackV1 } from '../../feedback/contracts.js';

const HOUR = 3600 * 1000;

/** Начало текущего часового окна — общее для всех серверов. */
export const windowStartOf = (now = Date.now()): Date => new Date(Math.floor(now / HOUR) * HOUR);

/**
 * Занять одно место в часовом пределе. `false` — предел исчерпан.
 *
 * Условие `count < limit` стоит внутри UPDATE, а не проверяется отдельным
 * чтением: между чтением и записью проходят другие запросы, и полсотни
 * одновременных отправок прошли бы все.
 */
export async function reserveRate(prisma: any, actorId: string, kind: 'report' | 'comment', limit: number): Promise<boolean> {
  const windowStart = windowStartOf();
  try {
    await prisma.feedbackRateWindow.create({ data: { actorId, kind, windowStart, count: 0 } });
  } catch (_) { /* окно уже заведено — так и надо */ }
  const won = await prisma.feedbackRateWindow.updateMany({
    where: { actorId, kind, windowStart, count: { lt: limit } },
    data: { count: { increment: 1 } },
  });
  return won.count === 1;
}

/** Вернуть занятое место: запись не удалась, и предел тратить не за что. */
export async function refundRate(prisma: any, actorId: string, kind: 'report' | 'comment'): Promise<void> {
  try {
    await prisma.feedbackRateWindow.updateMany({
      where: { actorId, kind, windowStart: windowStartOf(), count: { gt: 0 } },
      data: { count: { decrement: 1 } },
    });
  } catch (_) { /* не вернулось — предел просто отпустит через час */ }
}

/** Когда предел отпустит. Человеку говорят время, а не «попробуйте позже». */
export const rateResetAt = (): Date => new Date(windowStartOf().getTime() + HOUR);

/**
 * Следующий номер обращения.
 *
 * Внутри транзакции: UPDATE держит строку счётчика до конца, поэтому второй
 * сервер ждёт своей очереди, а не читает то же значение.
 */
export async function nextNumber(tx: any): Promise<number> {
  const bumped = await tx.feedbackCounter.updateMany({ where: { key: 'report' }, data: { value: { increment: 1 } } });
  if (!bumped.count) {
    try {
      await tx.feedbackCounter.create({ data: { key: 'report', value: 1 } });
    } catch (_) {
      await tx.feedbackCounter.updateMany({ where: { key: 'report' }, data: { value: { increment: 1 } } });
    }
  }
  const row = await tx.feedbackCounter.findUnique({ where: { key: 'report' } });
  return Number(row?.value || 1);
}

/**
 * Отпечаток отправки.
 *
 * Считается по содержанию, а не по всему телу: порядок полей в JSON у разных
 * клиентов разный, и одинаковая по смыслу отправка давала бы разные отпечатки.
 * Нужен, чтобы отличить честный повтор от «тот же ключ, другой текст».
 *
 * Список полей — явный, и это не лень. Времени отправки (`submittedAt`) здесь
 * нет намеренно: оно меняется на каждой попытке, и попади оно в отпечаток,
 * очередь после обрыва связи получала бы «тот же ключ, другое тело» — 409 на
 * собственный честный повтор.
 */
export function submitHashOf(v: SubmitFeedbackV1): string {
  const canonical = JSON.stringify([
    v.type, v.title, v.description, v.sectionKey, v.projectId || '',
    v.incidentAt, v.frequency, v.impact,
    (v.reproduction || []).join('\n'), v.expected || '', v.actual || '', v.benefit || '',
    [...v.uploadIds].sort().join(','),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export interface Created {
  /** `repeat` — та же карточка вернулась по тому же ключу. */
  repeat: boolean;
  report: any;
}

/**
 * Записать обращение.
 *
 * Внутри транзакции нет ни одной сетевой отправки и ни одного разбора
 * картинки: транзакция, которая ждёт диска или сети, держит строки базы и
 * останавливает соседние запросы.
 */
export async function createReport(
  actor: Actor,
  submit: SubmitFeedbackV1,
  appVersion: string,
  recipients: string[],
): Promise<Created> {
  const prisma = getPrisma();
  const hash = submitHashOf(submit);

  // Повтор ищется до всего остального: он не должен ни занимать место в
  // пределе, ни трогать загрузки
  const before = await prisma.feedbackReport.findFirst({
    where: { authorId: actor.id, clientRequestId: submit.clientRequestId },
  });
  if (before) {
    if (before.submitHash !== hash) {
      const clash: any = new Error('Тот же ключ отправки с другим содержанием');
      clash.code = 'IDEMPOTENCY_CONFLICT';
      throw clash;
    }
    return { repeat: true, report: before };
  }

  // Загрузки проверяются ДО транзакции: чужую или недоехавшую прикладывать
  // нельзя, а лезть за этим в базу внутри транзакции незачем
  const uploads = submit.uploadIds.length
    ? await prisma.feedbackUpload.findMany({ where: { id: { in: submit.uploadIds } } })
    : [];
  for (const upload of uploads) {
    if (upload.ownerId !== actor.id) {
      const e: any = new Error('Чужое вложение приложить нельзя'); e.code = 'FORBIDDEN'; throw e;
    }
    if (upload.status !== 'READY') {
      const e: any = new Error(`Вложение «${upload.originalName}» ещё не доехало`); e.code = 'VALIDATION'; throw e;
    }
  }
  if (uploads.length !== submit.uploadIds.length) {
    const e: any = new Error('Часть вложений не найдена'); e.code = 'VALIDATION'; throw e;
  }
  const totalBytes = uploads.reduce((sum: number, u: any) => sum + (u.declaredBytes || 0), 0);
  if (totalBytes > LIMITS.attachmentsBytes) {
    const e: any = new Error('Вложения вместе тяжелее допустимого'); e.code = 'TOO_LARGE'; throw e;
  }

  const report = await prisma.$transaction(async (tx: any) => {
    const number = await nextNumber(tx);
    const made = await tx.feedbackReport.create({
      data: {
        number,
        // Автор — только из сессии. Присланному полю здесь верить нельзя:
        // идентификаторы коллег видны в списке сотрудников
        authorId: actor.id,
        authorDisplayNameSnapshot: snapshotName(actor),
        clientRequestId: submit.clientRequestId,
        submitHash: hash,
        type: submit.type,
        title: submit.title,
        description: submit.description,
        reproductionJson: JSON.stringify(submit.reproduction || []),
        expected: submit.expected || '',
        actual: submit.actual || '',
        benefit: submit.benefit || '',
        frequency: submit.frequency,
        impact: submit.impact,
        sectionKey: submit.sectionKey,
        projectId: submit.projectId || null,
        incidentAt: new Date(submit.incidentAt),
        // Когда приняли — отдельно от того, когда сломалось. У обращения,
        // пролежавшего в очереди выходные, это единственный способ понять,
        // почему оно пришло в понедельник про пятницу
        submittedAt: submit.submittedAt ? new Date(submit.submittedAt) : new Date(),
        appVersion,
        status: 'NEW',
        priority: 'P2',
      },
    });

    for (const upload of uploads) {
      await tx.feedbackAttachment.create({
        data: {
          reportId: made.id, uploadId: upload.id, kind: upload.kind,
          displayName: upload.originalName, mime: upload.verifiedMime || 'application/octet-stream',
          byteLength: upload.declaredBytes, sha256: upload.sha256,
        },
      });
      await tx.feedbackUpload.update({
        where: { id: upload.id }, data: { status: 'ATTACHED', reportId: made.id },
      });
    }

    await tx.feedbackEvent.create({
      data: {
        reportId: made.id, actorId: actor.id, kind: 'created', visibility: 'PUBLIC',
        revision: 1, dataJson: JSON.stringify({ type: submit.type, attachments: uploads.length }),
      },
    });
    await tx.feedbackChange.create({ data: { reportId: made.id, revision: 1, visibility: 'PUBLIC' } });

    // Уведомление кладётся в ТОЙ ЖЕ транзакции, что и карточка: иначе оно
    // теряется ровно между записью и отправкой, и обращение никто не увидит
    for (const recipient of recipients) {
      if (recipient === actor.id) continue; // себе о своём же действии не пишем
      await tx.feedbackOutbox.create({
        data: {
          id: randomUUID(),
          dedupeKey: `created:${made.id}:${recipient}`,
          reportId: made.id, recipientId: recipient, publicRevision: 1,
          kind: 'created',
          payloadJson: JSON.stringify({ number: made.number, title: made.title, type: made.type }),
        },
      });
    }
    return made;
  });

  return { repeat: false, report };
}
