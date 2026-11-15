/**
 * Отказ записи, как его показывает экран «Оборудование»: текст и перечень «было → стало».
 *
 * Из результата `writeVersioned` и записи, которую экран показывал в МОМЕНТ действия
 * (её берут до перечитывания дерева: после него «показанное» уже стало чужим),
 * собирается `Refusal` — то, что рисует `RefusalView` в форме или в окне.
 * Текст приходит от сервера готовым (словарь `lib/refusalTexts`), здесь он не
 * сочиняется: клиент добавляет только перечень, который сервер не знает.
 *
 * Без React и сети: наборы гоняют это на голых объектах.
 */
import type { FieldChange } from '../../lib/recordChanges';
import { equipmentChanges, type EquipmentRecordKind } from './changeRules';
import { failureText, type WriteResult } from './versionedWrite';

/**
 * - `conflict` — запись изменили; есть перечень (он может быть пустым: показанное не затронуто);
 * - `gone` — запись уже удалили; `open` — открыта у коллеги (перечня нет, текст сервера);
 * - `plain` — любой другой отказ (занятый тег, нет права, сеть): прежняя строка текста.
 */
export type RefusalKind = 'conflict' | 'gone' | 'open' | 'plain';

export interface Refusal {
  kind: RefusalKind;
  message: string;
  changes?: FieldChange[];
}

/** Обычная строка отказа без перечня: проверка формы, отказ сервера по иной причине. */
export const plainRefusal = (message: string): Refusal => ({ kind: 'plain', message });

/** Отказ записи → что показать; принятая запись — `null`. `shown` — запись из дерева, какой её видел экран в момент действия. */
export function refusalOf(result: WriteResult, recordKind: EquipmentRecordKind, shown: unknown, fallback: string): Refusal | null {
  switch (result.kind) {
    case 'ok': return null;
    case 'conflict': return { kind: 'conflict', message: result.message, changes: equipmentChanges(recordKind, shown, result.current) };
    case 'gone': return { kind: 'gone', message: result.message };
    case 'open': return { kind: 'open', message: result.message };
    default: return plainRefusal(failureText(result, fallback));
  }
}

/** Нужно ли после отказа перечитать дерево: запись изменили или исчезла — экран устарел; чужая занятость и сеть его не меняют. */
export const needsReread = (result: WriteResult): boolean => result.kind === 'conflict' || result.kind === 'gone';
