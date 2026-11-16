/**
 * Что «Реестр» держит открытым: сообщает серверу, чтобы коллега не удалил это из-под рук.
 *
 * Открытым считается тег, чья карточка на экране (`editingTag`), и тег, над которым
 * стоит мини-панель (`cardPanel`). Название модели — как в схеме базы.
 */
import { useOpenRecords } from '../useOpenRecords';
import type { OpenRecordRef } from '../../lib/openRecords';

export const TAG_MODEL = 'Tag';

export function useRegistryOpenRecords(held: { cardTagId?: string | null; panelTagId?: string | null }): void {
  const records: OpenRecordRef[] = [];
  if (held.cardTagId) records.push({ model: TAG_MODEL, id: held.cardTagId });
  if (held.panelTagId && held.panelTagId !== held.cardTagId) records.push({ model: TAG_MODEL, id: held.panelTagId });
  useOpenRecords('registry', records);
}
