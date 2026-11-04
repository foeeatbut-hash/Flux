/**
 * Сверка документа с данными проекта: какие значения, записанные Flux в ячейки,
 * в источнике уже другие. Ничего не пишет — только читает байты файла и
 * источники и отвечает списком «где · было → стало» (office/changes.ts).
 *
 * «Было» — то, что Flux записал в прошлый раз (хранится в схеме файла), а если
 * в самой книге другое (правили руками), — то, что в ячейке. «Стало» считается
 * теми же правилами, что и заполнение (planOfficeFill), поэтому «Обновить» на
 * тех же данных сделает ровно эти замены.
 */
import JSZip from 'jszip';
import { readOfficeBindings } from './officeBindings.js';
import { readSheetCells } from './officeCells.js';
import { planOfficeFill, type OfficeEntityRow, type OfficeHeaderAnchor } from '../src/lib/officeModel.js';
import type { OfficeChange, OfficeChangesResult } from '../office/changes.js';

type RowsFor = (projectId: string, queryBody: any) => Promise<{ rows: OfficeEntityRow[]; sourceRevision: string }>;

const ENTITY: Record<string, string> = { equipment: 'element', tags: 'tag', management: 'management', e3flux: 'e3flux' };
/** Поля, по которым человек узнаёт позицию в строке документа */
const LABEL_FIELDS: Record<string, string[]> = { equipment: ['tag', 'name'], tags: ['identifier'], management: ['tag.identifier'], e3flux: ['element.tag', 'element.name'] };

const columnNumber = (letters: string) => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
const textOf = (value: unknown) => (value === null || value === undefined ? '' : String(value));

export async function officeChangesOfContent(bytes: Buffer, projectId: string, rowsFor: RowsFor): Promise<OfficeChangesResult> {
  const checkedAt = new Date().toISOString();
  const empty: OfficeChangesResult = { stale: false, count: 0, rows: 0, changes: [], checkedAt };
  const bindings = await readOfficeBindings(bytes);
  if (!bindings || !bindings.rows.length) return empty;
  const anchors: OfficeHeaderAnchor[] = bindings.anchors.map(({ part, sheet, ...anchor }) => ({ ...anchor, ...(part ? { documentPart: part } : {}), ...(sheet ? { sheetName: sheet } : {}) }) as OfficeHeaderAnchor);
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]));

  // Строки документа по источникам: у каждого источника свой запрос и свои колонки
  const bySource = new Map<string, typeof bindings.rows>();
  for (const row of bindings.rows) bySource.set(row.sourceId, [...(bySource.get(row.sourceId) || []), row]);
  const fresh = new Map<string, OfficeEntityRow>();
  for (const [sourceId] of bySource) {
    const columns = new Set<string>(LABEL_FIELDS[sourceId] || []);
    for (const anchor of anchors) for (const part of anchor.parts) {
      if (part.kind === 'field' && part.binding.sourceId === sourceId) columns.add(part.binding.fieldKey);
      if (part.kind === 'union') for (const alt of part.alternatives) if (alt.sourceId === sourceId) columns.add(alt.fieldKey);
    }
    const entity = ENTITY[sourceId];
    if (!entity) continue;
    const data = await rowsFor(projectId, { entity, columns: [...columns], filters: [], sort: [], excludedEntityIds: [], limit: 50000 });
    for (const row of data.rows) fresh.set(row.entityId, row);
  }

  const placed = bindings.rows.filter((row) => fresh.has(row.entityId));
  const plan = planOfficeFill({ baseHash: '', sourceRevision: '', selectedEntityIds: placed.map((row) => row.entityId), rows: [...fresh.values()], anchors, existingRows: placed.map((row) => ({ rowId: row.entityId, entityId: row.entityId })) });

  // Что на самом деле лежит в ячейках книги (для «было» и признака ручной правки)
  const zip = await JSZip.loadAsync(bytes);
  const isBook = !!zip.file('xl/workbook.xml');
  const actual = new Map<string, string>();
  if (isBook) {
    const wanted = new Map<string, string[]>();
    const want = (sheet: string | undefined, address: string | undefined) => { if (sheet && address) wanted.set(sheet, [...(wanted.get(sheet) || []), address]); };
    for (const row of bindings.rows) for (const anchorId of row.anchorIds) want(anchorById.get(anchorId)?.sheetName, row.cells?.[anchorId]);
    for (const anchor of anchors) want(anchor.sheetName, anchor.address);
    for (const [sheet, addresses] of wanted) for (const [address, value] of await readSheetCells(zip, sheet, addresses)) actual.set(`${sheet}\u0000${address}`, value);
  }
  const rowByEntity = new Map(bindings.rows.map((row) => [row.entityId, row]));
  const labelOf = (entityId: string): string => {
    const row = fresh.get(entityId);
    const stored = rowByEntity.get(entityId);
    for (const key of LABEL_FIELDS[stored?.sourceId || ''] || []) {
      const value = textOf(row?.values[key]?.value);
      if (value) return value;
    }
    // Позиции в источнике уже нет (удалена): имя — то, что осталось в её строке документа, в колонке тега или
    // наименования. Без этого строка списка называлась внутренним номером «PRJ-000001-EQ-000004»
    if (!row && stored && isBook) {
      const keys = LABEL_FIELDS[stored.sourceId] || [];
      for (const anchorId of stored.anchorIds) {
        const anchor = anchorById.get(anchorId);
        const only = anchor?.parts.length === 1 && anchor.parts[0]!.kind === 'field' ? anchor.parts[0]!.binding.fieldKey : '';
        const address = stored.cells?.[anchorId];
        const text = only && keys.includes(only) && anchor?.sheetName && address ? actual.get(`${anchor.sheetName}\u0000${address.toUpperCase()}`) : '';
        if (text) return text;
      }
    }
    return decodeURIComponent(entityId.split(':').at(-1) || entityId);
  };
  const headerText = (anchor: OfficeHeaderAnchor): string => {
    const cell = anchor.sheetName && anchor.address ? actual.get(`${anchor.sheetName}\u0000${anchor.address}`) : '';
    if (cell) return cell;
    const names = anchor.parts.map((part) => part.kind === 'text' ? part.text : part.kind === 'field' ? (part.binding.label || part.binding.fieldKey) : part.kind === 'union' ? (part.label || part.alternatives.map((a) => a.fieldKey).join(' / ')) : part.operator);
    return names.join('').trim() || anchor.id;
  };
  const place = (row: (typeof bindings.rows)[number], anchor: OfficeHeaderAnchor) => {
    const address = row.cells?.[anchor.id];
    if (isBook) return anchor.sheetName && address && /^[A-Z]+\d+$/i.test(address) ? { sheet: anchor.sheetName, address: address.toUpperCase() } : {};
    // Документ: у строки таблицы нет адреса, её держит закладка
    return address ? { bookmark: address } : {};
  };

  const changes: OfficeChange[] = [];
  for (const write of plan.writes) {
    const row = rowByEntity.get(write.entityId), anchor = anchorById.get(write.anchorId);
    if (!row || !anchor) continue;
    const now = textOf(write.value);
    const stored = row.values?.[anchor.id];
    const where = place(row, anchor);
    const inBook = 'address' in where && where.address ? actual.get(`${where.sheet}\u0000${where.address}`) : undefined;
    // Руками правили, если в ячейке не то, что Flux записал (стёрли — тоже правка): такую строку «Обновить» не заменит
    const manual = stored !== undefined && isBook && 'address' in where && !!where.address && (inBook ?? '') !== textOf(stored);
    if (manual ? (inBook ?? '') === now : stored !== undefined && textOf(stored) === now) continue;
    changes.push({
      kind: stored === undefined ? 'added' : 'changed', entityId: write.entityId, entityLabel: labelOf(write.entityId), anchorId: anchor.id, column: headerText(anchor), ...where,
      was: manual || stored === undefined ? (inBook ?? null) : textOf(stored), now, ...(write.unit ? { unit: write.unit } : {}), ...(manual ? { manual: true } : {}),
    });
  }
  // Значение пропало из источника: документ его не стирает, но человек должен знать
  for (const skip of plan.skips) {
    if (!skip.anchorId) continue;
    const row = rowByEntity.get(skip.entityId), anchor = anchorById.get(skip.anchorId);
    const stored = row?.values?.[skip.anchorId];
    if (!row || !anchor || stored === undefined || textOf(stored) === '') continue;
    changes.push({ kind: 'cleared', entityId: skip.entityId, entityLabel: labelOf(skip.entityId), anchorId: anchor.id, column: headerText(anchor), ...place(row, anchor), was: textOf(stored), now: null });
  }
  // Позиции, которой больше нет в источнике, — по одной записи на строку
  for (const row of bindings.rows) {
    if (fresh.has(row.entityId) || !ENTITY[row.sourceId]) continue;
    const anchor = anchorById.get(row.anchorIds[0] || '');
    changes.push({ kind: 'row-removed', ...(row.removed ? { marked: true } : {}), entityId: row.entityId, entityLabel: labelOf(row.entityId), anchorId: anchor?.id || '', column: anchor ? headerText(anchor) : '', ...(anchor ? place(row, anchor) : {}), was: null, now: null });
  }
  const order = (c: OfficeChange) => { const m = /^([A-Z]+)(\d+)$/.exec(c.address || ''); return m ? Number(m[2]) * 1000 + columnNumber(m[1]!) : 1e12; };
  changes.sort((a, b) => order(a) - order(b) || a.entityLabel.localeCompare(b.entityLabel, 'ru'));
  // Ручные правки в счёт устаревшего не идут: «Обновить» их не заменит, и документ всё время считался бы устаревшим
  // Помеченная строка снятой позиции — тоже: человек уже решил, как с ней быть, полоса не должна висеть вечно
  const count = changes.filter((change) => !change.manual && !change.marked).length;
  return { stale: count > 0, count, rows: bindings.rows.length, changes, checkedAt };
}
