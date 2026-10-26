/**
 * Движение окон: открытие, закрытие, «в кнопку панели задач», подгонка размера.
 *
 * Только transform и opacity через Web Animations: их рисует видеокарта, и
 * кадр не пересчитывает раскладку (left/top/width/height окна меняются сразу,
 * а глаз видит плавный переход благодаря обратному transform — приём FLIP).
 * Без React: функции получают готовый элемент окна, а решает, когда
 * двигать, оболочка (WindowsLayer, windowStore).
 *
 * Правила, общие для всех движений:
 *  - у окна одна анимация за раз: новая отменяет прежнюю, быстрые повторные
 *    нажатия не копят хвосты и не оставляют окно в полупрозрачном виде;
 *  - will-change и transform-origin стоят только на время анимации;
 *  - reducedMotion() — мгновенно, без единого кадра.
 */
import { DUR, EASE, reducedMotion } from './motion';

/** Метка анимации окна: по ней находим свою среди чужих (тень, переходы CSS) */
const ANIM_ID = 'flux-win';

const current = new WeakMap<Element, Animation>();

/** Отметки действий живут недолго: действие и перерисовка идут в одном тике */
const MARK_TTL = 400;
const freshMarks = new Map<string, number>();
const flipMarks = new Map<string, number>();

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function mark(map: Map<string, number>, id: string) { map.set(id, now()); }
function consume(map: Map<string, number>, id: string): boolean {
  const at = map.get(id);
  map.delete(id);
  return at !== undefined && now() - at < MARK_TTL;
}

/** Окно только что создано человеком — ему положено «открыться» */
export const markFresh = (id: string) => mark(freshMarks, id);
export const consumeFresh = (id: string) => consume(freshMarks, id);
/**
 * Геометрия окна сейчас изменится по команде (развернуть, доля, плитка), а
 * не от курсора и не от смены размера стола — только такие переходы анимируем.
 * Окно, которое идёт за курсором, движется 1:1 и без анимации.
 */
export const markFlip = (ids: string[]) => { for (const id of ids) mark(flipMarks, id); };
export const consumeFlip = (id: string) => consume(flipMarks, id);

/** Окна, которые прямо сейчас уходят: повторное закрытие их не трогает */
const closing = new Set<string>();
export const isClosing = (id: string) => closing.has(id);

/** Отменить движение окна: нужно перед перетаскиванием и перед новым движением */
export function stopMotion(el: Element | null | undefined) {
  if (!el) return;
  const a = current.get(el);
  if (a) { current.delete(el); try { a.cancel(); } catch { /* уже отменена */ } }
  // Анимации, которые завёл не этот модуль, но с той же меткой (горячая перезагрузка)
  if (typeof el.getAnimations === 'function') {
    for (const x of el.getAnimations()) if (x.id === ANIM_ID) x.cancel();
  }
}

interface PlayOpts {
  duration: number;
  easing: string;
  /** Точка, вокруг которой масштабируем; по умолчанию центр */
  origin?: string;
  /** Держать последний кадр до onDone — для ухода, когда после него display:none */
  hold?: boolean;
  /** Не снимать удержанный кадр: окно сразу удалят, а между кадрами оно не должно мелькнуть целым */
  keep?: boolean;
  onDone?: () => void;
}

function play(el: HTMLElement, frames: Keyframe[], o: PlayOpts): Animation | null {
  if (reducedMotion() || typeof el.animate !== 'function') { o.onDone?.(); return null; }
  stopMotion(el);
  el.style.willChange = 'transform, opacity';
  if (o.origin) el.style.transformOrigin = o.origin;
  const a = el.animate(frames, { duration: o.duration, easing: o.easing, fill: o.hold ? 'forwards' : 'none' });
  a.id = ANIM_ID;
  current.set(el, a);
  const tidy = () => {
    // Отменённую анимацию заменила новая: её will-change и origin трогать нельзя
    if (current.get(el) !== a) return;
    current.delete(el);
    el.style.willChange = '';
    el.style.transformOrigin = '';
  };
  a.addEventListener('finish', () => {
    // Конечное состояние применяет вызывающий; после этого держать кадр незачем
    const stillOurs = current.get(el) === a;
    if (stillOurs) o.onDone?.();
    if (o.hold && !o.keep && stillOurs) { try { a.cancel(); } catch { /* ignore */ } }
    tidy();
  });
  a.addEventListener('cancel', tidy);
  return a;
}

/** Как окно выглядит прямо сейчас — продолжаем с этого места, а не прыгаем */
function snapshot(el: HTMLElement): { transform: string; opacity: string } | null {
  if (!current.has(el) || typeof getComputedStyle !== 'function') return null;
  const cs = getComputedStyle(el);
  return { transform: cs.transform === 'none' ? 'none' : cs.transform, opacity: cs.opacity };
}

/** Открытие: из лёгкой глубины на место */
export function animateOpen(el: HTMLElement) {
  play(el, [
    { opacity: 0, transform: 'translateY(8px) scale(0.965)' },
    { opacity: 1, transform: 'translateY(0) scale(1)' },
  ], { duration: DUR.base, easing: EASE.enter });
}

/**
 * Закрытие: окно чуть уходит вглубь и гаснет, затем resolve — после этого
 * вызывающий удаляет окно из хранилища. Не дожидаясь события finish (вкладка
 * в фоне его задерживает), страхуемся таймером.
 */
export function animateClose(el: HTMLElement | null): Promise<void> {
  if (!el || reducedMotion() || typeof el.animate !== 'function' || el.getClientRects().length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    el.style.pointerEvents = 'none';
    play(el, [
      { opacity: 1, transform: 'scale(1)' },
      { opacity: 0, transform: 'scale(0.97)' },
    ], { duration: DUR.exit, easing: EASE.exit, hold: true, keep: true, onDone: finish });
    setTimeout(finish, DUR.exit + 160);
  });
}

/** Закрыть по id окна: страж mayClose уже спросили, остаётся показать уход */
export async function closeWithMotion(id: string): Promise<void> {
  if (typeof document === 'undefined') return;
  closing.add(id);
  try {
    await animateClose(document.querySelector<HTMLElement>(`[data-win="${id}"]`));
  } finally {
    closing.delete(id);
  }
}

/** Центр кнопки программы на панели задач; ближайшей, если панелей несколько */
export function taskbarTarget(path: string, from: { x: number; y: number }): { x: number; y: number } {
  const pick = (nodes: Element[]) => {
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const n of nodes) {
      const r = n.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const d = (c.x - from.x) ** 2 + (c.y - from.y) ** 2;
      if (d < bestD) { best = c; bestD = d; }
    }
    return best;
  };
  const q = (sel: string) => Array.from(document.querySelectorAll(sel));
  const esc = path.replace(/["\\]/g, '\\$&');
  return pick(q(`[data-taskbar-btn="${esc}"]`))
    // Кнопки нет (панель скрыта, раздел без кнопки): летим к самой панели
    ?? pick(q('[data-taskbar]'))
    ?? { x: window.innerWidth / 2, y: window.innerHeight };
}

const FLY_SCALE = 0.2;

function flyTransform(el: HTMLElement, path: string): string {
  const r = el.getBoundingClientRect();
  const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  const t = taskbarTarget(path, c);
  return `translate(${Math.round(t.x - c.x)}px, ${Math.round(t.y - c.y)}px) scale(${FLY_SCALE})`;
}

/**
 * Сворачивание: окно летит к своей кнопке. Вызывается, когда React уже
 * поставил display:none, поэтому показываем окно на время полёта и прячем
 * в конце — но только если его за это время не вернули.
 */
export function animateMinimize(el: HTMLElement, path: string, stillMinimized: () => boolean) {
  if (reducedMotion() || typeof el.animate !== 'function') return;
  const from = snapshot(el);
  el.style.display = '';
  if (el.getClientRects().length === 0) { el.style.display = 'none'; return; }
  const to = flyTransform(el, path);
  play(el, [
    { opacity: from ? Number(from.opacity) : 1, transform: from ? from.transform : 'none' },
    { opacity: 0, transform: to },
  ], {
    duration: DUR.slow, easing: EASE.exit, hold: true,
    onDone: () => { if (stillMinimized()) el.style.display = 'none'; },
  });
}

/** Восстановление: окно вылетает из своей кнопки обратно на место */
export function animateRestore(el: HTMLElement, path: string) {
  if (reducedMotion() || typeof el.animate !== 'function') return;
  const from = snapshot(el);
  stopMotion(el);
  if (el.getClientRects().length === 0) return;
  const start = from ?? { opacity: '0', transform: flyTransform(el, path) };
  play(el, [
    { opacity: Number(start.opacity), transform: start.transform },
    { opacity: 1, transform: 'none' },
  ], { duration: DUR.slow, easing: EASE.enter });
}

export interface RectLike { x: number; y: number; w: number; h: number }

/**
 * Развернуть, вернуть размер, доля экрана: геометрия уже новая, а глаз
 * должен увидеть переход от прежней. Ставим обратный transform (окно выглядит
 * как раньше) и анимируем его к единице.
 *
 * prev — прежний прямоугольник в координатах родителя окна (стола). Если окно
 * уже в движении, берём то, что видно сейчас: не прыгаем в начало.
 */
export function animateFlip(el: HTMLElement, prev: RectLike) {
  if (reducedMotion() || typeof el.animate !== 'function') return;
  const running = current.has(el);
  const seen = running ? el.getBoundingClientRect() : null;
  stopMotion(el);
  const layout = el.getBoundingClientRect();
  if (layout.width < 1 || layout.height < 1) return;
  let first: { left: number; top: number; width: number; height: number };
  if (seen) first = { left: seen.left, top: seen.top, width: seen.width, height: seen.height };
  else {
    const base = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    if (!base) return;
    first = { left: base.left + prev.x, top: base.top + prev.y, width: prev.w, height: prev.h };
  }
  const dx = first.left - layout.left;
  const dy = first.top - layout.top;
  const sx = first.width / layout.width;
  const sy = first.height / layout.height;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) return;
  play(el, [
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
    { transform: 'translate(0, 0) scale(1, 1)' },
  ], { duration: DUR.slow, easing: EASE.move, origin: '0 0' });
}

/** Окно вернулось на стол при переключении столов: короткое проявление без сдвигов */
export function animateDeskIn(el: HTMLElement) {
  play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.fast, easing: EASE.enter });
}

/**
 * Подсветка зоны прилипания и доли: появляется, а не вспыхивает. Годится как
 * ref-функция с постоянным именем — React вызовет её один раз при монтировании.
 */
export function appear(el: HTMLElement | null) {
  if (!el) return;
  play(el, [
    { opacity: 0, transform: 'scale(0.98)' },
    { opacity: 1, transform: 'scale(1)' },
  ], { duration: DUR.fast, easing: EASE.enter });
}
