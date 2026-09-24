/**
 * Теги позиции: разбор ячейки, код типа, производные теги привода и коробки.
 *
 * В MTO одна строка часто несёт несколько тегов («3700-B01-DN-001A,
 * 3700-B01-DN-001B, …»), в бланке их пишут через пробел или с новой строки.
 * Тег — идентификатор позиции во всём Конструкторе, поэтому разбирается он
 * строго: что не похоже на тег, тегом не становится, а возвращается отдельно,
 * чтобы человек увидел, что осталось неразобранным.
 */
import type { TagRule } from './model';
import { findTags, tagTypeOf } from './describe';

export { tagTypeOf };

export interface TagCell {
  tags: string[];
  /** Куски ячейки, не похожие на тег */
  rest: string[];
}

export function splitTagCell(cell: string): TagCell {
  const src = String(cell ?? '').replace(/[‐-—]/g, '-');
  const tags = findTags(src.toUpperCase());
  let left = src.toUpperCase();
  for (const t of tags) left = left.split(t).join(' ');
  const rest = left.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => s && !/^(И|AND|\.|-)$/i.test(s));
  return { tags, rest };
}

/** Правило класса по коду типа из тега */
export function tagRuleOf(rules: TagRule[], tag: string): TagRule | undefined {
  const code = tagTypeOf(tag);
  return code ? rules.find((r) => r.code.toUpperCase() === code) : undefined;
}

/**
 * Тег привода по тегу клапана: DF → DFD с тем же номером.
 * `3700-B01-DF-001` → `3700-B01-DFD-001`. Правило задаётся в Каталоге; если
 * его нет, тега привода не выдумываем — пустая строка.
 */
export function derivedTag(tag: string, fromCode: string, toCode: string | undefined): string {
  if (!toCode) return '';
  const re = new RegExp(`-${fromCode}-(\\d{2,}[A-ZА-Я]?)$`, 'i');
  return re.test(tag) ? tag.replace(re, `-${toCode}-$1`) : '';
}

/** Одинаковые теги в разных позициях — первая проверка ведомости */
export function duplicateTags(items: Array<{ id: string; tags: string[] }>): Map<string, string[]> {
  const where = new Map<string, string[]>();
  for (const it of items) {
    for (const t of it.tags) {
      const key = t.trim().toUpperCase();
      if (!key) continue;
      where.set(key, [...(where.get(key) || []), it.id]);
    }
  }
  return new Map([...where].filter(([, ids]) => new Set(ids).size > 1));
}
