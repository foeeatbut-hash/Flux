/**
 * Что показывать на месте лицензии.
 *
 * Зачем правило отдельно от экрана. Сбой связи со сервером ложился в тот же
 * объект состояния, что и настоящий ответ: `{ licensed: false, reason: 'none',
 * error: '<сообщение сети>' }`. Экран сообщение о сбое не показывал вовсе — он
 * брал `error` из другого места, а `reason: 'none'` прятал, — и человек видел
 * обычный экран «программа ещё не активирована». То есть при упавшем сервере
 * ему говорили «нет ключа», и он шёл искать ключ вместо того, чтобы позвать
 * того, кто починит сеть. Ключ при этом у него был.
 *
 * Поэтому «не смогли спросить» и «спросили, ответили: не активирована» — два
 * разных состояния, и путать их нельзя ни при каких обстоятельствах.
 *
 * Строгость гейта не меняется: наружу пропускает ровно одно состояние —
 * `licensed`. Сбой связи пропуском НЕ считается, иначе отключённая сеть стала
 * бы способом обойти лицензию.
 */

export type LicenseReason = '' | 'none' | 'invalid' | 'wrong_machine' | 'expired';

export interface GateInput {
  /** Ответ сервера; null — ещё не спрашивали или спросить не вышло */
  status: { licensed: boolean; reason?: LicenseReason } | null;
  /** Почему не вышло спросить. Пусто — сбоя связи не было */
  failure: string;
}

export type GateState =
  | { kind: 'loading' }
  | { kind: 'offline'; text: string; detail: string }
  | { kind: 'licensed' }
  | { kind: 'unlicensed'; reason: LicenseReason; text: string };

/** Почему ключ не принят — словами, которые человеку что-то говорят */
export const REASON_TEXT: Record<string, string> = {
  none: 'Программа ещё не активирована на этом компьютере.',
  invalid: 'Ключ активации неверный или повреждён. Проверьте, что скопировали его полностью.',
  wrong_machine: 'Этот ключ выдан для другого компьютера. Запросите ключ для кода этого компьютера.',
  expired: 'Срок действия лицензии истёк. Запросите новый ключ активации.',
};

export function reasonText(reason?: LicenseReason | string): string {
  return REASON_TEXT[String(reason || '')] || REASON_TEXT.none;
}

export function gateState({ status, failure }: GateInput): GateState {
  // Сбой связи сильнее всего остального: пока мы не знаем ответа, говорить
  // «нет ключа» — врать
  if (failure) {
    return {
      kind: 'offline',
      text: 'Не удалось проверить лицензию',
      detail: failure,
    };
  }
  if (!status) return { kind: 'loading' };
  if (status.licensed) return { kind: 'licensed' };
  return {
    kind: 'unlicensed',
    reason: (status.reason || 'none') as LicenseReason,
    text: reasonText(status.reason),
  };
}

/** Пускает дальше ровно одно состояние. */
export const passes = (s: GateState): boolean => s.kind === 'licensed';
