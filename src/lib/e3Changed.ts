/**
 * «Данные E3 изменились»: одно событие окна на любую запись справочника
 * атрибутов, каталога решений и значений позиций. На него подписан раздел
 * «Нет данных» — список пробелов пересчитывается сразу, без перезагрузки.
 */
const EVENT = 'flux:e3-changed';

export const notifyE3Changed = (): void => { try { window.dispatchEvent(new Event(EVENT)); } catch (_) { /* вне окна (тесты) сообщать некому */ } };

/** Подписка; возвращает отписку */
export function onE3Changed(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
