/**
 * Запись файла со стола: отказ сервера → то, что покажет стол.
 *
 * `dataService.renameNode`, `trashNode` и `moveDesktopItem` шлют версию файла, которую стол
 * показывал, а отказ сервера отдают как `WriteRefusal` с кодом и `current`. Разбор по коду —
 * общий (`components/projects/projectWrite`, `components/equipment/versionedWrite`), тексты —
 * только от сервера (`lib/refusalTexts`). Здесь добавляется то, что своё у стола: перечень
 * «имя, папка, в корзине» (`changeRules`) из показанной записи и `current`.
 *
 * Без React и без сети: наборы гоняют это на голых объектах.
 */
import { plainRefusal, type Refusal } from '../equipment/conflictView';
import { failureText, type WriteResult } from '../equipment/versionedWrite';
import { runWrite } from '../projects/projectWrite';
import { fileChanges, type DeskFolders } from './changeRules';

export { runWrite };

/** Исход записи → что показать; принятая запись — `null`. `shown` — файл, каким его видел стол в момент действия (взять ДО перечитывания). */
export function fileRefusalOf(result: WriteResult, shown: unknown, desk: DeskFolders, fallback: string): Refusal | null {
  switch (result.kind) {
    case 'ok': return null;
    case 'conflict': return { kind: 'conflict', message: result.message, changes: fileChanges(shown, result.current, desk), changedBy: result.changedBy };
    case 'gone': return { kind: 'gone', message: result.message };
    case 'open': return { kind: 'open', message: result.message };
    default: return plainRefusal(failureText(result, fallback));
  }
}

/**
 * Что делать с полем имени после отказа. Изменили — поле остаётся с набранным: человек решает,
 * повторить ли (версия при повторе уже свежая, стол перечитан). Файла нет — переименовывать
 * нечего, поле закрывается. Прочий отказ (сеть, нет права) — поле остаётся: набранное не теряется.
 */
export const keepsTypedName = (result: WriteResult): boolean => result.kind !== 'ok' && result.kind !== 'gone';
