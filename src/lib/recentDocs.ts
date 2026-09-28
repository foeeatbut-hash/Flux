/**
 * Недавние вещи: документы, которые человек открывал, а не разделы.
 *
 * «Недавние разделы» отвечают на вопрос, которого никто не задаёт: человек и
 * так помнит, что работает в Конструкторе. Он не помнит другого — как
 * называлась записка, которую правил в пятницу, и в какой она папке. Поэтому
 * список ведётся по вещам: имя, вид, адрес, когда открывали.
 *
 * Один список на все четыре редактора Flux Office (таблица, документ,
 * заметка, просмотр) — иначе «недавние» у каждого свои, и человек ищет
 * документ там, где его нет.
 *
 * Хранится локально, у каждого своё: это память рук, а не общие данные
 * проекта. Наружу ничего не уходит.
 */

export type DocKind = 'sheet' | 'text' | 'note' | 'pdf';

export interface RecentDoc {
  /** Адрес открытия — он же различает записи: два документа, один раздел */
  href: string;
  title: string;
  kind: DocKind;
  /** Когда открывали в последний раз, мс */
  at: number;
  /** Проект, если вещь проектная: чужие в списке ни к чему */
  projectId?: string;
}

/** Столько помещается в окно и в Пуск, не заставляя прокручивать */
export const RECENT_MAX = 12;

export const KIND_NAMES: Record<DocKind, string> = {
  sheet: 'Таблица',
  text: 'Документ',
  note: 'Заметка',
  pdf: 'PDF',
};

/** Как называется программа, которая это открывает */
export const kindName = (kind: DocKind): string => KIND_NAMES[kind] || 'Документ';

/**
 * Добавить открытое.
 *
 * Одна и та же вещь не двоится, а поднимается наверх с новым временем: список
 * из десяти строк «Смета.xlsx» бесполезен. Вещь без имени не запоминается —
 * строка «Без названия» в списке недавних не помогает никому.
 */
export function addRecent(list: RecentDoc[], doc: RecentDoc): RecentDoc[] {
  const title = String(doc.title || '').trim();
  const href = String(doc.href || '').trim();
  if (!title || !href) return list;
  const clean = { ...doc, title, href };
  return [clean, ...list.filter((d) => d.href !== href)].slice(0, RECENT_MAX);
}

/** Забыть вещь: её удалили или человек убрал её из списка сам */
export function forgetRecent(list: RecentDoc[], href: string): RecentDoc[] {
  return list.filter((d) => d.href !== href);
}

/**
 * Что показать: вещи этого проекта и общие.
 *
 * Чужой проект в списке — та же беда, что выдача оборудования всех проектов
 * сразу: человек открывает документ и не понимает, почему в нём чужие данные.
 */
export function visibleRecentDocs(list: RecentDoc[], projectId: string | null): RecentDoc[] {
  return list.filter((d) => !d.projectId || !projectId || d.projectId === projectId);
}

/** «сегодня», «вчера», «12 марта» — время в списке важнее точности до минуты */
export function whenLabel(at: number, now: number = Date.now()): string {
  const day = 24 * 3600 * 1000;
  const startOf = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const diff = Math.round((startOf(now) - startOf(at)) / day);
  if (diff <= 0) return 'сегодня';
  if (diff === 1) return 'вчера';
  if (diff < 7) return `${diff} дн. назад`;
  return new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
