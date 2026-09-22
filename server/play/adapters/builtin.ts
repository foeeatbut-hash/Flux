/**
 * Адаптер встроенной игры: сервер — это мы сами.
 *
 * Договор платформы написан под внешнюю игру: выделить сервер, принять
 * подписанный результат, отпустить сервер. Настольной игре выделять нечего, а
 * результат ей неоткуда взять, кроме как от нас же.
 *
 * Поэтому здесь важно не соврать в двух местах.
 *
 * **`allocate` не выделяет сервер**, а заводит доску. Адрес возвращается
 * словом «встроенная», а не выдуманным «host:port»: окно по нему никуда не
 * пойдёт, и притворяться, что пойдёт, незачем.
 *
 * **`verify` не проверяет подпись, потому что её нет.** Договор прямо требует:
 * «адаптер игры, у которой подписи нет, обязан сказать об этом вслух, а не
 * возвращать `true`». Здесь он и говорит: принимается только результат,
 * написанный самим сервером (`signature === 'builtin'`), а всё остальное —
 * нет. Результат встроенной игры никуда не уезжал: его посчитали те же чистые
 * правила, которыми шла партия, и подписывать нечего.
 */

import { registerAdapter, type AllocatedServer, type GameAdapter } from './contract.js';
import { allRules, freshSeed } from '../../../play/games/all.js';
import { openMatch } from '../match.js';

/** Как называется адрес встроенной игры. Не «host:port» — идти туда некуда */
export const BUILTIN_ADDRESS = 'встроенная';

const builtinAdapter = (id: string): GameAdapter => ({
  id,

  async allocate({ sessionId, seats }): Promise<AllocatedServer> {
    // Места в порядке команд: первый ходит первым. Порядок здесь и решается,
    // иначе «чёрные» достались бы то одному, то другому
    const ordered = [...seats].sort((a, b) => a.team - b.team).map((s) => s.userId);
    await openMatch(sessionId, id, ordered, freshSeed());
    return { address: BUILTIN_ADDRESS, externalId: sessionId };
  },

  async verify(_sessionId, _payload, signature): Promise<boolean> {
    // Подписи у встроенной игры нет, и «да» на любой запрос означало бы, что
    // результат можно прислать снаружи
    return signature === 'builtin';
  },

  async release(): Promise<void> {
    // Отпускать нечего: доска осталась в базе, и она — часть истории матча
  },
});

/** Подключить адаптеры ко всем встроенным играм разом. */
export function registerBuiltinAdapters(): void {
  for (const rules of allRules()) registerAdapter(builtinAdapter(rules.id));
}
