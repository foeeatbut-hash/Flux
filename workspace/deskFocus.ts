/**
 * Окна Flux вместе с окнами Windows: когда главное окно может получать
 * активацию от нажатия.
 *
 * Пока Flux не активен, нажатие по пустому столу не должно поднимать его над
 * Word и Excel (как рабочий стол Windows). Средствами Electron это делается
 * через `setFocusable(false)` (WS_EX_NOACTIVATE): щелчок не активирует и не
 * поднимает окно. Любое другое место — окно раздела, панель задач Flux, Пуск,
 * значок стола — остаётся обычным: щелчок выводит весь Flux вперёд, как раньше.
 *
 * Здесь только решение, без Electron: его проверяют отдельно от окна.
 */

export interface DeskFocusInput {
  /** `process.platform` главного процесса: вне Windows режим не включается вовсе. */
  platform: string;
  /** Выключатель «Параметры → Мониторы». */
  enabled: boolean;
  /** Окно показано и не свёрнуто: свёрнутое и скрытое всегда остаётся активируемым. */
  windowShown: boolean;
  /** Главное окно Flux сейчас активно. */
  windowActive: boolean;
  /** Указатель стоит над пустым местом стола Flux (сигнал окна). */
  pointerOverDesk: boolean;
}

/** Можно ли сейчас оставлять окну возможность активироваться от нажатия. */
export function windowFocusable(input: DeskFocusInput): boolean {
  if (input.platform !== 'win32' || !input.enabled) return true;
  if (!input.windowShown || input.windowActive) return true;
  return !input.pointerOverDesk;
}

/** Не чаще ~20 сигналов указателя в секунду доходят до главного процесса. */
export const DESK_POINTER_MIN_INTERVAL_MS = 50;

/**
 * Пустое место стола: внутри области стола и не на значке или кнопке — тот же
 * признак, по которому стол начинает рамку выделения (WindowsDesktop.tsx).
 * Область стола помечена `data-flux-desk`.
 */
export const DESK_AREA_SELECTOR = '[data-flux-desk]';
export const DESK_ITEM_SELECTOR = 'button,[data-desktop-item]';

export interface DeskTargetLike { closest(selector: string): unknown }

export function isEmptyDeskTarget(target: DeskTargetLike | null | undefined): boolean {
  if (!target || typeof target.closest !== 'function') return false;
  return !!target.closest(DESK_AREA_SELECTOR) && !target.closest(DESK_ITEM_SELECTOR);
}
