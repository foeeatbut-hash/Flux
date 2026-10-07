/**
 * Загрузка заполненной книги атрибутов E3 обратно во Flux (docs/e3-integration.md, 5.5, 9.1).
 *
 * Книга — договор (`attributeWorkbook.ts`): строка 1 — имена атрибутов, строка 2 —
 * описания, данные с 3-й, столбец A — скрытый ID позиции Flux. Здесь книга
 * читается обратно и превращается в ПЛАН: что изменится у каких позиций. Ничего
 * не пишет: запись — отдельный шаг после предпросмотра (flux-data-safety).
 *
 * Что куда ложится:
 *   — атрибут с «Да» и БЕЗ источника у ОВ (данные КИП: уставки, сигналы,
 *     диапазоны) — в характеристики позиции, группой «КИП», ключом по имени
 *     атрибута. Отсюда они попадают и в карточку, и в следующую выгрузку книги;
 *   — атрибут, значение которого Flux считает сам (есть источник), книгой не
 *     перезаписывается: спор «Flux или скрипт» решает настройка атрибута, а не
 *     случайный столбец в чьём-то Excel;
 *   — атрибут без «Да» Flux не ведёт: его заполняют в E3.
 *
 * Ключ строки — ID позиции И тег. Строка без ID, с чужим ID, с ID снятой
 * позиции или с тегом, который у позиции другой, — ошибка в плане, а не молчаливая
 * запись «куда придётся». Пустая ячейка ничего не стирает.
 *
 * Модуль чистый: ни базы, ни React.
 */
import { attributesForClass, KIP_GROUP, type E3Attribute } from './attributes';
import { E3_ID_HEADER } from './attributeWorkbook';

export { KIP_GROUP };

export interface BookSheet { name: string; aoa: unknown[][] }

export interface BookRow {
  sheet: string;
  /** Номер строки в Excel (с 1) */
  line: number;
  id: string;
  /** Имя атрибута → значение ячейки (только непустые) */
  cells: Record<string, string>;
}

export interface BookRead { rows: BookRow[]; columns: string[]; issues: string[] }

const text = (v: unknown): string => String(v ?? '').trim();

/**
 * Лист книги Flux → строки. Лист, у которого в A1 не заголовок ID, книгой Flux
 * не считается: читать его по угадыванию значило бы записать чужие данные.
 */
export function readBook(sheets: BookSheet[]): BookRead {
  const out: BookRead = { rows: [], columns: [], issues: [] };
  const seen = new Set<string>();
  for (const s of sheets || []) {
    const aoa = Array.isArray(s?.aoa) ? s.aoa : [];
    const head = (aoa[0] || []) as unknown[];
    if (text(head[0]) !== E3_ID_HEADER[0]) {
      out.issues.push(`Лист «${s?.name}» пропущен: в ячейке A1 нет «${E3_ID_HEADER[0]}» — это не книга, скачанная из Flux`);
      continue;
    }
    const names = head.map(text);
    // Строка 2 — описания; данные с 3-й. Если описаний нет (файл пересобрали), 2-я строка — данные, и распознаётся по ID
    for (let r = 2; r < aoa.length; r++) {
      const row = (aoa[r] || []) as unknown[];
      const cells: Record<string, string> = {};
      for (let j = 1; j < names.length; j++) {
        const v = text(row[j]);
        if (names[j] && v) { cells[names[j]] = v; seen.add(names[j]); }
      }
      const id = text(row[0]);
      // Совсем пустая строка — хвост листа, а не ошибка
      if (!id && !Object.keys(cells).length) continue;
      out.rows.push({ sheet: String(s.name), line: r + 1, id, cells });
    }
    for (const n of names.slice(1)) if (n && !out.columns.includes(n)) out.columns.push(n);
  }
  if (!out.rows.length && !out.issues.length) out.issues.push('В книге нет строк с данными');
  return out;
}

/** Позиция проекта так, как её видит план */
export interface UploadPosition {
  id: string;
  cls: string;
  tags: string[];
  label: string;
  /** Снята: пропала из расчёта или заменена. Данные в неё не пишутся */
  removed?: boolean;
  /** Что уже лежит в группе «КИП»: имя атрибута → значение */
  kip: Record<string, string>;
}

export interface UploadChange { attr: string; title: string; before: string; after: string }
export interface UploadWrite { id: string; label: string; cls: string; changes: UploadChange[] }
export interface UploadError { sheet: string; line: number; id: string; message: string }
export interface UploadNote { code: 'flux' | 'no-yes' | 'unknown' | 'na' | 'no-tag'; text: string; names: string[]; cells: number }

export interface UploadPlan {
  /** Позиции, у которых что-то изменится */
  writes: UploadWrite[];
  /** Строк без изменений */
  same: number;
  /** Ошибки ключа и значения: такие строки не пишутся, и об этом сказано */
  errors: UploadError[];
  /** Предупреждения по столбцам: значение считает Flux, атрибут не ведётся и т. п. */
  notes: UploadNote[];
  rows: number;
}

const MAX_VALUE = 500;

export function planUpload(read: BookRead, attrs: E3Attribute[], positions: UploadPosition[]): UploadPlan {
  const plan: UploadPlan = { writes: [], same: 0, errors: [], notes: [], rows: read.rows.length };
  const byName = new Map<string, E3Attribute>();
  for (const a of attrs || []) if (!a.removed && !byName.has(a.name)) byName.set(a.name, a);
  const byId = new Map(positions.map(p => [p.id, p]));
  const done = new Set<string>();

  // Столбцы с тегом позиции: по ним проверяется, что строка принадлежит своей позиции
  const tagCols = read.columns.filter(n => { const a = byName.get(n); return a?.fromFlux && a.source.kind === 'field' && a.source.key === 'tag'; });
  if (!tagCols.length) plan.notes.push({ code: 'no-tag', text: 'В книге нет столбца с тегом позиции: строки проверены только по ID', names: [], cells: 0 });

  const counts = { flux: new Map<string, number>(), noYes: new Map<string, number>(), unknown: new Map<string, number>(), na: new Map<string, number>() };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1);

  for (const row of read.rows) {
    const fail = (message: string) => plan.errors.push({ sheet: row.sheet, line: row.line, id: row.id, message });
    if (!row.id) { fail('Нет ID позиции в столбце A — строку не к чему отнести'); continue; }
    const pos = byId.get(row.id);
    if (!pos) { fail('Такой позиции нет в этом проекте: книга от другого проекта или позицию удалили'); continue; }
    if (pos.removed) { fail(`Позиция «${pos.label}» снята — данные в неё не пишутся`); continue; }
    if (done.has(row.id)) { fail(`ID уже встречался в книге выше — вторая строка позиции «${pos.label}» не записывается`); continue; }
    const alien = tagCols.map(n => ({ n, v: row.cells[n] })).find(x => x.v && !pos.tags.includes(x.v));
    if (alien) {
      fail(pos.tags.length
        ? `Чужой тег: в книге «${alien.v}», у позиции «${pos.tags.join(', ')}» — строку подставили не к своей позиции или тег сменили после выгрузки`
        : `Чужой тег: в книге «${alien.v}», а у позиции тега нет`);
      continue;
    }
    done.add(row.id);

    const changes: UploadChange[] = [];
    let bad = false;
    for (const [name, value] of Object.entries(row.cells)) {
      const a = byName.get(name);
      if (!a) { bump(counts.unknown, name); continue; }
      if (!attributesForClass([a], pos.cls).length) { bump(counts.na, name); continue; }
      if (!a.fromFlux) { bump(counts.noYes, name); continue; }
      if (a.source.kind !== 'none') { bump(counts.flux, name); continue; }
      if (value.length > MAX_VALUE) { fail(`Значение «${name}» длиннее ${MAX_VALUE} знаков`); bad = true; break; }
      const before = pos.kip[name] ?? '';
      if (before !== value) changes.push({ attr: name, title: a.title || name, before, after: value });
    }
    if (bad) continue;
    if (changes.length) plan.writes.push({ id: pos.id, label: pos.label, cls: pos.cls, changes });
    else plan.same++;
  }

  const note = (code: UploadNote['code'], m: Map<string, number>, textOf: (n: number) => string) => {
    if (!m.size) return;
    plan.notes.push({ code, text: textOf(m.size), names: [...m.keys()], cells: [...m.values()].reduce((s, n) => s + n, 0) });
  };
  note('flux', counts.flux, n => `Значение считает Flux — книгой не перезаписывается (атрибутов: ${n})`);
  note('no-yes', counts.noYes, n => `Flux этот атрибут не ведёт (нет «Да» в справочнике) — не загружено (атрибутов: ${n})`);
  note('na', counts.na, n => `Атрибут не относится к типу позиции — не загружено (атрибутов: ${n})`);
  note('unknown', counts.unknown, n => `Атрибута нет в справочнике — не загружено (атрибутов: ${n})`);
  return plan;
}

// ── Группа «КИП» в характеристиках позиции ──────────────────────────────────

interface SpecGroup { title: string; params: { key: string; value: string; unit: string; sourceGroup?: string; sourceKey?: string }[] }

const groupsOf = (specs: string | null | undefined): { groups: SpecGroup[] } & Record<string, unknown> => {
  try { const v = specs ? JSON.parse(specs) : null; return v && Array.isArray(v.groups) ? v : { groups: [] }; } catch (_) { return { groups: [] }; }
};

/** Что уже лежит в группе «КИП»: имя атрибута → значение */
export function kipOf(specs: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of groupsOf(specs).groups) if (g.title === KIP_GROUP) for (const p of g.params || []) if (p?.key) out[p.key] = String(p.value ?? '');
  return out;
}

/**
 * Характеристики с записанными значениями КИП. Группа заводится в конце, если
 * её не было; значения заменяются по имени атрибута, чужие характеристики не
 * трогаются. Ключ — имя атрибута E3: по нему книга находит значение при выгрузке.
 */
export function withKip(specs: string | null | undefined, changes: { attr: string; after: string }[]): string {
  const base = groupsOf(specs);
  let group = base.groups.find(g => g.title === KIP_GROUP);
  if (!group) { group = { title: KIP_GROUP, params: [] }; base.groups = [...base.groups, group]; }
  for (const c of changes) {
    const p = group.params.find(x => x.key === c.attr);
    if (p) p.value = c.after;
    else group.params.push({ key: c.attr, value: c.after, unit: '', sourceGroup: KIP_GROUP, sourceKey: c.attr });
  }
  return JSON.stringify(base);
}
