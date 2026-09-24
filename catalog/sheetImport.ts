/**
 * Импорт MTO и спецификаций: таблица → строки позиций → план.
 *
 * Разбор ничего не пишет (flux-data-safety, п. 1): он находит шапку и колонки,
 * отделяет строки систем от строк изделий, отбрасывает то, что не относится к
 * классу (решётки DA в MTO вентиляции), и строит план — что будет новым, что
 * изменится, что пропало. Запись — отдельный шаг после предпросмотра.
 *
 * Колонки ищутся по словарю заголовков, а не по буквам: у MTO тег в колонке A
 * под заголовком «Item / Поз.», у чужой спецификации он может быть где угодно.
 * Найденное сопоставление запоминается профилем формата (ImportProfile) и в
 * следующий раз предлагается само.
 */
import type { TagRule } from './model';
import type { SelectionItemData } from './selection';
import { splitTagCell, tagRuleOf } from './tags';
import { parseNum, foldText } from './text';

export type ColumnRole = 'tag' | 'description' | 'type' | 'code' | 'supplier' | 'unit' | 'qty' | 'weight' | 'note' | 'position';

export const COLUMN_ROLES: Array<{ role: ColumnRole; label: string; re: RegExp }> = [
  { role: 'tag', label: 'Тег', re: /^(item|поз)|\btag\b|тег|идентиф|kks|ккс|обозначение\s+позиции/i },
  { role: 'description', label: 'Описание', re: /name|наименов|description|описан|характеристик/i },
  { role: 'type', label: 'Тип, марка', re: /^type|тип\b|тип,|марк|опросн|data\s*sheet/i },
  { role: 'code', label: 'Код продукции', re: /product\s*code|код\s*продук|артикул|\bcode\b/i },
  { role: 'supplier', label: 'Поставщик', re: /supplier|поставщ|изготовит|завод/i },
  { role: 'unit', label: 'Ед. изм.', re: /unit|ед\.?\s*изм|единиц/i },
  { role: 'qty', label: 'Количество', re: /\bqty\b|quantity|кол[-.\s]?во|кол\.|количеств/i },
  { role: 'weight', label: 'Масса', re: /weight|масса/i },
  { role: 'note', label: 'Примечание', re: /note|примеч|remark/i },
];

export type ColumnMap = Partial<Record<ColumnRole, number>>;

export interface HeaderGuess {
  headerRow: number;
  columns: ColumnMap;
  /** Подпись формата: заголовки колонок через «|» — по ней узнаётся профиль */
  signature: string;
}

const cell = (rows: string[][], r: number, c: number | undefined) => (c === undefined ? '' : String(rows[r]?.[c] ?? '').trim());

/**
 * Найти шапку: первая строка из первых 40, где узнаётся хотя бы три колонки.
 * Если колонка тегов по заголовку не нашлась, ищем её по содержимому — там,
 * где больше всего ячеек похожи на теги.
 */
export function guessHeader(rows: string[][]): HeaderGuess | null {
  let best: HeaderGuess | null = null;
  let bestScore = 0;
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const cols: ColumnMap = {};
    let score = 0;
    (rows[r] || []).forEach((raw, c) => {
      const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 120) return;
      for (const { role, re } of COLUMN_ROLES) {
        if (cols[role] === undefined && re.test(text)) { cols[role] = c; score++; break; }
      }
    });
    if (score > bestScore && score >= 3) { bestScore = score; best = { headerRow: r, columns: cols, signature: '' }; }
  }
  if (!best) return null;
  if (best.columns.tag === undefined) {
    const counts = new Map<number, number>();
    for (let r = best.headerRow + 1; r < Math.min(rows.length, best.headerRow + 400); r++) {
      (rows[r] || []).forEach((v, c) => { if (splitTagCell(String(v ?? '')).tags.length) counts.set(c, (counts.get(c) || 0) + 1); });
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) best.columns.tag = top[0];
  }
  best.signature = signatureOfHeader(rows[best.headerRow] || []);
  return best;
}

export function signatureOfHeader(header: string[]): string {
  return header.map((h) => foldText(String(h ?? '')).replace(/[^\p{L}\d]+/gu, '').slice(0, 24)).join('|');
}

export interface SheetRow {
  /** Номер строки в листе, с единицы — как в Excel */
  row: number;
  tags: string[];
  /** Неразобранные куски ячейки тегов */
  tagRest: string[];
  description: string;
  type: string;
  code: string;
  supplier: string;
  unit: string;
  qty: number;
  weight: number | null;
  note: string;
  /** Система, под заголовком которой стоит строка (A01, B01…) */
  system: string;
  /** Почему строка не взята: «решётки DA», «нет тега и описания» */
  skip?: string;
}

/**
 * Строки листа. Строка системы — это строка, где заполнено только описание и
 * оно короткое («A01», «B02»): в MTO так начинается каждая система, и её код
 * пригодится при группировке листов бланка.
 */
export function readRows(rows: string[][], guess: HeaderGuess, tagRules: TagRule[], opts: { onlyTagged?: boolean } = {}): SheetRow[] {
  const col = guess.columns;
  const out: SheetRow[] = [];
  let system = '';
  for (let r = guess.headerRow + 1; r < rows.length; r++) {
    const line = rows[r] || [];
    if (!line.some((v) => String(v ?? '').trim())) continue;
    const desc = cell(rows, r, col.description);
    const tagCell = cell(rows, r, col.tag);
    const filled = line.filter((v) => String(v ?? '').trim()).length;
    if (!tagCell && desc && desc.length <= 12 && filled <= 2 && /^[A-ZА-Я]{0,3}\d{1,3}[A-ZА-Я]?$/i.test(desc)) { system = desc; continue; }
    // Строка-разделитель раздела («Ventilation system / Система вентиляции»)
    if (!tagCell && filled === 1 && desc && !/\d/.test(desc)) continue;
    const { tags, rest } = splitTagCell(tagCell);
    // Теги повторены в примечании (как в MTO) — берём оттуда, если в колонке тегов пусто
    const noteTags = !tags.length ? splitTagCell(cell(rows, r, col.note)).tags : [];
    const allTags = tags.length ? tags : noteTags;
    const qty = parseNum(cell(rows, r, col.qty)) ?? 0;
    const row: SheetRow = {
      row: r + 1,
      tags: allTags,
      tagRest: rest,
      description: desc,
      type: cell(rows, r, col.type),
      code: cell(rows, r, col.code),
      supplier: cell(rows, r, col.supplier),
      unit: cell(rows, r, col.unit),
      qty: qty || allTags.length || 0,
      weight: parseNum(cell(rows, r, col.weight)),
      note: cell(rows, r, col.note),
      system,
    };
    const rule = allTags[0] ? tagRuleOf(tagRules, allTags[0]) : undefined;
    if (rule?.skip) row.skip = `${rule.code} — ${rule.label.ru}`;
    else if (!allTags.length && opts.onlyTagged) row.skip = 'нет тега';
    else if (!allTags.length && !desc) row.skip = 'нет ни тега, ни описания';
    else if (allTags.length && tagRules.length && !rule) row.skip = 'код типа в теге не относится к классу';
    out.push(row);
  }
  return out;
}

/** Текст для подбора: описание, тип/марка и код продукции вместе */
export function textForMatch(r: SheetRow): string {
  return [r.description, r.type, r.code ? `E=${r.code}` : ''].filter(Boolean).join(' ');
}

// ── План ────────────────────────────────────────────────────────────────────

export type PlanAction = 'new' | 'update' | 'same' | 'conflict' | 'skip';

export interface PlanChange {
  field: string;
  from: unknown;
  to: unknown;
  /** Поле правил человек: по умолчанию оставляем его значение */
  overridden: boolean;
}

export interface PlanEntry {
  row: SheetRow;
  action: PlanAction;
  itemId?: string;
  /** Совпавшие позиции ведомости — больше одной означает конфликт */
  matchedItems: string[];
  changes: PlanChange[];
  proposed: Partial<SelectionItemData>;
  note?: string;
}

export interface ImportPlan {
  entries: PlanEntry[];
  /** Позиции ведомости, которых нет в файле. Предлагаются к снятию, только если файл полный */
  missing: Array<{ id: string; tags: string[]; designation: string }>;
  totals: Record<PlanAction, number> & { qty: number };
}

const tagKey = (t: string) => t.trim().toUpperCase();
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * План импорта: строка файла против ведомости, по тегам.
 *
 * Совпадение по тегу — единственное, по чему строка считается «той же»:
 * описание и количество в новой ревизии MTO меняются, а тег — нет. Строка,
 * чьи теги разошлись по двум позициям ведомости, — конфликт: слить или
 * разделить позиции должен человек.
 */
export function planSheetImport(
  existing: SelectionItemData[],
  rows: SheetRow[],
  proposeFor: (row: SheetRow) => Partial<SelectionItemData>,
  opts: { fullDocument?: boolean } = {},
): ImportPlan {
  const byTag = new Map<string, SelectionItemData[]>();
  for (const it of existing) for (const t of it.tags) {
    const k = tagKey(t);
    byTag.set(k, [...(byTag.get(k) || []), it]);
  }
  const touched = new Set<string>();
  const entries: PlanEntry[] = [];
  for (const row of rows) {
    if (row.skip) { entries.push({ row, action: 'skip', matchedItems: [], changes: [], proposed: {}, note: row.skip }); continue; }
    const hits = [...new Set(row.tags.flatMap((t) => (byTag.get(tagKey(t)) || []).map((i) => i.id)))];
    const proposed = proposeFor(row);
    if (hits.length > 1) {
      hits.forEach((h) => touched.add(h));
      entries.push({ row, action: 'conflict', matchedItems: hits, changes: [], proposed, note: 'Теги строки разошлись по нескольким позициям ведомости' });
      continue;
    }
    if (!hits.length) { entries.push({ row, action: 'new', matchedItems: [], changes: [], proposed }); continue; }
    const item = existing.find((i) => i.id === hits[0])!;
    touched.add(item.id);
    const ov = new Set(item.overrides || []);
    const changes: PlanChange[] = [];
    const cmp = (field: string, from: unknown, to: unknown) => { if (to !== undefined && !same(from, to)) changes.push({ field, from, to, overridden: ov.has(field) }); };
    cmp('tags', [...item.tags].sort(), [...(proposed.tags || row.tags)].sort());
    cmp('qty', item.qty, proposed.qty ?? row.qty);
    cmp('sourceText', item.sourceText, proposed.sourceText);
    cmp('familyId', item.familyId, proposed.familyId);
    for (const [k, v] of Object.entries(proposed.values || {})) cmp(`values.${k}`, item.values[k], v);
    entries.push({ row, action: changes.length ? 'update' : 'same', itemId: item.id, matchedItems: [item.id], changes, proposed });
  }
  // Отсутствие в файле — повод для удаления только у полного документа:
  // фрагмент (одна система, выделенные строки) ничего не снимает
  const missing = opts.fullDocument
    ? existing.filter((i) => !touched.has(i.id)).map((i) => ({ id: i.id, tags: i.tags, designation: i.designation }))
    : [];
  const totals = { new: 0, update: 0, same: 0, conflict: 0, skip: 0, qty: 0 } as ImportPlan['totals'];
  for (const e of entries) { totals[e.action]++; if (e.action !== 'skip') totals.qty += e.row.qty; }
  return { entries, missing, totals };
}
