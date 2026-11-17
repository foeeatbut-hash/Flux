/**
 * Массовая запись по предпросмотру: версии, которые он видел, и отказ «записи изменили».
 *
 * Мастер импорта тегов и разбор захвата сперва показывают план (что создастся, что
 * обновится), а пишут отдельным запросом. Пока человек смотрел, коллега мог изменить или
 * удалить теги, на которые план опирается. Поэтому запись несёт `seen` — целые версии тегов,
 * которые план читал и собирается менять, а сервер сверяет их в транзакции до первой записи
 * (`server/planGuard.ts`) и при расхождении отвечает 409 `VERSION_CONFLICT` с перечнем
 * `changed: [{ id, current }]` и `gone: [id]`; не записано ничего.
 *
 * Здесь — то, что экран делает с таким отказом: перечень «поле: было → стало» по записям
 * (правила полей тега — `changeRules.ts`, показ — общий `ConflictNotice`), версии для
 * повторного подтверждения и разбор прочих отказов. Тот же вид отказа, что у массовой записи
 * «Закупок» (`bulkWrite.ts`). Без React и без сети: наборы гоняют это на голых объектах.
 */
import type { ConflictGroup } from '../ui/ConflictNotice';
import { conflictOf, goneOf, openOf } from '../equipment/versionedWrite';
import { tagChanges, type TagNames } from './changeRules';
import type { TagRefusal } from './tagRefusal';

export interface PlanEntry { id: string; current: any }

export type PlanResult<T> =
  | { kind: 'ok'; data: T }
  /** План устарел: `changed` / `gone` — что с тех пор изменили и удалили; не записано ничего */
  | { kind: 'changed'; refusal: TagRefusal; changed: PlanEntry[]; gone: string[] }
  /** Любой другой отказ или сбой: перечитывать нечего */
  | { kind: 'failed'; refusal: TagRefusal };

/** Целая версия тега — единственное, что уходит в `seen` (нет колонки у старого ответа — тег не сверяется). */
const versionOf = (tag: any): number | undefined => {
  const n = typeof tag?.version === 'string' && tag.version.trim() !== '' ? Number(tag.version) : tag?.version;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : undefined;
};

/** `seen` для запроса: версии тегов с этими идентификаторами, как их видел предпросмотр. */
export function seenOfTags(tags: readonly any[], ids: Iterable<string>): Record<string, number> {
  const want = new Set(ids);
  const seen: Record<string, number> = {};
  for (const t of tags) {
    const v = versionOf(t);
    if (want.has(String(t?.id)) && v !== undefined) seen[String(t.id)] = v;
  }
  return seen;
}

/** Теги по идентификатору — то, что человек видел (основа перечня «было → стало»). */
export const byIdOf = (tags: readonly any[]): Map<string, any> => new Map(tags.map((t) => [String(t.id), t]));

/** Имена вместо идентификаторов для перечня: связи и родитель называются кодом тега. */
export const namesOf = (tags: readonly any[]): TagNames => ({
  tag: (id) => tags.find((t) => t?.id === id)?.identifier,
});

/**
 * Отказ плана → то, что покажет окно: текст сервера и группа на каждую запись.
 * Запись, которой предпросмотр не показывал (появилась после), называется своим кодом.
 */
export function planRefusalOf(data: any, shown: Map<string, any>, names: TagNames = {}): TagRefusal {
  const groups: ConflictGroup[] = [];
  for (const c of Array.isArray(data?.changed) ? data.changed : []) {
    if (!c || typeof c !== 'object') continue;
    const id = String(c.id ?? c.current?.id ?? '');
    const before = shown.get(id);
    groups.push({
      title: String(before?.identifier || c.current?.identifier || id),
      changes: before ? tagChanges(before, c.current, names) : [{ label: 'Тег', was: 'не было', now: 'появился после предпросмотра' }],
    });
  }
  for (const id of Array.isArray(data?.gone) ? data.gone : []) {
    groups.push({ title: String(shown.get(String(id))?.identifier || id), changes: [{ label: 'Тег', was: 'есть', now: 'удалён' }] });
  }
  return { kind: 'conflict', message: String(data?.error || 'Теги изменили, пока вы смотрели. Ничего не записано.'), groups };
}

/** Версии для повторного подтверждения: человек прочёл перечень, и теперь план опирается на то, что есть. */
export function reseen(seen: Record<string, number>, changed: readonly PlanEntry[], gone: readonly string[]): Record<string, number> {
  const next = { ...seen };
  for (const id of gone) delete next[id];
  for (const c of changed) { const v = versionOf(c.current); if (v !== undefined) next[c.id] = v; }
  return next;
}

/**
 * Выполнить запись плана и разобрать отказ. Не бросает: отказ сервера и сбой приходят результатом.
 * `shown` — теги, какими их видел предпросмотр (взять ДО перечитывания списка).
 */
export async function runPlan<T>(write: () => Promise<T>, shown: Map<string, any>, names: TagNames, fallback: string): Promise<PlanResult<T>> {
  try {
    return { kind: 'ok', data: await write() };
  } catch (err: any) {
    // Узнаём по имени, а не по классу: модуль остаётся чистым и не тянет за собой весь dataService
    if (err?.name === 'WriteRefusal' && typeof err.status === 'number') {
      const body = err.body;
      if (conflictOf(err.status, body)) {
        return {
          kind: 'changed', refusal: planRefusalOf(body, shown, names),
          changed: (Array.isArray(body?.changed) ? body.changed : []).filter((c: any) => c && typeof c === 'object').map((c: any) => ({ id: String(c.id ?? c.current?.id ?? ''), current: c.current })),
          gone: (Array.isArray(body?.gone) ? body.gone : []).map(String),
        };
      }
      const gone = goneOf(err.status, body);
      if (gone) return { kind: 'failed', refusal: { kind: 'gone', message: gone.message } };
      const open = openOf(err.status, body);
      if (open) return { kind: 'failed', refusal: { kind: 'open', message: open.message, holders: open.holders, record: open.record } };
      return { kind: 'failed', refusal: { kind: 'plain', message: String(body?.error || err.message || fallback) } };
    }
    return { kind: 'failed', refusal: { kind: 'plain', message: String(err?.message || fallback) } };
  }
}
