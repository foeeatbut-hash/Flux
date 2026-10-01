/**
 * Данные проекта для документов: срез тегов и оборудования, значение поля по
 * пути, отбор строк, отпечаток свежести.
 *
 * Жило в маршрутах Конструктора (server/routes/constructor.ts). Вынесено,
 * потому что теми же правилами теперь пользуются файлы Flux Office: поле
 * «Расход» в Документе, ячейка в Таблице, умный блок и Блокнот обязаны видеть
 * ровно то значение, что видел Конструктор, — со всеми ручными правками
 * инженера (overrides) и алиасами параметров. Две копии этих правил однажды
 * разошлись бы, и шифр в записке перестал бы совпадать с шифром в ведомости.
 *
 * Маршруты — server/routes/projectData.ts.
 */
import { enrichEquipment } from './equipmentCatalog.js';
import { createHash } from 'node:crypto';
import { compositionOf } from '../equipment/composition.js';
import { classifyAll, classTitle, modelOf } from '../equipment/classes.js';
import { compareBy } from './constructorSort.js';
import { getPrisma, upsertSetting } from './context.js';
import { parseRuNumber } from './normalize.js';
import { overrideKey } from './specUtils.js';

export const ALIAS_SETTING_KEY = 'constructor_param_aliases';

// Алиасы параметров проекта (общие на проект): «Расход воздуха»/«Производительность»/
// «Расход, м3/ч» из разных бланков считаются одним полем. Хранятся в AppSetting,
// применяются на ЧТЕНИИ (Конструктор) — недеструктивно, без переимпорта.
export async function loadProjectAliases(projectId: string): Promise<{ name: string; unit?: string; members: string[] }[]> {
  const prisma = getPrisma();
  const row = await prisma.appSetting.findFirst({ where: { key: ALIAS_SETTING_KEY, userId: null } });
  if (!row) return [];
  try {
    const all = JSON.parse(row.value) || {};
    const list = all[projectId];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export async function saveProjectAliases(projectId: string, aliases: any[]): Promise<void> {
  const prisma = getPrisma();
  const row = await prisma.appSetting.findFirst({ where: { key: ALIAS_SETTING_KEY, userId: null } });
  let all: any = {};
  if (row) { try { all = JSON.parse(row.value) || {}; } catch { all = {}; } }
  all[projectId] = aliases;
  await upsertSetting(ALIAS_SETTING_KEY, null, JSON.stringify(all));
}

// Список алиасов → карта name→alias (для resolveValue)
export function aliasMap(list: { name: string; unit?: string; members: string[] }[]): Record<string, { name: string; unit?: string; members: string[] }> {
  const m: Record<string, any> = {};
  for (const a of list) if (a?.name) m[a.name] = a;
  return m;
}

// ── Разбор specs и overrides (та же логика, что на экране «Оборудование») ──
export function normalizeSpecs(raw: any): { groups: { title: string; params: { key: string; value: string; unit?: string }[] }[] } {
  let parsed: any = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch (_) { return { groups: [] }; }
  }
  if (parsed && Array.isArray(parsed.groups)) {
    return { groups: parsed.groups.map((g: any) => ({ title: g?.title || 'Параметры', params: Array.isArray(g?.params) ? g.params : [] })) };
  }
  if (Array.isArray(parsed)) {
    return { groups: parsed.map((g: any) => ({ title: g?.title || 'Параметры', params: Array.isArray(g?.params) ? g.params : [] })) };
  }
  if (parsed && typeof parsed === 'object') {
    const params = Object.entries(parsed).map(([k, v]: [string, any]) => ({ key: k, value: String(v ?? '') }));
    return { groups: params.length ? [{ title: 'Параметры', params }] : [] };
  }
  return { groups: [] };
}

export function parseJsonSafe(raw: any): any {
  if (!raw) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Значение параметра элемента: specs с наложенными ручными правками инженера
export function elementParamValue(el: any, group: string, key: string): string {
  const overrides = parseJsonSafe(el.overrides) || {};
  const ovKey = overrideKey(group, key);
  if (ovKey in overrides) return String(overrides[ovKey] ?? '');
  const specs = normalizeSpecs(el.specs);
  for (const g of specs.groups) {
    if (g.title !== group) continue;
    for (const p of (g.params || [])) {
      if (p.key === key) return String(p.value ?? '');
    }
  }
  return '';
}

// ── Срез проекта: теги + элементы с распарсенными specs ──
export async function loadProjectSlice(projectId: string) {
  const prisma = getPrisma();
  const [tags, systems] = await Promise.all([
    prisma.tag.findMany({
      where: { projectId },
      include: { componentElements: { include: { monoblock: { include: { system: true } } } } },
      orderBy: { identifier: 'asc' },
    }),
    prisma.equipmentSystem.findMany({
      where: { projectId },
      include: { monoblocks: { include: { components: { include: { tags: true } } } } },
    }),
  ]);
  await enrichEquipment(systems);
  // Связанные с тегами позиции должны видеть тот же срез источников.
  const enriched = new Map<string, any>(systems.flatMap(s => s.monoblocks.flatMap(m => m.components)).map(e => [e.id, e]));
  for (const tag of tags) tag.componentElements = tag.componentElements.map(el => ({ ...el, ...(enriched.get(el.id) || {}) }));
  const elements: any[] = [];
  for (const sys of systems) {
    // Состав: тег владельца и тег установки — сразу у каждой строки. Считать
    // родителя в момент сборки ячейки значило бы обходить дерево на каждое
    // значение. Само правило — общее, в equipment/composition
    const all = (sys.monoblocks || []).flatMap((m: any) => m.components || []);
    const comp = compositionOf(all, sys.name);
    // Тип и вид — тем же правилом, что в разделе «Оборудование»: отбор строк
    // «только приводы» обязан видеть те же приводы, что и список позиций
    const types = classifyAll(all);
    for (const mono of (sys.monoblocks || [])) {
      for (const el of (mono.components || [])) {
        const t = types.get(el.id);
        elements.push({
          ...el, _system: sys, _monoblock: mono,
          _parentTag: comp.parentTagOf(el), _unitTag: comp.unitTag,
          _parentName: comp.parentNameOf(el),
          _class: t?.cls || 'ПРОЧЕЕ', _kind: t?.kind || '',
        });
      }
    }
  }
  return { tags, elements };
}

/** Элемент по коду или имени, без учёта регистра */
export function findElement(elements: any[], code: string) {
  const c = String(code ?? '').trim().toLowerCase();
  if (!c) return null;
  return elements.find(e =>
    String(e.itemCode ?? '').toLowerCase() === c || String(e.name ?? '').toLowerCase() === c) || null;
}

/**
 * Отбор элементов для сводных функций.
 *
 * Пустое поле — берём все: «=ПАРАМ_СУММ("Аэродинамика";"Расход")» считает по
 * всему проекту. Поле указано — сравниваем значение без учёта регистра, чтобы
 * «ВЕНТИЛЯТОР» и «Вентилятор» не расходились.
 */
export function filterElements(elements: any[], field?: string, value?: string) {
  const f = String(field ?? '').trim();
  if (!f) return elements;
  const want = String(value ?? '').trim().toLowerCase();
  return elements.filter(e => String(resolveValue('element', e, f) ?? '').toLowerCase() === want);
}

// Алиас параметра: одно имя для нескольких «группа|ключ» из разных бланков
export interface ParamAlias { name: string; unit?: string; members: string[] }
export type AliasMap = Record<string, ParamAlias>; // name → alias

// ── Разрешение значения по пути поля ──
// Пути (часть II дизайна, MVP-подмножество):
//   простые поля своей сущности; param:Группа|Ключ; param:@Алиас; meta:ключ;
//   system.name / monoblock.name; tags (список тегов элемента)
export function resolveValue(entity: 'tag' | 'element', row: any, path: string, aliases?: AliasMap): string {
  if (path.startsWith('param:')) {
    const spec = path.slice(6);
    // Алиас: перебираем участников по порядку, первое непустое значение
    if (spec.startsWith('@') && aliases) {
      const alias = aliases[spec.slice(1)];
      for (const member of (alias?.members || [])) {
        const [g, k] = member.split('|');
        const v = resolveValue(entity, row, `param:${g}|${k}`, aliases);
        if (v !== '') return v;
      }
      return '';
    }
    const [group, key] = spec.split('|');
    if (entity === 'element') return elementParamValue(row, group, key);
    // тег → через связанные элементы: первое непустое значение
    for (const el of (row.componentElements || [])) {
      const v = elementParamValue(el, group, key);
      if (v !== '') return v;
    }
    return '';
  }
  if (path.startsWith('meta:')) {
    const meta = parseJsonSafe(row.metadata) || {};
    // точечный путь без выражений: meta:procurement.stage
    let cur: any = meta;
    for (const part of path.slice(5).split('.')) {
      if (cur == null || typeof cur !== 'object') return '';
      cur = cur[part];
    }
    return cur == null ? '' : (typeof cur === 'object' ? JSON.stringify(cur) : String(cur));
  }
  if (entity === 'element') {
    switch (path) {
      case 'name': return String(row.name ?? '');
      case 'itemCode': return String(row.itemCode ?? '');
      case 'equipType': return String(row.equipType ?? '');
      case 'status': return String(row.status ?? '');
      case 'system.name': return String(row._system?.name ?? '');
      case 'monoblock.name': return String(row._monoblock?.name ?? '');
      case 'tags': return (row.tags || []).map((t: any) => t.identifier).join('; ');
      // ── Состав ──
      case 'tag': return String((row.tags || [])[0]?.identifier ?? '');
      case 'role': return String(row.role ?? 'БЛОК');
      case 'parentTag': return String(row._parentTag ?? '');
      case 'unitTag': return String(row._unitTag ?? '');
      case 'parent.name': return String(row._parentName ?? '');
      case 'instanceNo': return row.instanceNo ? String(row.instanceNo) : '';
      case 'origin': return originOf(row);
      // Тип — кодом (КЛАПАН), подпись — отдельным полем: отбор сравнивает
      // коды, а в шапку таблицы человеку нужно слово
      case 'class': return String(row._class ?? '');
      case 'classTitle': return classTitle(String(row._class ?? ''));
      case 'kind': return String(row._kind ?? '');
      case 'model': return modelOf(row.specs);
    }
    return '';
  }
  // entity === 'tag'
  switch (path) {
    case 'identifier': return String(row.identifier ?? '');
    case 'brand': return String(row.brand ?? '');
    case 'department': return String(row.department ?? '');
    case 'wbs': return String(row.wbs ?? '');
    case 'fluid': return String(row.fluid ?? '');
    case 'createdAt': return row.createdAt ? new Date(row.createdAt).toLocaleDateString('ru-RU') : '';
    case 'element.name': return String(row.componentElements?.[0]?.name ?? '');
    case 'element.itemCode': return String(row.componentElements?.[0]?.itemCode ?? '');
    case 'element.equipType': return String(row.componentElements?.[0]?.equipType ?? '');
    case 'system.name': return String(row.componentElements?.[0]?.monoblock?.system?.name ?? '');
    case 'monoblock.name': return String(row.componentElements?.[0]?.monoblock?.name ?? '');
  }
  return '';
}

// Число из строки в русской записи: «1 250,5 мм» → 1250.5 (для сортировки/фильтров)

/** Откуда позиция: по примечанию выгрузки, руками или из самого расчёта */
function originOf(row: any): string {
  if (row.manual) return 'заведено вручную';
  return row.sourceKind === 'note' ? 'по примечанию' : 'из расчёта';
}

export function applyFilter(value: string, op: string, target: any): boolean {
  const v = String(value ?? '');
  switch (op) {
    case 'contains': return v.toLowerCase().includes(String(target ?? '').toLowerCase());
    case 'ncontains': return !v.toLowerCase().includes(String(target ?? '').toLowerCase());
    case 'eq': return v === String(target ?? '');
    case 'neq': return v !== String(target ?? '');
    // Список — массивом или строкой через «|»: разметка таблицы хранит отбор строкой
    case 'in': return (Array.isArray(target) ? target : String(target ?? '').split('|')).map(String).includes(v);
    case 'empty': return v.trim() === '';
    case 'nempty': return v.trim() !== '';
    case 'gt': { const a = parseRuNumber(v), b = parseRuNumber(String(target)); return a != null && b != null && a > b; }
    case 'lt': { const a = parseRuNumber(v), b = parseRuNumber(String(target)); return a != null && b != null && a < b; }
    default: return true;
  }
}

// PostgreSQL-режим: таблица создаётся лениво при первом обращении к разделу
// (для SQLite её создаёт догоняющая миграция при старте сервера)

// ── Исполнитель запросов: сущность + колонки + фильтры → строки ──
export interface ProjectQuery {
  entity: 'tag' | 'element';
  columns: string[];
  filters: { field: string; op: string; value?: any }[];
  sort: { field: string; dir?: string }[];
  limit?: number;
}

/** Запрос из тела запроса: то, что прислали, приводится к безопасному виду */
export function cleanQuery(body: any): ProjectQuery {
  return {
    entity: body?.entity === 'element' ? 'element' : 'tag',
    columns: Array.isArray(body?.columns) ? body.columns.map(String) : [],
    filters: Array.isArray(body?.filters) ? body.filters.filter((f: any) => f && f.field).map((f: any) => ({ field: String(f.field), op: String(f.op || 'contains'), value: f.value })) : [],
    // Порядок строк: одно поле или несколько подряд («тип, потом тег»)
    sort: (Array.isArray(body?.sort) ? body.sort : body?.sort ? [body.sort] : []).filter((x: any) => x && x.field),
    limit: Math.min(Number(body?.limit) || 50000, 50000),
  };
}

/** Число из значения поля — числом: иначе в таблице не заработает СУММ() */
export function asCellValue(v: string): string | number {
  const n = parseRuNumber(v);
  return n != null && String(n) === v.replace(/[\s\u00A0]/g, '').replace(',', '.') ? n : v;
}

export async function runQuery(projectId: string, q: ProjectQuery) {
  const slice = await loadProjectSlice(projectId);
  const aliases = aliasMap(await loadProjectAliases(projectId));
  const { entity, columns } = q;
  let rows: any[] = entity === 'tag' ? slice.tags : slice.elements;
  for (const f of q.filters) {
    rows = rows.filter(r => applyFilter(resolveValue(entity, r, f.field, aliases), f.op, f.value));
  }
  if (q.sort.length) rows = [...rows].sort(compareBy(q.sort, (r, f) => resolveValue(entity, r, f, aliases)));
  const limit = q.limit ?? 50000;
  const total = rows.length;
  const out = rows.slice(0, limit).map(r => ({
    key: `${entity}:${r.id}`,
    cells: columns.map(c => asCellValue(resolveValue(entity, r, c, aliases))),
    route: entity === 'tag' ? `/registry?tag=${r.id}` : `/equipment?elementId=${r.id}`,
  }));
  return { rows: out, total, truncated: total > limit };
}

/**
 * «Отпечаток» состояния проекта по типам сущностей. Дёшево (без исполнения
 * фильтров): блок сравнивает отпечаток на момент своей сборки с текущим —
 * расхождение значит «данные изменились». Ложноположительные срабатывания
 * допустимы, ложноотрицательных нет
 */
export async function projectFingerprint(projectId: string): Promise<{ tag: string; element: string }> {
  const prisma = getPrisma();
  const [tagCount, tagMax, elCount, elMax] = await Promise.all([
    prisma.tag.count({ where: { projectId } }),
    prisma.tag.aggregate({ where: { projectId }, _max: { createdAt: true, updatedAt: true } }),
    prisma.componentElement.count({ where: { monoblock: { system: { projectId } } } }),
    prisma.componentElement.aggregate({ where: { monoblock: { system: { projectId } } }, _max: { updatedAt: true } }),
  ]);
  return {
    tag: `${tagCount}:${tagMax._max.createdAt?.toISOString?.() || ''}:${tagMax._max.updatedAt?.toISOString?.() || ''}`,
    element: `${elCount}:${elMax._max.updatedAt?.toISOString?.() || ''}`,
  };
}

/**
 * Отпечаток блока: состояние его сущности в проекте, сам запрос и алиасы
 * (переименовали алиас — строки блока уже другие)
 */
export async function blockFingerprint(projectId: string, query: ProjectQuery, layout: unknown): Promise<string> {
  const fp = await projectFingerprint(projectId);
  const aliases = await loadProjectAliases(projectId);
  const q = { entity: query.entity, columns: query.columns, filters: query.filters, sort: query.sort };
  return createHash('sha256').update(JSON.stringify([fp[query.entity], q, layout ?? null, aliases])).digest('hex').slice(0, 32);
}
