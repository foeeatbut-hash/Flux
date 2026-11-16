/**
 * Запись по экрану «Оборудование»: версия, которую экран видел, и отказ по ней.
 *
 * Зачем. Экран держит копию дерева, прочитанную при открытии. Пока человек
 * правил тип или значение, коллега мог изменить ту же позицию, и запись по
 * устаревшей копии молча затёрла бы чужую работу. Поэтому каждое действие
 * над позицией, блоком или установкой несёт `expectedVersion` — целую `version`
 * той записи, которую экран показывал в момент действия (у DELETE — в строке
 * запроса; у создания позиции — версия родителя). Сервер сверяет её и, если запись
 * успели изменить, отвечает 409 с полем `code: 'VERSION_CONFLICT'`, текстом для
 * человека и текущей записью (`server/versionGuard.ts`).
 *
 * Отказ узнаётся по полю `code`, а не по тексту или одному статусу: у 409 в этих
 * же маршрутах есть и другие причины («тег уже занят»), и перечитывать при них
 * нечего. Текст отказа читает человек, поэтому по нему ничего не решается.
 * Кодов три: `VERSION_CONFLICT` (запись изменили), `RECORD_GONE` (запись уже
 * удалили), `RECORD_OPEN` (удалять нельзя: запись открыта у коллеги).
 *
 * Модуль без React и без браузера: наборы гоняют его с подставным `fetch`.
 */

import { VERSION_CONFLICT, RECORD_GONE, RECORD_OPEN } from '../../lib/refusalTexts';

/** Коды отказов — из словаря, общего с сервером (`lib/refusalTexts`): запись об «изменили», «удалили» и «открыта у коллеги» */
export { VERSION_CONFLICT, RECORD_GONE, RECORD_OPEN };

/** Кто держит запись открытой и какая именно запись: как их присылает сервер при `RECORD_OPEN` */
export interface OpenHolder { userId: string; name: string }
export interface OpenRecordInfo { model: string; id: string; name: string }

export type WriteResult =
  /** Запись принята; `data` — разобранный ответ (пустой объект, если тела нет) */
  | { kind: 'ok'; data: any }
  /** Запись изменили раньше: `message` — текст сервера, `current` — запись, какой она стала, `data` — тело отказа целиком */
  | { kind: 'conflict'; message: string; current: any; changedBy: ChangedBy | null; data: any }
  /** Запись уже удалили (404 с кодом): правка не записана, перечитывать есть что — запись из дерева исчезнет */
  | { kind: 'gone'; message: string; data: any }
  /** Удалить нельзя: запись открыта у коллеги. `holders` — у кого, `record` — какая запись держит (может быть вложенной) */
  | { kind: 'open'; message: string; holders: OpenHolder[]; record: OpenRecordInfo | null; data: any }
  /** Другой отказ сервера (нет права, занятый тег, ошибка): перечитывать нечего */
  | { kind: 'refused'; status: number; message: string; data: any }
  /** Сервер не ответил */
  | { kind: 'offline'; message: string };

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Версия — целое ≥ 1; всё остальное (нет записи, нет колонки у старого ответа) не отправляется. */
export function versionToSend(version: unknown): number | undefined {
  const n = typeof version === 'string' && version.trim() !== '' ? Number(version) : version;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** Тело запроса с версией, которую видел экран. */
export function withVersion<T extends Record<string, unknown>>(body: T, version: unknown): T & { expectedVersion?: number } {
  const v = versionToSend(version);
  return v === undefined ? body : { ...body, expectedVersion: v };
}

/** Адрес запроса с версией в строке: так её несёт DELETE, у которого нет тела. */
export function withVersionQuery(url: string, version: unknown): string {
  const v = versionToSend(version);
  if (v === undefined) return url;
  return `${url}${url.includes('?') ? '&' : '?'}expectedVersion=${v}`;
}

/** Кто изменил запись последним — как его присылает сервер вместе с отказом по версии; нет автора (система, запись старше журнала) — `null` */
export interface ChangedBy { userId?: string; name: string; at?: string }

/** `changedBy` из тела отказа: без имени строка «Изменил» не нужна, поэтому такой автор — `null`. */
export function changedByOf(body: any): ChangedBy | null {
  const c = body && typeof body === 'object' ? body.changedBy : null;
  if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name.trim()) return null;
  return { ...(typeof c.userId === 'string' ? { userId: c.userId } : {}), name: c.name, ...(typeof c.at === 'string' ? { at: c.at } : {}) };
}

/** Отказ по версии в ответе сервера: ровно по полю `code`. */
export function conflictOf(status: number, body: any): { message: string; current: any; changedBy: ChangedBy | null } | null {
  if (status !== 409 || !body || typeof body !== 'object' || body.code !== VERSION_CONFLICT) return null;
  return { message: String(body.error || 'Запись изменили, пока вы её правили'), current: body.current ?? null, changedBy: changedByOf(body) };
}

/** Запись удалена в ответе сервера: 404 и ровно код `RECORD_GONE`. */
export function goneOf(status: number, body: any): { message: string } | null {
  if (status !== 404 || !body || typeof body !== 'object' || body.code !== RECORD_GONE) return null;
  return { message: String(body.error || 'Запись уже удалили') };
}

/** Запись открыта у коллеги в ответе сервера: 409 и ровно код `RECORD_OPEN`. */
export function openOf(status: number, body: any): { message: string; holders: OpenHolder[]; record: OpenRecordInfo | null } | null {
  if (status !== 409 || !body || typeof body !== 'object' || body.code !== RECORD_OPEN) return null;
  const holders = (Array.isArray(body.holders) ? body.holders : [])
    .filter((h: any) => h && typeof h === 'object')
    .map((h: any) => ({ userId: String(h.userId ?? ''), name: String(h.name ?? '') }));
  const r = body.record;
  const record = r && typeof r === 'object' ? { model: String(r.model ?? ''), id: String(r.id ?? ''), name: String(r.name ?? '') } : null;
  return { message: String(body.error || 'Запись сейчас открыта у коллеги'), holders, record };
}

/**
 * Отправить запись с версией и разобрать ответ. Не бросает: сеть и отказ
 * приходят результатом, чтобы вызывающий не забыл ни одну из веток.
 * `delete` версию несёт в строке запроса, остальные — в теле.
 */
export async function writeVersioned(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body: Record<string, unknown> | undefined,
  version: unknown,
  fetcher: Fetcher = (u, i) => fetch(u, i),
): Promise<WriteResult> {
  let res: Response;
  try {
    res = method === 'DELETE'
      ? await fetcher(withVersionQuery(url, version), { method })
      : await fetcher(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withVersion(body || {}, version)) });
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

/** Текст для человека о неудавшейся записи; у принятой — пустая строка. */
export function failureText(result: WriteResult, fallback: string): string {
  if (result.kind === 'ok') return '';
  if (result.kind === 'conflict' || result.kind === 'gone' || result.kind === 'open' || result.kind === 'offline') return result.message;
  return result.message || fallback;
}

export type VersionedKind = 'system' | 'monoblock' | 'component';

/** Запись дерева установок, какой её показывает экран; нет записи — `undefined`. */
export function recordIn(systems: any[], kind: VersionedKind, id: string | undefined | null): any | undefined {
  if (!id) return undefined;
  for (const system of systems || []) {
    if (kind === 'system' && system.id === id) return system;
    for (const mono of system.monoblocks || []) {
      if (kind === 'monoblock' && mono.id === id) return mono;
      if (kind === 'component') for (const comp of mono.components || []) if (comp.id === id) return comp;
    }
  }
  return undefined;
}

/** Версия записи в дереве установок, как её показывает экран; нет записи — `undefined`. */
export function versionIn(systems: any[], kind: VersionedKind, id: string | undefined | null): number | undefined {
  return versionToSend(recordIn(systems, kind, id)?.version);
}
