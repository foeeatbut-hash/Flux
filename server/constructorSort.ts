import { classOrder } from '../equipment/classes.js';
import { compareTags } from '../equipment/notes.js';
import { parseRuNumber } from './normalize.js';

/**
 * Порядок строк Таблицы по нескольким полям подряд («тип, потом тег»).
 *
 * Тег сравнивается естественно (`001A` раньше `002A`, `B01-9` раньше
 * `B01-10`), тип — по порядку справочника, а не по алфавиту: установка идёт
 * первой, прочее последним. Пустое значение уходит в конец при любом
 * направлении — строки без тега не должны вставать в начало таблицы.
 *
 * Отдельно от маршрутов конструктора: там планка размера, а правило порядка
 * проверяется скриптом (scripts/test-position-list.ts).
 */

const TAG_FIELDS = new Set(['tag', 'identifier', 'parentTag', 'unitTag']);

export function compareBy<T>(
  sort: { field: string; dir?: string }[],
  valueOf: (row: T, field: string) => string,
): (a: T, b: T) => number {
  return (a, b) => {
    for (const s of sort) {
      const dir = s.dir === 'desc' ? -1 : 1;
      const va = valueOf(a, s.field);
      const vb = valueOf(b, s.field);
      if (va === vb) continue;
      if (!va || !vb) return va ? -1 : 1;
      if (s.field === 'class') return (classOrder(va) - classOrder(vb)) * dir;
      if (TAG_FIELDS.has(s.field)) return compareTags(va, vb) * dir;
      const na = parseRuNumber(va), nb = parseRuNumber(vb);
      if (na != null && nb != null && na !== nb) return (na - nb) * dir;
      const c = va.localeCompare(vb, 'ru');
      if (c) return c * dir;
    }
    return 0;
  };
}
