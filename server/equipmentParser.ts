import * as XLSX from 'xlsx';
import { XMLParser } from 'fast-xml-parser';
import { canonicalUnit, isKnownUnit } from './normalize.js';

// ── Структурированный результат разбора расчёта вентиляционного оборудования ──
export interface SpecParam { key: string; value: string; unit: string; }
export interface SpecGroup { title: string; params: SpecParam[]; }
export interface ParsedBlock { name: string; title: string; equipType: string; groups: SpecGroup[]; tags?: string[]; }
export interface ParsedMonoblock { name: string; title: string; blocks: ParsedBlock[]; }
export interface ParsedUnit { name: string; title: string; groups: SpecGroup[]; monoblocks: ParsedMonoblock[]; tags?: string[]; }
export interface EquipParseResult { units: ParsedUnit[]; }

// Тип детали по её названию (для группировки и профилей видимости)
const TYPE_RULES: { type: string; kw: string[] }[] = [
  { type: 'КЛАПАН', kw: ['клапан'] },
  { type: 'ФИЛЬТР', kw: ['фильтр'] },
  { type: 'НАГРЕВАТЕЛЬ', kw: ['нагреват', 'нагрев', 'тэн', 'калорифер'] },
  { type: 'ОХЛАДИТЕЛЬ', kw: ['охладит', 'охлажд', 'фреон', 'испарит'] },
  { type: 'ВЕНТИЛЯТОР', kw: ['вентилятор', 'вск', 'радиальн'] },
  { type: 'УВЛАЖНИТЕЛЬ', kw: ['увлажнит'] },
  { type: 'РЕКУПЕРАТОР', kw: ['рекуператор', 'утилизат', 'теплоутил'] },
  { type: 'ШУМОГЛУШИТЕЛЬ', kw: ['шумоглуш', 'глушител'] },
  { type: 'КАМЕРА', kw: ['камера', 'промежуточн'] },
  { type: 'ВОЗДУХОПРИЁМНЫЙ', kw: ['воздухоприемн', 'воздухоприёмн', 'приемн', 'панель', 'заслонк'] },
  { type: 'ЗАВЕСА', kw: ['завеса'] },
  { type: 'СЕКЦИЯ', kw: ['секция'] },
];

export function detectEquipType(text: string): string {
  const t = (text || '').toLowerCase();
  for (const r of TYPE_RULES) {
    if (r.kw.some(k => t.includes(k))) return r.type;
  }
  return 'ПРОЧЕЕ';
}

// ── Словари распознавания шапок и единиц (нормализованные основы) ──
const HEADER_KEY_STEMS = ['параметр', 'наименован', 'показател', 'свойств', 'характеристик', 'parameter', 'property'];
const HEADER_VALUE_STEMS = ['значен', 'величин', 'value'];
const HEADER_UNIT_STEMS = ['ед', 'unit', 'единиц'];

// Единицы измерения — из общего словаря (server/normalize.ts): свой список
// здесь расходился с ним, и одно и то же написание в разных местах программы
// то считалось единицей, то нет.
const isUnitWord = (s: string) => isKnownUnit(s);

// Число в русской записи: «1 250,5», «0,50» (для классификации колонок)
function looksNumeric(v: any, w: string): boolean {
  if (typeof v === 'number') return true;
  const s = String(w || '').replace(/[\s ]/g, '').replace(',', '.');
  return s !== '' && /^-?\d+(\.\d+)?$/.test(s);
}

const hasStem = (s: string, stems: string[]) => {
  const t = s.toLowerCase();
  return stems.some(st => t.includes(st));
};

// ── Сетка листа: сырое (v) и отображаемое (w) значение каждой ячейки ──
// Отображаемое — то, что инженер видел в Excel: даты вместо серийных чисел,
// «0,50» вместо 0.5. Объединённые ячейки разворачиваются (значение копируется
// во весь диапазон) — двухстрочные шапки и «лесенки» перестают давать пустые ключи.
interface GridCell { v: any; w: string; merged?: boolean }
type GridRow = GridCell[];

const MAX_ROWS = 5000;
const MAX_COLS = 64;

function cellText(c: GridCell | undefined): string {
  if (!c) return '';
  if (c.w !== '') return c.w;
  return c.v === null || c.v === undefined ? '' : String(c.v).trim();
}

function readSheetGrid(wb: XLSX.WorkBook, name: string): GridRow[] {
  const sheet = wb.Sheets[name];
  if (!sheet || !sheet['!ref']) return [];
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const rEnd = Math.min(range.e.r, range.s.r + MAX_ROWS - 1);
  const cEnd = Math.min(range.e.c, range.s.c + MAX_COLS - 1);

  const rows: GridRow[] = [];
  for (let r = range.s.r; r <= rEnd; r++) {
    const row: GridRow = [];
    for (let c = range.s.c; c <= cEnd; c++) {
      const cell: any = (sheet as any)[XLSX.utils.encode_cell({ r, c })];
      row.push({
        v: cell?.v ?? '',
        w: String(cell?.w ?? (cell?.v ?? '')).trim(),
      });
    }
    rows.push(row);
  }

  // Разворачиваем объединённые ячейки
  for (const m of (sheet['!merges'] || [])) {
    const src = rows[m.s.r - range.s.r]?.[m.s.c - range.s.c];
    if (!src) continue;
    for (let r = m.s.r; r <= Math.min(m.e.r, rEnd); r++) {
      for (let c = m.s.c; c <= Math.min(m.e.c, cEnd); c++) {
        if (r === m.s.r && c === m.s.c) continue;
        const target = rows[r - range.s.r]?.[c - range.s.c];
        if (target) { target.v = src.v; target.w = src.w; target.merged = true; }
      }
    }
  }
  return rows;
}

// Обратная совместимость: extractGroupedSpecs принимает и «голые» строки
function toGrid(rows: any[][]): GridRow[] {
  return rows.map(r => (r || []).map(c => ({
    v: c ?? '',
    w: c === null || c === undefined ? '' : String(c).trim(),
  })));
}

// ── Классификатор колонок таблицы параметров (§3.1 дизайна) ──
// Определяет по СОДЕРЖИМОМУ, где ключ, где значение(я), где единицы —
// вместо жёсткого «0/1/2». При слабых сигналах возвращает раскладку,
// эквивалентную старому поведению (совместимость с текущими бланками).
interface ColumnLayout {
  keyCol: number;
  valueCols: { col: number; label: string }[]; // >1 = приток/вытяжка и т.п.
  unitCol: number | null;
  headerRowIdx: number | null; // строка-шапка «Параметр|Значение|ед» — пропускается
}

const ORDINAL_MARKERS = ['№', '#', 'n', 'пп', 'поз', 'номер'];
const isOrdinalLabel = (s: string) => {
  const t = s.toLowerCase().replace(/[\s ./]/g, '');
  return t !== '' && ORDINAL_MARKERS.some(m => t === m || t.startsWith(m));
};

function classifyColumns(rows: GridRow[], startIdx: number): ColumnLayout {
  const maxCols = Math.min(MAX_COLS, Math.max(0, ...rows.map(r => r.length)));

  // ── 1. Строка-шапка ищется НЕЗАВИСИМО от колонок: ≥2 ячейки со словами
  // ключ/значение/ед/№ из словарей. Детект не зависит от числа строк данных.
  let headerRowIdx: number | null = null;
  for (let i = startIdx; i < Math.min(startIdx + 5, rows.length); i++) {
    let hits = 0;
    for (const c of (rows[i] || [])) {
      const s = cellText(c);
      if (s === '') continue;
      if (hasStem(s, HEADER_KEY_STEMS) || hasStem(s, HEADER_VALUE_STEMS) || hasStem(s, HEADER_UNIT_STEMS) || isOrdinalLabel(s)) hits++;
    }
    if (hits >= 2) { headerRowIdx = i; break; }
  }

  // Самая «текстовая» колонка среди строк данных (для ключа), исключая шапку
  const pickTextCol = (): number => {
    const text = new Array(maxCols).fill(0);
    for (let i = startIdx; i < rows.length; i++) {
      if (i === headerRowIdx) continue;
      const r = rows[i] || [];
      const filled = r.filter(c => cellText(c) !== '');
      if (new Set(filled.map(cellText)).size < 2) continue;
      for (let c = 0; c < maxCols; c++) {
        const s = cellText(r[c]);
        if (s !== '' && !isUnitWord(s) && !looksNumeric(r[c]?.v, s) && /[a-zа-яё]/i.test(s)) text[c]++;
      }
    }
    let best = 0, bestC = 0;
    for (let c = 0; c < maxCols; c++) if (text[c] > best) { best = text[c]; bestC = c; }
    return bestC;
  };

  // ── 2а. Есть шапка → классифицируем по её подписям ──
  if (headerRowIdx !== null) {
    const hdr = (rows[headerRowIdx] || []).map(cellText);
    let keyCol = -1;
    let unitCol: number | null = null;
    const valueCols: { col: number; label: string }[] = [];
    for (let c = 0; c < maxCols; c++) {
      const label = hdr[c];
      if (label === '') continue;
      if (isOrdinalLabel(label)) continue;                       // «№» — пропускаем
      if (hasStem(label, HEADER_UNIT_STEMS)) { if (unitCol === null) unitCol = c; continue; }
      if (hasStem(label, HEADER_KEY_STEMS)) { if (keyCol === -1) keyCol = c; continue; }
      valueCols.push({ col: c, label: hasStem(label, HEADER_VALUE_STEMS) ? '' : label });
    }
    if (keyCol === -1) keyCol = pickTextCol();
    let vcs = valueCols.filter(v => v.col !== keyCol && v.col !== unitCol);

    // Несколько подписанных колонок значений (приток/вытяжка) — с суффиксами;
    // иначе одна колонка значений без суффикса (обычный бланк)
    const labelled = vcs.filter(v => v.label);
    if (!(labelled.length >= 2)) {
      const primary = vcs.find(v => v.col > keyCol) ?? vcs[0];
      vcs = primary ? [{ col: primary.col, label: '' }] : [];
    }
    if (vcs.length > 0) return { keyCol, valueCols: vcs, unitCol, headerRowIdx };
    // шапка есть, но колонку значений не нашли — падаем в позиционный фоллбэк ниже
  }

  // ── 2б. Шапки нет → классификация по содержимому колонок ──
  const paramRows = rows.slice(startIdx).filter(r => {
    const filled = r.filter(c => cellText(c) !== '');
    return filled.length >= 2 && new Set(filled.map(cellText)).size >= 2;
  });
  const stats = Array.from({ length: maxCols }, () => ({ nonEmpty: 0, text: 0, num: 0, unit: 0, ordinal: 0 }));
  for (const r of paramRows) {
    for (let c = 0; c < maxCols; c++) {
      const s = cellText(r[c]);
      if (s === '') continue;
      const st = stats[c];
      st.nonEmpty++;
      if (isUnitWord(s)) st.unit++;
      else if (looksNumeric(r[c]?.v, s)) { st.num++; if (/^\d{1,3}$/.test(s)) st.ordinal++; }
      else if (/[a-zа-яё]/i.test(s)) st.text++;
    }
  }
  const total = Math.max(1, paramRows.length);

  const isOrdinalCol = (c: number) => {
    if (stats[c].ordinal / total < 0.6) return false;
    const nums = paramRows.map(r => Number(String(cellText(r[c])).trim())).filter(n => !isNaN(n));
    if (nums.length < 2) return false;
    let asc = 0;
    for (let i = 1; i < nums.length; i++) if (nums[i] >= nums[i - 1]) asc++;
    return asc / (nums.length - 1) > 0.8;
  };

  let keyCol = 0, bestText = -1, seen = 0;
  for (let c = 0; c < maxCols && seen < 3; c++) {
    if (stats[c].nonEmpty === 0 || isOrdinalCol(c)) continue;
    seen++;
    if (stats[c].text > bestText) { bestText = stats[c].text; keyCol = c; }
  }

  let unitCol: number | null = null;
  for (let c = 0; c < maxCols; c++) {
    if (c === keyCol || stats[c].nonEmpty === 0) continue;
    if (stats[c].unit / stats[c].nonEmpty >= 0.4 && (unitCol === null || c > unitCol)) unitCol = c;
  }

  const valueCandidates: number[] = [];
  for (let c = 0; c < maxCols; c++) {
    if (c === keyCol || c === unitCol || isOrdinalCol(c)) continue;
    if (stats[c].nonEmpty / total >= 0.3) valueCandidates.push(c);
  }
  const primaryC = valueCandidates.find(c => c > keyCol) ?? valueCandidates[0];
  const valueCols = primaryC !== undefined ? [{ col: primaryC, label: '' }] : [];

  // Слабые сигналы → историческая раскладка «0/1/2»
  if (paramRows.length === 0 || valueCols.length === 0) {
    return { keyCol: 0, valueCols: [{ col: 1, label: '' }], unitCol: 2, headerRowIdx };
  }
  return { keyCol, valueCols, unitCol, headerRowIdx };
}

// ── Строки листа → сгруппированные параметры ──
// Заголовок группы: одна значимая ячейка в строке (включая развёрнутые merged —
// повторы одного значения считаются одной ячейкой).
export function extractGroupedSpecs(rowsIn: any[][] | GridRow[], skipTitleRow = true): SpecGroup[] {
  const rows: GridRow[] = rowsIn.length && typeof (rowsIn[0] as any[])[0] === 'object' && (rowsIn[0] as GridRow)[0] !== null && 'w' in ((rowsIn[0] as GridRow)[0] || {})
    ? (rowsIn as GridRow[])
    : toGrid(rowsIn as any[][]);

  const startIdx = skipTitleRow ? 1 : 0;
  const layout = classifyColumns(rows, startIdx);

  const groups: SpecGroup[] = [];
  let current: SpecGroup | null = null;
  const ensureDefault = () => {
    if (!current) { current = { title: 'Основные', params: [] }; groups.push(current); }
    return current;
  };

  for (let i = startIdx; i < rows.length; i++) {
    if (i === layout.headerRowIdx) continue;
    const row = rows[i] || [];
    const texts = row.map(cellText);
    const nonEmpty = texts.filter(t => t !== '');
    if (nonEmpty.length === 0) continue;

    const first = texts[layout.keyCol] || nonEmpty[0];

    // Повторная шапка внутри листа (многостраничные бланки) — пропускаем
    if (hasStem(first, HEADER_KEY_STEMS) && nonEmpty.length <= 3) continue;

    // Заголовок группы: одно значимое значение (merged-развёртка дает повторы)
    const distinct = new Set(nonEmpty);
    if (distinct.size === 1) {
      current = { title: nonEmpty[0], params: [] };
      groups.push(current);
      continue;
    }

    if (!first) continue;

    // Параметр: одна или несколько колонок значений
    const unit = layout.unitCol !== null ? (texts[layout.unitCol] || '') : '';
    const cleanUnit = hasStem(unit, HEADER_UNIT_STEMS) || hasStem(unit, HEADER_VALUE_STEMS) ? '' : unit;
    let emitted = false;
    for (const vc of layout.valueCols) {
      const value = texts[vc.col] || '';
      if (value === '') continue;
      const key = vc.label && layout.valueCols.length > 1 ? `${first} (${vc.label})` : first;
      ensureDefault().params.push({ key, value, unit: canonicalUnit(cleanUnit) });
      emitted = true;
    }
    // Значение вне размеченных колонок (кривая строка) — старое поведение: вторая ячейка
    if (!emitted && nonEmpty.length >= 2) {
      const value = nonEmpty[1];
      if (!isUnitWord(value)) ensureDefault().params.push({ key: first, value, unit: canonicalUnit(cleanUnit) });
    }
  }

  return groups.filter(g => g.params.length > 0);
}

// ── Поиск листа по коду/описанию ──
// Нормализация «бл 2.1 (Клапан)» → «бл2.1(клапан)»; лист подходит, если
// его нормализованное имя равно коду или начинается с него.
function findSheet(sheetNames: string[], code: string, desc: string): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[\s ]/g, '');
  const c = norm(code);
  if (!c) return null;
  let hit = sheetNames.find(n => norm(n) === c);
  if (hit) return hit;
  hit = sheetNames.find(n => norm(n).startsWith(c) && /[^a-zа-яё0-9]|^$/i.test(norm(n).slice(c.length, c.length + 1)));
  if (hit) return hit;
  // числовой префикс описания вида "2.1." → ищем лист "бл2.1"
  const m = (desc || '').match(/^(\d+(?:\.\d+)*)/);
  if (m) {
    const num = m[1];
    hit = sheetNames.find(n => norm(n) === `бл${num}` || norm(n) === num);
    if (hit) return hit;
  }
  return null;
}

const reUnit = /^[уy]\d+/i;
const reMono = /^(мн|mn|mb)\d+/i;
const reBlock = /^(бл|bl)\d+/i;
const reSupp = /^(шум|схема|диаг|вент|вспом|sound|scheme|diag)/i;
const reProject = /^(п|проект|project)$/i;

// ── Разбор книги Excel/расчёта → иерархия установок ──
export function parseEquipmentExcel(buffer: Buffer): EquipParseResult {
  // cellNF/cellText: нужны отображаемые значения (даты, форматированные числа)
  const wb = XLSX.read(buffer, { type: 'buffer', cellNF: true, cellText: true });
  const sheetNames = wb.SheetNames;
  const result: EquipParseResult = { units: [] };
  if (sheetNames.length === 0) return result;

  const gridCache = new Map<string, GridRow[]>();
  const readRows = (name: string): GridRow[] => {
    if (!gridCache.has(name)) gridCache.set(name, readSheetGrid(wb, name));
    return gridCache.get(name)!;
  };

  // Лист-оглавление: "0" / "index" / первый
  const indexName = sheetNames.find(n => n === '0' || n.toLowerCase().trim() === 'index') || sheetNames[0];
  const indexRows = readRows(indexName);

  // Является ли оглавление списком "код | описание"
  const looksLikeIndex = indexRows.some(r => {
    const code = cellText((r || [])[0]);
    return reUnit.test(code) || reMono.test(code) || reBlock.test(code);
  });

  if (looksLikeIndex) {
    let unit: ParsedUnit | null = null;
    let mono: ParsedMonoblock | null = null;

    for (const r of indexRows) {
      const code = cellText((r || [])[0]);
      const desc = cellText((r || [])[1]);
      if (!code || reProject.test(code) || reSupp.test(code)) continue;

      if (reUnit.test(code)) {
        unit = { name: code, title: desc || code, groups: [], monoblocks: [] };
        result.units.push(unit);
        mono = null;
        const sh = findSheet(sheetNames, code, desc);
        if (sh) unit.groups = extractGroupedSpecs(readRows(sh));
      } else if (reMono.test(code)) {
        if (!unit) { unit = { name: 'у1', title: 'Установка', groups: [], monoblocks: [] }; result.units.push(unit); }
        mono = { name: code, title: desc || code, blocks: [] };
        unit.monoblocks.push(mono);
        const sh = findSheet(sheetNames, code, desc);
        if (sh) {
          const g = extractGroupedSpecs(readRows(sh));
          if (g.length) mono.blocks.push({ name: code + '_общие', title: 'Общие параметры моноблока', equipType: 'МОНОБЛОК', groups: g });
        }
      } else if (reBlock.test(code) || findSheet(sheetNames, code, desc)) {
        if (!unit) { unit = { name: 'у1', title: 'Установка', groups: [], monoblocks: [] }; result.units.push(unit); }
        if (!mono) { mono = { name: 'мн1', title: 'Моноблок', blocks: [] }; unit.monoblocks.push(mono); }
        const sh = findSheet(sheetNames, code, desc);
        const groups = sh ? extractGroupedSpecs(readRows(sh)) : [];
        mono.blocks.push({ name: code, title: desc || code, equipType: detectEquipType(desc || code), groups });
      }
    }
    if (result.units.length) return result;
  }

  // ── Фоллбэк для «своих» файлов без стандартного оглавления ──
  // Каждый содержательный лист трактуем как отдельный блок одной установки.
  const unit: ParsedUnit = { name: 'Импорт', title: 'Импортированное оборудование', groups: [], monoblocks: [] };
  const mono: ParsedMonoblock = { name: 'мн1', title: 'Оборудование', blocks: [] };
  unit.monoblocks.push(mono);
  for (const name of sheetNames) {
    if (name === indexName && looksLikeIndex) continue;
    const rows = readRows(name);
    if (!rows.length) continue;
    const title = cellText((rows[0] || [])[0]) || name;
    const groups = extractGroupedSpecs(rows);
    if (groups.length === 0) continue;
    mono.blocks.push({ name, title, equipType: detectEquipType(title), groups });
  }
  if (mono.blocks.length) result.units.push(unit);
  return result;
}

// ── Разбор XML-расчёта → та же иерархия ──
// Настоящий XML-парсер (fast-xml-parser): CDATA, namespace-префиксы и вложенность
// перестают терять данные. Прежний разбор регулярками — аварийный фоллбэк.
const TAG_SYNONYMS = {
  system: ['system', 'equipmentsystem', 'установка', 'unit'],
  monoblock: ['monoblock', 'моноблок', 'mb'],
  block: ['block', 'блок', 'component', 'element'],
  group: ['group', 'группа', 'section'],
  param: ['param', 'параметр', 'property'],
};

// Имя тега без namespace-префикса, в нижнем регистре
const localName = (tag: string) => tag.toLowerCase().split(':').pop() || '';
const matches = (tag: string, kind: keyof typeof TAG_SYNONYMS) => TAG_SYNONYMS[kind].includes(localName(tag));

function xAttr(node: any, ...names: string[]): string {
  if (!node || typeof node !== 'object') return '';
  for (const key of Object.keys(node)) {
    if (!key.startsWith('@_')) continue;
    const bare = localName(key.slice(2));
    if (names.includes(bare)) return String(node[key] ?? '').trim();
  }
  return '';
}

// Все дочерние узлы данного вида (fast-xml-parser: одиночный ребёнок — объект, повторы — массив)
function xChildren(node: any, kind: keyof typeof TAG_SYNONYMS): any[] {
  if (!node || typeof node !== 'object') return [];
  const out: any[] = [];
  for (const key of Object.keys(node)) {
    if (key.startsWith('@_') || key === '#text' || key === '#cdata') continue;
    if (!matches(key, kind)) continue;
    const v = node[key];
    out.push(...(Array.isArray(v) ? v : [v]));
  }
  return out;
}

function xText(node: any): string {
  if (node === null || node === undefined) return '';
  if (typeof node !== 'object') return String(node).trim();
  const t = node['#text'] ?? node['#cdata'] ?? '';
  return String(t).trim();
}

function xParams(node: any): SpecParam[] {
  return xChildren(node, 'param')
    .map(p => ({
      key: xAttr(p, 'name', 'key', 'параметр'),
      value: xText(p),
      unit: canonicalUnit(xAttr(p, 'unit', 'ед')),
    }))
    .filter(p => p.key);
}

function xBlocks(node: any): ParsedBlock[] {
  return xChildren(node, 'block').map((b, i) => {
    const name = xAttr(b, 'name', 'код') || `бл${i + 1}`;
    const title = xAttr(b, 'title', 'описание') || name;
    const groups: SpecGroup[] = xChildren(b, 'group').map(g => ({
      title: xAttr(g, 'title', 'name') || 'Основные',
      params: xParams(g),
    }));
    if (groups.length === 0) {
      const params = xParams(b);
      if (params.length) groups.push({ title: 'Основные', params });
    }
    return { name, title, equipType: detectEquipType(title), groups: groups.filter(g => g.params.length) };
  });
}

// Рекурсивный поиск узлов-систем на любом уровне вложенности
function findSystems(node: any, acc: any[]): void {
  if (!node || typeof node !== 'object') return;
  for (const key of Object.keys(node)) {
    if (key.startsWith('@_') || key === '#text' || key === '#cdata') continue;
    const v = node[key];
    const items = Array.isArray(v) ? v : [v];
    if (matches(key, 'system')) acc.push(...items);
    else for (const item of items) findSystems(item, acc);
  }
}

export function parseEquipmentXML(xmlText: string): EquipParseResult {
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      cdataPropName: '#cdata',
      trimValues: true,
      parseTagValue: false,
      parseAttributeValue: false,
    });
    const doc = parser.parse(xmlText);

    const systems: any[] = [];
    findSystems(doc, systems);

    const result: EquipParseResult = { units: [] };
    for (const sys of systems) {
      const sysName = xAttr(sys, 'name', 'код') || `у${result.units.length + 1}`;
      const unit: ParsedUnit = {
        name: sysName,
        title: xAttr(sys, 'title', 'описание') || sysName,
        groups: [],
        monoblocks: [],
      };
      result.units.push(unit);

      const monos = xChildren(sys, 'monoblock');
      for (const mb of monos) {
        const mbName = xAttr(mb, 'name') || `мн${unit.monoblocks.length + 1}`;
        unit.monoblocks.push({ name: mbName, title: xAttr(mb, 'title') || mbName, blocks: xBlocks(mb) });
      }
      if (monos.length === 0) {
        const blocks = xBlocks(sys);
        if (blocks.length) unit.monoblocks.push({ name: 'мн1', title: 'Оборудование', blocks });
      }
    }
    if (result.units.length) return result;
  } catch (err) {
    console.warn('[equipmentParser] XML-парсер не справился, фоллбэк на регулярки:', (err as any)?.message);
  }
  return parseEquipmentXMLLegacy(xmlText);
}

// ── Прежний разбор регулярками — аварийный фоллбэк ──
function parseEquipmentXMLLegacy(xmlText: string): EquipParseResult {
  const result: EquipParseResult = { units: [] };
  const attr = (s: string, a: string) => (s.match(new RegExp(`${a}\\s*=\\s*"([^"]*)"`, 'i')) || [])[1] || '';

  // Границу имени тега задаём просмотром на пробел, «/» или «>», а не \b:
// в JavaScript \b кириллицу словом не считает, и «<установка …>» не
// находилось вовсе — файл с русскими тегами импортировался пустым
const sysRe = /<(?:system|EquipmentSystem|установка|unit)(?=[\s/>])([^>]*)>([\s\S]*?)<\/(?:system|EquipmentSystem|установка|unit)>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = sysRe.exec(xmlText))) {
    const sysName = attr(sm[1], 'name') || attr(sm[1], 'код') || `у${result.units.length + 1}`;
    const sysTitle = attr(sm[1], 'title') || attr(sm[1], 'описание') || sysName;
    const unit: ParsedUnit = { name: sysName, title: sysTitle, groups: [], monoblocks: [] };
    result.units.push(unit);

    const mbRe = /<(?:monoblock|моноблок|mb)(?=[\s/>])([^>]*)>([\s\S]*?)<\/(?:monoblock|моноблок|mb)>/gi;
    let mbm: RegExpExecArray | null;
    let foundMb = false;
    while ((mbm = mbRe.exec(sm[2]))) {
      foundMb = true;
      const mbName = attr(mbm[1], 'name') || `мн${unit.monoblocks.length + 1}`;
      const mono: ParsedMonoblock = { name: mbName, title: attr(mbm[1], 'title') || mbName, blocks: [] };
      unit.monoblocks.push(mono);
      mono.blocks.push(...parseXmlBlocksLegacy(mbm[2], attr));
    }
    if (!foundMb) {
      const mono: ParsedMonoblock = { name: 'мн1', title: 'Оборудование', blocks: [] };
      const blocks = parseXmlBlocksLegacy(sm[2], attr);
      if (blocks.length) { mono.blocks.push(...blocks); unit.monoblocks.push(mono); }
    }
  }
  return result;
}

function parseXmlBlocksLegacy(inner: string, attr: (s: string, a: string) => string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const blRe = /<(?:block|блок|component|element)(?=[\s/>])([^>]*)>([\s\S]*?)<\/(?:block|блок|component|element)>/gi;
  let bm: RegExpExecArray | null;
  while ((bm = blRe.exec(inner))) {
    const name = attr(bm[1], 'name') || attr(bm[1], 'код') || `бл${blocks.length + 1}`;
    const title = attr(bm[1], 'title') || attr(bm[1], 'описание') || name;
    const groups: SpecGroup[] = [];
    const grRe = /<(?:group|группа|section)(?=[\s/>])([^>]*)>([\s\S]*?)<\/(?:group|группа|section)>/gi;
    let gm: RegExpExecArray | null;
    let hasGroups = false;
    while ((gm = grRe.exec(bm[2]))) {
      hasGroups = true;
      groups.push({ title: attr(gm[1], 'title') || attr(gm[1], 'name') || 'Основные', params: parseXmlParamsLegacy(gm[2], attr) });
    }
    if (!hasGroups) {
      const params = parseXmlParamsLegacy(bm[2], attr);
      if (params.length) groups.push({ title: 'Основные', params });
    }
    blocks.push({ name, title, equipType: detectEquipType(title), groups: groups.filter(g => g.params.length) });
  }
  return blocks;
}

function parseXmlParamsLegacy(inner: string, attr: (s: string, a: string) => string): SpecParam[] {
  const params: SpecParam[] = [];
  const pRe = /<(?:param|параметр|property)(?=[\s/>])([^>]*)>([\s\S]*?)<\/(?:param|параметр|property)>/gi;
  let pm: RegExpExecArray | null;
  while ((pm = pRe.exec(inner))) {
    const key = attr(pm[1], 'name') || attr(pm[1], 'key') || attr(pm[1], 'параметр');
    const unit = attr(pm[1], 'unit') || attr(pm[1], 'ед');
    const value = pm[2].replace(/<[^>]+>/g, '').trim();
    if (key) params.push({ key, value, unit: canonicalUnit(unit) });
  }
  return params;
}
