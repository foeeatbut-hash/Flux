/**
 * Сборка плоской картинки в отдельном потоке.
 *
 * Снимок экрана на двух мониторах — это восемь-десять мегапикселей. Рисование
 * и кодирование PNG такого размера занимает сотни миллисекунд, и на главном
 * потоке это застывшее окно ровно в тот момент, когда человек нажал «Готово».
 *
 * Правило то же, что у распознавания: воркер — ускорение, а не условие работы.
 * Не собрался, не поддержан браузером, упал — вызывающий считает сам
 * (`imageClient.ts`), и человек этого не замечает.
 */

import { flattenTo, type FlatPlan } from '../feedback/flatten';

const make = (width: number, height: number) => {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Холст недоступен');
  return { canvas, ctx: ctx as unknown as OffscreenCanvasRenderingContext2D };
};

self.onmessage = async (event: MessageEvent<any>) => {
  const { id, bitmap, plan, thumbWidth } = event.data || {};
  try {
    const flat: OffscreenCanvas = flattenTo(make, bitmap, plan as FlatPlan);
    const blob = await flat.convertToBlob({ type: 'image/png' });

    // Миниатюра — из уже плоской картинки, а не из исходника: иначе в списке
    // вложений маска не появилась бы
    let thumb: Blob | null = null;
    if (thumbWidth > 0 && flat.width > thumbWidth) {
      const scale = thumbWidth / flat.width;
      const small = new OffscreenCanvas(thumbWidth, Math.max(1, Math.round(flat.height * scale)));
      const ctx = small.getContext('2d');
      if (ctx) {
        (ctx as any).drawImage(flat, 0, 0, small.width, small.height);
        thumb = await small.convertToBlob({ type: 'image/png' });
      }
    }
    (self as any).postMessage({ id, type: 'result', blob, thumb, width: flat.width, height: flat.height });
  } catch (error: any) {
    (self as any).postMessage({ id, type: 'error', message: String(error?.message || error) });
  } finally {
    try { bitmap?.close?.(); } catch (_) { /* уже закрыт */ }
  }
};
