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

/**
 * Клавиши окна, а не списка: вкладки, адрес, поиск, история, обновление. Они
 * работают, где бы ни стоял фокус (даже в поле поиска), поэтому лежат
 * отдельной таблицей: у клавиш списка свои условия — «нужен выбранный объект»,
 * «не печатают в поле». Проверку на «у каждой клавиши есть сценарий»
 * (scripts/test-explorer-shell-ui.ts) они проходят так же, как таблица
 * списка. Backspace «назад» живёт в таблице списка: в поле он стирает.
 */
export type ShellAction =
  | 'newTab' | 'closeTab' | 'nextTab' | 'prevTab'
  | 'goBack' | 'goForward' | 'goUp'
  | 'address' | 'search' | 'refresh';

export type ShellBinding = Omit<KeyBinding, 'action' | 'needs'> & { action: ShellAction };

export const SHELL_KEYS: ShellBinding[] = [
  { action: 'newTab', label: 'Ctrl+T', key: 't', ctrl: true, does: 'новая вкладка на «Главной»' },
  { action: 'closeTab', label: 'Ctrl+W', key: 'w', ctrl: true, does: 'закрыть вкладку' },
  { action: 'nextTab', label: 'Ctrl+Tab', key: 'Tab', ctrl: true, does: 'следующая вкладка по кругу' },
  { action: 'prevTab', label: 'Ctrl+Shift+Tab', key: 'Tab', ctrl: true, shift: true, does: 'предыдущая вкладка по кругу' },
  { action: 'goBack', label: 'Alt+←', key: 'ArrowLeft', alt: true, does: 'назад по истории вкладки' },
  { action: 'goForward', label: 'Alt+→', key: 'ArrowRight', alt: true, does: 'вперёд по истории вкладки' },
  { action: 'goUp', label: 'Alt+↑', key: 'ArrowUp', alt: true, does: 'на уровень вверх' },
  { action: 'address', label: 'Ctrl+L', key: 'l', ctrl: true, does: 'адрес текстом' },
  { action: 'address', label: 'Alt+D', key: 'd', alt: true, does: 'адрес текстом' },
  { action: 'address', label: 'F4', key: 'F4', does: 'адрес текстом' },
  { action: 'search', label: 'Ctrl+E', key: 'e', ctrl: true, does: 'поле поиска' },
  { action: 'search', label: 'Ctrl+F', key: 'f', ctrl: true, does: 'поле поиска' },
  { action: 'search', label: 'F3', key: 'F3', does: 'поле поиска' },
  { action: 'refresh', label: 'F5', key: 'F5', does: 'обновить открытое место' },
];

type KeyLike = { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean };

function findKey<B extends { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean }>(table: B[], event: KeyLike): B | null {
  const ctrl = !!(event.ctrlKey || event.metaKey);
  const sameKey = (binding: B) => binding.key.length === 1
    ? binding.key === event.key.toLowerCase() || event.code === `Key${binding.key.toUpperCase()}`
    : binding.key === event.key;
  return table.find((binding) =>
    sameKey(binding) && !!binding.ctrl === ctrl && !!binding.shift === !!event.shiftKey && !!binding.alt === !!event.altKey) ?? null;
}

/**
 * Какая клавиша из таблицы нажата. Cmd на Mac читается как Ctrl. Буквы
 * сверяются и по физической клавише (`code`): при русской раскладке Ctrl+C
 * приходит как «с», и без этого копирование работало бы только по-английски.
 */
export const matchKey = (event: KeyLike): KeyBinding | null => findKey(EXPLORER_KEYS, event);
/** То же для клавиш окна (`SHELL_KEYS`). */
export const matchShellKey = (event: KeyLike): ShellBinding | null => findKey(SHELL_KEYS, event);

/** Хватает ли выбранных объектов для действия. */
export function keyAvailable(binding: KeyBinding, selectedCount: number): boolean {
  return binding.needs === 'none' || (binding.needs === 'any' ? selectedCount >= 1 : selectedCount === 1);
}

/** Печатают в поле: тогда клавиши принадлежат полю, а не Проводнику. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element?.closest?.('input, textarea, select, [contenteditable="true"]');
}
