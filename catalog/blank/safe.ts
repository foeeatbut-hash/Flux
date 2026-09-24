/**
 * Что из шаблона бланка можно подставлять в HTML.
 *
 * Шаблон общий: его правит один сотрудник, а предпросмотр рисуется у всех,
 * кто откроет бланк, — строкой HTML (blankHtml.ts). Картинка и цвета стиля
 * вставляются туда атрибутом, и строка вроде `fff;"><img onerror=…>` вышла бы
 * из атрибута и стала разметкой в чужом окне. Поэтому в HTML попадает только
 * то, что проходит эти правила, а сервер шаблон с нарушением не сохраняет.
 */
import type { BlankTemplate } from './model';

const IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;
const HEX = /^[0-9a-f]{6}$/i;

/** Картинка шаблона: только встроенная PNG/JPEG/GIF/WEBP */
export const safeImage = (src: unknown): string => (typeof src === 'string' && IMAGE.test(src) ? src : '');

/** Цвет без «#»: шесть шестнадцатеричных знаков, иначе — запасной */
export const safeHex = (v: unknown, fallback: string): string => (typeof v === 'string' && HEX.test(v) ? v : fallback);

/** Число в разумных пределах, иначе — запасное */
export const safeNum = (v: unknown, fallback: number, min = 1, max = 400): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

/** Что не так с шаблоном — пустая строка, если всё в порядке */
export function templateProblem(t: Partial<BlankTemplate> | null | undefined): string {
  if (!t) return 'Шаблон пуст';
  for (const [id, src] of Object.entries(t.assets || {})) {
    if (!safeImage(src)) return `Картинка «${id}» не встроенная PNG/JPEG/GIF/WEBP`;
  }
  const st: any = t.style || {};
  for (const key of ['headFill', 'labelFill']) {
    if (st[key] !== undefined && !HEX.test(String(st[key]))) return `Цвет «${key}» — не шесть шестнадцатеричных знаков`;
  }
  for (const key of ['size', 'titleSize']) {
    if (st[key] !== undefined && safeNum(st[key], -1) < 0) return `Размер шрифта «${key}» вне пределов`;
  }
  if (st.font !== undefined && !/^[\p{L}\d .,'-]{1,60}$/u.test(String(st.font))) return 'Имя шрифта содержит недопустимые знаки';
  return '';
}
