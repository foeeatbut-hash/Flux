/**
 * Запись metadata тега из экранов: только изменившиеся ключи и версия, которую
 * экран читал.
 *
 * Зачем. Экран держит копию тега, прочитанную при открытии. Раньше любая правка
 * отправляла `metadata` целиком, и копия, устаревшая за время работы, стирала
 * то, что за это время записали коллеги: комментарий в «Тегах», этап в
 * «Закупках». Теперь экран отправляет
 *   - только те верхние ключи, которые сам изменил (убранный ключ — `null`:
 *     пропущенный ключ сервер понимает как «не трогать»);
 *   - версию (`updatedAt`), которую читал. Тег с тех пор изменился — сервер
 *     отвечает 409 (`code: VERSION_CONFLICT`) и присылает текущий тег (`current`):
 *     экран заменяет им свою копию и показывает перечень «было → стало»
 *     (changeRules.ts, tagRefusal.ts), а набранное остаётся для повтора.
 *     Тега уже нет (`RECORD_GONE`) и тег открыт у коллеги (`RECORD_OPEN`, у удаления)
 *     узнаются по тому же полю `code`.
 * Слияние и сверка — на сервере (`server/tagWrite.ts`).
 */
import type { Dispatch, SetStateAction } from 'react';
import { outcomeOf, refusalOf, needsReread, deleteUrl, type TagOutcome, type TagRefusal } from './tagRefusal';
import type { TagNames } from './changeRules';

export interface TagWriteDeps {
  setTags: Dispatch<SetStateAction<any[]>>;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** Карточка тега держит своё отдельное состояние: при конфликте ей тоже нужна свежая копия */
  onFresh?: (tag: any) => void;
  /** Показать отказ с перечнем «было → стало» (в карточке на месте, у правки без формы — окном); нет — тост с текстом сервера */
  onRefusal?: (refusal: TagRefusal, tag: any) => void;
  /** Имена вместо идентификаторов для перечня: связи, поля справочника, этапы */
  names?: () => TagNames;
  /** Перечитать теги, когда экран устарел (тег изменили или удалили) */
  reload?: () => void;
}

/** Отказ показан как «изменили»: набранное человеком экрану сбрасывать нельзя, оно ещё нужно для повтора */
let lastKept = false;
export const lastWriteKeptInput = (): boolean => lastKept;
/** Последняя запись принята: «Сохранено» после отказа было бы неправдой */
let lastSaved = true;
export const lastWriteSaved = (): boolean => lastSaved;

/** Служебное окна («_noPos», разобранный кэш) в базу не едет и правкой не считается. */
const isService = (key: string): boolean => key.startsWith('_') || key === 'parsedMetadata' || key === '__procMeta';

const parse = (raw: unknown): Record<string, any> => {
  if (raw && typeof raw === 'object') return raw as Record<string, any>;
  try { const v = JSON.parse(String(raw || '{}')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
};

/** Что изменилось: новые значения изменившихся ключей, `null` у убранных. */
export function metadataPatch(was: unknown, now: unknown): Record<string, unknown> {
  const a = parse(was);
  const b = parse(now);
  const patch: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (isService(k)) continue;
    const had = k in a && a[k] !== undefined;
    const has = k in b && b[k] !== undefined;
    if (!has) { if (had) patch[k] = null; continue; }
    if (!had || JSON.stringify(a[k]) !== JSON.stringify(b[k])) patch[k] = b[k];
  }
  return patch;
}

/**
 * Версии, полученные от сервера после собственных записей этого окна. Копия
 * тега в списке обновляется не мгновенно, а вторая правка того же тега не должна
 * получить конфликт с первой.
 */
const known = new Map<string, string | null>();
/** Записи одного тега идут по очереди: вторая, отправленная до ответа на первую, ушла бы со старой версией. */
const queue = new Map<string, Promise<unknown>>();

const later = (a: string | null | undefined, b: string | null | undefined): string | null | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
};

/** Версия тега, как её знает это окно: своя запись обгоняет копию списка. */
export const versionOf = (tag: any): string | null | undefined => later(tag?.updatedAt, known.get(tag?.id));

/** Принять версии из ответа сервера (после массовой записи) и обновить копии в списке. */
export function rememberVersions(list: Array<{ id: string; updatedAt: string | null }> | undefined, setTags?: TagWriteDeps['setTags']): void {
  if (!Array.isArray(list)) return;
  const byId = new Map(list.map((v) => [v.id, v.updatedAt]));
  for (const [id, at] of byId) known.set(id, at);
  setTags?.((prev) => prev.map((t) => (byId.has(t.id) ? { ...t, updatedAt: byId.get(t.id) } : t)));
}

/**
 * Отправить запись тега: по очереди для одного тега, с версией, которую экран
 * читал; конфликт и ошибка превращаются в понятный тост, а не в тихую потерю.
 */
async function send(tag: any, url: string, method: 'PUT' | 'PATCH', payload: Record<string, unknown>, deps: TagWriteDeps): Promise<boolean> {
  const id = String(tag?.id || '');
  const run = async (): Promise<boolean> => {
    try {
      const version = versionOf(tag);
      // Запись с экрана берётся ДО подмены свежей копией: перечень сравнивает с тем, что человек видел
      const outcome = await outcomeOf(() => fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, ...(version !== undefined ? { version } : {}) }),
      }));
      lastKept = outcome.kind === 'conflict' || outcome.kind === 'gone';
      lastSaved = outcome.kind === 'ok';
      if (outcome.kind !== 'ok') {
        const refusal = refusalOf(outcome, tag, deps.names?.() || {}, 'Не удалось сохранить изменения');
        if (outcome.kind === 'conflict' && outcome.current) {
          const fresh = outcome.current;
          known.set(id, fresh.updatedAt ?? null);
          // Свежая копия вместо устаревшей; связи с оборудованием (equipment, componentElements) в ответе нет — они остаются прежние
          deps.setTags((prev) => prev.map((t) => (t.id === id ? { ...t, ...fresh, parsedMetadata: undefined, __procMeta: undefined } : t)));
          deps.onFresh?.(fresh);
        }
        if (needsReread(outcome)) deps.reload?.();
        if (refusal) {
          if (deps.onRefusal && refusal.kind !== 'plain') deps.onRefusal(refusal, tag);
          else deps.addToast(refusal.message, outcome.kind === 'conflict' || outcome.kind === 'gone' ? 'info' : 'error');
        }
        return false;
      }
      const saved = outcome.data?.tag;
      if (saved) rememberVersions([{ id, updatedAt: saved.updatedAt ?? null }], deps.setTags);
      return true;
    } catch (err) {
      lastSaved = false;
      console.error('Не удалось сохранить тег:', err);
      deps.addToast('Не удалось сохранить изменения', 'error');
      return false;
    }
  };

  const turn = (queue.get(id) || Promise.resolve()).then(run, run);
  queue.set(id, turn);
  return turn;
}

/**
 * Записать изменения metadata (и, если нужно, полей тега) одним запросом.
 * `now` — полная metadata, какой она должна стать; из неё выбирается разница с
 * тем, что экран читал (`tag.metadata`). Возвращает, записано ли.
 */
export async function saveTagMetadataPatch(tag: any, now: unknown, deps: TagWriteDeps, fields: Record<string, unknown> = {}): Promise<boolean> {
  const id = String(tag?.id || '');
  const patch = metadataPatch(tag?.metadata, now);
  if (!id || (!Object.keys(patch).length && !Object.keys(fields).length)) { lastSaved = true; return true; }
  return send(tag, `/api/tags/${id}`, 'PUT', { ...fields, metadata: patch }, deps);
}

/**
 * Закупка тега — отдельным запросом, который меняет только ключ `procurement`
 * (server/routes/tagProcurement.ts): комментарии и связи, добавленные коллегой
 * за время работы экрана, остаются.
 */
export async function saveProcurement(tag: any, procurement: unknown, deps: TagWriteDeps): Promise<boolean> {
  const id = String(tag?.id || '');
  if (!id) return true;
  return send(tag, `/api/tags/${id}/procurement`, 'PATCH', { procurement }, deps);
}

/**
 * Удалить тег: целая версия записи — в строке запроса (у DELETE тела нет). Сервер
 * отвечает отказом, если тег изменили или он открыт у коллеги; ответ разбирает
 * вызывающий (`refusalOf`), чтобы человек увидел причину, а не тишину.
 */
export function deleteTagRequest(tag: any): Promise<TagOutcome> {
  return outcomeOf(() => fetch(deleteUrl(String(tag?.id || ''), tag?.version), { method: 'DELETE' }));
}

/** Связи тега без окна и без отказа на экран (выправление дерева при загрузке): версия та, что прочитана; отказ — выправим на следующей загрузке. */
export function putTagLinks(tag: any, metadata: Record<string, unknown>): Promise<TagOutcome> {
  const version = versionOf(tag);
  return outcomeOf(() => fetch(`/api/tags/${tag.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metadata, ...(version !== undefined ? { version } : {}) }),
  }));
}

/**
 * Массовая запись metadata (`bulk-metadata`). Каждая запись несёт `version` — то, что
 * видел экран; раскладка (только x, y) версию не требует. «Всё или ничего»: хоть один
 * тег изменён или удалён — сервер не записал ничего и прислал `changed` / `gone`.
 */
export function bulkMetadataRequest(updates: Array<{ id: string; metadata: unknown }>, shown: Map<string, any>, extra: Record<string, unknown> = {}): Promise<TagOutcome> {
  const withVersion = updates.map((u) => {
    const v = versionOf(shown.get(u.id));
    return v === undefined ? u : { ...u, version: v };
  });
  return outcomeOf(() => fetch('/api/tags/bulk-metadata', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates: withVersion, ...extra }),
  }));
}
