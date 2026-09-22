/**
 * Проверочная игра: настоящий отдельный процесс, а не заглушка.
 *
 * Разница принципиальная, и ТЗ на ней настаивает. Заглушка отвечает мгновенно
 * и всегда «да» — на ней «работает» и то, что на живом процессе не работает
 * никогда: тайм-аут выделения, повторная доставка результата, подпись,
 * которую никто не считал. Поэтому проверочная игра — это `scripts/testgame-server.ts`,
 * поднимаемый отдельно и говорящий по HTTP.
 *
 * Общий секрет берётся из окружения (`FLUX_TESTGAME_SECRET`). В коде его нет и
 * быть не может: секрет в репозитории — это секрет у всех. Нет секрета —
 * адаптер не регистрируется вовсе, и матч честно не начинается, вместо того
 * чтобы начаться без подписи.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { stableJson } from '../commands.js';
import { registerAdapter, type AllocatedServer, type GameAdapter } from './contract.js';

const ENV_URL = 'FLUX_TESTGAME_URL';
const ENV_SECRET = 'FLUX_TESTGAME_SECRET';

/** Подпись результата: HMAC по матчу и телу. Порядок полей на неё не влияет. */
export function signResult(secret: string, sessionId: string, payload: unknown): string {
  return createHmac('sha256', secret).update(`${sessionId}.${stableJson(payload)}`).digest('hex');
}

/** Сравнение подписей постоянным временем: иначе её подбирают по задержке. */
function sameSignature(a: string, b: string): boolean {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length || !left.length) return false;
  return timingSafeEqual(left, right);
}

export function makeTestGameAdapter(baseUrl: string, secret: string): GameAdapter {
  const call = async (path: string, body: unknown): Promise<any> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`проверочная игра ответила ${res.status}`);
    return res.json();
  };

  return {
    id: 'testgame',

    async allocate(input): Promise<AllocatedServer> {
      const data = await call('/allocate', { sessionId: input.sessionId, seats: input.seats });
      const address = String(data?.address || '');
      if (!address) throw new Error('проверочная игра не назвала адрес');
      return { address, externalId: String(data?.externalId || input.sessionId) };
    },

    async verify(sessionId, payload, signature): Promise<boolean> {
      return sameSignature(signResult(secret, sessionId, payload), signature);
    },

    async release(sessionId): Promise<void> {
      try { await call('/release', { sessionId }); } catch (_) { /* процесс мог уже уйти */ }
    },
  };
}

/**
 * Подключить проверочную игру, если она настроена.
 *
 * Возвращает, подключилась ли. Не подключилась — это не беда и не молчание:
 * матч по ней просто не начнётся, и человек увидит «игра не подключена», а не
 * бесконечное «Подключение…».
 */
export function setupTestGame(log?: (m: string) => void): boolean {
  const url = String(process.env[ENV_URL] || '').replace(/\/+$/, '');
  const secret = String(process.env[ENV_SECRET] || '');
  if (!url || !secret) {
    log?.(`Проверочная игра не подключена: нет ${ENV_URL} или ${ENV_SECRET}`);
    return false;
  }
  registerAdapter(makeTestGameAdapter(url, secret));
  log?.(`Проверочная игра подключена: ${url}`);
  return true;
}
