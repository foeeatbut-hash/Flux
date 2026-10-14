import { ICON_SIZE } from '../../lib/metrics';

/**
 * Размер значка по явному `size` или по классу Tailwind: w-3.5 → 14, w-4 → 16,
 * w-5 → 20. Значки разделов раньше были значками lucide, которым размер
 * задавали классом; такие места остались, и значок раздела обязан понимать тот
 * же класс. Нет ни того ни другого — размер строки списка.
 */
export function resolveIconSize(size?: number, className = ''): number {
  if (typeof size === 'number') return size;
  const m = /(?:^|\s)w-(\d+(?:\.\d+)?)(?=\s|$)/.exec(className);
  if (m) return Math.round(Number(m[1]) * 4);
  const px = /(?:^|\s)w-\[(\d+)px\](?=\s|$)/.exec(className);
  if (px) return Number(px[1]);
  return ICON_SIZE.row;
}
