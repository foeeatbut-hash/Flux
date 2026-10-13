/** Источники Office читают сохранённые данные, без вызовов COM и связей по номеру строки. */
import { createHash } from 'node:crypto';
import { parseRuNumber } from './normalize.js';
import { catalogSetting } from './catalogWorkspace.js';
import { parseJsonSafe, applyFilter } from './projectSlice.js';
import { officeEntityId, type OfficeEntityRow } from '../src/lib/officeModel.js';

const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
type Field = { path: string; title: string; kind: 'text' | 'number'; entityType: string };
const fields = (entityType: string, prefix: string, labels: Record<string, string>, numbers: string[] = []): Field[] =>
  Object.entries(labels).map(([key, title]) => ({ path: prefix + key, title, kind: numbers.includes(key) ? 'number' : 'text', entityType }));
export const managementFields = [
  ...fields('procurement', '', { identifier: 'Тег', brand: 'Марка', department: 'Отдел', wbs: 'WBS', fluid: 'Среда', supplier: 'Поставщик', qty: 'Количество (как введено)', stage: 'Этап закупки', stageLog: 'История этапов', templateId: 'Шаблон этапов', note: 'Примечание закупки', orderedAt: 'Заказано: дата', orderedBy: 'Заказано: сотрудник', approvedAt: 'Согласовано: дата', approvedBy: 'Согласовано: сотрудник', purchasedAt: 'Закуплено: дата', purchasedBy: 'Закуплено: сотрудник' }),
  ...fields('vdr', 'vdr.', { kind: 'Вид записи ВДР', name: 'Название реестра', vendor: 'Поставщик ВДР', contractor: 'Подрядчик', owner: 'Заказчик', poNumber: 'Номер заказа', revision: 'Ревизия', titleRu: 'Название документа (RU)', titleEn: 'Название документа (EN)', contractorNo: 'Номер подрядчика', ownerNo: 'Номер заказчика', vendorNo: 'Номер поставщика', vdrCode: 'Код ВДР', issueDate: 'Дата выпуска', reasonForIssue: 'Цель выпуска', language: 'Язык', equipmentTags: 'Теги оборудования', status: 'Статус документа', remarks: 'Замечания', reviewCode: 'Код рассмотрения', dueDate: 'Срок', docId: 'ID документа', fileNodeId: 'ID файла замечаний', extra: 'Дополнительные колонки' }),
];
export const e3fluxFields = fields('e3', 'e3.', {
  kind: 'Вид записи E3Flux', name: 'Наименование', designation: 'Обозначение', elementId: 'ID позиции Flux', projectName: 'Проект E3', projectKey: 'Ключ проекта E3', sheet: 'Лист схемы', x: 'Координата X', y: 'Координата Y', rotation: 'Поворот', state: 'Состояние связи', solutionId: 'ID решения', solutionName: 'Название решения', mainClass: 'Основной класс', subclass: 'Подкласс', short: 'Краткое обозначение', description: 'Описание', items: 'Изделия решения', symbols: 'Символы', pdf: 'PDF решения', e3p: 'Файл E3P', sentVersion: 'Отправленная версия', sentAttrs: 'Отправленные атрибуты', title: 'Описание атрибута', carrier: 'Носитель атрибута', attrClass: 'Класс атрибута', source: 'Источник атрибута', group: 'Группа IO', code: 'Код IO', component: 'Справка об изделии IO', di: 'DI', do: 'DO', ai: 'AI', ao: 'AO', notes: 'Описание сигналов',
}, ['x', 'y', 'rotation', 'di', 'do', 'ai', 'ao']);
const scalar = (v: any): string | number | null => v == null ? null : v instanceof Date ? v.toISOString() : typeof v === 'number' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export async function officeSourceCatalog(_db: any, _projectId: string) {
  return { managementFields, e3fluxFields };
}

type RecordRow = { id: string; type: 'procurement' | 'vdr' | 'e3'; data: Record<string, any> };
function unique(items: any[], idOf: (row: any) => string, what: string) {
  const seen = new Set<string>();
  for (const item of items) {
    const id = idOf(item);
    if (!id || seen.has(id)) fail(`Неоднозначный источник ${what}: повторяющийся или пустой ID «${id}»`, 409);
    seen.add(id);
  }
}
async function management(db: any, projectId: string, entity: string): Promise<RecordRow[]> {
  if (entity === 'procurement') {
    const tags = await db.tag.findMany({ where: { projectId }, orderBy: { id: 'asc' } });
    return tags.map((tag: any) => ({ id: String(tag.id), type: 'procurement', data: {
      ...Object.fromEntries(['identifier', 'brand', 'department', 'wbs', 'fluid'].map(k => [k, tag[k]])),
      ...Object.fromEntries(managementFields.filter(f => f.entityType === 'procurement' && !['identifier', 'brand', 'department', 'wbs', 'fluid'].includes(f.path)).map(f => [f.path, parseJsonSafe(tag.metadata)?.procurement?.[f.path]])),
    } }));
  }
  const [registers, items] = await Promise.all([
    db.docRegister.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    db.docRegisterItem.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
  ]);
  const byId = new Map(registers.map((r: any) => [r.id, r]));
  const result: RecordRow[] = registers.map((r: any) => ({ id: `register:${r.id}`, type: 'vdr', data: { ...r, kind: 'register' } }));
  for (const item of items) {
    const register: any = byId.get(item.registerId);
    if (!register) fail(`У документа ВДР «${item.id}» нет реестра в проекте`, 409);
    result.push({ id: `item:${item.id}`, type: 'vdr', data: { ...register, ...item, name: register.name, kind: 'document' } });
  }
  return result;
}
async function e3(db: any, projectId: string): Promise<RecordRow[]> {
  const [projects, solutions, attributes] = await Promise.all([
    db.e3Project.findMany({ where: { fluxProjectId: projectId }, orderBy: { id: 'asc' } }),
    catalogSetting(db, 'e3_solutions', { solutions: [], ioTable: [] }),
    catalogSetting(db, 'e3_attributes', { items: [] }),
  ]);
  const bindings = await db.e3Binding.findMany({ where: { e3ProjectId: { in: projects.map((p: any) => p.id) } }, orderBy: { id: 'asc' } });
  unique(solutions.solutions || [], r => String(r.id || ''), 'типовых решений');
  unique(attributes.items || [], r => String(r.name || ''), 'атрибутов');
  unique(solutions.ioTable || [], r => String(r.id || ''), 'IO');
  unique(bindings, r => `${r.e3ProjectId}:${r.elementId}`, 'связей E3');
  const projectMap = new Map(projects.map((p: any) => [p.id, p]));
  const solutionMap = new Map((solutions.solutions || []).map((s: any) => [s.id, s]));
  const records: RecordRow[] = bindings.map((b: any) => {
    const project: any = projectMap.get(b.e3ProjectId), solution: any = solutionMap.get(b.solutionId);
    return { id: `binding:${b.id}`, type: 'e3', data: { ...b, kind: 'binding', projectName: project?.name, projectKey: project?.key, solutionName: solution?.name, sentAttrs: parseJsonSafe(b.sentAttrsJson) } };
  });
  for (const s of solutions.solutions || []) records.push({ id: `solution:${s.id}`, type: 'e3', data: { ...s, kind: 'solution', solutionId: s.id, solutionName: s.name } });
  for (const a of attributes.items || []) records.push({ id: `attribute:${a.name}`, type: 'e3', data: { ...a, kind: 'attribute' } });
  for (const io of solutions.ioTable || []) records.push({ id: `io:${io.id}`, type: 'e3', data: { ...io, kind: 'io' } });
  return records;
}

/** Строгая проверка полей не позволяет опечатке превратить фильтр в выбор всего проекта. */
export async function queryOfficeSource(db: any, projectId: string, body: any) {
  const entity = String(body?.entity || '');
  if (!['procurement', 'vdr', 'e3'].includes(entity)) fail(`Источник «${entity}» не поддерживается`);
  const sourceId = entity === 'e3' ? 'e3flux' : 'management';
  const known = (entity === 'e3' ? e3fluxFields : managementFields.filter(f => f.entityType === entity));
  const fieldMap = new Map(known.map(f => [f.path, f]));
  const columns: string[] = Array.isArray(body.columns) ? body.columns.map(String) : known.map(f => f.path);
  const filters = Array.isArray(body.filters) ? body.filters : [];
  const sort = Array.isArray(body.sort) ? body.sort : [];
  for (const key of [...columns, ...filters.map((f: any) => f.field), ...sort.map((s: any) => s.field)]) if (!fieldMap.has(key)) fail(`Поле «${key}» отсутствует в источнике ${sourceId}`);
  const ops = ['contains', 'ncontains', 'eq', 'neq', 'in', 'empty', 'nempty', 'gt', 'gte', 'lt', 'lte'];
  if (filters.some((f: any) => !ops.includes(f.op))) fail('Оператор фильтра не поддерживается');
  let records = entity === 'e3' ? await e3(db, projectId) : await management(db, projectId, entity);
  unique(records, r => r.id, sourceId);
  // Ревизия зависит от всех исходных полей, даже если их нет в текущей выборке.
  const sourceRevision = hash(records);
  const value = (row: RecordRow, field: string) => scalar(row.data[field.replace(/^(vdr|e3)\./, '')]);
  for (const f of filters) records = records.filter(r => {
    if (f.op === 'gte' || f.op === 'lte') {
      const a = parseRuNumber(String(value(r, f.field) ?? '')), b = parseRuNumber(String(f.value ?? ''));
      return a != null && b != null && (f.op === 'gte' ? a >= b : a <= b);
    }
    return applyFilter(String(value(r, f.field) ?? ''), f.op, f.value);
  });
  const excluded = new Set(Array.isArray(body.excludedEntityIds) ? body.excludedEntityIds.map(String) : []);
  records = records.filter(r => !excluded.has(officeEntityId(sourceId, r.type, r.id)));
  records.sort((a, b) => {
    for (const s of sort) {
      const av = value(a, s.field), bv = value(b, s.field);
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''), 'ru', { numeric: true });
      if (cmp) return s.dir === 'desc' ? -cmp : cmp;
    }
    return a.id.localeCompare(b.id);
  });
  const limit = Math.max(1, Math.min(Number(body.limit) || 50000, 50000));
  const rows: OfficeEntityRow[] = records.slice(0, limit).map(r => ({ entityId: officeEntityId(sourceId, r.type, r.id), entityType: r.type, sourceId,
    values: Object.fromEntries(columns.map(key => [key, { value: value(r, key), revision: sourceRevision }])) }));
  return { rows, sourceRevision, total: records.length };
}
