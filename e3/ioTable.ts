/**
 * Лист «Таблица IO» классификатора: сколько сигналов (DI, DO, AI, AO) даёт
 * каждый вид устройства (docs/e3-integration.md, 5.4 и 5.9). По этим числам
 * рецепт блока (`recipe.ts`) считает сигналы установки до выгрузки в E3.
 *
 * Как и у решений, у строки два слоя: поля ИЗ ФАЙЛА (группа, наименование,
 * обозначение, числа, описания) загрузка обновляет; имя изделия E3
 * (`component`) — настройка Flux, в файле его нет, его задаёт каталог, и
 * загрузка его не трогает.
 *
 * Модуль чистый: без React, без сервера, без сети.
 */
import { normText } from './solutionDefaults';
import type { E3IoCount, E3IoCond, E3IoPlan, E3IoRow, E3IoRowRef, E3IoRule, E3IoSignals, E3RecipeLine } from './solutionTypes';

export const IO_SHEET = 'Таблица IO';
export const IO_KEYS = ['di', 'do', 'ai', 'ao'] as const;
export const IO_TITLES: Record<(typeof IO_KEYS)[number], string> = { di: 'DI', do: 'DO', ai: 'AI', ao: 'AO' };
/** Поля из файла: только их сравнивает и обновляет загрузка */
export const IO_FILE_FIELDS = ['group', 'name', 'code', 'di', 'do', 'ai', 'ao', 'notes'] as const;

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
/** Многострочная ячейка с состояниями («Работа» / «Авария») одной строкой */
const oneLine = (v: unknown): string => text(v).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' / ');
const slug = (s: string): string => normText(s).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80);

/** Стабильный ключ строки: группа и наименование без регистра, пробелов и знаков */
export const ioRowId = (group: string, name: string): string => `${slug(group) || '-'}::${slug(name) || '-'}`;

export const emptySignals = (): E3IoSignals => ({ di: 0, do: 0, ai: 0, ao: 0 });
export const addSignals = (a: E3IoSignals, b: E3IoSignals, times = 1): E3IoSignals =>
  ({ di: a.di + b.di * times, do: a.do + b.do * times, ai: a.ai + b.ai * times, ao: a.ao + b.ao * times });
/** «DI 2 · DO 1 · AI 1»: только ненулевые; пусто — «нет сигналов» */
export const signalsText = (s: E3IoSignals): string => {
  const parts = IO_KEYS.filter((k) => s[k] > 0).map((k) => `${IO_TITLES[k]} ${s[k]}`);
  return parts.length ? parts.join(' · ') : 'нет сигналов';
};

// ── Разбор листа ────────────────────────────────────────────────────────────

/**
 * Лист «Таблица IO». Шапка — по подписям, а не по номеру строки: «Полевые
 * приборы», «Наименование», «Обозначение», затем DI, DO, AI, AO дважды — первая
 * четвёрка числа сигналов, вторая описания. Группа в первом столбце стоит
 * только в первой строке блока, ниже она продолжается; строка без цифр и
 * описаний — подзаголовок раздела, её пропускаем.
 */
export function parseIoSheet(rows: unknown[][]): { rows: E3IoRow[]; issues: string[] } {
  const out: E3IoRow[] = [];
  const issues: string[] = [];
  const list = Array.isArray(rows) ? rows : [];
  const headerAt = list.findIndex((r) => Array.isArray(r) && r.some((c) => normText(c) === 'полевые приборы'));
  if (headerAt < 0) return { rows: out, issues: ['Лист «Таблица IO»: не найдена строка заголовков со столбцом «Полевые приборы»'] };

  let gCol = -1; let nCol = -1; let cCol = -1;
  const counts: number[] = []; const notes: number[] = [];
  const seenKey = new Set<string>();
  (list[headerAt] as unknown[]).forEach((cell, j) => {
    const n = normText(cell);
    if (n === 'полевые приборы') gCol = j;
    else if (n === 'наименование') nCol = j;
    else if (n === 'обозначение') cCol = j;
    else if ((IO_KEYS as readonly string[]).includes(n)) {
      const k = IO_KEYS.indexOf(n as any);
      if (!seenKey.has(n)) { seenKey.add(n); counts[k] = j; } else if (notes[k] === undefined) notes[k] = j;
    }
  });
  if (nCol < 0) issues.push('Лист «Таблица IO»: нет столбца «Наименование»');
  const missingKeys = IO_KEYS.filter((_, k) => counts[k] === undefined);
  if (missingKeys.length) issues.push(`Лист «Таблица IO»: нет столбцов ${missingKeys.map((k) => IO_TITLES[k]).join(', ')}`);
  if (nCol < 0 || missingKeys.length) return { rows: out, issues };

  let group = '';
  const used = new Map<string, number>();
  for (let i = headerAt + 1; i < list.length; i++) {
    const r = list[i];
    if (!Array.isArray(r) || r.every((c) => !text(c))) continue;
    const line = i + 1;
    const g = gCol >= 0 ? text(r[gCol]) : '';
    if (g) group = g;
    const name = text(r[nCol]);
    const nums = IO_KEYS.map((_, k) => {
      const raw = text(r[counts[k]]);
      if (!raw) return 0;
      const v = Number(raw.replace(',', '.'));
      if (!Number.isInteger(v) || v < 0) { issues.push(`Таблица IO, строка ${line}: в столбце ${IO_TITLES[IO_KEYS[k]]} «${raw}» — не целое число, принято 0`); return 0; }
      return v;
    });
    const desc = IO_KEYS.map((_, k) => (notes[k] === undefined ? '' : oneLine(r[notes[k]])));
    const hasDigits = IO_KEYS.some((_, k) => !!text(r[counts[k]]));
    const hasNotes = desc.some(Boolean);
    // Подзаголовок раздела («Описываются сигналы от полевых устройств…»): ни цифр, ни описаний
    if (!hasDigits && !hasNotes) continue;
    if (!name) { issues.push(`Таблица IO, строка ${line}: сигналы есть, а наименования нет — строка пропущена`); continue; }
    if (!hasDigits) issues.push(`Таблица IO, строка ${line} «${name}»: описания сигналов есть, а числа не заданы — принято 0`);

    let id = ioRowId(group, name);
    const again = (used.get(id) || 0) + 1;
    used.set(id, again);
    if (again > 1) { issues.push(`Таблица IO, строка ${line}: «${name}» в группе «${group}» повторяется — ключ получил номер ${again}`); id = `${id}#${again}`; }
    out.push({
      id, group, name, code: cCol >= 0 ? text(r[cCol]) : '', di: nums[0], do: nums[1], ai: nums[2], ao: nums[3],
      notes: { di: desc[0], do: desc[1], ai: desc[2], ao: desc[3] },
    });
  }
  if (!out.length) issues.push('Лист «Таблица IO»: строк с сигналами не найдено');
  return { rows: out, issues };
}

/** Лист для выгрузки каталога: той же формы, что в файле владельца (шапка в двух строках), чтобы он читался обратно */
export function ioSheetRows(table: E3IoRow[]): string[][] {
  const head2 = ['', '', '', '', 'Входы-выходы для БПУ', '', '', '', '', 'Описание сигналов', '', '', ''];
  const head3 = ['', 'Полевые приборы', 'Наименование', 'Обозначение', 'DI', 'DO', 'AI', 'AO', '', 'DI', 'DO', 'AI', 'AO'];
  const rows: string[][] = [[], head2, head3];
  let prev = '\u0000';
  for (const r of table || []) {
    const n = (v: number) => (v > 0 ? String(v) : '');
    rows.push(['', r.group === prev ? '' : r.group, r.name, r.code, n(r.di), n(r.do), n(r.ai), n(r.ao), '', r.notes?.di || '', r.notes?.do || '', r.notes?.ai || '', r.notes?.ao || '']);
    prev = r.group;
  }
  return rows;
}

// ── План загрузки ───────────────────────────────────────────────────────────

const sameFile = (a: E3IoRow, b: E3IoRow, f: (typeof IO_FILE_FIELDS)[number]): boolean =>
  f === 'notes' ? IO_KEYS.every((k) => (a.notes?.[k] || '') === (b.notes?.[k] || '')) : a[f] === b[f];
const fileDiff = (cur: E3IoRow, inc: E3IoRow): string[] => IO_FILE_FIELDS.filter((f) => !sameFile(cur, inc, f));
const byId = (list: E3IoRow[]): Map<string, E3IoRow> => { const m = new Map<string, E3IoRow>(); for (const r of list) if (!m.has(r.id)) m.set(r.id, r); return m; };

/** Что сделает загрузка листа. Ничего не пишет */
export function planIoTable(current: E3IoRow[], incoming: E3IoRow[]): E3IoPlan {
  const plan: E3IoPlan = { added: 0, changed: [], same: 0, missing: [], editedKept: [] };
  const cur = byId(current || []);
  const seen = new Set<string>();
  for (const inc of incoming || []) {
    if (seen.has(inc.id)) continue;
    seen.add(inc.id);
    const before = cur.get(inc.id);
    if (!before) { plan.added++; continue; }
    const diff = fileDiff(before, inc);
    if (!diff.length) { plan.same++; continue; }
    if (before.edited) plan.editedKept.push(inc.id); else plan.changed.push({ id: inc.id, fields: diff });
  }
  for (const r of current || []) if (!seen.has(r.id) && !plan.missing.includes(r.id)) plan.missing.push(r.id);
  return plan;
}

/**
 * Применить загрузку: порядок как в файле, затем строки, которых в файле нет
 * (они остаются — файл могли прислать неполным). Имя изделия и пометка
 * «правлено» берутся из каталога; у правленой строки поля файла не меняются.
 */
export function mergeIoTable(current: E3IoRow[], incoming: E3IoRow[]): E3IoRow[] {
  const cur = byId(current || []);
  const out: E3IoRow[] = [];
  const used = new Set<string>();
  for (const inc of incoming || []) {
    if (used.has(inc.id)) continue;
    used.add(inc.id);
    const before = cur.get(inc.id);
    if (!before) { out.push({ ...inc }); continue; }
    if (before.edited) { out.push(before); continue; }
    out.push({ ...inc, ...(before.component ? { component: before.component } : {}) });
  }
  for (const r of current || []) if (!used.has(r.id)) { used.add(r.id); out.push(r); }
  return out;
}

// ── Поиск строки по ссылке правила ──────────────────────────────────────────

const codeTokens = (s: string): string[] => normText(s).split(/[\s,;/]+/).filter(Boolean);
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((t) => b.includes(t));

export const refText = (r: E3IoRowRef): string =>
  [r.group ? `группа «${r.group}»` : '', r.name ? `наименование «${r.name}»` : '', r.code ? `обозначение ${r.code}` : ''].filter(Boolean).join(', ') || 'любая строка';
export const refIsEmpty = (r: E3IoRowRef | undefined): boolean => !r || (!text(r.group) && !text(r.name) && !text(r.code));

/**
 * Строка IO по ссылке. Группа — целиком, наименование — вхождением, обозначение
 * — сначала совпадением всего набора кодов («TS» не цепляет «PT, PDT, TT»), и
 * только если такого нет, вхождением кода. Подходящих несколько — берётся
 * первая и говорится об этом: рецепт не должен молча выбирать за человека.
 */
export function findIoRow(table: E3IoRow[], ref: E3IoRowRef): { row?: E3IoRow; issue?: string } {
  if (refIsEmpty(ref)) return { issue: 'В правиле не указано, какую строку «Таблицы IO» брать' };
  const g = normText(ref.group); const n = normText(ref.name); const c = codeTokens(ref.code || '');
  let found = (table || []).filter((r) => (!g || normText(r.group) === g) && (!n || normText(r.name).includes(n)));
  if (c.length) {
    const exact = found.filter((r) => sameSet(codeTokens(r.code), c));
    found = exact.length ? exact : found.filter((r) => c.every((t) => codeTokens(r.code).includes(t)));
  }
  if (!found.length) return { issue: `В таблице IO нет строки: ${refText(ref)}` };
  if (found.length > 1) return { row: found[0], issue: `В таблице IO подходит несколько строк (${found.length}): ${refText(ref)} — взята «${found[0].name}»` };
  return { row: found[0] };
}

// ── Проверка входных данных (сервер) ────────────────────────────────────────

const MAX_ROWS = 500;
const ROW_ID = /^[\p{L}\p{N}\-:#]{1,200}$/u;
const RULE_ID = /^[\w.\-]{1,60}$/;
const FEATURE_ID = /^[\w.\-]{1,60}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 9999 ? v : null);

/** Одна строка IO из тела запроса; `component` и `edited` приходят отдельно: их знает только каталог */
export function sanitizeIoRow(raw: any): E3IoRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id, 200); const group = str(raw.group ?? '', 120); const name = str(raw.name, 300); const code = str(raw.code ?? '', 80);
  if (!id || !ROW_ID.test(id) || group === null || !name?.trim() || code === null) return null;
  const nums = IO_KEYS.map((k) => num(raw[k]));
  if (nums.some((v) => v === null)) return null;
  const notes = { di: '', do: '', ai: '', ao: '' };
  for (const k of IO_KEYS) { const v = str(raw.notes?.[k] ?? '', 400); if (v === null) return null; notes[k] = v.trim(); }
  const component = raw.component === undefined || raw.component === null || raw.component === '' ? undefined : str(raw.component, 160)?.trim();
  if (component === null) return null;
  return {
    id, group: group.trim(), name: name.trim(), code: code.trim(), di: nums[0]!, do: nums[1]!, ai: nums[2]!, ao: nums[3]!, notes,
    ...(component ? { component } : {}),
  };
}

/** Строки из файла: без имени изделия и пометки «правлено» — их не бывает в файле */
export function validateIoRows(raw: unknown): { rows: E3IoRow[] } | { error: string } {
  if (raw === undefined) return { rows: [] };
  if (!Array.isArray(raw)) return { error: 'Таблица IO: ожидается список строк' };
  if (raw.length > MAX_ROWS) return { error: `Таблица IO: слишком много строк, не больше ${MAX_ROWS}` };
  const rows: E3IoRow[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = sanitizeIoRow(raw[i]);
    if (!r) return { error: `Таблица IO, строка ${i + 1}: нужны ключ, наименование и целые числа DI, DO, AI, AO` };
    const { component: _c, ...rest } = r;
    rows.push(rest);
  }
  return { rows };
}

export function sanitizeRowRef(raw: any): E3IoRowRef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: E3IoRowRef = {};
  for (const [k, max] of [['group', 120], ['name', 300], ['code', 80]] as const) {
    if (raw[k] === undefined || raw[k] === null || raw[k] === '') continue;
    const v = str(raw[k], max)?.trim();
    if (v === null || v === undefined) return null;
    if (v) out[k] = v;
  }
  return refIsEmpty(out) ? null : out;
}

function sanitizeCount(raw: any): E3IoCount | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind === 'one') return { kind: 'one' };
  if (raw.kind === 'children') { const role = str(raw.role, 60)?.trim(); return role ? { kind: 'children', role } : null; }
  if (raw.kind === 'feature') {
    const feature = str(raw.feature, 60);
    const offset = raw.offset === undefined ? 0 : raw.offset;
    const cap = raw.cap === undefined ? undefined : raw.cap;
    if (!feature || !FEATURE_ID.test(feature) || FORBIDDEN.has(feature) || !Number.isInteger(offset) || Math.abs(offset) > 99) return null;
    if (cap !== undefined && (!Number.isInteger(cap) || cap < 0 || cap > 99)) return null;
    return { kind: 'feature', feature, ...(offset ? { offset } : {}), ...(cap !== undefined ? { cap } : {}) };
  }
  return null;
}

export function sanitizeIoRule(raw: any): E3IoRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id, 60); const title = str(raw.title, 200)?.trim(); const mainClass = str(raw.mainClass, 100)?.trim(); const role = str(raw.role, 100)?.trim();
  if (!id || !RULE_ID.test(id) || FORBIDDEN.has(id) || !title || !mainClass || !role) return null;
  const row = sanitizeRowRef(raw.row); const count = sanitizeCount(raw.count);
  if (!row || !count) return null;
  if (!Array.isArray(raw.when ?? []) || (raw.when ?? []).length > 10) return null;
  const when: E3IoCond[] = [];
  for (const c of raw.when ?? []) {
    const feature = str(c?.feature, 60);
    if (!feature || !FEATURE_ID.test(feature) || FORBIDDEN.has(feature) || !Array.isArray(c?.values) || !c.values.length || c.values.length > 30) return null;
    const values: string[] = [];
    for (const v of c.values) { const s = str(v, 100)?.trim(); if (!s) return null; if (!values.includes(s)) values.push(s); }
    when.push({ feature, values, ...(c.not === true ? { not: true } : {}) });
  }
  const fromRole = raw.fromRole === undefined || raw.fromRole === null || raw.fromRole === '' ? undefined : str(raw.fromRole, 60)?.trim();
  if (fromRole === null) return null;
  return { id, title, mainClass, when, role, row, count, ...(fromRole ? { fromRole } : {}) };
}

export function sanitizeIoRules(raw: unknown): E3IoRule[] | null {
  if (!Array.isArray(raw) || raw.length > 300) return null;
  const out: E3IoRule[] = [];
  for (const r of raw) { const x = sanitizeIoRule(r); if (!x) return null; if (!out.some((o) => o.id === x.id)) out.push(x); }
  return out;
}

/** Ручной состав: до 40 строк; пустой список — «состав по правилам» */
export function sanitizeRecipeLines(raw: unknown): E3RecipeLine[] | null {
  if (!Array.isArray(raw) || raw.length > 40) return null;
  const out: E3RecipeLine[] = [];
  for (const l of raw) {
    const role = str((l as any)?.role, 100)?.trim(); const row = sanitizeRowRef((l as any)?.row); const count = (l as any)?.count;
    if (!role || !row || !Number.isInteger(count) || count < 1 || count > 50) return null;
    const fromRole = (l as any).fromRole === undefined || (l as any).fromRole === '' ? undefined : str((l as any).fromRole, 60)?.trim();
    if (fromRole === null) return null;
    out.push({ role, row, count, ...(fromRole ? { fromRole } : {}) });
  }
  return out;
}
