/**
 * Плоская картинка: воркером, а если его нет — на месте.
 *
 * Запасной путь здесь обязателен и не является перестраховкой: `OffscreenCanvas`
 * есть не везде, сборка воркера может не доехать до собранной программы, а
 * воркер может упасть на большом снимке. Ни один из этих случаев не должен
 * означать «снимок не приложился» — он должен означать «немного подождите».
 */

import { flattenTo, type FlatPlan } from './flatten';

export interface Flat {
  blob: Blob;
  thumb: Blob | null;
  width: number;
  height: number;
  /** Посчитано на месте — это видно в состоянии и в замерах. */
  onMainThread: boolean;
}

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const pending = new Map<number, { resolve: (f: Flat) => void; reject: (e: any) => void }>();

function getWorker(): Worker | null {
  if (broken) return null;
  if (worker) return worker;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') { broken = true; return null; }
  try {
    worker = new Worker(new URL('../workers/feedbackImage.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<any>) => {
      const { id, type, blob, thumb, width, height, message } = event.data || {};
      const waiting = pending.get(id);
      if (!waiting) return;
      pending.delete(id);
      if (type === 'result') waiting.resolve({ blob, thumb: thumb || null, width, height, onMainThread: false });
      else waiting.reject(new Error(message || 'Не удалось собрать картинку'));
    };
    worker.onerror = () => {
      broken = true;
      for (const [, waiting] of pending) waiting.reject(new Error('Воркер недоступен'));
      pending.clear();
      try { worker?.terminate(); } catch (_) { /* уже мёртв */ }
      worker = null;
    };
    return worker;
  } catch (_) { broken = true; return null; }
}

/** Тот же расчёт на главном потоке. Медленнее, но всегда доступен. */
async function onMainThread(source: CanvasImageSource, plan: FlatPlan, thumbWidth: number): Promise<Flat> {
  const make = (width: number, height: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Холст недоступен');
    return { canvas, ctx };
  };
  const flat: HTMLCanvasElement = flattenTo(make, source as any, plan);
  const blob = await new Promise<Blob | null>((resolve) => flat.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Картинка не собралась');

  let thumb: Blob | null = null;
  if (thumbWidth > 0 && flat.width > thumbWidth) {
    const small = document.createElement('canvas');
    small.width = thumbWidth;
    small.height = Math.max(1, Math.round(flat.height * (thumbWidth / flat.width)));
    const ctx = small.getContext('2d');
    if (ctx) {
      ctx.drawImage(flat, 0, 0, small.width, small.height);
      thumb = await new Promise<Blob | null>((resolve) => small.toBlob(resolve, 'image/png'));
    }
  }
  return { blob, thumb, width: flat.width, height: flat.height, onMainThread: true };
}

/**
 * Собрать отправляемую картинку из исходника и разметки.
 *
 * Исходник наружу не отдаётся ни в каком виде: наружу выходит только то, что
 * нарисовано здесь.
 */
export async function flattenImage(
  source: Blob, plan: FlatPlan, thumbWidth = 320,
): Promise<Flat> {
  const useWorker = getWorker();
  if (useWorker && typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(source);
      const id = ++seq;
      return await new Promise<Flat>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          useWorker.postMessage({ id, bitmap, plan, thumbWidth }, [bitmap as any]);
        } catch (error) { pending.delete(id); reject(error); }
      });
    } catch (_) { /* считаем сами — ниже */ }
  }
  const bitmap = typeof createImageBitmap === 'function'
    ? await createImageBitmap(source)
    : await imageFromBlob(source);
  return onMainThread(bitmap as any, plan, thumbWidth);
}

/** Совсем старый путь: картинка через элемент `img`. */
function imageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Картинка не читается')); };
    image.src = url;
  });
}
