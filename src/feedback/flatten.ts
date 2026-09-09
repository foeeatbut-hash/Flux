/**
 * Снимок с разметкой превращается в новую плоскую картинку.
 *
 * Это единственное место, где решается главный вопрос всей разметки: что
 * увидит человек, открывший вложение. Ответ должен быть «ровно то, что автор
 * видел в предпросмотре», поэтому:
 *
 * — на сервер уходит НОВЫЙ PNG, нарисованный с нуля. Исходник не отправляется
 *   никогда: вместе с ним уехали бы и пиксели под маской, и EXIF, и всё, что
 *   было за пределами обрезки;
 * — маска заливается непрозрачным цветом. Размытие и полупрозрачный маркер
 *   скрытием не считаются: и то и другое обратимо, а человек уверен, что
 *   закрыл;
 * — миниатюра рисуется из этой же плоской картинки, а не из исходника, — иначе
 *   в списке вложений маска просто не появилась бы.
 */

import type { Crop, Shape } from './shapes';
import { toPixels } from './shapes';

/** Чем закрашивается маска. Непрозрачный, тёмный, ни на что не похожий. */
export const MASK_COLOR = '#0f172a';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const px = (share: number, size: number) => share * size;

/** Стрелка: линия плюс две черты на конце — без заливки, чтобы не расползалась. */
function arrow(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, width: number): void {
  const head = Math.max(8, width * 4);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
  ctx.stroke();
}

/**
 * Нарисовать разметку поверх уже обрезанного снимка.
 *
 * Координаты фигур — доли от снимка ПОСЛЕ обрезки: пересчёт делает `reframe`,
 * и делает его один раз, когда обрезку подтверждают.
 */
export function drawShapes(ctx: Ctx, shapes: Shape[], width: number, height: number): void {
  const line = Math.max(2, Math.round(Math.min(width, height) / 300));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const shape of shapes) {
    const x1 = px(shape.x, width);
    const y1 = px(shape.y, height);
    const x2 = px(shape.x2, width);
    const y2 = px(shape.y2, height);
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);

    ctx.strokeStyle = shape.color;
    ctx.fillStyle = shape.color;
    ctx.lineWidth = line;

    if (shape.kind === 'mask') {
      // Непрозрачная заливка, и никаких режимов смешивания: под ней не должно
      // остаться ничего, что можно вытянуть обратно
      ctx.globalAlpha = 1;
      ctx.fillStyle = MASK_COLOR;
      ctx.fillRect(Math.round(left), Math.round(top), Math.round(w), Math.round(h));
      continue;
    }
    if (shape.kind === 'rect') { ctx.strokeRect(left, top, w, h); continue; }
    if (shape.kind === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(left + w / 2, top + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      continue;
    }
    if (shape.kind === 'line') {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      continue;
    }
    if (shape.kind === 'arrow') { arrow(ctx, x1, y1, x2, y2, line); continue; }
    if (shape.kind === 'pencil') {
      const points = shape.points || [];
      if (points.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(px(points[0].x, width), px(points[0].y, height));
      for (const point of points.slice(1)) ctx.lineTo(px(point.x, width), px(point.y, height));
      ctx.stroke();
      continue;
    }
    if (shape.kind === 'text') {
      const size = Math.max(14, Math.round(Math.min(width, height) / 40));
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      // Подложка под текст: на пёстром снимке иначе не читается ни один цвет
      const text = String(shape.text || '');
      const measured = ctx.measureText(text).width;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x1 - 4, y1 - 3, measured + 8, size + 6);
      ctx.globalAlpha = 1;
      ctx.fillStyle = shape.color;
      ctx.fillText(text, x1, y1);
      continue;
    }
    if (shape.kind === 'mark') {
      const radius = Math.max(12, Math.round(Math.min(width, height) / 45));
      ctx.beginPath();
      ctx.arc(x1, y1, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${Math.round(radius * 1.2)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(shape.number || 1), x1, y1 + 1);
      ctx.textAlign = 'start';
    }
  }
  ctx.globalAlpha = 1;
}

export interface FlatPlan {
  crop: Crop;
  shapes: Shape[];
  /** Больше этого числа точек не отдаём: предел вложения считается по нему. */
  maxPixels?: number;
}

/** Во сколько раз уменьшить, чтобы уложиться в предел по числу точек. */
export function shrinkTo(width: number, height: number, maxPixels: number): number {
  if (!maxPixels || width * height <= maxPixels) return 1;
  return Math.sqrt(maxPixels / (width * height));
}

type Source = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

const sizeOf = (source: any): { width: number; height: number } => ({
  width: source.naturalWidth || source.width, height: source.naturalHeight || source.height,
});

/**
 * Собрать плоскую картинку.
 *
 * Возвращает холст, а не байты: снимок и миниатюра рисуются одинаково, а
 * кодирует их вызывающий — в браузере и в воркере это разные вызовы.
 */
export function flattenTo(
  make: (w: number, h: number) => { canvas: any; ctx: Ctx },
  source: Source, plan: FlatPlan,
): any {
  const full = sizeOf(source);
  const crop = toPixels(plan.crop, full.width, full.height);
  const cutW = Math.max(1, crop.width || full.width);
  const cutH = Math.max(1, crop.height || full.height);
  const shrink = shrinkTo(cutW, cutH, plan.maxPixels || 0);
  const width = Math.max(1, Math.round(cutW * shrink));
  const height = Math.max(1, Math.round(cutH * shrink));

  const { canvas, ctx } = make(width, height);
  // Пиксели за обрезкой не переносятся вовсе — не прячутся, а не рисуются
  ctx.drawImage(source as any, crop.x, crop.y, cutW, cutH, 0, 0, width, height);
  drawShapes(ctx, plan.shapes, width, height);
  return canvas;
}
