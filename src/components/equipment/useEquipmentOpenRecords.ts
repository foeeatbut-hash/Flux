/**
 * Что экран «Оборудование» держит открытым: сообщает серверу, чтобы коллега не удалил это из-под рук.
 *
 * Открытой считается запись, чья карточка на экране (выбранная позиция или
 * установка), и запись, над которой открыто окно правки (привязка тега, добавление
 * позиции внутрь). Названия моделей — как в схеме базы: по ним сервер находит
 * запись и всё, что уйдёт с ней при удалении.
 */
import { useOpenRecords } from '../useOpenRecords';
import type { OpenRecordRef } from '../../lib/openRecords';

export const OPEN_MODELS = { component: 'ComponentElement', system: 'EquipmentSystem' } as const;

export function useEquipmentOpenRecords(held: {
  /** Выбранная позиция */ componentId?: string | null;
  /** Выбранная установка */ systemId?: string | null;
  /** Позиция, к которой привязывают тег */ tagPickerComponentId?: string | null;
  /** Позиция, внутрь которой добавляют (блок отдельно не держится: удалить его можно только вместе с установкой) */ addToComponentId?: string | null;
}): void {
  const records: OpenRecordRef[] = [];
  const add = (model: string, id?: string | null) => { if (id) records.push({ model, id }); };
  add(OPEN_MODELS.component, held.componentId);
  add(OPEN_MODELS.system, held.systemId);
  add(OPEN_MODELS.component, held.tagPickerComponentId);
  add(OPEN_MODELS.component, held.addToComponentId);
  useOpenRecords('equipment', records);
}
