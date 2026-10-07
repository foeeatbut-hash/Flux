/**
 * Справочник атрибутов E3.series: что за атрибут, кто его заполняет и откуда
 * Flux берёт значение.
 *
 * Исходник — «Список атрибутов» владельца (классификатор E3). Владелец хочет
 * пока одно: заполнять атрибуты E3 в Excel. Атрибут с «Да» в первом столбце
 * файла заполняет Flux, остальные остаются пустыми — их дописывают руками.
 * Поэтому у справочника два слоя, и путать их нельзя:
 *
 *   — поля ИЗ ФАЙЛА (подпись, носитель, класс, служебный, «Да», скрипт,
 *     комментарий): загрузка файла их обновляет;
 *   — НАСТРОЙКИ FLUX (источник значения, типы оборудования, правило спора
 *     со скриптом): файл их не трогает, их задаёт человек в каталоге.
 *
 * Модуль чистый: без React, без сервера, без сети. Его читают сервер
 * (хранение и права), окно (экран справочника) и выгрузка (столбцы `e3:`).
 * Описание и решения — docs/e3-integration.md, разделы 5.5 и 5.7.
 */
import type { ExportColumn } from '../src/lib/exportSpec';
import { CLASSES, isClassId } from '../equipment/classes';

/** Группа характеристик позиции, где хранятся данные КИП: у ОВ их нет, их вводит инженер КИП (docs/e3-integration.md, 9.1) */
export const KIP_GROUP = 'КИП';

/** Поле позиции, которое можно взять в атрибут как есть */
export type E3FieldKey = 'tag' | 'parentTag' | 'unitTag' | 'name' | 'parentName' | 'model' | 'kind' | 'class' | 'system' | 'monoblock' | 'itemCode';

/** Откуда значение: нет / поле позиции / характеристика / константа */
export type E3Source =
  | { kind: 'none' }
  | { kind: 'field'; key: E3FieldKey }
  | { kind: 'param'; name: string; unit?: string }
  | { kind: 'const'; value: string };

/**
 * Кто главнее, если Flux записал значение, а скрипт E3 его пересчитал
 * (раздел 5.5): Flux всегда / Flux только первый раз / скрипт / спросить.
 */
export type E3Conflict = 'flux' | 'flux-once' | 'script' | 'ask';

export interface E3Attribute {
  /** Имя атрибута в E3 — ключ: по нему пишется значение */
  name: string;
  /** Описание атрибута («MOTOR_Мощность») */
  title: string;
  /** Носитель: Изделие, Блок, Лист, Пин */
  carrier: string;
  /** «Основной класс» из файла: Общий, Двигатели, КИП… */
  attrClass: string;
  /** «Служебный (не менять!)»: обычно его считает скрипт E3 */
  service: boolean;
  /** «Да» в первом столбце: значение приходит из Flux */
  fromFlux: boolean;
  script: string;
  comment: string;
  source: E3Source;
  /** Типы оборудования; пусто — по `defaultClassesOf(attrClass)` */
  classes: string[];
  conflict: E3Conflict;
  /** Правили руками в каталоге: загрузка файла такие поля не перезаписывает */
  edited?: boolean;
  /** Снят загрузкой («нет в файле → снять»); физически не удаляется */
  removed?: boolean;
}

export interface E3AttributeBook { version: number; items: E3Attribute[]; updatedAt: string; updatedById?: string }

export interface E3Plan {
  added: E3Attribute[];
  changed: { name: string; fields: string[]; before: E3Attribute; after: E3Attribute }[];
  same: number;
  /** Есть в каталоге, нет в файле */
  missing: string[];
  /** Правились руками, а файл их поменял бы — оставлены как есть */
  editedKept: string[];
  issues: string[];
}

export const E3_FIELD_TITLES: Record<E3FieldKey, string> = {
  tag: 'Тег позиции',
  parentTag: 'Тег родителя',
  unitTag: 'Тег установки',
  name: 'Наименование',
  parentName: 'Наименование родителя',
  model: 'Модель',
  kind: 'Вид',
  class: 'Тип',
  system: 'Установка',
  monoblock: 'Моноблок',
  itemCode: 'Код позиции',
};

export const E3_FIELD_KEYS = Object.keys(E3_FIELD_TITLES) as E3FieldKey[];
export const E3_CONFLICTS: E3Conflict[] = ['flux', 'flux-once', 'script', 'ask'];

/** Поля, которые приходят из файла: только их сравнивает и обновляет загрузка */
const FILE_FIELDS = ['title', 'carrier', 'attrClass', 'service', 'fromFlux', 'script', 'comment'] as const;

/** Без регистра, без пробелов по краям и лишних внутри, ё = е */
const norm = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/ё/g, 'е');
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const yes = (v: unknown): boolean => norm(v) === 'да';

// ── Типы оборудования по «основному классу» файла ───────────────────────────

/** Класс файла → типы Flux. 'all' — любой тип, 'cable' — только если выбрано вручную */
const CLASS_RULES: Record<string, string[] | 'all' | 'cable'> = {
  'общий': 'all',
  'подвал': 'all',
  'двигатели': ['ДВИГАТЕЛЬ'],
  'нагреватели': ['НАГРЕВАТЕЛЬ', 'ТЭН'],
  'кип': ['ДАТЧИК'],
  'кип зра': ['ОБВЯЗКА'],
  'привод': ['ПРИВОД'],
  'сигналы': ['ДАТЧИК', 'ПРИВОД'],
  'освещение и климат': ['ОСНАЩЕНИЕ'],
  'силовая техника': ['НАСОС', 'ДВИГАТЕЛЬ'],
  'комплектные изделия': ['ПРОЧЕЕ', 'ОСНАЩЕНИЕ'],
  'черный ящик': ['ПРОЧЕЕ', 'ОСНАЩЕНИЕ'],
  // Кабели и кабельные вводы — не оборудование установки, а изделия схемы;
  // на тип оборудования сами не ложатся
  'кабель': 'cable',
  'кабельный ввод': 'cable',
};

/**
 * Что значит «основной класс» файла. Значение с запятой («Сигналы, Привод»,
 * «КИП, Привод») — объединение. Незнакомое слово не прячет атрибут: он
 * относится ко всем типам, а загрузка называет его в замечаниях.
 */
function classRule(attrClass: string): { all: boolean; cable: boolean; ids: string[]; unknown: string[] } {
  const parts = String(attrClass ?? '').split(/[,;]/).map(norm).filter(Boolean);
  const ids: string[] = [];
  const unknown: string[] = [];
  let all = parts.length === 0;
  let cable = false;
  for (const p of parts) {
    const rule = CLASS_RULES[p];
    if (rule === undefined) { unknown.push(p); all = true; continue; }
    if (rule === 'all') { all = true; continue; }
    if (rule === 'cable') { cable = true; continue; }
    for (const id of rule) if (!ids.includes(id)) ids.push(id);
  }
  return { all, cable, ids: all ? [] : ids, unknown };
}

/** Типы оборудования по умолчанию; пусто — все типы (или кабельный атрибут, см. attributesForClass) */
export function defaultClassesOf(attrClass: string): string[] {
  return classRule(attrClass).ids;
}

// ── Источник значения по умолчанию ──────────────────────────────────────────

const FIELD_SOURCES: Record<string, E3FieldKey> = {
  'device designation': 'tag',
  'global_tag_unit': 'unitTag',
  'global_tag_node': 'parentTag',
  'global_node_name': 'parentName',
  'global_device_name': 'name',
  'global_unit_name': 'system',
  'global_model': 'model',
  'global_device_type': 'class',
};

/**
 * Что Flux может подставить сам. Остальным атрибутам с «Да» источник ставит
 * человек: угадывать характеристику по имени (INST_RANGE_MIN, SIGNAL_DESC)
 * значило бы писать в схему чужое число.
 */
export function defaultSource(name: string): E3Source {
  const n = norm(name);
  const field = FIELD_SOURCES[n];
  if (field) return { kind: 'field', key: field };
  const up = String(name ?? '').trim().toUpperCase();
  if (/^(MOTOR|ELH|LC|PEQ|COMPRO)_POWER$/.test(up)) return { kind: 'param', name: 'Мощность', unit: 'кВт' };
  if (/_VOLTAGE$/.test(up)) return { kind: 'param', name: 'Напряжение', unit: 'В' };
  if (/_CURRENT_RATED$/.test(up)) return { kind: 'param', name: 'Ток', unit: 'А' };
  return { kind: 'none' };
}

// ── Разбор листа ────────────────────────────────────────────────────────────

/**
 * Лист «Список атрибутов» → атрибуты и замечания.
 *
 * Строка заголовков ищется по тексту, а не по номеру: владелец вставит строку
 * над таблицей — и загрузка не должна читать шапку как данные. Первый столбец
 * в файле без заголовка, поэтому он берётся как столбец левее имени.
 *
 * Файл — живая таблица, а не образец: повторы имён, пробел в конце имени,
 * «Да» вместе со «Служебным» в нём обычны. Загрузка ничего из этого не
 * чинит молча — она берёт первую строку и называет остальное словами.
 */
export function parseAttributeSheet(rows: unknown[][]): { items: E3Attribute[]; issues: string[] } {
  const items: E3Attribute[] = [];
  const issues: string[] = [];
  const list = Array.isArray(rows) ? rows : [];

  const headerAt = list.findIndex((r) => Array.isArray(r) && r.some((c) => norm(c).includes('наименование атрибута')));
  if (headerAt < 0) {
    return { items, issues: ['Не найдена строка заголовков: нужен столбец «Наименование атрибута E3»'] };
  }

  const col: Record<string, number> = { name: -1, title: -1, carrier: -1, attrClass: -1, service: -1, script: -1, comment: -1, veza: -1, veza2: -1 };
  (list[headerAt] as unknown[]).forEach((cell, j) => {
    const n = norm(cell);
    if (!n) return;
    if (n.includes('наименование атрибута')) col.name = j;
    else if (n.startsWith('описание атрибута')) col.title = j;
    else if (n.includes('носитель')) col.carrier = j;
    else if (n.includes('основной класс')) col.attrClass = j;
    else if (n.includes('служебный')) col.service = j;
    else if (n.includes('скрипт')) col.script = j;
    else if (n.startsWith('комментарий')) {
      if (n.includes('веза2')) col.veza2 = j;
      else if (n.includes('веза')) col.veza = j;
      else col.comment = j;
    }
  });
  const fromFluxCol = col.name - 1;
  if (fromFluxCol < 0) issues.push('Слева от имени атрибута нет столбца «Да» (заполняет Flux): все атрибуты будут без заполнения из Flux');
  for (const [key, what] of [['title', 'Описание атрибута'], ['carrier', 'Носитель'], ['attrClass', 'Основной класс'], ['service', 'Служебный атрибут']] as const) {
    if (col[key] < 0) issues.push(`В файле нет столбца «${what}»`);
  }

  const at = (row: unknown[], j: number): string => (j < 0 ? '' : text(row[j]));
  const firstRow = new Map<string, number>();

  for (let i = headerAt + 1; i < list.length; i++) {
    const row = list[i];
    if (!Array.isArray(row) || row.every((c) => !text(c))) continue;
    const line = i + 1;
    const raw = row[col.name] === null || row[col.name] === undefined ? '' : String(row[col.name]);
    const name = raw.trim();
    if (!name) { issues.push(`Строка ${line}: нет имени атрибута — пропущена`); continue; }

    const carrier = at(row, col.carrier);
    const taken = firstRow.get(name);
    if (taken !== undefined) {
      const first = items.find((a) => a.name === name);
      const same = first && first.carrier === carrier ? '' : `, носитель во второй строке другой («${carrier || 'пусто'}»)`;
      issues.push(`${name}: в файле дважды — взята строка ${taken}${same}`);
      continue;
    }
    firstRow.set(name, line);
    if (raw !== name) issues.push(`Строка ${line}: в имени «${raw}» пробелы по краям убраны`);

    const fromFlux = fromFluxCol >= 0 && yes(row[fromFluxCol]);
    const service = col.service >= 0 && yes(row[col.service]);
    const attrClass = at(row, col.attrClass);
    const comment = [
      at(row, col.comment),
      at(row, col.veza) ? `ВЕЗА: ${at(row, col.veza)}` : '',
      at(row, col.veza2) ? `ВЕЗА2: ${at(row, col.veza2)}` : '',
    ].filter(Boolean).join('\n');

    if (fromFlux && service) issues.push(`${name}: отмечен и «Да» (заполняет Flux), и «Служебный» — по умолчанию правило спора «Спросить», решите в каталоге`);
    if (norm(name) === 'device designation') issues.push(`${name}: служебное поле E3, а не атрибут — пишется отдельным вызовом, а не как атрибут`);
    const rule = classRule(attrClass);
    if (rule.unknown.length) issues.push(`${name}: неизвестный основной класс «${attrClass}» — атрибут относится ко всем типам`);

    items.push({
      name, title: at(row, col.title), carrier, attrClass, service, fromFlux,
      script: at(row, col.script), comment,
      source: fromFlux ? defaultSource(name) : { kind: 'none' },
      classes: [],
      conflict: fromFlux && service ? 'ask' : 'flux',
    });
  }
  return { items, issues };
}

// ── План загрузки ───────────────────────────────────────────────────────────

/** Первая запись с каждым именем — файл разбирается так же */
function byNameFirst(list: E3Attribute[]): Map<string, E3Attribute> {
  const m = new Map<string, E3Attribute>();
  for (const a of list) if (!m.has(a.name)) m.set(a.name, a);
  return m;
}

const fileDiff = (cur: E3Attribute, inc: E3Attribute): string[] => FILE_FIELDS.filter((f) => cur[f] !== inc[f]);

/**
 * Что сделает загрузка файла. Ничего не пишет: это предпросмотр.
 *
 * Сравнивается только то, что приходит из файла. Источник, типы и правило
 * спора — настройки Flux: файл про них ничего не знает, и «изменённых» из-за
 * них быть не должно. Атрибут, который правили руками, загрузка не
 * перезаписывает, а показывает отдельно.
 */
export function planAttributes(current: E3Attribute[], incoming: E3Attribute[]): E3Plan {
  const plan: E3Plan = { added: [], changed: [], same: 0, missing: [], editedKept: [], issues: [] };
  const cur = byNameFirst(current || []);
  const seen = new Set<string>();
  for (const inc of incoming || []) {
    if (seen.has(inc.name)) { plan.issues.push(`${inc.name}: в загружаемых данных дважды — взята первая запись`); continue; }
    seen.add(inc.name);
    const before = cur.get(inc.name);
    if (!before) { plan.added.push(inc); continue; }
    const diff = fileDiff(before, inc);
    const keep = !!before.edited && diff.length > 0;
    const fields = [...(before.edited ? [] : diff), ...(before.removed ? ['removed'] : [])];
    if (keep) plan.editedKept.push(inc.name);
    if (fields.length) {
      const after: E3Attribute = { ...before };
      for (const f of fields) if (f !== 'removed') (after as any)[f] = (inc as any)[f];
      delete after.removed;
      plan.changed.push({ name: inc.name, fields, before, after });
    } else if (!keep) plan.same++;
  }
  for (const a of current || []) if (!a.removed && !seen.has(a.name) && !plan.missing.includes(a.name)) plan.missing.push(a.name);
  return plan;
}

/**
 * Применить план. Порядок — как в файле, затем остальные записи каталога.
 * Записи, которых нет в файле, при `remove` помечаются снятыми, но не
 * удаляются: выгрузки и снимки «до» ссылаются на них по имени.
 */
export function applyAttributePlan(current: E3Attribute[], incoming: E3Attribute[], opts: { missing: 'keep' | 'remove' }): E3Attribute[] {
  const cur = byNameFirst(current || []);
  const out: E3Attribute[] = [];
  const used = new Set<string>();
  for (const inc of incoming || []) {
    if (used.has(inc.name)) continue;
    used.add(inc.name);
    const before = cur.get(inc.name);
    if (!before) { out.push(inc); continue; }
    const next: E3Attribute = { ...before };
    if (!before.edited) for (const f of FILE_FIELDS) (next as any)[f] = (inc as any)[f];
    delete next.removed;
    out.push(next);
  }
  for (const a of current || []) {
    if (used.has(a.name)) continue;
    out.push(opts?.missing === 'remove' && !a.removed ? { ...a, removed: true } : a);
  }
  return out;
}

// ── Какие атрибуты у какого типа и что идёт в выгрузку ──────────────────────

/** Атрибуты типа оборудования: заданные вручную типы сильнее класса из файла */
export function attributesForClass(items: E3Attribute[], classId: string): E3Attribute[] {
  return (items || []).filter((a) => {
    if (a.removed) return false;
    if (a.classes && a.classes.length) return a.classes.includes(classId);
    const rule = classRule(a.attrClass);
    if (rule.all) return true;
    // Кабельные атрибуты без выбранных вручную типов не относятся ни к одному
    return rule.ids.includes(classId);
  });
}

/**
 * Столбцы выгрузки `e3:<имя>` для выбранных типов (пусто — все типы).
 * Порядок — как в справочнике. Для атрибута без «Да» источник пуст: Flux его
 * не заполняет, столбец остаётся для ручного ввода.
 */
export function e3Columns(items: E3Attribute[], classIds: string[], opts: { header: 'name' | 'title'; onlyFromFlux?: boolean }): ExportColumn[] {
  const live = (items || []).filter((a) => !a.removed);
  const picked = classIds && classIds.length
    ? live.filter((a) => classIds.some((id) => attributesForClass([a], id).length))
    : live;
  const seen = new Set<string>();
  const out: ExportColumn[] = [];
  for (const a of picked) {
    if (seen.has(a.name) || (opts?.onlyFromFlux && !a.fromFlux)) continue;
    seen.add(a.name);
    // «Да» без источника — данные КИП: значение лежит в группе «КИП» позиции под именем
    // атрибута (книга, загруженная обратно, кладёт его туда) и в следующую выгрузку попадает оттуда
    const source: E3Source = !a.fromFlux ? { kind: 'none' } : a.source.kind === 'none' ? { kind: 'param', name: `${KIP_GROUP}|${a.name}` } : a.source;
    const col: ExportColumn = { key: `e3:${a.name}`, label: opts?.header === 'title' ? (a.title || a.name) : a.name, source };
    if (source.kind === 'param' && source.unit) col.unit = source.unit;
    out.push(col);
  }
  return out;
}

// ── Проверка входных данных (сервер и шаблоны выгрузки) ─────────────────────

const MAX_TEXT = 500;

/** Источник из чужих рук → источник или null, если это не источник */
export function sanitizeSource(raw: any): E3Source | null {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length <= MAX_TEXT ? v : null);
  switch (raw.kind) {
    case 'none': return { kind: 'none' };
    case 'field': return E3_FIELD_KEYS.includes(raw.key) ? { kind: 'field', key: raw.key } : null;
    case 'param': {
      const name = str(raw.name)?.trim();
      if (!name) return null;
      if (raw.unit === undefined || raw.unit === null || raw.unit === '') return { kind: 'param', name };
      const unit = str(raw.unit)?.trim();
      return unit === undefined || unit === null ? null : { kind: 'param', name, ...(unit ? { unit } : {}) };
    }
    case 'const': { const value = str(raw.value); return value === null ? null : { kind: 'const', value }; }
    default: return null;
  }
}

/** Типы оборудования: только известные Flux, без повторов */
export function sanitizeClasses(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > CLASSES.length) return null;
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c !== 'string' || !isClassId(c)) return null;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Атрибуты из тела запроса: массив не длиннее 2000, строки не длиннее 500
 * знаков, источник одного из четырёх видов. Строка ошибки — человеку.
 */
export function validateAttributes(raw: unknown): { items: E3Attribute[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'Ожидается список атрибутов' };
  if (raw.length > 2000) return { error: 'Слишком много атрибутов: не больше 2000' };
  const items: E3Attribute[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r: any = raw[i];
    const where = `Атрибут ${i + 1}`;
    if (!r || typeof r !== 'object') return { error: `${where}: ожидается объект` };
    for (const f of ['name', 'title', 'carrier', 'attrClass', 'script', 'comment'] as const) {
      if (typeof r[f] !== 'string') return { error: `${where}: поле «${f}» должно быть строкой` };
      if (r[f].length > MAX_TEXT) return { error: `${where}: поле «${f}» длиннее ${MAX_TEXT} знаков` };
    }
    const name = r.name.trim();
    if (!name) return { error: `${where}: нет имени` };
    if (typeof r.service !== 'boolean' || typeof r.fromFlux !== 'boolean') return { error: `${name}: «service» и «fromFlux» должны быть true или false` };
    const source = sanitizeSource(r.source);
    if (!source) return { error: `${name}: источник значения не распознан` };
    const classes = sanitizeClasses(r.classes ?? []);
    if (!classes) return { error: `${name}: неизвестный тип оборудования` };
    if (!E3_CONFLICTS.includes(r.conflict)) return { error: `${name}: неизвестное правило спора со скриптом` };
    items.push({
      name, title: r.title, carrier: r.carrier, attrClass: r.attrClass, service: r.service, fromFlux: r.fromFlux,
      script: r.script, comment: r.comment, source, classes, conflict: r.conflict,
      ...(r.edited ? { edited: true } : {}), ...(r.removed ? { removed: true } : {}),
    });
  }
  return { items };
}
