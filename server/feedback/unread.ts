/**
 * Сколько обращений ждут этого человека.
 *
 * Счётчик считает не «сколько ошибок в программе», а «сколько мест, где ждут
 * меня»: свои обращения, где появился ответ, и — для тех, кто разбирает, —
 * чужие, которых ещё никто не открыл.
 *
 * Внутренние ревизии в счёт автора не идут. Иначе у него рос бы счётчик от
 * переписки обработчиков между собой, которую он всё равно не увидит: человек
 * открывает карточку, ничего нового не находит и перестаёт верить счётчику.
 */

import { getPrisma } from '../context.js';

/** Больше этого не считаем: число сверх сотни человеку всё равно ничего не говорит. */
const CAP = 200;

/**
 * Докуда карточка «новая» для автора.
 *
 * Ревизия карточки растёт от ЛЮБОГО изменения, включая переписку обработчиков
 * между собой. Сравнивать её с отметкой «дочитано до публичной ревизии» нельзя:
 * счётчик у автора рос от внутренней заметки, он открывал карточку, не находил
 * ничего нового — и переставал верить счётчику. Ровно на это заведена таблица
 * изменений с признаком видимости; берём из неё последнюю публичную.
 */
async function lastPublicRevisions(prisma: any, reportIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!reportIds.length) return out;
  const rows = await prisma.feedbackChange.findMany({
    where: { reportId: { in: reportIds }, visibility: 'PUBLIC' },
    select: { reportId: true, revision: true },
    take: 5000,
  });
  for (const row of rows) {
    const known = out.get(row.reportId) || 0;
    if (row.revision > known) out.set(row.reportId, row.revision);
  }
  return out;
}

export async function unreadFor(userId: string, triage: boolean): Promise<{ mine: number; queue: number; total: number }> {
  const prisma = getPrisma();
  const seenPublic = new Map<string, number>();
  const seenAny = new Map<string, number>();
  const marks = await prisma.feedbackReadState.findMany({
    where: { userId }, select: { reportId: true, lastPublicRevision: true, lastInternalRevision: true },
  });
  for (const m of marks) {
    seenPublic.set(m.reportId, m.lastPublicRevision);
    seenAny.set(m.reportId, Math.max(m.lastPublicRevision, m.lastInternalRevision || 0));
  }

  const mineRows = await prisma.feedbackReport.findMany({
    where: { authorId: userId },
    select: { id: true },
    take: CAP,
  });
  const publicAt = await lastPublicRevisions(prisma, mineRows.map((r: any) => r.id));
  const mine = mineRows.filter((r: any) => (publicAt.get(r.id) || 0) > (seenPublic.get(r.id) || 0)).length;

  let queue = 0;
  if (triage) {
    const queueRows = await prisma.feedbackReport.findMany({
      // Закрытое не ждёт никого: считать его — значит держать красный кружок
      // на разделе, в который заходить незачем
      where: { status: { in: ['NEW', 'TRIAGE', 'PLANNED', 'IN_PROGRESS'] }, authorId: { not: userId } },
      select: { id: true, revision: true },
      take: CAP,
    });
    // Обработчику видно и внутреннее, поэтому здесь сравнивается общая ревизия
    queue = queueRows.filter((r: any) => r.revision > (seenAny.get(r.id) || 0)).length;
  }
  return { mine, queue, total: mine + queue };
}
