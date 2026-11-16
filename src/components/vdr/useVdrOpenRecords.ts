/**
 * Что ВДР держит открытым: сообщает серверу, чтобы коллега не удалил это из-под рук.
 *
 * Открытой считается строка, чья карточка на экране, и реестр, чьи реквизиты правят.
 * Названия моделей — как в схеме базы: по ним сервер находит запись и всё, что уйдёт
 * с ней при удалении (у реестра — его строки). Источников два: карточка и реквизиты
 * живут независимо, и закрытие одной не должно освобождать другую.
 */
import { useOpenRecords } from '../useOpenRecords';

export const VDR_MODELS = { item: 'DocRegisterItem', register: 'DocRegister' } as const;

/** Карточка строки: открыта, пока компонент на экране (новая строка — без записи в базе, держать нечего). */
export function useVdrItemOpen(itemId: string | null | undefined): void {
  useOpenRecords('vdr-item', itemId ? [{ model: VDR_MODELS.item, id: itemId }] : []);
}

/** Реквизиты реестра: открыты, пока форма на экране. */
export function useVdrRegisterOpen(registerId: string | null | undefined): void {
  useOpenRecords('vdr-register', registerId ? [{ model: VDR_MODELS.register, id: registerId }] : []);
}
