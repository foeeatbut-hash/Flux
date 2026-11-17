/**
 * Сочетание, которое открывает скрытый раздел экстренной установки: CapsLock + Shift + Ctrl, зажатые вместе.
 *
 * CapsLock — клавиша-переключатель: состояние «включён» (`getModifierState`) не годится, оно может остаться от
 * обычной работы. Поэтому считаем именно нажатые сейчас клавиши: порядок нажатия любой, сочетание срабатывает
 * в момент, когда зажаты все три. Потеря фокуса окном сбрасывает всё: отпускание клавиши мимо окна иначе
 * оставило бы её «зажатой» навсегда.
 *
 * Без React и без окна: проверяется в браузерном наборе (scripts/test-emergency-ui.ts) и подключается хуком.
 */
export interface ChordTarget {
  addEventListener: (type: string, listener: (e: any) => void, options?: boolean) => void;
  removeEventListener: (type: string, listener: (e: any) => void, options?: boolean) => void;
}

const KEYS = { CapsLock: 'caps', ShiftLeft: 'shift', ShiftRight: 'shift', ControlLeft: 'ctrl', ControlRight: 'ctrl' } as const;

/** Подписаться на сочетание; возвращает отписку */
export function watchEmergencyChord(target: ChordTarget, onChord: () => void): () => void {
  const held = new Set<string>();
  const fire = () => { if (held.has('caps') && held.has('shift') && held.has('ctrl')) { held.clear(); onChord(); } };
  const down = (e: KeyboardEvent) => {
    const role = KEYS[e.code as keyof typeof KEYS];
    if (!role || e.repeat) return;
    held.add(role);
    // Модификаторы события — подстраховка: если Shift или Ctrl нажали до того, как окно получило фокус
    if (e.shiftKey) held.add('shift');
    if (e.ctrlKey) held.add('ctrl');
    fire();
  };
  const up = (e: KeyboardEvent) => { const role = KEYS[e.code as keyof typeof KEYS]; if (role) held.delete(role); };
  const reset = () => held.clear();
  target.addEventListener('keydown', down, true);
  target.addEventListener('keyup', up, true);
  target.addEventListener('blur', reset);
  return () => {
    target.removeEventListener('keydown', down, true);
    target.removeEventListener('keyup', up, true);
    target.removeEventListener('blur', reset);
  };
}
