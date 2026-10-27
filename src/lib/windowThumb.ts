/**
 * Уменьшенные снимки окон для карточек над кнопками панели задач.
 *
 * В установленной программе снимок берёт основной процесс (`capturePage` по
 * области окна, electron/windowThumb.ts); в браузере снимать нечем, и карточка
 * честно рисует значок программы. Этот модуль решает, КОГДА снимать: снимок
 * дорог, а наведение мыши частое.
 *
 * Правила (проверяются scripts/test-window-thumb.ts):
 *  - свёрнутое окно не снимается — его нет на экране; показывается последний
 *    снимок, сделанный перед сворачиванием;
 *  - окно, закрытое другим окном больше чем на четверть, не снимается: на
 *    картинке оказалось бы чужое содержимое, а прежний снимок честнее;
 *  - пока карточка уже показана, снимать нельзя: она сама стоит над столом и
 *    попала бы в кадр;
 *  - свежий снимок (моложе двух секунд) не повторяется.
 */

export interface Thumb { url: string; w: number; h: number; at: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** Сколько живёт снимок, прежде чем его стоит переснять */
export const THUMB_TTL = 2000;
/** Какая доля окна может быть закрыта другими, чтобы снимок ещё считался честным */
export const MAX_COVER = 0.25;
/** Ширина картинки по IPC: карточка 180 точек, запас на плотные экраны */
export const THUMB_W = 360;

const cache = new Map<string, Thumb>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const bump = () => { version++; listeners.forEach((fn) => fn()); };

export const subscribeThumbs = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const thumbsVersion = (): number => version;
export const cachedThumb = (id: string): Thumb | undefined => cache.get(id);
export function forgetThumb(id: string): void { if (cache.delete(id)) bump(); }

const bridge = (): any => (typeof window === 'undefined' ? undefined : (window as any).electron?.ipcRenderer);
/** Снимать есть чем только в установленной программе */
export const canThumb = (): boolean => typeof bridge()?.invoke === 'function';

/** Доля окна, закрытая окнами выше него (0..1). Перекрытия между верхними считаются дважды — для порога это запас. */
export function coverage(target: Rect, above: Rect[]): number {
  const area = target.w * target.h;
  if (area <= 0) return 0;
  let sum = 0;
  for (const o of above) {
    const w = Math.min(target.x + target.w, o.x + o.w) - Math.max(target.x, o.x);
    const h = Math.min(target.y + target.h, o.y + o.h) - Math.max(target.y, o.y);
    if (w > 0 && h > 0) sum += w * h;
  }
  return Math.min(1, sum / area);
}

export interface CaptureAsk {
  minimized: boolean;
  /** Доля закрытого другими окнами */
  covered: number;
  /** Карточка над столом уже показана */
  panelShown: boolean;
  cached?: Thumb;
  now?: number;
  /** Перед сворачиванием снимают обязательно, не глядя на свежесть */
  force?: boolean;
}

export function shouldCapture(a: CaptureAsk): boolean {
  if (a.minimized) return false;
  if (a.covered > MAX_COVER) return false;
  if (a.force) return true;
  if (a.panelShown) return false;
  if (a.cached && (a.now ?? Date.now()) - a.cached.at < THUMB_TTL) return false;
  return true;
}

/** Снять область окна. Ошибка не бросается: нет снимка — карточка нарисует значок. */
export async function captureThumb(id: string, rect: Rect): Promise<Thumb | undefined> {
  const invoke = bridge()?.invoke;
  if (!invoke || inflight.has(id)) return cache.get(id);
  inflight.add(id);
  try {
    const answer = await invoke('taskbar:window-thumb', {
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.w), height: Math.round(rect.h), maxWidth: THUMB_W,
    });
    if (!answer?.ok || typeof answer.dataUrl !== 'string') return cache.get(id);
    const thumb: Thumb = { url: answer.dataUrl, w: Number(answer.width) || 0, h: Number(answer.height) || 0, at: Date.now() };
    cache.set(id, thumb);
    bump();
    return thumb;
  } catch (_) {
    return cache.get(id);
  } finally {
    inflight.delete(id);
  }
}
