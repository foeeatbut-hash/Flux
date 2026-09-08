/**
 * Что программа знает о документе Flux Office, не открывая его.
 *
 * Отдельно от экрана, потому что этим пользуются двое: библиотека, которая
 * рисует список, и редактор, который показывает «изменён такого-то». Пока обе
 * записи жили внутри экрана, вынести библиотеку было нельзя, а экран рос.
 */

export interface DocMeta {
  id: string;
  name: string;
  /** DOC — книга, TEXT — текст, NOTE — заметка, TEMPLATE и TITLE — образцы */
  kind: string;
  scope: string;
  ownerId?: string | null;
  /** Названный документ виден в Проводнике; безымянный — черновик */
  named: boolean;
  createdById?: string | null;
  updatedById?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Дата в списке: короткая и с временем.
 *
 * Год не пишем намеренно — в списке документов проекта он одинаков у всех и
 * съедает место, которого не хватает названию.
 */
export function fmtDate(s: string): string {
  try {
    return new Date(s).toLocaleString('ru-RU', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch (_) { return s; }
}
