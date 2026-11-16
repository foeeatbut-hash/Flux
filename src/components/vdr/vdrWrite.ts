/**
 * Запись ВДР с экрана: версия, которую экран видел, и отказ по ней.
 *
 * Строку и реестр сверяет сервер по `expectedUpdatedAt` (то, что экран читал), выпуск
 * ревизии — по `expectedRevision`. Отказ узнаётся по полю `code` ответа (словарь
 * `lib/refusalTexts`, общий с сервером), а не по тексту или одному статусу;
 * `current` — голая запись, как её отдаёт чтение. Текст сервера приходит готовым
 * и здесь не сочиняется: экран добавляет только перечень «было → стало», который
 * сервер не знает, потому что не знает, что показывала карточка.
 *
 * Правило набранного: отказ ничего не сбрасывает. Поля, которые человек менял,
 * остаются как набраны; поля, которых он не касался, берутся из `current` (иначе
 * повторное «Сохранить» вернуло бы в базу старое значение чужой правки — например
 * ревизию, которую коллега выпустил). Версия для повтора берётся из `current`:
 * человек прочитал перечень и повторяет осознанно.
 *
 * Модуль без React: наборы гоняют его на голых объектах и подставном `fetch`.
 */
import { conflictOf, goneOf, openOf, type WriteResult } from '../equipment/versionedWrite';
import type { FieldChange } from '../../lib/recordChanges';
import type { ConflictGroup } from '../ui/ConflictNotice';
import { editGoneText, nothingChangedText, bulkPartialText } from '../../lib/refusalTexts';
import { itemChanges, type VdrNames } from './changeRules';

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Ответ сервера → исход записи. Не бросает: сеть и разбор приходят результатом. */
export async function sendVdr(url: string, method: 'POST' | 'PUT' | 'DELETE', body?: Record<string, unknown>, fetcher: Fetcher = (u, i) => fetch(u, i)): Promise<WriteResult> {
  let res: Response;
  try {
    res = await fetcher(url, method === 'DELETE' ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  } catch {
    return { kind: 'offline', message: 'Сервер не ответил' };
  }
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

/**
 * - `conflict` — запись изменили: перечень `changes` (пустой — показанное не затронуто) или, у массового, `groups`;
 * - `gone` — записи уже нет; `open` — открыта у коллеги; `plain` — любой другой отказ: прежняя строка текста.
 */
export interface VdrRefusal {
  kind: 'conflict' | 'gone' | 'open' | 'plain';
  message: string;
  changes?: FieldChange[];
  groups?: ConflictGroup[];
  /** Строки, которые не записаны не из-за чужой правки (удалены, сбой): название и причина — под перечнем */
  notes?: Array<{ title: string; text: string }>;
}

/** Отказ записи → что показать; принятая запись — `null`. `changesOf` собирает перечень по записи из отказа. */
export function refusalOf(result: WriteResult, changesOf: (current: any) => FieldChange[], fallback: string): VdrRefusal | null {
  switch (result.kind) {
    case 'ok': return null;
    case 'conflict': return { kind: 'conflict', message: result.message, changes: changesOf(result.current) };
    case 'gone': return { kind: 'gone', message: result.message };
    case 'open': return { kind: 'open', message: result.message };
    case 'offline': return { kind: 'plain', message: result.message };
    default: return { kind: 'plain', message: result.message || fallback };
  }
}

/** Нужно ли после отказа перечитать данные: запись изменили или она исчезла. */
export const needsReread = (result: WriteResult): boolean => result.kind === 'conflict' || result.kind === 'gone';

/**
 * Поля формы после отказа «изменили»: набранное человеком остаётся, нетронутое
 * берётся из текущей записи. «Набранное» — то, что в форме отличается от записи,
 * какой её видела карточка (`base`). `skip` — служебные ключи, форме не принадлежащие.
 */
export function keepTyped<T extends Record<string, any>>(base: T, typed: T, current: T | null | undefined, skip: readonly string[] = ['id', 'updatedAt', 'createdAt', 'version', 'counts', 'tagLinks', 'unmatchedTags']): T {
  if (!current) return typed;
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const out: Record<string, any> = { ...current };
  for (const key of Object.keys(typed)) {
    if (skip.includes(key)) continue;
    if (!same(typed[key], base[key])) out[key] = typed[key];
  }
  return out as T;
}

/** Название строки в перечнях: номер документа, иначе название */
export const rowTitle = (row: any): string => String(row?.contractorNo || row?.titleRu || row?.titleEn || 'строка').trim();

/** Итог массового действия по строкам: что записано и что нет, и почему */
export interface BulkReport {
  total: number;
  /** id записанных строк */
  written: string[];
  /** id незаписанных строк (для повтора: выбор остаётся на них) */
  refusedIds: string[];
  /** Перечень для окна; `null` — всё записано */
  refusal: VdrRefusal | null;
}

/**
 * Массовое действие по строкам: каждая строка — свой запрос с `expectedUpdatedAt`
 * той строки, которую экран показывал. Ответы проверяются: записано то, что приняли,
 * остальное названо с причиной. Не «всё или ничего»: строки независимы, и коллега
 * изменил одну — остальные записать можно; при этом ни одна изменённая не затирается.
 * Сеть пропала — оставшиеся не отправляются.
 */
export async function bulkWriteRows(
  rows: Array<{ shown: any; body: Record<string, unknown> }>,
  names: VdrNames,
  fetcher: Fetcher = (u, i) => fetch(u, i),
): Promise<BulkReport> {
  const written: string[] = [];
  const refusedIds: string[] = [];
  const groups: ConflictGroup[] = [];
  const notes: Array<{ title: string; text: string }> = [];
  let offline = false;
  for (const { shown, body } of rows) {
    const title = rowTitle(shown);
    if (offline) { refusedIds.push(shown.id); continue; }
    const result = await sendVdr(`/api/vdr/items/${shown.id}`, 'PUT', { ...body, expectedUpdatedAt: shown.updatedAt }, fetcher);
    if (result.kind === 'ok') { written.push(shown.id); continue; }
    refusedIds.push(shown.id);
    if (result.kind === 'conflict') {
      const changes = itemChanges(shown, result.current, names);
      if (changes.length) groups.push({ title, changes }); else notes.push({ title, text: nothingChangedText() });
    } else if (result.kind === 'gone') {
      notes.push({ title, text: editGoneText('registerItem', shown?.contractorNo || shown?.titleRu) });
    } else if (result.kind === 'offline') {
      offline = true;
      notes.push({ title, text: `${result.message}: эта и следующие строки не отправлены.` });
    } else {
      notes.push({ title, text: result.kind === 'refused' && result.message ? result.message : 'Не удалось записать.' });
    }
  }
  const refusal: VdrRefusal | null = refusedIds.length === 0 ? null : {
    kind: 'conflict', message: bulkPartialText(written.length, rows.length), groups, ...(notes.length ? { notes } : {}),
  };
  return { total: rows.length, written, refusedIds, refusal };
}
