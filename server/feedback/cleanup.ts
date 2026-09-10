/**
 * Уборка того, что осталось от незаконченных отправок.
 *
 * Вложения лежат кусками в ОБЩЕЙ базе — иначе обработчик не открыл бы файл,
 * оставшийся на диске автора. Плата за это простая: незавершённая загрузка
 * занимает место у всех. Человек начал прикладывать снимок и передумал, связь
 * оборвалась на середине, программа закрылась — куски остались, и через год
 * такой базы это уже разговор с администратором о её размере.
 *
 * Правила уборки нарочно осторожные:
 *
 * — удаляются КУСКИ, а не карточки. В домене обращений удалений нет вовсе:
 *   отклонение и отзыв — это состояния. Пропавшее вложение отмечается
 *   `expiredAt`, и карточка честно говорит «срок хранения истёк», а не делает
 *   вид, что файла не было;
 * — берётся только заведомо брошенное: незавершённая загрузка старше своего
 *   срока (сутки). Загрузка, приложенная к обращению, не трогается никогда;
 * — проход редкий и с запасом по числу за раз: уборка не должна конкурировать
 *   с работой людей за одну и ту же базу.
 */

import { getPrisma, onDatabaseSwapped } from '../context.js';

/** Как часто проходить. Раз в час: спешить здесь некуда. */
const TICK_MS = 60 * 60 * 1000;
/** Сколько загрузок разбирать за проход. */
const BATCH = 50;

/**
 * Сколько живёт вложение, приложенное к обращению.
 *
 * Ноль означает «хранить всегда» — это и есть значение по умолчанию. Срок
 * задаётся при создании вложения (`expiresAt`), и уборка только исполняет
 * записанное, а не решает сама, чему пора исчезнуть.
 */
export const KEEP_FOREVER = 0;

let timer: any = null;
let working = false;

/** Один проход. Возвращает, сколько чего убрано — по этому и проверяется. */
export async function sweepUploads(now = new Date()): Promise<{ dropped: number; expired: number }> {
  const prisma = getPrisma();
  if (!prisma) return { dropped: 0, expired: 0 };
  let dropped = 0;
  let expired = 0;

  try {
    // Брошенные загрузки: срок вышел, а к обращению их так и не приложили
    const stale = await prisma.feedbackUpload.findMany({
      where: { status: { in: ['OPEN', 'VERIFYING', 'READY', 'REJECTED'] }, expiresAt: { lt: now } },
      select: { id: true },
      take: BATCH,
    });
    for (const upload of stale) {
      await prisma.feedbackUploadChunk.deleteMany({ where: { uploadId: upload.id } });
      await prisma.feedbackUpload.update({
        where: { id: upload.id }, data: { status: 'EXPIRED' },
      });
      dropped++;
    }
  } catch (_) { /* база могла смениться на ходу — проход повторится через час */ }

  try {
    // Вложения с истёкшим сроком хранения: куски убираем, запись оставляем
    const old = await prisma.feedbackAttachment.findMany({
      where: { expiredAt: null, expiresAt: { not: null, lt: now } },
      select: { id: true, uploadId: true },
      take: BATCH,
    });
    for (const attachment of old) {
      await prisma.feedbackUploadChunk.deleteMany({ where: { uploadId: attachment.uploadId } });
      await prisma.feedbackAttachment.update({
        where: { id: attachment.id }, data: { expiredAt: now },
      });
      expired++;
    }
  } catch (_) { /* то же самое: молча ждём следующего прохода */ }

  return { dropped, expired };
}

export function startCleanup(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (working) return;
    working = true;
    void sweepUploads().finally(() => { working = false; });
  }, TICK_MS);
  // Уборка не держит процесс: программа должна закрываться, когда её закрыли
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopCleanup(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// База сменилась — проход, державший прежний клиент, надо перезавести
onDatabaseSwapped(() => { stopCleanup(); startCleanup(); });
