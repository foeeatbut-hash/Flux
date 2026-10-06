/**
 * Горячие клавиши Проводника — таблицей, а не россыпью `if` в обработчике.
 *
 * Таблицу читают двое: обработчик в `WindowsExplorer` и проверка
 * (`scripts/test-windows-explorer-ui.ts`), которая падает на клавише без
 * сценария. Поэтому новая клавиша появляется здесь и сразу требует проверки:
 * иначе она работала бы «на слово». Раскладка — Windows 11, в нужной части
 * (docs/explorer-windows11.md, раздел «Клавиатура»); без React, чтобы таблицу
 * можно было прочитать из скрипта.
 */

export type KeyAction =
  | 'open' | 'rename' | 'trash' | 'copy' | 'cut' | 'paste' | 'selectAll' | 'create' | 'properties' | 'back'
  | 'clear' | 'down' | 'up' | 'left' | 'right' | 'extendDown' | 'extendUp';

export interface KeyBinding {
  action: KeyAction;
  /** Как пишет клавишу человек: «Ctrl+Shift+N» */
  label: string;
  /** Значение KeyboardEvent.key; регистр у букв не важен */
  key: string;
  ctrl?: boolean; shift?: boolean; alt?: boolean;
  /** Что делает клавиша — одной строкой, как в справке */
  does: string;
  /** Сколько выбранных объектов нужно: ни одного, хотя бы один или ровно один */
  needs: 'none' | 'any' | 'one';
}

export const EXPLORER_KEYS: KeyBinding[] = [
  { action: 'open', label: 'Enter', key: 'Enter', does: 'открыть выбранный объект', needs: 'one' },
  { action: 'properties', label: 'Alt+Enter', key: 'Enter', alt: true, does: 'свойства', needs: 'one' },
  { action: 'rename', label: 'F2', key: 'F2', does: 'переименовать', needs: 'one' },
  { action: 'trash', label: 'Del', key: 'Delete', does: 'в корзину (все выбранные)', needs: 'any' },
  { action: 'copy', label: 'Ctrl+C', key: 'c', ctrl: true, does: 'копировать (все выбранные)', needs: 'any' },
  { action: 'cut', label: 'Ctrl+X', key: 'x', ctrl: true, does: 'вырезать (все выбранные)', needs: 'any' },
  { action: 'paste', label: 'Ctrl+V', key: 'v', ctrl: true, does: 'вставить в открытую папку', needs: 'none' },
  { action: 'selectAll', label: 'Ctrl+A', key: 'a', ctrl: true, does: 'выделить всё', needs: 'none' },
  { action: 'create', label: 'Ctrl+Shift+N', key: 'n', ctrl: true, shift: true, does: 'панель «Создать» на пункте «Папку»', needs: 'none' },
  { action: 'back', label: 'Backspace', key: 'Backspace', does: 'назад по истории', needs: 'none' },
  { action: 'clear', label: 'Esc', key: 'Escape', does: 'снять выделение', needs: 'none' },
  { action: 'down', label: '↓', key: 'ArrowDown', does: 'следующий объект', needs: 'none' },
  { action: 'up', label: '↑', key: 'ArrowUp', does: 'предыдущий объект', needs: 'none' },
  { action: 'right', label: '→', key: 'ArrowRight', does: 'следующий объект в плитках', needs: 'none' },
  { action: 'left', label: '←', key: 'ArrowLeft', does: 'предыдущий объект в плитках', needs: 'none' },
  { action: 'extendDown', label: 'Shift+↓', key: 'ArrowDown', shift: true, does: 'добавить следующий к выделению', needs: 'none' },
  { action: 'extendUp', label: 'Shift+↑', key: 'ArrowUp', shift: true, does: 'добавить предыдущий к выделению', needs: 'none' },
];

type KeyLike = { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean };

/**
 * Какая клавиша из таблицы нажата. Cmd на Mac читается как Ctrl. Буквы
 * сверяются и по физической клавише (`code`): при русской раскладке Ctrl+C
 * приходит как «с», и без этого копирование работало бы только по-английски.
 */
export function matchKey(event: KeyLike): KeyBinding | null {
  const ctrl = !!(event.ctrlKey || event.metaKey);
  const sameKey = (binding: KeyBinding) => binding.key.length === 1
    ? binding.key === event.key.toLowerCase() || event.code === `Key${binding.key.toUpperCase()}`
    : binding.key === event.key;
  return EXPLORER_KEYS.find((binding) =>
    sameKey(binding) && !!binding.ctrl === ctrl && !!binding.shift === !!event.shiftKey && !!binding.alt === !!event.altKey) ?? null;
}

/** Хватает ли выбранных объектов для действия. */
export function keyAvailable(binding: KeyBinding, selectedCount: number): boolean {
  return binding.needs === 'none' || (binding.needs === 'any' ? selectedCount >= 1 : selectedCount === 1);
}

/** Печатают в поле: тогда клавиши принадлежат полю, а не Проводнику. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element?.closest?.('input, textarea, select, [contenteditable="true"]');
}
