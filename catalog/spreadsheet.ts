import type { Catalog, Component } from './model';
import { componentKey, manufacturerKey } from './componentCatalog';

export interface CatalogSheet { name: string; rows: unknown[][] }
export type ImportPolicy = 'add' | 'fill' | 'update';
export interface CatalogImportOptions { classId: string; policy: ImportPolicy; mapping?: Record<string, string> }
export interface CatalogImportChange { field: string; before: string; after: string }
export interface CatalogImportRow {
  row: number; sheet: string; code: string; manufacturer: string;
  action: 'new' | 'update' | 'same' | 'conflict' | 'error';
  changes: CatalogImportChange[]; error?: string; component?: Component; before?: Component;
}
const text = (v: unknown) => String(v ?? '').trim();
const norm = (v: unknown) => text(v).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
const has = (v: unknown) => v !== null && v !== undefined && text(v) !== '';

export function columnRole(header: string): string {
  const h = norm(header);
  if (/^(ключ модели|ключ комплектующего|id|key|model id)$/.test(h)) return 'key';
  if (/^(модель|марка|model|обозначение|код|code)$/.test(h)) return 'model';
  if (/^(изготовитель|производитель|manufacturer|завод)$/.test(h)) return 'manufacturer';
  if (/^(тип|тип комплектующего|вид|type)$/.test(h)) return 'type';
  if (/^(название|наименование|name|title)$/.test(h)) return 'name';
  if (/^(источник|source|документ)$/.test(h)) return 'source';
  if (/^(редакция|edition)$/.test(h)) return 'edition';
  if (/^(параметр|характеристика|parameter)$/.test(h)) return 'parameter';
  if (/^(значение|value)$/.test(h)) return 'value';
  if (/^(единица|единица измерения|ед\. изм\.?|unit)$/.test(h)) return 'unit';
  if (/^(класс оборудования|classid|тип изделия веза)$/.test(h)) return 'class';
  if (/^(семейство|семейство изделия веза|familyid)$/.test(h)) return 'family';
  if (/^(страница pdf|печатные страницы|страницы|pages)$/.test(h)) return 'pages';
  if (/^(серия|группа|статус|примечание|основание)$/.test(h)) return 'ignore';
  return 'param';
}

export function sheetHeader(sheet: CatalogSheet): number {
  let best = -1; let score = 0;
  for (let i = 0; i < Math.min(sheet.rows.length, 40); i++) {
    const roles = (sheet.rows[i] || []).map(v => columnRole(text(v)));
    const n = roles.filter(r => !['param', 'ignore'].includes(r)).length;
    if (n > score && roles.some(r => r === 'model' || r === 'key')) { best = i; score = n; }
  }
  return best;
}

const kindOf = (type: string): Component['kind'] => /привод|actuator/i.test(type) ? 'actuator'
  : /коробк|box/i.test(type) ? 'box' : /ввод|gland/i.test(type) ? 'gland'
    : /обогрев|heater/i.test(type) ? 'heater' : /рам|frame/i.test(type) ? 'frame' : 'other';
const idOf = (key: string): string => {
  // Два независимых хэша: стабильный компактный ключ на всех СУБД.
  let a = 2166136261; let b = 5381;
  for (const c of key) { a = Math.imul(a ^ c.codePointAt(0)!, 16777619); b = Math.imul(b, 33) ^ c.codePointAt(0)!; }
  return `cmp-import-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
};
const paramKey = (s: { label: { ru: string }; unit?: string }) => `${norm(s.label.ru)}|${norm(s.unit)}`;

/** Разбор таблиц не пишет: длинные характеристики соединяются только по явному ключу. */
export function planCatalogSpreadsheet(sheets: CatalogSheet[], catalog: Catalog, opts: CatalogImportOptions): CatalogImportRow[] {
  if (!Array.isArray(sheets) || sheets.length > 50) throw new Error('Допускается не больше 50 листов');
  if (!catalog.classes.some(c => c.id === opts.classId)) throw new Error('Выберите существующий тип оборудования');
  if (!['add', 'fill', 'update'].includes(opts.policy)) throw new Error('Неизвестный режим загрузки');
  let count = 0;
  for (const sheet of sheets) {
    if (!Array.isArray(sheet.rows)) throw new Error('Не удалось прочитать строки листа');
    count += sheet.rows.length;
    if (sheet.rows.some(r => !Array.isArray(r) || r.length > 100)) throw new Error('На листе допускается до 100 столбцов');
  }
  if (count > 50000) throw new Error('В одной партии допускается до 50 000 строк');
  const out: CatalogImportRow[] = [];
  const refs = new Map<string, CatalogImportRow>();
  const seen = new Map<string, CatalogImportRow>();
  const secondary: { sheet: CatalogSheet; header: number; roles: string[] }[] = [];
  for (const sheet of sheets) {
    const header = sheetHeader(sheet);
    if (header < 0) continue;
    const heads = sheet.rows[header].map(text);
    const roles = heads.map(h => opts.mapping?.[h] || columnRole(h));
    if ((roles.includes('parameter') && roles.includes('value')) || (!roles.includes('model') && (roles.includes('class') || roles.includes('family')))) { secondary.push({ sheet, header, roles }); continue; }
    const get = (row: unknown[], role: string) => text(row[roles.indexOf(role)]);
    for (let r = header + 1; r < sheet.rows.length; r++) {
      const values = sheet.rows[r];
      if (!values.some(has)) continue;
      const code = get(values, 'model'); const manufacturer = get(values, 'manufacturer');
      const item: CatalogImportRow = { row: r + 1, sheet: sheet.name, code, manufacturer, action: 'new', changes: [] };
      out.push(item);
      if (code.length > 200 || manufacturer.length > 200) { item.action = 'error'; item.error = 'Модель и изготовитель: не более 200 символов'; continue; }
      if (!code || !manufacturer) { item.action = 'error'; item.error = 'Нужны модель и изготовитель'; continue; }
      if (values.some(v => text(v) === '__FORMULA_NO_RESULT__')) { item.action = 'error'; item.error = 'У формулы нет сохранённого результата. Пересчитайте книгу и сохраните её в Excel'; continue; }
      const type = get(values, 'type') || 'Привод';
      const incoming: Component = {
        id: '', classId: opts.classId, classIds: [opts.classId], kind: kindOf(type), equipmentType: type,
        code, manufacturer, title: { ru: get(values, 'name') || code }, specs: [],
      };
      const source = get(values, 'source');
      if (source) incoming.catalog = { file: source, edition: get(values, 'edition') || undefined, pages: get(values, 'pages') || undefined };
      roles.forEach((role, col) => {
        if (role !== 'param' || !heads[col] || !has(values[col])) return;
        const m = /^(.*?)\s*(?:\[([^\]]+)\]|,\s*([^,]+))$/.exec(heads[col]);
        incoming.specs!.push({ label: { ru: m ? m[1].trim() : heads[col] }, value: text(values[col]), unit: m ? (m[2] || m[3]).trim() : undefined });
      });
      const key = componentKey(incoming);
      const matches = catalog.components.filter(c => componentKey(c) === key);
      if (matches.length > 1) { item.action = 'conflict'; item.error = 'В каталоге несколько моделей с одинаковым изготовителем, обозначением и типом'; continue; }
      const duplicate = seen.get(key);
      if (duplicate) { item.action = duplicate.action = 'conflict'; item.error = duplicate.error = 'Модель повторяется в нескольких строках файла'; continue; }
      seen.set(key, item);
      incoming.id = matches[0]?.id || idOf(key);
      if (!matches.length && catalog.components.some(c => c.id === incoming.id)) { item.action = 'conflict'; item.error = 'Коллизия ключа модели: задайте другую марку'; continue; }
      item.before = matches[0]; item.component = incoming;
      const externalKey = get(values, 'key');
      if (externalKey) {
        if (refs.has(externalKey)) { item.action = 'conflict'; item.error = 'Один ключ указан у разных моделей'; const other = refs.get(externalKey)!; other.action = 'conflict'; other.error = item.error; }
        else refs.set(externalKey, item);
      }
      refs.set(incoming.id, item);
    }
  }
  for (const { sheet, header, roles } of secondary) {
    const get = (row: unknown[], role: string) => text(row[roles.indexOf(role)]);
    for (let r = header + 1; r < sheet.rows.length; r++) {
      const values = sheet.rows[r]; if (!values.some(has)) continue;
      const key = get(values, 'key'); const target = refs.get(key);
      const fail = (error: string) => out.push({ row: r + 1, sheet: sheet.name, code: key, manufacturer: '', action: 'error', changes: [], error });
      if (!target?.component) { fail('Нет строки модели с указанным ключом. Добавьте лист «Модели»'); continue; }
      if (roles.includes('parameter')) {
        const label = get(values, 'parameter'); const value = get(values, 'value'); const unit = get(values, 'unit');
        if (!label) { fail('Нет названия характеристики'); continue; }
        if (value === '__FORMULA_NO_RESULT__') { target.action = 'error'; target.error = 'У формулы характеристики нет сохранённого результата'; fail(target.error); continue; }
        if (!value) continue;
        const param = { label: { ru: label }, value, unit: unit || undefined };
        const prior = target.component.specs!.find(s => paramKey(s) === paramKey(param));
        if (prior && prior.value !== value) { target.action = 'conflict'; target.error = `Разные значения одной характеристики: ${label}`; fail(target.error); }
        else if (!prior) target.component.specs!.push(param);
      } else {
        const classId = get(values, 'class'); const familyId = get(values, 'family');
        if (classId && !catalog.classes.some(c => c.id === classId || norm(c.title.ru) === norm(classId))) { target.action = 'error'; fail('Не найден тип оборудования применяемости'); continue; }
        const cls = catalog.classes.find(c => c.id === classId || norm(c.title.ru) === norm(classId));
        if (cls) target.component.classIds = [...new Set([...(target.component.classIds || []), cls.id])];
        if (familyId) {
          const families = catalog.families.filter(f => f.id === familyId || (f.code === familyId && (!cls || f.classId === cls.id)));
          const family = families.length === 1 ? families[0] : undefined;
          if (!family) { target.action = 'error'; fail('Не найдено однозначное семейство применяемости (укажите ID)'); continue; }
          target.component.familyIds = [...new Set([...(target.component.familyIds || []), family.id])];
        }
      }
    }
  }
  for (const item of out) {
    if (!item.component || ['error', 'conflict'].includes(item.action)) continue;
    const incoming = item.component; const before = item.before;
    if (!before) { item.changes = [{ field: 'Модель', before: '', after: incoming.code }]; continue; }
    const after: Component = { ...before, specs: [...(before.specs || [])], classIds: [...new Set([before.classId, ...(before.classIds || []), ...(incoming.classIds || [])])] };
    if (opts.policy === 'add') { item.component = before; item.action = 'same'; continue; }
    const replace = (field: 'title' | 'catalog' | 'equipmentType', next: any) => {
      if (!next || (field === 'title' && next.ru === incoming.code)) return;
      if (opts.policy === 'fill' && has((before as any)[field]?.ru || (before as any)[field]?.file || (before as any)[field])) return;
      if (JSON.stringify((before as any)[field]) !== JSON.stringify(next)) {
        item.changes.push({ field, before: JSON.stringify((before as any)[field] || ''), after: JSON.stringify(next) });
        (after as any)[field] = next;
      }
    };
    replace('title', incoming.title); replace('catalog', incoming.catalog); replace('equipmentType', incoming.equipmentType);
    for (const param of incoming.specs || []) {
      const i = after.specs!.findIndex(p => paramKey(p) === paramKey(param));
      if (i < 0) { after.specs!.push(param); item.changes.push({ field: param.label.ru, before: '', after: param.value }); }
      else if ((opts.policy === 'update' || !has(after.specs![i].value)) && after.specs![i].value !== param.value) {
        item.changes.push({ field: param.label.ru, before: after.specs![i].value, after: param.value }); after.specs![i] = param;
      }
    }
    after.familyIds = [...new Set([...(before.familyIds || []), ...(incoming.familyIds || [])])];
    if (JSON.stringify(before.classIds || [before.classId]) !== JSON.stringify(after.classIds)) item.changes.push({ field: 'Применяемость', before: (before.classIds || [before.classId]).join(', '), after: after.classIds!.join(', ') });
    if (JSON.stringify(before.familyIds || []) !== JSON.stringify(after.familyIds)) item.changes.push({ field: 'Семейства', before: (before.familyIds || []).join(', '), after: after.familyIds.join(', ') });
    item.component = after; item.action = item.changes.length ? 'update' : 'same';
  }
  if (!out.length) throw new Error('Не найдены модели. Нужны колонки «Модель» и «Изготовитель»');
  return out;
}
