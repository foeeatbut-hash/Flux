/**
 * «Данные E3 изменились»: одно событие окна на любую запись справочника
 * атрибутов, каталога решений и значений позиций. На него подписан раздел
 * «Нет данных» — список пробелов пересчитывается сразу, без перезагрузки.
 */
const EVENT = 'flux:e3-changed';

export interface E3ChangedDetail { entity?: 'attributes' | 'solutions' | 'profile' | 'layout'; projectId?: string }

export const notifyE3Changed = (detail?: E3ChangedDetail): void => {
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail })); } catch (_) { /* вне окна (тесты) сообщать некому */ }
};

/** Подписка; возвращает отписку */
export function onE3Changed(fn: (detail?: E3ChangedDetail) => void): () => void {
  const listener = (event: Event) => fn((event as CustomEvent<E3ChangedDetail | undefined>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
