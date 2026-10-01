/** Встроенная игра считает состояние и итог на сервере, а не принимает счёт от клиента. */

import { randomBytes } from 'node:crypto';
import { registerAdapter, type AllocatedServer, type GameAdapter } from './contract.js';
import { PLAY_GAMES } from '../../../play/features.js';
import { allRules } from '../../../play/games/all.js';
import { openMatch } from '../match.js';

/** Как называется адрес встроенной игры. Не «host:port» — идти туда некуда */
export const BUILTIN_ADDRESS = 'встроенная';

const builtinAdapter = (id: string): GameAdapter => ({
  id,

  async allocate({ sessionId, seats }): Promise<AllocatedServer> {
    // Места в порядке команд: первый ходит первым. Порядок здесь и решается,
    // иначе «чёрные» достались бы то одному, то другому
    const ordered = [...seats].sort((a, b) => a.team - b.team).map((s) => s.userId);
    await openMatch(sessionId, id, ordered, randomBytes(32).toString('hex'));
    return { address: BUILTIN_ADDRESS, externalId: sessionId };
  },

  async verify(_sessionId, _payload, _signature): Promise<boolean> {
    // Даже строка builtin от клиента не является подписью: итог пишут
    // правила внутри транзакции хода, HTTP-публикация его не принимает.
    return false;
  },

  async release(): Promise<void> {
    // Отпускать нечего: доска осталась в базе, и она — часть истории матча
  },
});

/** Подключить адаптеры ко всем встроенным играм разом. */
export function registerBuiltinAdapters(): void {
  for (const rules of allRules()) if (PLAY_GAMES.some(game => game.id === rules.id)) registerAdapter(builtinAdapter(rules.id));
}
