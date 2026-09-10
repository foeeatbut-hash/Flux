/**
 * Разбор приложенного пакета диагностики.
 *
 * Пакет — это строки событий, которые окно записало вокруг происшествия. Сами
 * по себе они разбирающему мало что дают: тысяча строк, которые надо читать
 * глазами. Ценность появляется, когда из них посчитана сводка — самые медленные
 * операции, ошибки по коду, паузы интерфейса, незавершённые цепочки, — и она
 * лежит рядом с карточкой.
 *
 * Три решения, каждое с причиной:
 *
 * — разбор идёт ПОСЛЕ создания обращения, а не внутри его транзакции. Транзакция
 *   держит блокировки в общей базе, а разбор пятимегабайтного пакета — это
 *   десятки миллисекунд чтения и счёта. Обращение важнее сводки: сначала оно
 *   создаётся, потом считается сводка;
 * — сводка считается один раз и записывается. Считать её на каждое открытие
 *   карточки значило бы читать вложение из базы всякий раз, когда обработчик
 *   пролистывает очередь;
 * — отпечаток технического дубля берётся отсюда, из настоящей ошибки и кадров
 *   стека, а не из первой строки поля «что получилось». Тот способ был
 *   компромиссом, пока пакет никто не разбирал.
 */

import { getPrisma } from '../context.js';
import { summarize, parseJsonl } from '../../diagnostics/summary.js';
import { technicalFingerprint } from '../../feedback/fingerprint.js';

/** Больше этого не разбираем: пакет ограничен пятью мегабайтами при приёме. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Отпечаток по разобранным событиям.
 *
 * Берётся первая ошибка: она и есть то, на что человек жалуется. Кадры стека
 * лежат в полях события уже очищенными — путь установки и номера строк из них
 * убраны при записи.
 */
export function fingerprintOfEvents(events: any[], appVersion: string, sectionKey: string): string {
  const failure = events.find((e) => e?.event === 'log.error' || e?.fields?.outcome === 'fail');
  if (!failure) return '';
  const fields = failure.fields || {};
  const frames = [fields.frame1, fields.frame2, fields.frame3].filter(Boolean);
  return technicalFingerprint({
    appVersion,
    sectionKey,
    errorCode: String(fields.code || fields.error || failure.event || ''),
    frames,
  });
}

/**
 * Разобрать пакеты, приложенные к обращению.
 *
 * Зовётся без ожидания ответа: сводка появляется через мгновение после
 * карточки, и это правильный порядок. Ошибки разбора никуда не всплывают —
 * испорченный пакет не должен мешать обращению существовать.
 */
export async function describeBundles(reportId: string): Promise<number> {
  const prisma = getPrisma();
  if (!prisma || !reportId) return 0;
  let made = 0;
  try {
    const report = await prisma.feedbackReport.findUnique({
      where: { id: reportId },
      select: { appVersion: true, sectionKey: true },
    });
    const attachments = await prisma.feedbackAttachment.findMany({
      where: { reportId, kind: 'DIAGNOSTICS' },
      select: { id: true, uploadId: true, byteLength: true },
    });

    for (const attachment of attachments) {
      if (attachment.byteLength > MAX_BYTES) continue;
      const already = await prisma.feedbackDiagnosticBundle.findFirst({
        where: { attachmentId: attachment.id }, select: { id: true },
      });
      // Повторный разбор ничего не улучшит, а место займёт
      if (already) continue;

      const parts = await prisma.feedbackUploadChunk.findMany({
        where: { uploadId: attachment.uploadId },
        orderBy: { index: 'asc' },
        select: { bytes: true },
      });
      if (!parts.length) continue;
      const text = Buffer.concat(parts.map((p: any) => Buffer.from(p.bytes))).toString('utf8');

      const { events, broken } = parseJsonl(text);
      const summary = summarize(events);
      const fingerprint = fingerprintOfEvents(events, report?.appVersion || '', report?.sectionKey || '');

      await prisma.feedbackDiagnosticBundle.create({
        data: {
          reportId,
          attachmentId: attachment.id,
          // В описи — то, что нужно, чтобы понять, чего в сводке ждать: сколько
          // строк не разобралось и сколько событий вообще было
          manifestJson: JSON.stringify({ bytes: attachment.byteLength, lines: events.length, broken }),
          summaryJson: JSON.stringify(summary),
          ...(fingerprint ? { fingerprint } : {}),
        },
      });
      made++;
    }
  } catch (_) {
    // Пакет мог оказаться не тем, база — смениться на ходу. Обращение от этого
    // не страдает: сводки просто не будет, и в карточке это видно
  }
  return made;
}
