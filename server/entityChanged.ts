import type { Request } from 'express';
import { broadcast } from './context.js';

// ── «Карточку изменил кто-то ещё» ────────────────────────────────────────────
// Двое правят одну карточку — молча побеждает последний. Полноценное слияние
// для карточек не нужно (правки точечные), но человек обязан узнать, что под
// ним поменяли данные. Событие лёгкое: что тронули и кто, без содержимого —
// экран сам решает, перечитывать ему или нет.
//
// Лежит отдельным модулем, потому что зовётся из маршрутов тегов и оборудования,
// которые живут в разных файлах; рассылка идёт через broadcast() из контекста,
// как и у прочих вынесенных модулей.
export function emitEntityChanged(kind: 'tag' | 'element', id: string, req: Request): void {
  try {
    broadcast('entity:changed', {
      kind, id,
      by: (req as any).authUser?.name || '',
      byId: (req as any).authUser?.id || '',
      at: Date.now(),
    });
  } catch (_) {}
}

/** Одна пакетная запись должна обновлять открытые списки одним запросом. */
export function emitEntitiesChanged(kind: 'tag' | 'element', ids: Iterable<string>, req: Request): void {
  const all = [...new Set(Array.from(ids, (id) => String(id || '')).filter(Boolean))];
  const unique = all;
  if (!unique.length) return;
  if (unique.length === 1) { emitEntityChanged(kind, unique[0], req); return; }
  try {
    broadcast('entity:changed', {
      kind, id: '', ids: unique,
      by: (req as any).authUser?.name || '',
      byId: (req as any).authUser?.id || '',
      at: Date.now(),
    });
  } catch (_) {}
}

/**
 * Ввоз меняет сразу много сущностей: один проектный маркер будит списки без
 * тысячи одинаковых socket-пакетов, а префикс ID не совпадёт с карточкой.
 */
export function emitProjectDataChanged(kind: 'tag' | 'element', projectId: string, actor?: { userId?: string | null }): void {
  if (!projectId) return;
  try {
    broadcast('entity:changed', {
      kind, id: `project:${projectId}`, projectId,
      byId: actor?.userId || '', by: '', at: Date.now(),
    });
  } catch (_) {}
}
