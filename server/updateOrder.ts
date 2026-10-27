/** Порядок выпусков обновления: общий для /latest, ревизии и списка назначений. */
import { compareVersions } from '../electron/updateSignature.js';

/**
 * Выпуски от новых к старым ПО НОМЕРУ версии, а не по дате публикации:
 * хотфикс старой ветки, выложенный позже свежего выпуска, иначе становился
 * «последним», и сотрудники на новой ветке получали откат. При равных версиях
 * (в базе они уникальны, но порядок должен быть однозначным) — по дате.
 */
export function newestFirst<T extends { version: string; createdAt?: Date | string | number }>(list: T[]): T[] {
  const at = (r: T) => (r.createdAt ? new Date(r.createdAt).getTime() : 0);
  return [...list].sort((a, b) => compareVersions(b.version, a.version) || at(b) - at(a));
}
