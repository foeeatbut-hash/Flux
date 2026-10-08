/**
 * Каталог типовых решений E3.series: разбор «Классификатора типовых решений»,
 * план загрузки, проверка входных данных. Подбор — `solutionSelect.ts`,
 * признаки и правила по умолчанию — `solutionDefaults.ts`.
 *
 * Исходник — каталог Flux (docs/e3-integration.md, 5.0): Excel нужен только
 * чтобы наполнить каталог и обменяться. Поэтому у решения два слоя, и путать
 * их нельзя, как у справочника атрибутов:
 *
 *   — поля ИЗ ФАЙЛА (класс, название схемы, описание, ссылки, «Есть в САПР»,
 *     изделия, пояснение): загрузка файла их обновляет;
 *   — НАСТРОЙКИ Flux (признаки и их подтверждение): файл их не трогает, их
 *     ведёт человек в каталоге.
 *
 * Модуль чистый: без React, без сервера, без сети.
 */
import { isClassId } from '../equipment/classes';
import { E3_FIELD_KEYS } from './attributes';
import { DEFAULT_CLASS_MAP, DEFAULT_FEATURES, DEFAULT_RULES, normText, suggestFeatures } from './solutionDefaults';
import { DEFAULT_IO_RULES } from './ioDefaults';
import { planIoTable, sanitizeRecipeLines } from './ioTable';
import type {
  E3Dictionary, E3Feature, E3FeatureRule, E3IoRow, E3Profile, E3RuleSource, E3Solution, E3SolutionBook, E3SolutionPlan,
} from './solutionTypes';

export * from './solutionTypes';
export { DEFAULT_CLASS_MAP, DEFAULT_FEATURES, DEFAULT_RULES, suggestFeatures, cyrillicToken } from './solutionDefaults';
export { selectSolution } from './solutionSelect';
export * from './ioTable';
export { DEFAULT_IO_RULES } from './ioDefaults';
export { buildRecipe, buildRecipeFor, parseRecipeLines, recipeLinesText } from './recipe';
export { planMissingDefaults, applyMissingDefaults, type E3MissingDefaults } from './solutionMissing';

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const yes = (v: unknown): boolean => normText(v) === 'да';

export const emptySolutionBook = (): E3SolutionBook => ({
  version: 0, solutions: [], features: structuredClone(DEFAULT_FEATURES), dictionary: {}, rules: structuredClone(DEFAULT_RULES),
  ioTable: [], ioRules: structuredClone(DEFAULT_IO_RULES), classMap: structuredClone(DEFAULT_CLASS_MAP), updatedAt: '',
});

/** Поля, которые приходят из файла: только их сравнивает и обновляет загрузка */
export const SOLUTION_FILE_FIELDS = ['mainClass', 'subclass', 'short', 'name', 'description', 'pdf', 'e3p', 'twoLevel', 'inCad', 'items', 'symbols', 'note'] as const;

// ── Разбор листов ───────────────────────────────────────────────────────────

/**
 * Лист «Обозначения»: пара столбцов «Обозначение в классификаторе» →
 * «Краткое описание». В файле владельца таких заголовков два — слева легенда
 * по классам («ПП – прямой пуск…»), справа сам словарь; берётся пара, у
 * которой справа стоит «Краткое описание».
 */
export function parseDictionarySheet(rows: unknown[][]): { dictionary: E3Dictionary; issues: string[] } {
  const dictionary: E3Dictionary = {};
  const issues: string[] = [];
  const list = Array.isArray(rows) ? rows : [];
  let headerAt = -1; let codeCol = -1;
  for (let i = 0; i < list.length && headerAt < 0; i++) {
    const r = list[i];
    if (!Array.isArray(r)) continue;
    for (let j = 0; j < r.length - 1; j++) {
      if (normText(r[j]).startsWith('обозначение') && normText(r[j + 1]).startsWith('краткое описание')) { headerAt = i; codeCol = j; break; }
    }
  }
  if (headerAt < 0) return { dictionary, issues: ['Не найдены столбцы «Обозначение в классификаторе» и «Краткое описание»'] };
  for (let i = headerAt + 1; i < list.length; i++) {
    const r = list[i];
    if (!Array.isArray(r)) continue;
    const raw = r[codeCol] === null || r[codeCol] === undefined ? '' : String(r[codeCol]);
    const code = raw.trim();
    const description = text(r[codeCol + 1]);
    if (!code && !description) continue;
    if (!code) { issues.push(`Словарь, строка ${i + 1}: описание «${description}» без кода — пропущено`); continue; }
    if (code in dictionary) { issues.push(`Словарь: код «${code}» встречается дважды — взято первое описание`); continue; }
    dictionary[code] = description;
  }
  return { dictionary, issues };
}

/** Лист «Классификатор типовых решений» → решения и замечания */
export function parseSolutionSheet(rows: unknown[][], ctx: { features: E3Feature[]; dictionary: E3Dictionary }): { items: E3Solution[]; issues: string[] } {
  const items: E3Solution[] = [];
  const issues: string[] = [];
  const list = Array.isArray(rows) ? rows : [];
  const headerAt = list.findIndex((r) => Array.isArray(r) && r.some((c) => normText(c).includes('уникальный id')));
  if (headerAt < 0) return { items, issues: ['Не найдена строка заголовков: нужен столбец «Уникальный ID типового решения»'] };

  const col: Record<string, number> = { id: -1, mainClass: -1, subclass: -1, short: -1, name: -1, description: -1, pdf: -1, e3p: -1, twoLevel: -1, inCad: -1, items: -1, symbols: -1, note: -1, confirmed: -1 };
  const featureCols: [number, string][] = [];
  (list[headerAt] as unknown[]).forEach((cell, j) => {
    const n = normText(cell);
    if (!n) return;
    const fid = String(cell).trim().match(/\[([\w.\-]+)\]$/);
    if (fid) featureCols.push([j, fid[1]]);
    else if (n.includes('уникальный id')) col.id = j;
    else if (n.includes('основной класс')) col.mainClass = j;
    else if (n === 'класс') col.subclass = j;
    else if (n.startsWith('краткое обозначение')) col.short = j;
    else if (n.startsWith('название схемы')) col.name = j;
    else if (n.startsWith('описание схемы')) col.description = j;
    else if (n.includes('pdf')) col.pdf = j;
    else if (n.includes('.e3p') || n.includes('e3p')) col.e3p = j;
    else if (n.startsWith('двухуровнев')) col.twoLevel = j;
    else if (n.startsWith('есть в сапр')) col.inCad = j;
    else if (n.startsWith('список изделий')) col.items = j;
    else if (n.startsWith('список символов')) col.symbols = j;
    else if (n.startsWith('пояснение')) col.note = j;
    else if (n.startsWith('признаки подтверждены')) col.confirmed = j;
  });
  for (const [key, what] of [['mainClass', 'Основной класс'], ['name', 'Название схемы']] as const) {
    if (col[key] < 0) issues.push(`В файле нет столбца «${what}»`);
  }

  const knownFeature = new Set(ctx.features.map((f) => f.id));
  const firstRow = new Map<string, number>();
  const trimmed: string[] = [];
  const byName = new Map<string, string[]>();
  const latin: string[] = [];
  const unknownCodes = new Set<string>();
  let toConfirm = 0;
  const raw = (row: unknown[], j: number): string => (j < 0 || row[j] === null || row[j] === undefined ? '' : String(row[j]));

  for (let i = headerAt + 1; i < list.length; i++) {
    const row = list[i];
    if (!Array.isArray(row) || row.every((c) => !text(c))) continue;
    const line = i + 1;
    const id = text(row[col.id]);
    if (!id) { issues.push(`Строка ${line}: нет ID решения — пропущена`); continue; }
    if (firstRow.has(id)) { issues.push(`${id}: ID в файле дважды — взята строка ${firstRow.get(id)}, строка ${line} пропущена`); continue; }
    firstRow.set(id, line);

    const cell = (key: string): string => {
      const v = raw(row, col[key]);
      if (v !== v.trim() && !trimmed.includes(id)) trimmed.push(id);
      return v.trim();
    };
    const sol: E3Solution = {
      id, mainClass: cell('mainClass'), subclass: cell('subclass'), short: cell('short'), name: cell('name'), description: cell('description'),
      pdf: cell('pdf'), e3p: cell('e3p'), twoLevel: yes(row[col.twoLevel]), inCad: yes(row[col.inCad]), items: cell('items'), symbols: cell('symbols'),
      note: cell('note'), features: {}, featuresConfirmed: false,
    };
    if (!sol.mainClass) issues.push(`${id}: нет основного класса — решение не подберётся ни одной позиции`);
    if (!sol.name) issues.push(`${id}: нет названия схемы — в E3 не на что ссылаться`);
    else { const same = byName.get(sol.name) || []; same.push(id); byName.set(sol.name, same); }

    const s = suggestFeatures(sol, ctx);
    sol.features = s.features;
    sol.featuresConfirmed = s.confirmed;
    if (!s.confirmed) toConfirm++;
    for (const [from, to] of s.latin) latin.push(`${id}: «${from}» → «${to}» в «${sol.name}»`);
    for (const c of s.notInDictionary) unknownCodes.add(c);
    if (s.ambiguous.length) issues.push(`${id} ${sol.name}: на подтверждение — ${s.ambiguous.map((a) => `«${a.token}»: ${a.reason}`).join('; ')}`);
    if (s.unknown.length) issues.push(`${id} ${sol.name}: не разобрано — ${s.unknown.map((u) => (u.startsWith('признак') ? u : `«${u}»`)).join(', ')}`);

    // Файл с признаками (выгрузка каталога): явные ответы сильнее разбора названия
    if (featureCols.length) {
      const own = featureCols.filter(([, fid]) => knownFeature.has(fid) && ctx.features.find((f) => f.id === fid)?.mainClass === sol.mainClass);
      for (const [j, fid] of own) { const v = text(row[j]); if (v) sol.features[fid] = v; }
      if (col.confirmed >= 0) sol.featuresConfirmed = yes(row[col.confirmed]);
    }
    items.push(sol);
  }

  if (trimmed.length) issues.push(`Пробелы по краям значений убраны у ${trimmed.length} решений (например ${trimmed.slice(0, 4).join(', ')}): в названии схемы они не сохраняются`);
  for (const [name, ids] of byName) if (ids.length > 1) issues.push(`Название схемы «${name}» у решений ${ids.join(' и ')} — решения разные, ключом остаётся ID`);
  for (const l of latin) issues.push(`Латинская буква вместо кириллической: ${l} — в названии оставлено как в файле, признак разобран по кириллическому`);
  if (unknownCodes.size) {
    const all = [...unknownCodes];
    issues.push(`Кодов нет в словаре «Обозначения»: ${all.slice(0, 15).join(', ')}${all.length > 15 ? ` и ещё ${all.length - 15}` : ''}`);
  }
  if (items.length) issues.unshift(`Признаки разобраны из названий: подтверждения ждут ${toConfirm} из ${items.length}`);
  return { items, issues };
}

// ── План загрузки ───────────────────────────────────────────────────────────

const firstById = (list: E3Solution[]): Map<string, E3Solution> => {
  const m = new Map<string, E3Solution>();
  for (const s of list) if (!m.has(s.id)) m.set(s.id, s);
  return m;
};
const fileDiff = (cur: E3Solution, inc: E3Solution): string[] => SOLUTION_FILE_FIELDS.filter((f) => cur[f] !== inc[f]);

/** Что сделает загрузка. Ничего не пишет. Признаки у существующих решений не сравниваются: файл их не ведёт */
export function planSolutions(
  current: E3Solution[], incoming: E3Solution[], dictionary?: { current: E3Dictionary; incoming: E3Dictionary }, io?: { current: E3IoRow[]; incoming: E3IoRow[] },
): E3SolutionPlan {
  const plan: E3SolutionPlan = { added: [], changed: [], same: 0, missing: [], editedKept: [], dictionaryAdded: [], dictionaryDiffers: [], issues: [] };
  const cur = firstById(current || []);
  const seen = new Set<string>();
  for (const inc of incoming || []) {
    if (seen.has(inc.id)) { plan.issues.push(`${inc.id}: в загружаемых данных дважды — взята первая запись`); continue; }
    seen.add(inc.id);
    const before = cur.get(inc.id);
    if (!before) { plan.added.push(inc); continue; }
    const diff = fileDiff(before, inc);
    const keep = !!before.edited && diff.length > 0;
    const fields = [...(before.edited ? [] : diff), ...(before.removed ? ['removed'] : [])];
    if (keep) plan.editedKept.push(inc.id);
    if (fields.length) {
      const after: E3Solution = { ...before };
      for (const f of fields) if (f !== 'removed') (after as any)[f] = (inc as any)[f];
      delete after.removed;
      plan.changed.push({ id: inc.id, fields, before, after });
    } else if (!keep) plan.same++;
  }
  for (const s of current || []) if (!s.removed && !seen.has(s.id) && !plan.missing.includes(s.id)) plan.missing.push(s.id);
  if (dictionary) {
    for (const [code, d] of Object.entries(dictionary.incoming)) {
      if (!(code in dictionary.current)) plan.dictionaryAdded.push(code);
      else if (dictionary.current[code] !== d) plan.dictionaryDiffers.push(code);
    }
  }
  if (io && io.incoming.length) plan.io = planIoTable(io.current, io.incoming);
  return plan;
}

/** Новые коды словаря добавляются, расхождения оставляют своё описание: словарь — настройка каталога */
export function mergeDictionary(current: E3Dictionary, incoming: E3Dictionary): E3Dictionary {
  const out: E3Dictionary = { ...current };
  for (const [code, d] of Object.entries(incoming || {})) if (!(code in out)) out[code] = d;
  return out;
}

/** Применить план: порядок как в файле, затем остальные. Снятые не удаляются — на них ссылаются схемы */
export function applySolutionPlan(current: E3Solution[], incoming: E3Solution[], opts: { missing: 'keep' | 'remove' }): E3Solution[] {
  const cur = firstById(current || []);
  const out: E3Solution[] = [];
  const used = new Set<string>();
  for (const inc of incoming || []) {
    if (used.has(inc.id)) continue;
    used.add(inc.id);
    const before = cur.get(inc.id);
    if (!before) { out.push(inc); continue; }
    const next: E3Solution = { ...before };
    if (!before.edited) for (const f of SOLUTION_FILE_FIELDS) (next as any)[f] = (inc as any)[f];
    delete next.removed;
    out.push(next);
  }
  for (const s of current || []) {
    if (used.has(s.id)) continue;
    out.push(opts?.missing === 'remove' && !s.removed ? { ...s, removed: true } : s);
  }
  return out;
}

// ── Проверка входных данных (сервер) ────────────────────────────────────────

const MAX = 2000;
const ID = /^[\w.\-]{1,80}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);

/** Ответы на признаки: id → значение; только строки, без служебных ключей */
export function sanitizeFeatureAnswers(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  const keys = Object.keys(raw);
  if (keys.length > 100) return null;
  for (const k of keys) {
    const v = str((raw as any)[k], 100);
    if (!ID.test(k) || FORBIDDEN.has(k) || v === null) return null;
    out[k] = v;
  }
  return out;
}

/** Решения из тела запроса. Пометки «правлено» и «снято» принимает только справочник */
export function validateSolutions(raw: unknown): { items: E3Solution[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'Ожидается список решений' };
  if (raw.length > MAX) return { error: `Слишком много решений: не больше ${MAX}` };
  const items: E3Solution[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r: any = raw[i];
    const where = `Решение ${i + 1}`;
    if (!r || typeof r !== 'object') return { error: `${where}: ожидается объект` };
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!ID.test(id)) return { error: `${where}: ID — до 80 знаков из букв, цифр, точки и дефиса` };
    for (const f of ['mainClass', 'subclass', 'short', 'name', 'description', 'pdf', 'e3p', 'items', 'symbols', 'note'] as const) {
      if (typeof r[f] !== 'string') return { error: `${id}: поле «${f}» должно быть строкой` };
      if (r[f].length > 1000) return { error: `${id}: поле «${f}» длиннее 1000 знаков` };
    }
    if (typeof r.twoLevel !== 'boolean' || typeof r.inCad !== 'boolean' || typeof r.featuresConfirmed !== 'boolean') return { error: `${id}: «twoLevel», «inCad» и «featuresConfirmed» должны быть true или false` };
    const features = sanitizeFeatureAnswers(r.features ?? {});
    if (!features) return { error: `${id}: признаки — набор «id → значение»` };
    const recipeOverride = r.recipeOverride === undefined ? [] : sanitizeRecipeLines(r.recipeOverride);
    if (!recipeOverride) return { error: `${id}: ручной состав — до 40 строк «роль, строка IO, число»` };
    items.push({
      id, mainClass: r.mainClass.trim(), subclass: r.subclass.trim(), short: r.short.trim(), name: r.name.trim(), description: r.description,
      pdf: r.pdf, e3p: r.e3p, twoLevel: r.twoLevel, inCad: r.inCad, items: r.items, symbols: r.symbols, note: r.note, features, featuresConfirmed: r.featuresConfirmed,
      ...(r.edited ? { edited: true } : {}), ...(r.removed ? { removed: true } : {}), ...(recipeOverride.length ? { recipeOverride } : {}),
    });
  }
  return { items };
}

export function sanitizeRuleSource(raw: any): E3RuleSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = (v: unknown) => { const s = str(v, 200)?.trim(); return s || null; };
  const unit = (v: unknown) => (v === undefined || v === null || v === '' ? '' : str(v, 20)?.trim() ?? null);
  switch (raw.kind) {
    case 'field': return E3_FIELD_KEYS.includes(raw.key) ? { kind: 'field', key: raw.key } : null;
    case 'param': { const n = name(raw.name); const u = unit(raw.unit); return n && u !== null ? { kind: 'param', name: n, ...(u ? { unit: u } : {}) } : null; }
    case 'count': { const role = name(raw.role); return role ? { kind: 'count', role } : null; }
    case 'child-param': { const role = name(raw.role); const n = name(raw.name); const u = unit(raw.unit); return role && n && u !== null ? { kind: 'child-param', role, name: n, ...(u ? { unit: u } : {}) } : null; }
    case 'child-field': { const role = name(raw.role); return role && E3_FIELD_KEYS.includes(raw.key) ? { kind: 'child-field', role, key: raw.key } : null; }
    default: return null;
  }
}

const KINDS = ['ov', 'profile', 'layout'];

export function sanitizeFeature(raw: any): E3Feature | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id, 60); const mainClass = str(raw.mainClass, 100)?.trim(); const title = str(raw.title, 200)?.trim(); const hint = str(raw.hint ?? '', 500);
  if (!id || !ID.test(id) || FORBIDDEN.has(id) || !mainClass || !title || hint === null || !KINDS.includes(raw.kind)) return null;
  if (!Array.isArray(raw.values) || raw.values.length > 60) return null;
  const values: string[] = [];
  for (const v of raw.values) {
    const s = str(v, 100)?.trim();
    if (!s) return null;
    if (!values.includes(s)) values.push(s);
  }
  const absent = raw.absent === undefined || raw.absent === null || raw.absent === '' ? undefined : str(raw.absent, 100)?.trim();
  if (absent === null || (absent !== undefined && !values.includes(absent))) return null;
  return { id, mainClass, title, values, kind: raw.kind, hint, ...(absent ? { absent } : {}) };
}

export function sanitizeRule(raw: any): E3FeatureRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const mainClass = str(raw.mainClass, 100)?.trim(); const featureId = str(raw.featureId, 60);
  const source = sanitizeRuleSource(raw.source);
  if (!mainClass || !featureId || !/^(@class|[\w.\-]+)$/.test(featureId) || FORBIDDEN.has(featureId) || !source) return null;
  if (!Array.isArray(raw.table) || raw.table.length > 60) return null;
  const table: { when: string; answer: string }[] = [];
  for (const t of raw.table) {
    const when = str(t?.when, 100); const answer = str(t?.answer, 100);
    if (!when?.trim() || answer === null) return null;
    table.push({ when: when.trim(), answer: answer.trim() });
  }
  const otherwise = raw.otherwise === undefined || raw.otherwise === null || raw.otherwise === '' ? undefined : str(raw.otherwise, 100)?.trim();
  if (otherwise === null) return null;
  return { mainClass, featureId, source, table, ...(otherwise ? { otherwise } : {}) };
}

export function sanitizeDictionary(raw: unknown): E3Dictionary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length > MAX) return null;
  const out: E3Dictionary = {};
  for (const k of keys) {
    const code = k.trim(); const d = str((raw as any)[k], 500);
    if (!code || code.length > 60 || FORBIDDEN.has(code) || d === null) return null;
    out[code] = d.trim();
  }
  return out;
}

export function sanitizeClassMap(raw: unknown): Record<string, string[]> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string[]> = {};
  const keys = Object.keys(raw);
  if (keys.length > 100) return null;
  for (const k of keys) {
    const list = (raw as any)[k];
    if (!isClassId(k) || !Array.isArray(list) || list.length > 20) return null;
    const classes: string[] = [];
    for (const c of list) {
      const s = str(c, 100)?.trim();
      if (!s) return null;
      if (!classes.includes(s)) classes.push(s);
    }
    out[k] = classes;
  }
  return out;
}

/** Профиль проекта: ответы строкой или порогом */
export function sanitizeProfile(raw: unknown): E3Profile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: E3Profile = {};
  const keys = Object.keys(raw);
  if (keys.length > 300) return null;
  for (const k of keys) {
    const v: any = (raw as any)[k];
    if (!/^[\w.\-]+$/.test(k) || FORBIDDEN.has(k)) return null;
    if (typeof v === 'string') { if (v.length > 100) return null; out[k] = v; continue; }
    const source = sanitizeRuleSource(v?.source);
    if (!source || !Array.isArray(v?.steps) || v.steps.length > 20) return null;
    const above = str(v.above, 100);
    if (above === null) return null;
    const steps: { upTo: number; answer: string }[] = [];
    for (const s of v.steps) {
      const answer = str(s?.answer, 100);
      if (typeof s?.upTo !== 'number' || !Number.isFinite(s.upTo) || answer === null) return null;
      steps.push({ upTo: s.upTo, answer });
    }
    out[k] = { source, steps, above };
  }
  return out;
}
