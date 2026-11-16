/**
 * Отказ действия по предпросмотру в ВДР: «строки изменили, пока вы смотрели».
 *
 * Отмена переноса кодов в связи и ввоз файла отвечают 409 `VERSION_CONFLICT` с перечнем
 * `changed: [{ id, current }]` и `gone: [id]` (server/planGuard.ts): не записано ничего.
 * Здесь — перечень «было → стало» по строкам (правила полей строки — `changeRules.ts`, показ —
 * общий `ConflictNotice` через `VdrRefusalView`) и версии для повторного подтверждения.
 * Без React и без сети: наборы гоняют это на голых объектах.
 */
import type { ConflictGroup } from '../ui/ConflictNotice';
import { nothingChangedText } from '../../lib/refusalTexts';
import { itemChanges, type VdrNames } from './changeRules';
import { rowTitle, type VdrRefusal } from './vdrWrite';

/** Строки по идентификатору — то, что человек видел. */
export const shownById = (rows: readonly any[]): Map<string, any> => new Map(rows.map((r) => [String(r.id), r]));

/** Перечень по строкам: изменённая — «было → стало», удалённая — «есть → удалена». */
export function itemPlanRefusal(data: any, shown: Map<string, any>, names: VdrNames = {}): VdrRefusal {
  const groups: ConflictGroup[] = [];
  const notes: Array<{ title: string; text: string }> = [];
  for (const c of Array.isArray(data?.changed) ? data.changed : []) {
    if (!c || typeof c !== 'object') continue;
    const id = String(c.id ?? c.current?.id ?? '');
    const before = shown.get(id);
    const title = rowTitle(before || c.current);
    const changes = before ? itemChanges(before, c.current, names) : [];
    if (changes.length) groups.push({ title, changes });
    else notes.push({ title, text: before ? nothingChangedText() : 'строка появилась после предпросмотра' });
  }
  for (const id of Array.isArray(data?.gone) ? data.gone : []) {
    groups.push({ title: rowTitle(shown.get(String(id)) || { contractorNo: String(id) }), changes: [{ label: 'Строка', was: 'есть', now: 'удалена' }] });
  }
  return {
    kind: 'conflict',
    message: String(data?.error || 'Строки изменили, пока вы смотрели. Ничего не записано.'),
    groups, ...(notes.length ? { notes } : {}),
  };
}

/** Версии для повторного подтверждения: человек прочёл перечень, и действие опирается на то, что есть сейчас. */
export function reseenItems(seen: Record<string, number>, data: any): Record<string, number> {
  const next = { ...seen };
  for (const id of Array.isArray(data?.gone) ? data.gone : []) delete next[String(id)];
  for (const c of Array.isArray(data?.changed) ? data.changed : []) {
    const v = Number(c?.current?.version);
    if (c && Number.isInteger(v) && v >= 1) next[String(c.id ?? c.current?.id)] = v;
  }
  return next;
}
