/**
 * Какие теги проекта массовый ввоз тронет: одно правило для экрана и сервера.
 *
 * Экран по нему собирает `seen` (версии тегов, которые предпросмотр видел), а
 * сервер — список «что собираюсь менять» (server/planGuard.ts). Расходись они,
 * экран присылал бы неполные версии, а сервер отказывал бы всякий раз — или,
 * хуже, молча писал бы в тег, которого предпросмотр не показывал.
 *
 * Тронутыми считаются:
 *  • тег с кодом строки, когда режим — «обновить» (в режиме «добавить» совпавший
 *    по коду тег не пишется, строка уходит в повторы);
 *  • тег — родитель строки: ему дописывается связь с дочерним (и в режиме «добавить»,
 *    и у строки-повтора).
 * Коды сравниваются по ключу `identityKeyOf`, тем же, что держит база.
 */
import { identityKeyOf } from '../equipment/tagPolicy.js';

export interface TagImportRow { identifier?: unknown; parent?: unknown }

export function importTouchedKeys(rows: readonly TagImportRow[], mode: 'add' | 'update'): Set<string> {
  const keys = new Set<string>();
  for (const r of rows || []) {
    const code = identityKeyOf(String(r?.identifier ?? ''));
    if (!code) continue;
    if (mode === 'update') keys.add(code);
    const parent = identityKeyOf(String(r?.parent ?? ''));
    if (parent && parent !== code) keys.add(parent);
  }
  return keys;
}

/** Идентификаторы тегов из списка, чьи коды попали в `keys`. */
export function tagIdsOfKeys(tags: readonly { id: string; identifier?: unknown }[], keys: ReadonlySet<string>): string[] {
  return tags.filter((t) => keys.has(identityKeyOf(String(t.identifier ?? '')))).map((t) => t.id);
}
