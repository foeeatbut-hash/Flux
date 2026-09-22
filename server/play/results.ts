/**
 * Результат матча: приходит от игрового сервера и проверяется подписью.
 *
 * Игрок свой счёт не присылает — никогда. Это не осторожность ради
 * осторожности: тот, кто присылает свой результат, рано или поздно пришлёт
 * тот, который ему нравится, и никакой статистики после этого не существует.
 *
 * Правила приёма:
 *
 *   — **подпись проверяет адаптер игры.** Игра без подписи обязана сказать
 *     это вслух, а не возвращать «да»;
 *   — **результат на матч один.** Держит уникальный индекс: повтор доставки
 *     (а он будет — игровой сервер тоже не уверен, что мы его услышали) не
 *     удваивает счёт, а отвечает тем же;
 *   — **приём и завершение матча — одно действие.** Разделив их, мы завели бы
 *     матч с результатом, но без конца: люди в нём остались бы «в матче»
 *     навсегда, и следующий им не завели бы.
 */

import { randomUUID } from 'node:crypto';
import { getPrisma } from '../context.js';
import { PLAY_ERRORS } from '../../play/contracts.js';
import { fail, isDuplicate, stableJson } from './commands.js';
import { adapterFor } from './adapters/contract.js';
import { finishSession } from './sessions.js';

export interface AcceptedResult {
  sessionId: string;
  repeated: boolean;
  payload: Record<string, unknown>;
}

/**
 * Принять результат.
 *
 * `signature` считается по `sessionId` и телу; как именно — дело адаптера.
 * Платформа только спрашивает, верна ли она.
 */
export async function acceptResult(
  sessionId: string, payload: Record<string, unknown>, signature: string,
): Promise<AcceptedResult> {
  const prisma = getPrisma();
  const session = await prisma.playSession.findUnique({ where: { id: sessionId } });
  if (!session) fail(PLAY_ERRORS.NOT_FOUND);

  const adapter = adapterFor(session.gameId);
  if (!adapter) fail(PLAY_ERRORS.UNSUPPORTED);

  const trusted = await adapter!.verify(sessionId, payload, signature);
  if (!trusted) fail(PLAY_ERRORS.FORBIDDEN, 'Подпись результата не подтверждена');

  try {
    await prisma.playResult.create({
      data: { id: randomUUID(), sessionId, payloadJson: stableJson(payload), signature },
    });
  } catch (e) {
    // Результат уже принят: повтор доставки отвечает тем же, а не вторым
    // счётом. Игровой сервер повторяет доставку именно потому, что не уверен,
    // что мы его услышали, — и он прав
    if (isDuplicate(e)) {
      const was = await prisma.playResult.findUnique({ where: { sessionId } });
      await finishSession(sessionId);
      return { sessionId, repeated: true, payload: safeJson(was?.payloadJson) };
    }
    throw e;
  }

  await finishSession(sessionId);
  return { sessionId, repeated: false, payload };
}

/** Результат матча, если он уже есть. */
export async function resultOf(sessionId: string): Promise<Record<string, unknown> | null> {
  const prisma = getPrisma();
  const row = await prisma.playResult.findUnique({ where: { sessionId } });
  return row ? safeJson(row.payloadJson) : null;
}

function safeJson(text: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { return {}; }
}
