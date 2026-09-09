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

export async function unreadFor(userId: string, triage: boolean): Promise<{ mine: number; queue: number; total: number }> {
  const prisma = getPrisma();
  const seen = new Map<string, number>();
  const marks = await prisma.feedbackReadState.findMany({
    where: { userId }, select: { reportId: true, lastPublicRevision: true },
  });
  for (const m of marks) seen.set(m.reportId, m.lastPublicRevision);

  const mineRows = await prisma.feedbackReport.findMany({
    where: { authorId: userId },
    select: { id: true, revision: true },
    take: CAP,
  });
  const mine = mineRows.filter((r: any) => r.revision > (seen.get(r.id) || 0)).length;

  let queue = 0;
  if (triage) {
    const queueRows = await prisma.feedbackReport.findMany({
      // Закрытое не ждёт никого: считать его — значит держать красный кружок
      // на разделе, в который заходить незачем
      where: { status: { in: ['NEW', 'TRIAGE', 'PLANNED', 'IN_PROGRESS'] }, authorId: { not: userId } },
      select: { id: true, revision: true },
      take: CAP,
    });
    queue = queueRows.filter((r: any) => r.revision > (seen.get(r.id) || 0)).length;
  }
  return { mine, queue, total: mine + queue };
}
