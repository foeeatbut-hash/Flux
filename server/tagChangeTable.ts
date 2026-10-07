/**
 * Таблица истории изменений тега (TagChange): описание под три движка базы.
 *
 * Устроена так же, как таблица правил тегов (ProjectTagPolicy): модель лежит во
 * всех трёх схемах Prisma, и автомиграция создаёт таблицу при старте; на случай,
 * когда она не отработала, то же описание проходит через общий слой
 * `server/ddl.ts`, который собирает SQL под SQLite, PostgreSQL и MariaDB. Только
 * добавление: существующие таблицы и данные не меняются.
 *
 * Связи с Tag нет намеренно: удалённый тег обязан оставить историю, а внешний
 * ключ с каскадом стёр бы её вместе с тегом.
 *
 * Описание обязано совпадать со схемами Prisma: расхождение ловит
 * `scripts/test-ddl.ts` — иначе подстраховка создала бы таблицу, которую
 * автомиграция потом «исправляет» по-своему.
 */

import { getPrisma, onDatabaseSwapped } from './context.js';
import { ensureTables, type TableSpec } from './ddl.js';

export const TAG_CHANGE_TABLES: TableSpec[] = [{
  table: 'TagChange',
  cols: [
    { name: 'id', kind: 'text', pk: true, indexed: true },
    { name: 'tagId', kind: 'text', notNull: true, indexed: true },
    { name: 'projectId', kind: 'text', notNull: true, indexed: true },
    { name: 'at', kind: 'time', notNull: true, def: 'now' },
    { name: 'userId', kind: 'text', indexed: true },
    { name: 'source', kind: 'text', notNull: true, def: '' },
    { name: 'kind', kind: 'text', notNull: true },
    { name: 'field', kind: 'text', notNull: true, def: '' },
    // «Было» и «стало» — тексты комментариев и значения полей: могут быть длинными
    { name: 'before', kind: 'longtext' },
    { name: 'after', kind: 'longtext' },
  ],
  // Имена — как у Prisma для @@index: иначе автомиграция и подстраховка
  // завели бы по индексу каждая
  indexes: [
    { name: 'TagChange_tagId_at_idx', cols: ['tagId', 'at'] },
    { name: 'TagChange_projectId_idx', cols: ['projectId'] },
  ],
}];

let ready = false;
onDatabaseSwapped(() => { ready = false; });

/**
 * Убедиться, что таблица есть. Ошибка не глотается, а возвращается текстом:
 * историю, которую не удалось записать, должно быть видно в журнале.
 */
export async function ensureTagChangeTable(): Promise<string> {
  if (ready) return '';
  const why = await ensureTables(getPrisma(), TAG_CHANGE_TABLES, (m) => console.error('[История тегов]', m));
  if (!why) ready = true;
  return why;
}
