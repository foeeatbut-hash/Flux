/**
 * Правила «что изменилось» для файла на рабочем столе: что из записи видит человек.
 *
 * Человек видит на столе имя значка, место (общий или личный стол) и, если файл
 * убрали, — что его там больше нет. Номер версии, даты, размер, автор и служебное
 * в перечень не входят: иначе он шумел бы. Папка в записи — номер, а читается
 * она словами: стол знает номера двух своих папок и называет их так же, как меню
 * («общий стол», «ваш стол»); любая другая папка Проводника — «другая папка».
 */
import { changesBetween, type ChangeRule, type FieldChange } from '../../lib/recordChanges';

/** Номера двух папок стола: по ним место файла читается словами */
export interface DeskFolders { sharedFolderId: string | null; personalFolderId: string | null }

export const SHARED_DESK = 'Общий стол';
export const PERSONAL_DESK = 'Ваш стол';
export const OTHER_FOLDER = 'Другая папка Проводника';

/** Папка файла словами; нет папки — пусто (в перечне прочерк) */
export function folderTitle(folderId: unknown, desk: DeskFolders): string {
  const id = String(folderId ?? '').trim();
  if (!id) return '';
  if (id === desk.sharedFolderId) return SHARED_DESK;
  if (id === desk.personalFolderId) return PERSONAL_DESK;
  return OTHER_FOLDER;
}

export function fileRules(desk: DeskFolders): ChangeRule[] {
  return [
    { label: 'Имя', value: (r) => r.name },
    { label: 'Папка', value: (r) => folderTitle(r.folderId, desk) },
    { label: 'В корзине', value: (r) => Boolean(r.deletedAt) },
  ];
}

/** Перечень изменений файла: `shown` — запись, какой её показывал стол, `current` — из отказа. */
export function fileChanges(shown: unknown, current: unknown, desk: DeskFolders): FieldChange[] {
  return changesBetween(shown, current, fileRules(desk));
}
