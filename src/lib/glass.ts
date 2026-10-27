/**
 * Прозрачность оболочки: включена ли и насколько.
 *
 * Вид задают CSS-переменные и класс на <html> (index.css, блок «Стекло»):
 * `flux-glass` включает полупрозрачные фоны у `.fx-glass`, `--flux-glass-level`
 * (0..1) — насколько. Здесь только чтение и запись настройки: как и тема с
 * плотностью, она живёт в localStorage рабочего места, а не на сервере, потому
 * что зависит от видеокарты и вкуса за этим монитором, а не от учётной записи.
 */

const ON_KEY = 'flux_glass';
const LEVEL_KEY = 'flux_glass_level';

/** Умеренный уровень по умолчанию: фон просвечивает, но текст под ним не мешает */
export const GLASS_DEFAULT_LEVEL = 50;

export type GlassState = { on: boolean; level: number };

const clampLevel = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : GLASS_DEFAULT_LEVEL);

export function readGlass(): GlassState {
  try {
    const on = localStorage.getItem(ON_KEY);
    const level = localStorage.getItem(LEVEL_KEY);
    return { on: on !== '0', level: level === null ? GLASS_DEFAULT_LEVEL : clampLevel(Number(level)) };
  } catch {
    // Хранилище закрыто (приватное окно): остаётся умолчание
    return { on: true, level: GLASS_DEFAULT_LEVEL };
  }
}

/** Ставит класс и переменную на <html>; запоминает, если просили */
export function applyGlass(state: GlassState, persist = false) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('flux-glass', state.on);
  root.style.setProperty('--flux-glass-level', String(clampLevel(state.level) / 100));
  if (!persist) return;
  try {
    localStorage.setItem(ON_KEY, state.on ? '1' : '0');
    localStorage.setItem(LEVEL_KEY, String(clampLevel(state.level)));
  } catch { /* не сохранилось — настройка поживёт до перезапуска */ }
}
