// Распознавание документа: работает с промежуточной моделью (types.ts)
// и не знает, из какого формата пришли блоки. Чистые функции — тестируются в Node.

import {
  DocBlock, DocTable, ExtractedDoc, DraftResult, DraftItem, DraftField, DocType, Confidence,
  LearnObservation,
} from './types';
import {
  FIELDS, FieldDef, matchLabel, detectEquip, findSystem, normalizeCode, looksLikeCode,
  splitValueUnit, unitFromLabel, validateValue, GARBAGE_MARKERS, PAGE_MARKER_RE,
  ADMIN_LABEL_RE, ADMIN_TAG_RE, ADMIN_VENDOR_RE, textQuality, sanitizeText,
  dedupeRepeatedPhrase, parseFormulaLine, normalizeLabel, fieldByUniqueUnit, splitTagList,
} from './dictionary';
import { resolveSymbol, looksLikeSymbol } from './symbols';
import { crossCheckFan, isImplausible } from './valueGrammar';

let idSeq = 0;
const nextId = () => `draft-${++idSeq}`;

// Позиционный тег KKS: 3700-B09-AS-001В, 7421-S01-AN-001. Это НЕ марка изделия —
// не должен попадать в brand при дочитывании прозы/секций.
const KKS_TAG_RE = /^\d{3,4}-[A-Za-zА-Яа-я]\d{1,2}-[A-Za-zА-Яа-я]{1,3}-\d{2,4}[A-Za-zА-Яа-я]?$/;
export function isKksTag(s: string): boolean {
  return KKS_TAG_RE.test((s || '').trim());
}

// Оставлять ли нераспознанный параметр в «Прочее». Пользователю не нужен поток
// строительных примечаний («сторона: справа», «выбор: оптимальный») — берём только
// то, что похоже на реальную характеристику: число с единицей, код или короткий индекс.
function isUsefulRawParam(value: string, unit: string, source?: RawPair['source']): boolean {
  const v = (value || '').trim();
  if (!v) return false;
  if (unit) return v.length <= 60;                        // число + единица (dpсеть=700 Па)
  if (v.length <= 40) {
    if (/^[~≈]?-?\d[\d\s.,]*\s*[^\s]{0,6}$/.test(v) && /\d/.test(v)) return true; // число (возможно с коротким хвостом)
    if (looksLikeCode(v)) return true;                    // код с разделителем
    if (/^[A-Za-zА-Яа-я]{0,4}\d{1,4}[A-Za-zА-Яа-я]{0,4}$/.test(v)) return true;   // короткий индекс G4, IP54, У2
  }
  // Короткое словесное значение из таблицы свойств («назначение — нормально
  // закрытый», «огнестойкость — EI 90», «взрывозащита — Взрывозащищённый»):
  // это данные бланка, а не примечание. Примечания приходят абзацами, не
  // строками таблицы, поэтому источник здесь и решает. Раньше отбрасывалось
  // всё словесное подряд — из листа на клапаны пропадала половина свойств.
  if (source === 'table' && v.length <= 80 && v.split(/\s+/).length <= 8 && !/[.!?]\s/.test(v)) return true;
  return false;
}

// ── Классификация абзаца ─────────────────────────────────────────────────────

type ParaClass = 'prose' | 'kvline' | 'heading' | 'garbage' | 'empty';

// Нумерованный заголовок раздела бланка: «1.», «2.4.», «5.1.» и название.
// Это разметка документа, а не словарное слово: раньше заголовком считалась
// только строка, в которой словарь узнал тип оборудования, поэтому «2.3. Камера
// промежуточная» разделом не становилась — и её данные приклеивались к
// предыдущему блоку. В листе на установку так терялась половина секций.
const SECTION_NO_RE = /^(\d{1,2}(?:\.\d{1,2}){0,2})\.?\s+(?=\S)/;

/** «1.2. Фильтр карманный» → «1.2»; не заголовок → null */
export function sectionNumber(text: string): string | null {
  const t = (text || '').trim();
  if (!t || t.length > 120 || /\n/.test(t)) return null;
  const m = t.match(SECTION_NO_RE);
  if (!m) return null;
  // Примечание («1. Клапаны изготовить с…») — это предложение: точка в конце
  if (/[.!?]$/.test(t)) return null;
  // Ссылка на документ или перечисление («1. см. PDH2…-0001») заголовком не считаем
  const rest = t.slice(m[0].length);
  if (!rest || rest.length < 3) return null;
  return m[1];
}

export function classifyParagraph(text: string): ParaClass {
  const t = (text || '').trim();
  if (!t) return 'empty';
  const low = t.toLowerCase();
  if (PAGE_MARKER_RE.test(low)) return 'garbage';
  if (GARBAGE_MARKERS.some(g => low.startsWith(g) || (t.length < 60 && low.includes(g)))) return 'garbage';
  // «Ключ: значение» или «Ключ — значение» в короткой строке
  if (t.length <= 90 && /^[^:—-]{2,45}[:—]\s*\S/.test(t) && !/[.!?].*[.!?]/.test(t)) {
    const key = t.split(/[:—]/)[0];
    if (matchLabel(key)) return 'kvline';
  }
  // Нумерованный раздел бланка — заголовок независимо от словаря
  if (sectionNumber(t)) return 'heading';
  // Короткая строка с типом оборудования и без глагольной прозы — заголовок секции.
  // Примечания («* — …», «…с учётом 10% запаса») заголовками не считаем.
  if (t.length <= 70 && detectEquip(t) && !/[.!?]$/.test(t)
      && !/^[*•\-–—]/.test(t) && !/%|учет|учёт|запас/i.test(t)) return 'heading';
  return 'prose';
}

// ── Классификация таблицы ────────────────────────────────────────────────────

export type TableShape = 'attribute' | 'entity' | 'matrix' | 'layout' | 'kvgrid' | 'admin';

// Строка вида «ключ: значение» или «ключ = значение» с коротким ключом
const KV_LINE_RE = /^[^:=\n]{1,45}[:=]\s*\S/;

export function classifyTable(rows: string[][]): TableShape {
  const nonEmptyRows = rows.filter(r => r.some(c => (c || '').trim()));
  if (nonEmptyRows.length === 0) return 'layout';
  const colCount = Math.max(...nonEmptyRows.map(r => r.length));

  // kv-сетка: пары «ключ: значение» лежат ВНУТРИ ячеек (типичный бланк-раскладка
  // в две колонки). Каждая ячейка разбирается независимо, строки таблицы не пары.
  {
    let cells = 0, kvCells = 0;
    for (const r of nonEmptyRows) {
      for (const c of r) {
        const t = (c || '').trim();
        if (!t) continue;
        cells++;
        const lines = t.split('\n');
        if (lines.some(l => KV_LINE_RE.test(l) || parseFormulaLine(l).length > 0)) kvCells++;
      }
    }
    if (cells >= 4 && kvCells / cells >= 0.45) return 'kvgrid';
  }

  // Административная шапка (CONTRACTOR/OWNER/заказчик/ревизии): почти все подписи —
  // реквизиты документа. Из неё берём только тег позиции и производителя.
  {
    let labeled = 0, admin = 0;
    for (const r of nonEmptyRows) {
      const label = (r[0] || '').split('\n')[0];
      if (!label.trim()) continue;
      labeled++;
      if (ADMIN_LABEL_RE.test(label)) admin++;
    }
    if (labeled >= 3 && admin / labeled >= 0.5) return 'admin';
  }

  if (colCount < 2) return 'layout';

  // Совпадения словаря в первой колонке
  let col0Matches = 0;
  for (const r of nonEmptyRows) {
    if (matchLabel(r[0] || '')) col0Matches++;
  }

  // Совпадения словаря в первой непустой строке (потенциальная шапка)
  const header = nonEmptyRows[0];
  let headerMatches = 0;
  for (const c of header) if (matchLabel(c || '')) headerMatches++;

  const col0Ratio = col0Matches / nonEmptyRows.length;
  const dataRows = nonEmptyRows.length - 1;

  // Матрица: параметры в строках, типоразмеры в колонках (шапка — коды, не подписи)
  if (col0Ratio >= 0.4 && colCount >= 3 && headerMatches <= 1) {
    const headerCodes = header.slice(1).filter(c => looksLikeCode(c || '') || /\d/.test(c || '')).length;
    if (headerCodes >= 2) return 'matrix';
  }

  if (headerMatches >= 2 && dataRows >= 2 && col0Ratio < 0.4) return 'entity';
  if (col0Ratio >= 0.35) return 'attribute';
  if (headerMatches >= 2 && dataRows >= 1) return 'entity';

  // Структурная атрибутная: почти каждая строка — «подпись | значение».
  // Ловит бланки, где ключи не из словаря (Mвен | 212кг, dpсеть | 700 Па,
  // «огнестойкость по ГОСТ | EI 90»). Колонок считаем только непустые: в
  // выгрузке из Excel объединённые ячейки дают пустые столбцы, и таблица
  // свойств на пять колонок раньше уходила в «оформительские» — вместе со
  // всеми общими характеристиками вида оборудования.
  if (nonEmptyRows.length >= 2) {
    let pairRows = 0;
    for (const r of nonEmptyRows) {
      const cells = r.map(c => (c || '').trim()).filter(Boolean);
      const k = cells[0] || '';
      const v = cells[1] || '';
      if (k && v && k.length <= 48 && cells.length <= 4 && !k.includes('\n')) pairRows++;
    }
    if (pairRows / nonEmptyRows.length >= 0.6) return 'attribute';
  }
  return 'layout';
}

// ── Извлечение пар из разных форм ────────────────────────────────────────────

interface RawPair {
  label: string;
  value: string;
  unit: string;
  source: DraftField['source'];
  /** Поле уже известно (формульные записи: Lв=140 м³/ч → airflow по единице) */
  fieldId?: string;
  /** Подпись уже человеческая (справочник обозначений) — не заменять на общую */
  named?: boolean;
}

/** Строка «ключ: значение» → пара; formула → набор пар; иначе null */
function pairsFromLine(line: string, source: DraftField['source']): RawPair[] | null {
  const t = (line || '').trim();
  if (!t) return null;
  // Формульная запись: «Lв=42860м³/ч; Pполн=250 Па» / «Эл. двиг: Ny=0,07 кВт; …»
  const formulaPart = t.replace(/^[^:=]{1,20}:\s*(?=.*=)/, ''); // отрезаем префикс «Эл. двиг:»
  const fp = parseFormulaLine(formulaPart);
  if (fp.length) {
    return fp.map(f => ({ label: f.label, value: f.value, unit: f.unit, fieldId: f.fieldId, named: f.named, source }));
  }
  if (!KV_LINE_RE.test(t)) return null;
  const sep = t.search(/[:=]/);
  const key = t.slice(0, sep).trim();
  const value = t.slice(sep + 1).trim();
  if (!key || !value) return null;
  const su = splitValueUnit(value);
  return [{ label: key, value, unit: unitFromLabel(key) || su.unit, source }];
}

/**
 * kv-сетка: каждая ячейка — независимые строки «ключ: значение» и формулы.
 * Строки, парой не ставшие, отдаём в прозу (аргумент prose): в бланке-заказе
 * вентилятора там лежит само обозначение изделия
 * («Вентилятор ВИР800-140(1)-Т80-В-…»), и раньше оно пропадало без следа.
 */
function pairsFromKvGrid(rows: string[][], prose?: string[]): RawPair[] {
  const out: RawPair[] = [];
  for (const r of rows) {
    for (const c of r) {
      for (const line of (c || '').split('\n')) {
        const pairs = pairsFromLine(line, 'table');
        if (pairs) { out.push(...pairs); continue; }
        const t = line.trim();
        if (prose && t.length >= 6 && t.length <= 200) prose.push(t);
      }
    }
  }
  return out;
}

/**
 * Административная шапка: берём только тег позиции и производителя, остальное —
 * реквизиты документа. Подпись ищем в ЛЮБОЙ ячейке строки, а не только в
 * первой: в двуязычных шапках «TAG N. / № Технологической позиции» стоит
 * посередине строки, и тег бланка не находился вовсе.
 */
function pairsFromAdminTable(rows: string[][]): RawPair[] {
  const out: RawPair[] = [];
  for (const r of rows) {
    for (let i = 0; i < r.length; i++) {
      const label = (r[i] || '').replace(/\n/g, ' ').trim();
      if (!label) continue;
      const isTag = ADMIN_TAG_RE.test(label);
      const isVendor = !isTag && ADMIN_VENDOR_RE.test(label);
      if (!isTag && !isVendor) continue;
      let value = '';
      for (let j = i + 1; j < r.length; j++) {
        const v = (r[j] || '').trim();
        if (v) { value = v; break; }
      }
      if (!value) continue;
      if (isTag) {
        // Тегов в ячейке бывает несколько («3700-C01-BL-001A, …-001B, …»):
        // один лист выпускается на пять одинаковых изделий. Раньше весь
        // список целиком становился названием и системой одной позиции.
        const codes = splitTagList(value);
        for (const c of codes) out.push({ label: 'Тег', value: c, unit: '', source: 'table', fieldId: 'tag' });
      } else if (value.length <= 80) {
        out.push({ label: 'Производитель', value: value.split('\n')[0], unit: '', source: 'table', fieldId: 'manufacturer' });
      }
    }
  }
  return out;
}

/** Атрибутная таблица: подпись в колонке 0 (или 0+1), значение правее */
function pairsFromAttributeTable(rows: string[][]): RawPair[] {
  const out: RawPair[] = [];
  for (const r of rows) {
    const label = (r[0] || '').trim();
    if (!label) continue;
    // Первое непустое значение правее подписи
    let value = '';
    let valueIdx = -1;
    for (let i = 1; i < r.length; i++) {
      if ((r[i] || '').trim()) { value = r[i].trim(); valueIdx = i; break; }
    }
    if (!value) continue;
    // Ячейка сразу за значением может быть единицей («5000 | м3/ч»)
    let unit = unitFromLabel(label) || splitValueUnit(value).unit;
    // Единица нередко стоит своей колонкой правее значения, причём между ними
    // бывают пустые ячейки объединённых столбцов: «рабочее давление | | до 1500 | | Па»
    if (!unit && valueIdx >= 0) {
      for (let i = valueIdx + 1; i < r.length; i++) {
        const next = (r[i] || '').trim();
        if (!next) continue;
        if (next.length <= 12 && !/\d/.test(next)) unit = splitValueUnit('0 ' + next).unit || next;
        break;
      }
    }
    out.push({ label, value, unit, source: 'table' });
  }
  return out;
}

/** Сущностная таблица: шапка → позиции по строкам */
function itemsFromEntityTable(rows: string[][], obs?: LearnObservation[]): DraftItem[] {
  const nonEmpty = rows.filter(r => r.some(c => (c || '').trim()));
  if (nonEmpty.length < 2) return [];
  const header = nonEmpty[0];
  const cols = header.map(h => ({ raw: (h || '').trim(), match: matchLabel(h || '') }));
  const items: DraftItem[] = [];
  for (const r of nonEmpty.slice(1)) {
    // Строки-разделители/итоги пропускаем
    const joined = r.join(' ').toLowerCase();
    if (/итого|всего|примечани/.test(joined)) continue;
    const pairs: RawPair[] = [];
    for (let i = 0; i < cols.length; i++) {
      const v = (r[i] || '').trim();
      if (!v || !cols[i].raw) continue;
      pairs.push({ label: cols[i].raw, value: v, unit: unitFromLabel(cols[i].raw) || splitValueUnit(v).unit, source: 'table' });
    }
    if (pairs.length === 0) continue;
    const item = buildItem(pairs, '', false, obs, true);
    if (item.name || item.brand || item.title !== 'Позиция' || (item.tags || []).length) items.push(item);
  }
  return items;
}

/** Матричная таблица: выбор колонки типоразмера */
function pairsFromMatrixTable(rows: string[][], brandHint?: string): { pairs: RawPair[]; headers: string[]; chosen: number } {
  const nonEmpty = rows.filter(r => r.some(c => (c || '').trim()));
  const header = nonEmpty[0] || [];
  const headers = header.slice(1).map(h => (h || '').trim());
  let chosen = -1;
  if (brandHint) {
    const hint = normalizeCode(brandHint).value.toLowerCase().replace(/\s/g, '');
    chosen = headers.findIndex(h => {
      const hn = normalizeCode(h).value.toLowerCase().replace(/\s/g, '');
      return hn && (hn === hint || hint.includes(hn) || hn.includes(hint));
    });
  }
  if (chosen < 0 && headers.length === 1) chosen = 0;
  const pairs: RawPair[] = [];
  if (chosen >= 0) {
    for (const r of nonEmpty.slice(1)) {
      const label = (r[0] || '').trim();
      const value = (r[chosen + 1] || '').trim();
      if (label && value) pairs.push({ label, value, unit: unitFromLabel(label) || splitValueUnit(value).unit, source: 'table' });
    }
  }
  return { pairs, headers, chosen };
}

/** Проза: типы, марки, системы, «мощность составляет 3 кВт» */
function minePairsFromProse(text: string): RawPair[] {
  const out: RawPair[] = [];
  const sentences = text.split(/[.;!?]\s+|\n/);
  for (const s of sentences) {
    const low = ' ' + s.toLowerCase().replace(/ё/g, 'е') + ' ';
    for (const f of FIELDS) {
      if (f.kind !== 'number') continue;
      for (const syn of f.synonyms) {
        const idx = low.indexOf(' ' + syn);
        if (idx < 0) continue;
        // число с единицей в ближайших ~50 символах после синонима
        const tail = s.slice(Math.min(idx + syn.length, s.length), Math.min(idx + syn.length + 55, s.length));
        const m = tail.match(/(-?\d[\d\s.,]*)\s*(тыс\.?\s*)?([a-zа-я°/³3()]+[\w/³()]*)?/i);
        if (m && m[1]) {
          const valueRaw = ((m[2] || '') + m[1]).trim();
          const unit = splitValueUnit((m[1] || '') + ' ' + (m[3] || '')).unit;
          out.push({ label: f.label, value: valueRaw.replace(/\s+$/, ''), unit, source: 'prose' });
          break;
        }
      }
    }
  }
  return out;
}

// ── Сборка позиции из пар ────────────────────────────────────────────────────

/** «1250», «65,8», «1 250.5» — значение целиком число (без хвостов и дат) */
function isPlainValue(v: string): boolean {
  const t = String(v ?? '').replace(/[\s ]/g, '').replace(',', '.');
  return t !== '' && /^-?\d+(\.\d+)?$/.test(t);
}

function confidenceFor(f: FieldDef | null, verdict: 'ok' | 'suspicious' | 'reject', source: RawPair['source'], isOcr: boolean): Confidence {
  if (verdict === 'suspicious') return 'low';
  if (isOcr) return 'mid'; // OCR никогда не даёт high сам по себе
  if (!f) return 'mid';
  if (source === 'prose') return 'mid';
  return 'high';
}

// Значение-ячейка может само содержать пачку параметров:
// многострочные «Lв=42860м3/ч\ndpсеть=700Па» или «L=80мм; M=94кг» под общей подписью.
// Разворачиваем в отдельные пары (подпись-контейнер отбрасываем).
function expandPairs(pairs: RawPair[]): RawPair[] {
  const out: RawPair[] = [];
  for (const p of pairs) {
    if (!p.fieldId && (/\n/.test(p.value) || /[A-Za-zА-Яа-я][\wв]{0,10}\s*=\s*[~≈]?-?\d/.test(p.value))) {
      let any = false;
      for (const line of p.value.split('\n')) {
        const lp = pairsFromLine(line, p.source);
        if (lp) { out.push(...lp); any = true; }
      }
      if (any) continue;
    }
    out.push(p);
  }
  return out;
}

// Слияние доказательств: поле определяется не только подписью, но и единицей.
// Единица, однозначно указывающая на одно поле (fieldByUniqueUnit), спасает
// нераспознанные подписи и переубеждает слабое (неточное) совпадение подписи.
function resolveFieldFusion(
  p: RawPair, value: string, m: { field: FieldDef; score: number } | null,
): FieldDef | null {
  const labelField = m?.field || null;
  const unit = p.unit || splitValueUnit(value).unit;
  const uid = fieldByUniqueUnit(unit);
  const unitField = uid ? (FIELDS.find(ff => ff.id === uid) || null) : null;
  if (!unitField) return labelField;
  // Единица годится, только если значение под неё правдоподобно
  if (validateValue(unitField, value, unit) === 'reject') return labelField;
  if (!labelField) return unitField;
  // Конфликт: подпись совпала неточно (score < 100), а единица говорит иначе — верим единице
  if (labelField.id !== unitField.id && m && m.score < 100
      && labelField.kind === 'number' && unitField.kind === 'number') {
    return unitField;
  }
  return labelField;
}

function buildItem(rawPairs: RawPair[], contextTitle: string, isOcr = false, obs?: LearnObservation[], fromRow = false): DraftItem {
  const item: DraftItem = {
    id: nextId(),
    title: contextTitle || 'Позиция',
    name: '',
    equipType: '',
    fields: [],
    ...(fromRow ? { fromRow: true } : {}),
  };
  const pairs = expandPairs(rawPairs);
  for (let p of pairs) {
    // Чистка значения: мусорные символы, двуязычные дубли («X X» → «X»)
    let value = dedupeRepeatedPhrase(sanitizeText(p.value));
    let unit = p.unit;
    if (!value || value === p.label) continue;
    if (textQuality(value) < 0.5) continue; // бинарный мусор не тащим

    // Поле может быть известно заранее (формулы, админ-извлечения); иначе —
    // слияние доказательств (подпись + единица), а не только совпадение подписи
    const m = p.fieldId ? null : matchLabel(p.label);
    let f: FieldDef | null = p.fieldId
      ? (FIELDS.find(ff => ff.id === p.fieldId) || null)
      : resolveFieldFusion(p, value, m);
    // Подпись не слово, а условное обозначение («L», «Ny», «Ширина В») —
    // спрашиваем справочник обозначений: величину решает символ вместе с
    // единицей. Работает и для отдельной ячейки, и для шапки колонки.
    let named = p.named;
    if (!f && !p.fieldId && looksLikeSymbol(p.label)) {
      const symUnit = p.unit || splitValueUnit(value).unit;
      // Одной буквы мало: без единицы принимаем символ, только если значение —
      // чистое число. Иначе таблица ревизий («B | 28.07.2025») превращается
      // в «Ширину», а английский дубль подписи («name | 225M8») — в обороты.
      if (symUnit || isPlainValue(value)) {
        const sm = resolveSymbol(p.label, symUnit);
        const sf = sm ? FIELDS.find(ff => ff.id === sm.field) : null;
        if (sm && sf) { f = sf; p = { ...p, label: sm.label }; named = true; }
      }
    }

    // Административные подписи («Заказчик», «Телефон/Факс», «№ документа»…) —
    // реквизиты бланка, не характеристики. Неточное совпадение со словарём
    // («название документа» → name) тоже отбрасываем.
    if (!p.fieldId && ADMIN_LABEL_RE.test(p.label)) {
      if (!f || (m && m.score < 100)) continue;
    }

    // Авто-обучение: сырая подпись из документа → поле (только реальные подписи, не формулы/админ).
    // Учим новые написания сопоставленных полей и подписи, однозначно определяемые единицей.
    if (obs && !p.fieldId && p.label) {
      const norm = normalizeLabel(p.label);
      if (norm.length >= 2 && norm.length <= 60) {
        if (f && !f.synonyms.includes(norm)) {
          obs.push({ label: norm, field: f.id, unit: p.unit || undefined });
        } else if (!f) {
          const uUnit = p.unit || splitValueUnit(value).unit;
          const uu = fieldByUniqueUnit(uUnit);
          if (uu) obs.push({ label: norm, field: uu, unit: uUnit || undefined });
        }
      }
    }

    // Технологические позиции разбираем до проверки значения: в ячейке лежит
    // список из четырёх тегов длиной под семьдесят знаков, и проверка «код не
    // длиннее шестидесяти» отбрасывала его целиком — вместе со всеми тегами.
    if (f && f.target === 'tag') {
      for (const code of splitTagList(value)) {
        // «001Е» кириллицей и «001E» латиницей — один и тот же тег
        const norm = normalizeCode(code).value;
        if (!norm || norm.length < 3 || norm.length > 40) continue;
        item.tags = item.tags || [];
        if (!item.tags.includes(norm)) item.tags.push(norm);
      }
      continue;
    }

    if (f) {
      // Значение может содержать единицу («5000 м3/ч», «600 °C») — расщепляем всегда,
      // чтобы в поле осталось чистое число, а единица ушла в unit
      if (f.kind === 'number' || f.kind === 'dims') {
        const su = splitValueUnit(value);
        if (su.unit) { value = su.value; if (!unit) unit = su.unit; }
      }
      const verdict = validateValue(f, value, unit);
      if (verdict === 'reject') {
        // Значение не подходит под якорь: сохраняем, только если само похоже на параметр
        if (isUsefulRawParam(value, p.unit, p.source)) {
          item.fields.push({ label: p.label, value, unit: p.unit, group: 'Прочее', confidence: 'low', source: p.source });
        }
        continue;
      }
      const conf = confidenceFor(f, verdict, p.source, isOcr);
      switch (f.target) {
        case 'name':
          if (!item.title || item.title === 'Позиция') item.title = value;
          break;
        case 'brand': {
          if (isKksTag(value)) break; // позиционный тег — не марка
          // Отсеиваем не-марки: одиночное слово без цифры/разделителя («базовое», «стандарт»)
          if (!/\d/.test(value) && !/[-./]/.test(value) && !/[A-ZА-Я]{2,}/.test(value)) break;
          // Первая марка выигрывает: в разделе бланка сначала стоит само
          // изделие («индекс: ВОСК72Б-063…»), а ниже его навеска
          // («назв: АДЭМ (F) 112М4» — двигатель). Последняя запись делала
          // маркой вентилятора его двигатель.
          if (!item.brand) item.brand = normalizeCode(value).value;
          break;
        }
        case 'system':
          if (!item.system) item.system = normalizeCode(value).value;
          break;
        case 'qty':
          if (!item.qty) item.qty = value;
          break;
        case 'spec': {
          // Сохраняем ИСХОДНУЮ подпись документа (dpсеть.вс, dpсеть.нг…), чтобы
          // разные параметры одного поля не схлопывались в общее «Давление».
          // Подпись из справочника обозначений («Полное давление») уже
          // человеческая; сырую подпись документа («dpсеть.вс») тоже бережём,
          // чтобы разные параметры одной величины не схлопнулись в одну строку
          const rawLabel = named ? p.label
            : (!p.fieldId && p.label && p.label.length <= 40) ? p.label : f.label;
          item.fields.push({ fieldId: f.id, label: rawLabel, value, unit: unit || (f.units ? '' : ''), group: f.group, confidence: conf, source: p.source });
          break;
        }
      }
      if (f.target !== 'spec' && f.target !== 'tag') {
        // Свойства позиции показываем в предпросмотре (кроме отклонённого KKS в brand)
        if (f.target === 'brand' && !item.brand) { /* KKS-тег отклонён — не выводим */ }
        else item.fields.push({ fieldId: f.id, label: f.label, value: f.target === 'brand' ? (item.brand || value) : value, unit: '', group: 'Общие', confidence: conf, source: p.source });
      }
    } else {
      // Подпись не сопоставлена — оставляем, только если значение похоже на характеристику.
      // Единицу отделяем от числа для чистого вида («212кг» → 212 + кг).
      let rawVal = value, rawUnit = p.unit;
      const su = splitValueUnit(value);
      if (su.unit) { rawVal = su.value; rawUnit = su.unit; }
      if (p.label.length <= 60 && isUsefulRawParam(rawVal, rawUnit, p.source)) {
        item.fields.push({ label: p.label, value: rawVal, unit: rawUnit, group: 'Прочее', confidence: 'low', source: p.source });
      }
    }
  }

  // Один тег — он же обозначение установки: в листе технических данных
  // «код системы: 3700-A01-HU-001A» — и адрес изделия в проекте, и имя
  // установки. Список тегов системой не бывает — там изделий несколько.
  if (!item.system && !fromRow && item.tags && item.tags.length === 1) item.system = item.tags[0];

  // Тип оборудования и система из названия/марки
  const searchText = `${item.title} ${item.brand || ''}`;
  const eq = detectEquip(searchText);
  if (eq) item.equipType = eq.id;
  if (!item.system) {
    const sys = findSystem(item.title);
    if (sys) item.system = sys;
  }
  if (!item.name) item.name = item.brand || '';
  return item;
}

/**
 * Общие свойства куска бланка — каждой его позиции. Своё у позиции сильнее:
 * дописываем только те подписи, которых у неё нет. Без этого сто клапанов
 * из перечня приезжали с пятью размерами и без единого общего свойства —
 * ни огнестойкости, ни материала, ни рабочего давления.
 */
function applyCommonPairs(items: DraftItem[], pairs: RawPair[], isOcr: boolean): void {
  const common = buildItem(pairs, '', isOcr);
  for (const it of items) {
    if (!it.system && common.system) it.system = common.system;
    if (!it.brand && common.brand) it.brand = common.brand;
    const have = new Set(it.fields.map(fl => fl.label.toLowerCase().trim()));
    for (const fl of common.fields) {
      const key = fl.label.toLowerCase().trim();
      if (have.has(key)) continue;
      have.add(key);
      it.fields.push({ ...fl, confidence: fl.confidence === 'high' ? 'mid' : fl.confidence });
    }
  }
}

/** Дополняет пустые свойства позиции найденным в прозе (пониженная уверенность) */
function enrichFromProse(item: DraftItem, proseTexts: string[]) {
  const all = proseTexts.join('\n');
  if (!item.equipType) {
    const eq = detectEquip(all);
    if (eq) item.equipType = eq.id;
  }
  if ((!item.title || item.title === 'Позиция')) {
    const eq = detectEquip(all);
    if (eq) {
      // Пробуем взять фразу вокруг найденного слова как название
      const low = all.toLowerCase().replace(/ё/g, 'е');
      const word = eq.words.find(w => low.includes(w));
      if (word) {
        const idx = low.indexOf(word);
        const frag = all.slice(idx, Math.min(idx + 70, all.length)).split(/[.,;\n]/)[0].trim();
        item.title = frag.length >= word.length ? frag : eq.label;
      } else item.title = eq.label;
    }
  }
  // Разделу многосекционного бланка марку из общей прозы не выдаём: проза
  // принадлежит всему документу, и одна и та же марка досталась бы всем
  // разделам — а потом схлопывание по марке оставило бы от бланка один блок.
  if (!item.brand && !item.section && !item.fromRow) {
    // Код с цифрой и разделителем в прозе — кандидат в марку.
    // Из «7421-S01-AN-001 … AeroBlast-K-340-13LW03Н» берём самый «богатый» код
    // (больше сегментов, длиннее), а не короткий обрывок KKS-тега «AN-001».
    // Основную марку ищем ДО пометки «Дополнительно оборудование» — там указана
    // навеска (узлы, приводы), которую нельзя принять за марку самого изделия
    const mainText = all.split(/дополнительн[а-яё]*\s*оборудован|additional\s*equip|доп\.?\s*оборудован/i)[0] || all;
    const codes = (mainText.match(/[A-Za-zА-Яа-я]{1,14}[\-./][A-Za-zА-Яа-я0-9,\-./]{2,30}/g) || [])
      .filter(c => /\d/.test(c) && looksLikeCode(c) && !isKksTag(c) && c.length >= 6);
    // Первый по порядку богатый код (≥3 сегментов) — это марка главного изделия;
    // если таких нет, берём самый насыщенный
    codes.sort((a, b) => {
      const sa = a.split(/[-./]/).length, sb = b.split(/[-./]/).length;
      const ra = sa >= 3 ? 1 : 0, rb = sb >= 3 ? 1 : 0;
      if (ra !== rb) return rb - ra;
      return 0; // сохраняем порядок появления среди «богатых»
    });
    if (codes.length) {
      const norm = normalizeCode(codes[0]);
      item.brand = norm.value;
      item.fields.push({ fieldId: 'brand', label: 'Марка', value: norm.value, unit: '', group: 'Общие', confidence: 'mid', source: 'prose' });
      if (!item.name) item.name = norm.value;
    }
  }
  if (!item.system) {
    const sys = findSystem(all);
    if (sys) {
      item.system = sys;
      item.fields.push({ fieldId: 'system', label: 'Система', value: sys, unit: '', group: 'Общие', confidence: 'mid', source: 'prose' });
    }
  }
}

// ── Главная функция ──────────────────────────────────────────────────────────

export function recognize(doc: ExtractedDoc): DraftResult {
  const warnings = [...doc.warnings];
  const isOcr = doc.source === 'pdf-ocr';
  const observations: LearnObservation[] = [];

  // 1. Классификация блоков
  const tables: { rows: string[][]; shape: TableShape }[] = [];
  const kvPairs: RawPair[] = [];
  const proseTexts: string[] = [];
  const headings: { text: string; blockIndex: number }[] = [];
  const orderedData: { blockIndex: number; kind: 'table' | 'pairs'; tableIdx?: number; pairs?: RawPair[] }[] = [];
  let dataBlocks = 0;

  doc.blocks.forEach((b, bi) => {
    if (b.kind === 'kv') {
      kvPairs.push({ label: b.key, value: b.value, unit: splitValueUnit(b.value).unit, source: 'kv' });
      orderedData.push({ blockIndex: bi, kind: 'pairs', pairs: [kvPairs[kvPairs.length - 1]] });
      dataBlocks++;
      return;
    }
    if (b.kind === 'table') {
      const shape = classifyTable(b.rows);
      if (shape === 'layout') {
        // Оформительская таблица: содержимое читаем построчно (внутри бывают данные)
        for (const r of b.rows) {
          for (const cell of r) {
            for (const line of (cell || '').split('\n')) {
              const t = line.trim();
              if (!t) continue;
              const linePairs = pairsFromLine(t, 'table');
              if (linePairs) {
                kvPairs.push(...linePairs);
                orderedData.push({ blockIndex: bi, kind: 'pairs', pairs: linePairs });
                dataBlocks++;
                continue;
              }
              const cls = classifyParagraph(t);
              if (cls === 'heading') headings.push({ text: t, blockIndex: bi });
              else if (cls === 'prose') proseTexts.push(t);
            }
          }
        }
        return;
      }
      tables.push({ rows: b.rows, shape });
      orderedData.push({ blockIndex: bi, kind: 'table', tableIdx: tables.length - 1 });
      dataBlocks++;
      return;
    }
    // Абзац: сначала пробуем как «ключ: значение»/формулу, затем классификация
    const paraPairs = (b.text || '').length <= 200 ? pairsFromLine(b.text, 'table') : null;
    if (paraPairs) {
      kvPairs.push(...paraPairs);
      orderedData.push({ blockIndex: bi, kind: 'pairs', pairs: paraPairs });
      dataBlocks++;
      return;
    }
    const cls = classifyParagraph(b.text);
    if (cls === 'heading') {
      headings.push({ text: b.text.trim(), blockIndex: bi });
    } else if (cls === 'prose') {
      proseTexts.push(b.text);
    }
  });

  // 2. Определение типа документа
  const entityTables = tables.filter(t => t.shape === 'entity');
  const attributeTables = tables.filter(t => t.shape === 'attribute');
  const matrixTables = tables.filter(t => t.shape === 'matrix');
  const kvGridTables = tables.filter(t => t.shape === 'kvgrid');
  const adminTables = tables.filter(t => t.shape === 'admin');

  let docType: DocType = 'unknown';
  const items: DraftItem[] = [];

  // Опросный лист: много подчёркиваний/пустых значений
  const underscoreHeavy = doc.blocks.filter(b => b.kind === 'para' && /_{3,}/.test((b as any).text)).length >= 3;

  if (entityTables.length > 0 && entityTables.some(t => t.rows.length >= 3)) {
    // Ведомость: строки = позиции. Соседние таблицы свойств — общие данные
    // именно этих строк: в листе на клапаны каждый вид идёт своим куском
    // «шапка → перечень позиций → общие характеристики», и характеристики
    // одного вида нельзя приписывать другому. Границей куска служит шапка.
    docType = 'list';
    let segItems: DraftItem[] = [];
    let segPairs: RawPair[] = [];
    const flushSegment = () => {
      if (segItems.length && segPairs.length) applyCommonPairs(segItems, segPairs, isOcr);
      segItems = [];
      segPairs = [];
    };
    for (const od of orderedData) {
      if (od.kind === 'pairs' && od.pairs) { segPairs.push(...od.pairs); continue; }
      if (od.kind !== 'table' || od.tableIdx === undefined) continue;
      const t = tables[od.tableIdx];
      if (t.shape === 'admin') {
        // Новая шапка — новый вид оборудования: предыдущий кусок закрываем
        flushSegment();
        segPairs.push(...pairsFromAdminTable(t.rows));
      } else if (t.shape === 'entity') {
        const built = itemsFromEntityTable(t.rows, observations);
        segItems.push(...built);
        items.push(...built);
      } else if (t.shape === 'attribute') {
        segPairs.push(...pairsFromAttributeTable(t.rows));
      } else if (t.shape === 'kvgrid') {
        segPairs.push(...pairsFromKvGrid(t.rows, proseTexts));
      } else if (t.shape === 'matrix') {
        segPairs.push(...pairsFromMatrixTable(t.rows).pairs);
      }
    }
    flushSegment();
  } else if (headings.length >= 2) {
    // Многосекционный бланк: секции между заголовками
    const sectionOf = (bi: number) => {
      let cur = -1;
      for (let h = 0; h < headings.length; h++) if (headings[h].blockIndex <= bi) cur = h;
      return cur;
    };
    const sectionPairs: RawPair[][] = headings.map(() => []);
    const preamblePairs: RawPair[] = [];
    for (const od of orderedData) {
      const sec = sectionOf(od.blockIndex);
      const bucket = sec >= 0 ? sectionPairs[sec] : preamblePairs;
      if (od.kind === 'pairs' && od.pairs) bucket.push(...od.pairs);
      else if (od.kind === 'table' && od.tableIdx !== undefined) {
        const t = tables[od.tableIdx];
        if (t.shape === 'attribute') bucket.push(...pairsFromAttributeTable(t.rows));
        else if (t.shape === 'kvgrid') bucket.push(...pairsFromKvGrid(t.rows, proseTexts));
        else if (t.shape === 'admin') bucket.push(...pairsFromAdminTable(t.rows));
        else if (t.shape === 'matrix') {
          const mx = pairsFromMatrixTable(t.rows);
          bucket.push(...mx.pairs);
        }
      }
    }
    // Заголовок без данных — подпись к картинке, а не раздел. Если разделов с
    // данными меньше двух, бланк не многосекционный: разбираем как карточку,
    // иначе всё, что стоит до первого заголовка, потерялось бы.
    const filled = sectionPairs.filter(sp => sp.length > 0).length;
    if (filled >= 2) {
      docType = 'multi';
      // Данные до первого заголовка — это сам предмет бланка (шапка заказа,
      // общие характеристики изделия), а не мусор: раньше их отбрасывали
      // целиком, оставляя от бланка-заказа вентилятора две пустые подписи.
      if (preamblePairs.length >= 3) {
        items.push(buildItem(preamblePairs, '', isOcr, observations));
      }
      headings.forEach((h, i) => {
        // Первый заголовок — предмет бланка (сама установка), он остаётся даже
        // без своих данных; пустые заголовки дальше — подписи к приложениям
        if (!sectionPairs[i].length && i > 0) return;
        const item = buildItem(sectionPairs[i], h.text, isOcr, observations);
        // Номер раздела — это устройство бланка: «1.» моноблок, «1.2.» блок в нём
        const no = sectionNumber(h.text);
        if (no) item.section = no;
        items.push(item);
      });
      // Система из шапки — всем разделам, у которых своей нет
      const sys = items.find(it => it.system)?.system;
      if (sys) for (const it of items) if (!it.system) it.system = sys;
    }
  }
  if (items.length === 0) {
    // Карточка одного изделия (или опросный лист)
    docType = underscoreHeavy ? 'questionnaire' : 'card';
    const pairs: RawPair[] = [...kvPairs];
    for (const t of attributeTables) pairs.push(...pairsFromAttributeTable(t.rows));
    for (const t of kvGridTables) pairs.push(...pairsFromKvGrid(t.rows, proseTexts));
    for (const t of adminTables) pairs.push(...pairsFromAdminTable(t.rows));

    // Матрица: марка из уже найденных пар помогает выбрать колонку
    let matrixHeaders: string[] | undefined;
    let matrixRaw: string[][] | undefined;
    if (matrixTables.length) {
      const brandPair = pairs.find(p => matchLabel(p.label)?.field.id === 'brand');
      for (const t of matrixTables) {
        const mx = pairsFromMatrixTable(t.rows, brandPair?.value);
        if (mx.chosen >= 0) pairs.push(...mx.pairs);
        else if (mx.headers.length) {
          matrixHeaders = mx.headers;
          matrixRaw = t.rows; // сохраняем строки, чтобы подставить значения после выбора колонки
          warnings.push('В таблице несколько типоразмеров — выберите нужную колонку.');
        }
      }
    }

    // Опросный лист: пустые значения (подчёркивания) выбрасываем
    const cleaned = docType === 'questionnaire'
      ? pairs.filter(p => p.value.replace(/[_\s.]/g, '').length > 0)
      : pairs;

    // Проза добавляет числовые параметры, которых нет в таблицах
    const prosePairs = minePairsFromProse(proseTexts.join('\n'));
    const have = new Set(cleaned.map(p => matchLabel(p.label)?.field.id).filter(Boolean));
    for (const pp of prosePairs) {
      const fid = matchLabel(pp.label)?.field.id;
      if (fid && !have.has(fid)) { cleaned.push(pp); have.add(fid); }
    }

    const item = buildItem(cleaned, '', isOcr, observations);
    if (matrixHeaders) { item.matrixHeaders = matrixHeaders; item.matrixRaw = matrixRaw; }
    items.push(item);
  }

  // 3. Дочитывание прозы для всех позиций без названия/марки/системы.
  // Для карточки/опросника заголовки тоже участвуют («Опросный лист на воздушную завесу» —
  // это тип оборудования); в многосекционном бланке заголовки уже стали названиями секций.
  const enrichTexts = docType === 'multi' ? proseTexts : [...headings.map(h => h.text), ...proseTexts];
  for (const it of items) enrichFromProse(it, enrichTexts);

  // 4. Финальные штрихи
  for (const it of items) {
    if (!it.title || it.title === 'Позиция') {
      it.title = it.brand ? `Оборудование ${it.brand}` : 'Нераспознанная позиция';
    }
    // Код позиции: тег, затем марка, затем номер раздела. Номер раздела
    // устойчивее обрезанного названия — по нему повторный ввоз того же бланка
    // находит тот же блок, а не заводит второй.
    if (!it.name) it.name = (it.tags && it.tags[0]) || it.brand || it.section || it.title.slice(0, 30);
  }

  // Позиция без единого параметра — это подпись к картинке или строка
  // оформления («3.3. Вентилятор ВСК. Аэродинамическая характеристика»,
  // «VezaFan v.254.1.54.56»), а не единица оборудования. Единственную позицию
  // документа оставляем в любом случае — иначе пользователь не поймёт, что
  // именно не распозналось.
  const PROP_FIELDS = new Set(['name', 'brand', 'system', 'qty']);
  const hasData = (it: DraftItem) => it.fromRow          // строка ведомости — позиция по построению
    || (it.tags || []).length > 0
    || (it.matrixHeaders || []).length > 0
    || it.fields.some(fl => !fl.fieldId || !PROP_FIELDS.has(fl.fieldId));
  // В многосекционном бланке первая позиция — сама установка: она даёт имя
  // всему дереву, даже если своих характеристик у неё нет
  let filtered = items.filter((it, i) => hasData(it) || (docType === 'multi' && i === 0));
  // Ничего не осталось, а позиция была одна и с осмысленным названием —
  // показываем её: пользователю нужно видеть, что именно не разобралось
  if (!filtered.length && items.length === 1 && items[0].title !== 'Нераспознанная позиция') {
    filtered = items;
  }

  // Двуязычные бланки дают ту же позицию дважды (RU + EN), а «характеристика/схема» —
  // пустой хвост секции. Схлопываем по марке, оставляя самую полную (предпочитая русскую).
  if (filtered.length > 1) {
    const cyr = (s: string) => ([...(s || '')].filter(c => /[а-яё]/i.test(c)).length);
    const lat = (s: string) => ([...(s || '')].filter(c => /[a-z]/i.test(c)).length);
    // Английская секция: подписи полей и заголовок латиницей заметно преобладают
    const langText = (it: DraftItem) => it.title + ' ' + it.fields.map(f => f.label).join(' ');
    const isEnglish = (it: DraftItem) => { const t = langText(it); return lat(t) > cyr(t) * 2 + 3; };
    const hasRussian = filtered.some(it => { const t = langText(it); return cyr(t) > lat(t); });

    const byBrand = new Map<string, DraftItem>();
    const kept: DraftItem[] = [];
    for (const it of filtered) {
      // Английский перевод русской позиции — отбрасываем (дубль другого языка)
      if (hasRussian && isEnglish(it)) continue;
      // Строки ведомости и разделы бланка — это разные изделия, даже если
      // марка у них одна: пятнадцать клапанов КПУ-1Н-О-Н с разными тегами
      // схлопывались в один, и бланк на сто позиций давал одну.
      const key = (it.brand || '').trim().toLowerCase();
      if (!key || it.fromRow || it.section) { kept.push(it); continue; }
      const prev = byBrand.get(key);
      if (!prev) { byBrand.set(key, it); kept.push(it); continue; }
      const score = (x: DraftItem) => x.fields.length * 100 + cyr(x.fields.map(f => f.label).join(''));
      if (score(it) > score(prev)) {
        const idx = kept.indexOf(prev);
        if (idx >= 0) kept[idx] = it;
        byBrand.set(key, it);
      }
    }
    filtered = kept.length ? kept : filtered;
  }

  if (filtered.length === 0) {
    warnings.push('Не удалось найти параметры оборудования. Проверьте, что в документе есть подписи полей (наименование, марка, расход…) со значениями.');
  }
  if (isOcr) {
    warnings.push('Документ распознан со скана (OCR) — проверьте жёлтые значения перед импортом.');
  }

  // Самопроверка (только пометки/предупреждения, значения не меняем):
  //  • число вне правдоподобного диапазона поля → понижаем уверенность до low;
  //  • физика вентилятора (P ≈ Q·ΔP/η) — предупреждение при явном расхождении.
  for (const it of filtered) {
    for (const fld of it.fields) {
      if (!fld.fieldId || fld.confidence === 'low') continue;
      const def = FIELDS.find(ff => ff.id === fld.fieldId);
      if (def?.kind === 'number' && def.range && isImplausible(fld.value, fld.unit, def.range, def.units?.[0])) {
        fld.confidence = 'low';
      }
    }
    const w = crossCheckFan(
      it.fields.filter(f => f.fieldId).map(f => ({ fieldId: f.fieldId!, value: f.value, unit: f.unit }))
    );
    if (w && !warnings.includes(w)) warnings.push(w);
  }

  // Дедупликация наблюдений по паре «подпись+поле»
  const obsSeen = new Set<string>();
  const dedupObs = observations.filter(o => {
    const k = `${o.label}|${o.field}`;
    if (obsSeen.has(k)) return false;
    obsSeen.add(k);
    return true;
  });

  return {
    docType: filtered.length ? docType : 'unknown',
    items: filtered,
    warnings,
    stats: { dataBlocks, totalBlocks: doc.blocks.length },
    observations: dedupObs,
  };
}

// ── Выбор колонки матричной таблицы ──────────────────────────────────────────
// Когда в бланке несколько типоразмеров, пользователь выбирает нужный. Тогда
// заново извлекаем значения именно этой колонки из сохранённых строк матрицы и
// доклеиваем их к позиции (не дублируя уже имеющиеся подписи).
export function applyMatrixColumn(item: DraftItem, header: string): DraftItem {
  const base: DraftItem = {
    ...item,
    brand: header,
    name: item.name || header,
    matrixHeaders: undefined,
    matrixRaw: undefined,
  };
  if (!item.matrixRaw) return base;
  const { pairs } = pairsFromMatrixTable(item.matrixRaw, header);
  if (!pairs.length) return base;
  const built = buildItem(pairs, item.title);
  const haveLabels = new Set(item.fields.map(f => f.label.toLowerCase().trim()));
  const added = built.fields.filter(f => {
    const key = f.label.toLowerCase().trim();
    if (haveLabels.has(key)) return false;
    haveLabels.add(key);
    return true;
  });
  return { ...base, fields: [...item.fields, ...added] };
}

// ── Черновик → payload для сервера ───────────────────────────────────────────

import { CommitUnit, CommitSpecGroup } from './types';

/**
 * Границы изделий внутри одного бланка.
 *
 * Комплектный документ содержит несколько независимых установок подряд. Раньше
 * родителем всех становилась первая найденная: `findIndex(ahu)` брал её, а
 * всё остальное — включая вторую такую же установку — складывалось внутрь.
 * Две одинаковые ВЕРОСА превращались в одну, вложенную сама в себя.
 *
 * Делим по порядку документа: каждая установка забирает то, что идёт за ней
 * до следующей. Порядок — это доказательство, а не догадка: секции печатают
 * под своим изделием. Что идёт до первой установки, остаётся отдельным
 * корнем, а не приписывается ей задним числом.
 */
function splitByUnits(items: DraftItem[]): DraftItem[][] {
  const heads: number[] = [];
  items.forEach((it, i) => { if (it.equipType === 'ahu') heads.push(i); });
  if (heads.length < 2) return [items];
  const parts: DraftItem[][] = [];
  if (heads[0] > 0) parts.push(items.slice(0, heads[0]));
  heads.forEach((start, n) => {
    parts.push(items.slice(start, n + 1 < heads.length ? heads[n + 1] : items.length));
  });
  return parts.filter(p => p.length);
}

export function draftToUnits(items: DraftItem[], docTitle: string): CommitUnit[] {
  const parts = splitByUnits(items);
  if (parts.length > 1) return parts.flatMap(part => oneUnit(part, docTitle));
  return oneUnit(items, docTitle);
}

function oneUnit(items: DraftItem[], docTitle: string): CommitUnit[] {
  const groupsOf = (it: DraftItem): CommitSpecGroup[] => {
    const map: Record<string, CommitSpecGroup> = {};
    for (const f of it.fields) {
      if (f.fieldId && ['name', 'brand', 'system', 'qty'].includes(f.fieldId)) continue;
      const g = f.group || 'Характеристики';
      if (!map[g]) map[g] = { title: g, params: [] };
      map[g].params.push({ key: f.label, value: f.value, unit: f.unit || '' });
    }
    // Свойства позиции — в группу «Общие», чтобы не потерялись в дереве
    const gen = map['Общие'] || (map['Общие'] = { title: 'Общие', params: [] });
    const addOnce = (key: string, value?: string) => {
      if (value && !gen.params.some(p => p.key === key)) gen.params.push({ key, value, unit: '' });
    };
    addOnce('Марка', it.brand);
    addOnce('Система', it.system);
    addOnce('Количество', it.qty);
    if ((it.tags || []).length) addOnce('Тег', (it.tags || []).join(', '));
    return Object.values(map).filter(g => g.params.length);
  };

  const blockOf = (it: DraftItem) => ({
    name: it.name || it.title,
    title: it.title,
    equipType: it.equipType || 'component',
    groups: groupsOf(it),
    ...((it.tags || []).length ? { tags: it.tags } : {}),
  });

  // ── Устройство бланка задано его нумерацией ──────────────────────────────
  // «1.» — моноблок установки, «1.2.» — блок внутри него. Это ровно те три
  // уровня, что есть в разделе «Оборудование» (установка → моноблок → блок),
  // поэтому строим дерево по номерам, а не сваливаем всё в один «M1».
  const sectioned = items.filter(it => it.section);
  const head = items.find(it => !it.section && (it.equipType === 'ahu' || it === items[0]));
  if (sectioned.length >= 2 && head && sectioned.length + 1 <= items.length) {
    const order: string[] = [];
    const byMb = new Map<string, DraftItem[]>();
    for (const it of items) {
      if (it === head) continue;
      const mb = (it.section || '').split('.')[0] || '1';
      if (!byMb.has(mb)) { byMb.set(mb, []); order.push(mb); }
      byMb.get(mb)!.push(it);
    }
    return [{
      name: head.system || head.tags?.[0] || head.brand || head.name || docTitle,
      title: head.title,
      groups: groupsOf(head),
      ...((head.tags || []).length ? { tags: head.tags } : {}),
      monoblocks: order.map(mb => ({
        name: `M${mb}`,
        // Название моноблока — из его собственного раздела («1. моноблок»),
        // если он в бланке есть; иначе просто номер
        title: byMb.get(mb)!.find(x => x.section === mb)?.title || `Моноблок ${mb}`,
        blocks: byMb.get(mb)!.map(blockOf),
      })),
    }];
  }

  // Составное изделие без нумерации: первая позиция — установка, остальные — секции
  const ahuIdx = items.findIndex(i => i.equipType === 'ahu');
  if (items.length > 1 && ahuIdx >= 0) {
    const top = items[ahuIdx];
    const rest = items.filter((_, i) => i !== ahuIdx);
    return [{
      name: top.system || top.brand || top.name || docTitle,
      title: top.title,
      groups: groupsOf(top),
      ...((top.tags || []).length ? { tags: top.tags } : {}),
      monoblocks: [{ name: 'M1', title: 'Секции установки', blocks: rest.map(blockOf) }],
    }];
  }

  // Обычный случай: документ → установка, позиции → блоки
  return [{
    name: items[0]?.system || docTitle,
    title: docTitle,
    groups: [],
    monoblocks: [{ name: 'M1', title: docTitle, blocks: items.map(blockOf) }],
  }];
}
