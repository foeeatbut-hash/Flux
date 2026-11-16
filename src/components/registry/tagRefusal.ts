/**
 * Отказ записи тега, как его видит человек: текст сервера и перечень «было → стало».
 *
 * Ответ разбирается ровно по полю `code` (словарь `lib/refusalTexts`, общий с
 * сервером): `VERSION_CONFLICT` — тег изменили, `RECORD_GONE` — тега уже нет,
 * `RECORD_OPEN` — тег открыт у коллеги. У 409 в маршрутах тегов есть и другая
 * причина — занятый код; её узнают по `duplicate`, перечитывать при ней нечего.
 * Текст приходит от сервера готовым и здесь не сочиняется; клиент добавляет
 * только перечень, который сервер не знает: он сравнивает то, что показывал
 * экран, с записью из отказа.
 *
 * Без React и без сети: наборы гоняют это на голых объектах.
 */
import type { ConflictGroup } from '../ui/ConflictNotice';
import type { FieldChange } from '../../lib/recordChanges';
import { conflictOf, goneOf, openOf, type OpenHolder, type OpenRecordInfo } from '../equipment/versionedWrite';
import { tagChanges, type TagNames } from './changeRules';

export type TagRefusalKind = 'conflict' | 'gone' | 'open' | 'plain';

export interface TagRefusal {
  kind: TagRefusalKind;
  message: string;
  /** Перечень по одной записи (может быть пустым: показанное не затронуто) */
  changes?: FieldChange[];
  /** Перечень по записям — для массовых действий */
  groups?: ConflictGroup[];
  holders?: OpenHolder[];
  record?: OpenRecordInfo | null;
}

export type TagOutcome =
  | { kind: 'ok'; data: any }
  | { kind: 'conflict'; message: string; current: any; data: any }
  | { kind: 'gone'; message: string; data: any }
  | { kind: 'open'; message: string; holders: OpenHolder[]; record: OpenRecordInfo | null; data: any }
  | { kind: 'refused'; status: number; message: string; data: any }
  | { kind: 'offline'; message: string };

/** Ответ сервера → исход записи. Не бросает: сеть и разбор приходят результатом. */
export async function outcomeOf(send: () => Promise<Response>): Promise<TagOutcome> {
  let res: Response;
  try { res = await send(); } catch { return { kind: 'offline', message: 'Сервер не ответил' }; }
  const data = await res.json().catch(() => ({}));
  const conflict = conflictOf(res.status, data);
  if (conflict) return { kind: 'conflict', ...conflict, data };
  const gone = goneOf(res.status, data);
  if (gone) return { kind: 'gone', ...gone, data };
  const open = openOf(res.status, data);
  if (open) return { kind: 'open', ...open, data };
  if (!res.ok) return { kind: 'refused', status: res.status, message: String(data?.error || ''), data };
  return { kind: 'ok', data };
}

/** Целая версия записи в адресе удаления (`?expectedVersion=`): нет версии — адрес прежний. */
export function deleteUrl(id: string, version: unknown): string {
  const n = typeof version === 'string' && version.trim() !== '' ? Number(version) : version;
  const v = typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : undefined;
  return `/api/tags/${encodeURIComponent(id)}${v === undefined ? '' : `?expectedVersion=${v}`}`;
}

/** Отказ → что показать; принятая запись — `null`. `shown` — тег, какой его видел экран в момент действия (до подмены). */
export function refusalOf(outcome: TagOutcome, shown: unknown, names: TagNames, fallback: string): TagRefusal | null {
  switch (outcome.kind) {
    case 'ok': return null;
    case 'conflict': return { kind: 'conflict', message: outcome.message, changes: tagChanges(shown, outcome.current, names) };
    case 'gone': return { kind: 'gone', message: outcome.message };
    case 'open': return { kind: 'open', message: outcome.message, holders: outcome.holders, record: outcome.record };
    case 'offline': return { kind: 'plain', message: outcome.message };
    default: return { kind: 'plain', message: outcome.message || fallback };
  }
}

/** Нужно ли после отказа перечитать теги: тег изменили или удалили — экран устарел. */
export const needsReread = (o: TagOutcome): boolean => o.kind === 'conflict' || o.kind === 'gone';

/**
 * Отказ массового действия «всё или ничего»: в теле — `changed: [{ id, current }]` и `gone: [id]`.
 * `shownById` — теги, какими их видел экран; по ним собирается перечень по записям.
 */
export function bulkRefusalOf(data: any, shownById: Map<string, any>, names: TagNames): TagRefusal {
  const codeOf = (id: string) => String(shownById.get(id)?.identifier || id);
  const groups: ConflictGroup[] = (Array.isArray(data?.changed) ? data.changed : [])
    .filter((c: any) => c && typeof c === 'object')
    .map((c: any) => ({ title: codeOf(String(c.id ?? c.current?.id ?? '')), changes: tagChanges(shownById.get(String(c.id ?? c.current?.id ?? '')), c.current, names) }));
  for (const id of Array.isArray(data?.gone) ? data.gone : []) {
    groups.push({ title: codeOf(String(id)), changes: [{ label: 'Тег', was: 'есть', now: 'удалён' }] });
  }
  return { kind: 'conflict', message: String(data?.error || 'Теги изменили, пока вы смотрели. Ничего не записано.'), groups };
}
