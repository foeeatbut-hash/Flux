/**
 * Движение Flux для анимаций из кода (Web Animations, motion/react).
 *
 * Числа — те же, что токены `--flux-dur-*` и `--flux-ease*` в index.css:
 * окно, меню и тост должны двигаться в одном ритме, иначе программа
 * ощущается собранной из разных кусков. Анимируются только transform и
 * opacity — их рисует видеокарта, и кадр не пересчитывает раскладку.
 */
export const DUR = { fast: 120, base: 160, slow: 220, exit: 100 } as const;

export const EASE = {
  /** Приход: быстрый старт, мягкая посадка */
  enter: 'cubic-bezier(0.16, 1, 0.3, 1)',
  /** Уход: разгон без торможения — исчезающее не задерживает взгляд */
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
  /** Перемещение с места на место */
  move: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

/** Те же кривые для motion/react, который принимает массив из четырёх чисел */
export const EASE_ARR = {
  enter: [0.16, 1, 0.3, 1],
  exit: [0.4, 0, 1, 1],
  move: [0.2, 0, 0, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** Человек попросил систему меньше двигать — анимации из кода тоже молчат */
export function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** Готовые transition для motion/react (секунды): приход и уход. Уход короче прихода */
export const TRANSITION = {
  enter: { duration: DUR.base / 1000, ease: EASE_ARR.enter },
  exit: { duration: DUR.exit / 1000, ease: EASE_ARR.exit },
} as const;
