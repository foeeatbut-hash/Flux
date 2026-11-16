/**
 * Правила «что изменилось» для проекта: какие поля карточки видит человек.
 *
 * Подписи — те, что стоят над полями карточки (`ProjectFields`), чтобы строка
 * перечня читалась как поле, которое человек только что правил. Номер версии,
 * даты и служебные поля сюда не входят: иначе перечень шумел бы.
 */
import { changesBetween, type ChangeRule, type FieldChange } from '../../lib/recordChanges';

/** Состояние проекта словами из выпадающего списка карточки; незнакомое значение показывается как есть */
export const PROJECT_STATUS_TITLES: Record<string, string> = { ACTIVE: 'В работе', ARCHIVED: 'Архив' };

export const statusTitle = (status: unknown): string => {
  const key = String(status ?? '').trim();
  return PROJECT_STATUS_TITLES[key] ?? key;
};

export const PROJECT_RULES: ChangeRule[] = [
  { label: 'Наименование', value: (r) => r.name },
  { label: 'Код проекта', value: (r) => r.code },
  { label: 'Заказчик', value: (r) => r.customer },
  { label: 'Подрядчик', value: (r) => r.contractor },
  { label: 'Краткое описание', value: (r) => r.description },
  { label: 'Подробное описание', value: (r) => r.info },
  { label: 'Статус проекта', value: (r) => statusTitle(r.status) },
];

/** Перечень изменений проекта: `shown` — запись, какой её показывал экран, `current` — из отказа. */
export function projectChanges(shown: unknown, current: unknown): FieldChange[] {
  return changesBetween(shown, current, PROJECT_RULES);
}
