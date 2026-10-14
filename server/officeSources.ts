import { createHash } from 'node:crypto';
import { getPrisma } from './context.js';
import { officeEntityId } from '../src/lib/officeModel.js';
import { isPlainNumber, parseRuNumber } from './normalize.js';
import { buildRecipeFor } from '../e3/recipe.js';
import type { E3Position, E3SolutionBook } from '../e3/solutionTypes.js';

export interface OfficeSourceField {
  path: string;
  title: string;
  type?: 'text' | 'number';
  unit?: string;
  entityType: 'procurement' | 'vdr' | 'e3';
}

export interface OfficeSourceRow {
  entityId: string;
  entityType: 'procurement' | 'vdr' | 'e3';
  sourceId: 'management' | 'e3flux';
  values: Record<string, string | number | null>;
}

const MANAGEMENT_FIELDS: OfficeSourceField[] = [
  { path: 'tag.identifier', title: 'Тег', entityType: 'procurement' },
  { path: 'procurement.stage', title: 'Этап закупки (код)', entityType: 'procurement' },
  { path: 'procurement.stageName', title: 'Этап закупки', entityType: 'procurement' },
  { path: 'procurement.stageSince', title: 'Дата этапа закупки', entityType: 'procurement' },
  { path: 'procurement.stageHistory', title: 'История этапов закупки', entityType: 'procurement' },
  { path: 'procurement.supplier', title: 'Поставщик', entityType: 'procurement' },
  { path: 'procurement.qty', title: 'Количество', entityType: 'procurement', type: 'number' },
  { path: 'procurement.note', title: 'Примечание закупки', entityType: 'procurement' },
  { path: 'procurement.templateId', title: 'Шаблон этапов закупки (ID)', entityType: 'procurement' },
  { path: 'vdr.register', title: 'Реестр ВДР', entityType: 'vdr' },
  { path: 'vdr.vendor', title: 'Поставщик в реестре ВДР', entityType: 'vdr' },
  { path: 'vdr.contractor', title: 'Подрядчик в реестре ВДР', entityType: 'vdr' },
  { path: 'vdr.owner', title: 'Владелец в реестре ВДР', entityType: 'vdr' },
  { path: 'vdr.poNumber', title: 'Номер заказа в реестре ВДР', entityType: 'vdr' },
  { path: 'vdr.ownerProjectNo', title: 'Номер проекта владельца', entityType: 'vdr' },
  { path: 'vdr.contractorProjectNo', title: 'Номер проекта подрядчика', entityType: 'vdr' },
  { path: 'vdr.materialRequisition', title: 'Заявка на материалы ВДР', entityType: 'vdr' },
  { path: 'vdr.equipmentTitle', title: 'Название оборудования ВДР', entityType: 'vdr' },
  { path: 'vdr.registerContractorDocNo', title: 'Номер ВДР подрядчика', entityType: 'vdr' },
  { path: 'vdr.registerOwnerDocNo', title: 'Номер ВДР владельца', entityType: 'vdr' },
  { path: 'vdr.registerVendorDocNo', title: 'Номер ВДР поставщика', entityType: 'vdr' },
  { path: 'vdr.registerRevision', title: 'Ревизия реестра ВДР', entityType: 'vdr' },
  { path: 'vdr.registerRevisions', title: 'История ревизий реестра ВДР', entityType: 'vdr' },
  { path: 'vdr.standardId', title: 'Стандарт ВДР (ID)', entityType: 'vdr' },
  { path: 'vdr.preparedBy', title: 'Подготовил реестр ВДР', entityType: 'vdr' },
  { path: 'vdr.preparedById', title: 'Подготовил реестр ВДР (ID)', entityType: 'vdr' },
  { path: 'vdr.checkedBy', title: 'Проверил реестр ВДР', entityType: 'vdr' },
  { path: 'vdr.checkedById', title: 'Проверил реестр ВДР (ID)', entityType: 'vdr' },
  { path: 'vdr.approvedBy', title: 'Утвердил реестр ВДР', entityType: 'vdr' },
  { path: 'vdr.approvedById', title: 'Утвердил реестр ВДР (ID)', entityType: 'vdr' },
  { path: 'vdr.managerId', title: 'Ответственный за реестр ВДР (ID)', entityType: 'vdr' },
  { path: 'vdr.contractorNo', title: 'Номер документа у подрядчика', entityType: 'vdr' },
  { path: 'vdr.ownerNo', title: 'Номер документа у владельца', entityType: 'vdr' },
  { path: 'vdr.vendorNo', title: 'Номер документа у поставщика', entityType: 'vdr' },
  { path: 'vdr.titleRu', title: 'Документ (русское название)', entityType: 'vdr' },
  { path: 'vdr.titleEn', title: 'Документ (английское название)', entityType: 'vdr' },
  { path: 'vdr.code', title: 'Тип документа ВДР', entityType: 'vdr' },
  { path: 'vdr.revision', title: 'Ревизия документа ВДР', entityType: 'vdr' },
  { path: 'vdr.issueDate', title: 'Дата выпуска документа ВДР', entityType: 'vdr' },
  { path: 'vdr.reasonForIssue', title: 'Причина выпуска документа ВДР', entityType: 'vdr' },
  { path: 'vdr.language', title: 'Язык документа ВДР', entityType: 'vdr' },
  { path: 'vdr.status', title: 'Статус документа ВДР', entityType: 'vdr' },
  { path: 'vdr.remarks', title: 'Замечания к документу ВДР', entityType: 'vdr' },
  { path: 'vdr.reviewCode', title: 'Код рассмотрения документа ВДР', entityType: 'vdr' },
  { path: 'vdr.dueDate', title: 'Срок документа ВДР', entityType: 'vdr' },
  { path: 'vdr.assigneeId', title: 'Исполнитель документа ВДР (ID)', entityType: 'vdr' },
  { path: 'vdr.docId', title: 'ID документа Конструктора', entityType: 'vdr' },
  { path: 'vdr.fileNodeId', title: 'ID файла замечаний', entityType: 'vdr' },
  { path: 'vdr.itemRevisionHistory', title: 'История ревизий документа ВДР', entityType: 'vdr' },
  { path: 'vdr.tags', title: 'Теги документа ВДР', entityType: 'vdr' },
  { path: 'vdr.tagsConflict', title: 'Неоднозначные теги документа ВДР', entityType: 'vdr' },
];

const E3_FIELDS: OfficeSourceField[] = [
  { path: 'element.itemCode', title: 'Код позиции Flux', entityType: 'e3' },
  { path: 'element.name', title: 'Наименование позиции Flux', entityType: 'e3' },
  { path: 'element.tag', title: 'Тег позиции Flux', entityType: 'e3' },
  { path: 'e3.project', title: 'Проект E3', entityType: 'e3' },
  { path: 'e3.version', title: 'Версия E3.series', entityType: 'e3' },
  { path: 'e3.partsDb', title: 'База изделий E3', entityType: 'e3' },
  { path: 'e3.path', title: 'Путь проекта E3', entityType: 'e3' },
  { path: 'e3.solutionId', title: 'ID типового решения', entityType: 'e3' },
  { path: 'e3.solutionName', title: 'Типовое решение', entityType: 'e3' },
  { path: 'e3.solutionClass', title: 'Класс типового решения', entityType: 'e3' },
  { path: 'e3.designation', title: 'Обозначение в E3', entityType: 'e3' },
  { path: 'e3.sheet', title: 'Лист E3', entityType: 'e3' },
  { path: 'e3.state', title: 'Состояние связи E3', entityType: 'e3' },
  { path: 'e3.sentVersion', title: 'Версия позиции при выгрузке', entityType: 'e3' },
  { path: 'e3.manualSolution', title: 'Решение выбрано вручную', entityType: 'e3' },
  { path: 'e3.devices', title: 'Изделия E3 в составе решения', entityType: 'e3' },
  { path: 'e3.di', title: 'Сумма DI по решению', entityType: 'e3', type: 'number' },
  { path: 'e3.do', title: 'Сумма DO по решению', entityType: 'e3', type: 'number' },
  { path: 'e3.ai', title: 'Сумма AI по решению', entityType: 'e3', type: 'number' },
  { path: 'e3.ao', title: 'Сумма AO по решению', entityType: 'e3', type: 'number' },
];

const json = (raw: unknown): any => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { const parsed = JSON.parse(String(raw)); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
};
// Битая настройка (items не массив, null и т.п.) читается как пустая, а не роняет весь источник.
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
// Таблицы ВДР и E3 создаются лениво (vdr.ts, e3ExportStore): если их ещё нет, источник пуст, а не отвечает 500.
const soft = <T>(promise: Promise<T>, fallback: T): Promise<T> => promise.catch(() => fallback);
const scalar = (value: unknown): string | number | null => {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return JSON.stringify(value);
};
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const tagEntityId = (tagId: string) => officeEntityId('management', 'procurement', tagId);
const vdrEntityId = (itemId: string) => officeEntityId('management', 'vdr', itemId);
const e3EntityId = (elementId: string) => officeEntityId('e3flux', 'e3', elementId);

function stageName(stageId: string, stages: any[]): string {
  return String(stages.find((stage) => String(stage?.id) === stageId)?.label || stageId || '');
}

function dateValue(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

function managementRows(tags: any[], registers: any[], stages: any[], revisions: any[]): OfficeSourceRow[] {
  const rows: OfficeSourceRow[] = tags.map((tag) => {
    const metadata = json(tag.metadata);
    const procurement = json(metadata.procurement);
    const stageId = String(procurement.stage || '');
    const stageLog = json(procurement.stageLog);
    for (const [id, atKey, byKey] of [['ordered', 'orderedAt', 'orderedBy'], ['approved', 'approvedAt', 'approvedBy'], ['purchased', 'purchasedAt', 'purchasedBy']]) {
      if (procurement[atKey] && !stageLog[id]) stageLog[id] = { at: procurement[atKey], by: procurement[byKey] || '' };
    }
    const stageSince = stageId ? json(stageLog[stageId]).at : null;
    const history = Object.entries(stageLog).map(([id, record]: [string, any]) => ({ id, label: stageName(id, stages), at: String(record?.at || ''), by: String(record?.by || '') }));
    return {
      entityId: tagEntityId(String(tag.id)), entityType: 'procurement', sourceId: 'management',
      values: {
        'tag.identifier': String(tag.identifier || ''),
        'procurement.stage': stageId || null,
        'procurement.stageName': stageId ? stageName(stageId, stages) : null,
        'procurement.stageSince': dateValue(stageSince),
        'procurement.stageHistory': history.length ? JSON.stringify(history) : null,
        'procurement.supplier': scalar(procurement.supplier),
        'procurement.qty': typeof procurement.qty === 'number' || isPlainNumber(procurement.qty) ? parseRuNumber(procurement.qty) : scalar(procurement.qty),
        'procurement.note': scalar(procurement.note),
        'procurement.templateId': scalar(procurement.templateId),
      },
    };
  });

  const tagByIdentifier = new Map<string, any[]>();
  for (const tag of tags) {
    const key = String(tag.identifier || '').trim().toLocaleLowerCase('ru-RU');
    if (!key) continue;
    tagByIdentifier.set(key, [...(tagByIdentifier.get(key) || []), tag]);
  }
  for (const register of registers) for (const item of list(register.items)) {
    const tagCodes: string[] = (() => {
      const parsed = json(item.equipmentTags);
      return Array.isArray(parsed) ? parsed.map((value: any) => String(value).trim()).filter(Boolean) : [];
    })();
    const matchedTags = tagCodes.flatMap((code) => tagByIdentifier.get(code.toLocaleLowerCase('ru-RU')) || []);
    const ambiguous = [...new Set(tagCodes.filter((code) => (tagByIdentifier.get(code.toLocaleLowerCase('ru-RU')) || []).length > 1))];
    // Неоднозначный тег портит только значение «vdr.tags» этой строки, а не весь источник закупок.
    const extra = json(item.extra);
    const meta = json(item.meta);
    rows.push({
      entityId: vdrEntityId(String(item.id)), entityType: 'vdr', sourceId: 'management',
      values: {
        'vdr.register': String(register.name || ''),
        'vdr.vendor': String(register.vendor || ''), 'vdr.contractor': String(register.contractor || ''), 'vdr.owner': String(register.owner || ''),
        'vdr.poNumber': String(register.poNumber || ''), 'vdr.ownerProjectNo': String(register.ownerProjectNo || ''),
        'vdr.contractorProjectNo': String(register.contractorProjectNo || ''), 'vdr.materialRequisition': String(register.materialRequisition || ''),
        'vdr.equipmentTitle': String(register.equipmentTitle || ''), 'vdr.registerContractorDocNo': String(register.contractorDocNo || ''),
        'vdr.registerOwnerDocNo': String(register.ownerDocNo || ''), 'vdr.registerVendorDocNo': String(register.vendorDocNo || ''),
        'vdr.registerRevision': String(register.revision || ''), 'vdr.registerRevisions': scalar(register.revisions),
        'vdr.standardId': register.standardId || null,
        'vdr.preparedBy': String(register.preparedBy || ''), 'vdr.checkedBy': String(register.checkedBy || ''),
        'vdr.approvedBy': String(register.approvedBy || ''), 'vdr.managerId': register.managerId || null,
        'vdr.preparedById': register.preparedById || null, 'vdr.checkedById': register.checkedById || null, 'vdr.approvedById': register.approvedById || null,
        'vdr.contractorNo': String(item.contractorNo || ''), 'vdr.ownerNo': String(item.ownerNo || ''), 'vdr.vendorNo': String(item.vendorNo || ''),
        'vdr.titleRu': String(item.titleRu || ''), 'vdr.titleEn': String(item.titleEn || ''), 'vdr.code': String(item.vdrCode || ''),
        'vdr.revision': String(item.revision || ''), 'vdr.issueDate': dateValue(item.issueDate), 'vdr.reasonForIssue': String(item.reasonForIssue || ''),
        'vdr.language': String(item.language || ''), 'vdr.status': String(item.status || ''), 'vdr.remarks': String(item.remarks || ''),
        'vdr.reviewCode': String(item.reviewCode || ''), 'vdr.dueDate': dateValue(item.dueDate), 'vdr.assigneeId': item.assigneeId || null,
        'vdr.docId': item.docId || null, 'vdr.fileNodeId': item.fileNodeId || null,
        'vdr.itemRevisionHistory': scalar(revisions.filter((revision) => revision.itemId === item.id).map(({ id, itemId, ...revision }) => revision)),
        'vdr.tags': ambiguous.length ? null : matchedTags.map((tag) => String(tag.identifier || '')).join('; ') || (tagCodes.length ? tagCodes.join('; ') : null),
        'vdr.tagsConflict': ambiguous.length ? `Неоднозначное сопоставление ВДР по тегу: ${ambiguous.join(', ')}` : null,
        ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [`vdr.extra.${key}`, scalar(value)])),
        ...Object.fromEntries(Object.entries(meta).map(([key, value]) => [`vdr.meta.${key}`, scalar(value)])),
      },
    });
  }
  return rows;
}

function e3Rows(elements: any[], projects: any[], bindings: any[], book: E3SolutionBook): OfficeSourceRow[] {
  const solutionIds = new Set<string>();
  for (const solution of book.solutions) {
    const id = String(solution.id || '');
    if (id && solutionIds.has(id)) throw Object.assign(new Error(`В каталоге E3 неоднозначный ID типового решения: ${id}`), { status: 409 });
    if (id) solutionIds.add(id);
  }
  const projectById = new Map(projects.map((item) => [item.id, item]));
  const solutionById = new Map(book.solutions.map((item) => [String(item.id), item]));
  const byElement = new Map<string, { project: any; binding: any }[]>();
  for (const binding of bindings) {
    const project = projectById.get(binding.e3ProjectId);
    if (!project) continue;
    byElement.set(binding.elementId, [...(byElement.get(binding.elementId) || []), { project, binding }]);
  }
  const elementsById = new Map(elements.map((item) => [String(item.id), item]));
  const elementById = elementsById;
  for (const [elementId, matches] of byElement) {
    if (matches.length > 1) throw Object.assign(new Error(`У позиции ${elementId} несколько привязок E3 в проекте Flux`), { status: 409 });
  }
  const elementTag = (item: any) => (item.tags || []).map((tag: any) => String(tag.identifier || '')).find(Boolean) || '';
  const parentTag = (item: any) => {
    const parent = elementById.get(String(item.parentElementId || ''));
    return parent ? elementTag(parent) : '';
  };
  // Список позиций одинаков для всех привязок: строим один раз, иначе выйдет O(N²) на 1000+ позиций.
  const positionOf = (item: any): E3Position => ({
    id: String(item.id), cls: String(item.equipClass || item.equipType || ''), role: String(item.role || ''),
    tag: elementTag(item), parentElementId: item.parentElementId || undefined, parentTag: parentTag(item), read: () => '',
  } as E3Position);
  const ioById = new Map(book.ioTable.map((row) => [row.id, row]));
  const allPositions = elements.map(positionOf);
  const positionById = new Map(allPositions.map((item) => [item.id, item]));
  return [...byElement.entries()].flatMap(([elementId, matches]) => {
    const element = elementsById.get(elementId);
    if (!element) return [];
    const { project, binding } = matches[0];
    const tagCodes = (element.tags || []).map((tag: any) => String(tag.identifier || '')).filter(Boolean);
    const attrs = json(binding.sentAttrsJson);
    const overrides = json(binding.overridesJson);
    const solution = solutionById.get(String(binding.solutionId || ''));
    const features = { ...(solution?.features || {}), ...json(binding.answersJson) };
    const self = positionById.get(String(element.id)) as E3Position;
    const recipe = solution ? buildRecipeFor({ ...solution, features }, self, allPositions, book) : null;
    const values: Record<string, string | number | null> = {
      'element.itemCode': String(element.itemCode || ''), 'element.name': String(element.name || ''), 'element.tag': tagCodes.join('; '),
      'e3.project': String(project.name || ''), 'e3.version': String(project.e3Version || ''), 'e3.partsDb': String(project.partsDb || ''), 'e3.path': String(project.path || ''),
      'e3.solutionId': String(binding.solutionId || ''), 'e3.solutionName': solution?.name || null,
      'e3.solutionClass': solution?.mainClass || null, 'e3.designation': String(binding.designation || ''),
      'e3.sheet': String(binding.sheet || ''), 'e3.state': String(binding.state || ''), 'e3.sentVersion': String(binding.sentVersion || ''),
      'e3.manualSolution': binding.manualSolution ? 'Да' : 'Нет',
      'e3.devices': recipe?.items.length ? recipe.items.map((item) => {
        const io = ioById.get(item.ioRowId);
        return `${item.role}: ${io?.name || io?.code || item.ioRowId || 'изделие'}${item.component ? ` (${item.component})` : ''}`;
      }).join('; ') : null,
      'e3.di': recipe?.total.di ?? null, 'e3.do': recipe?.total.do ?? null, 'e3.ai': recipe?.total.ai ?? null, 'e3.ao': recipe?.total.ao ?? null,
    };
    for (const [key, value] of Object.entries(attrs)) values[`e3.attr:${key}`] = scalar(value);
    // Настроенные колонки идут без владельца («e3.attr:|ИМЯ»), а в привязке ключ — «владелец|ИМЯ».
    // Для такой колонки берём значение, если владелец с этим именем один; при нескольких не угадываем.
    const byName = new Map<string, Set<string | number | null>>();
    for (const [key, value] of Object.entries(attrs)) {
      const bar = key.indexOf('|');
      if (bar <= 0) continue;
      const name = key.slice(bar + 1);
      byName.set(name, (byName.get(name) || new Set()).add(scalar(value)));
    }
    for (const [name, found] of byName) {
      const field = `e3.attr:|${name}`;
      if (!(field in values)) values[field] = found.size === 1 ? [...found][0] : null;
    }
    for (const [key, value] of Object.entries(overrides)) values[`e3.override:${key}`] = scalar(value);
    if (recipe) for (const io of book.ioTable) {
      const count = recipe.items.filter((item) => item.ioRowId === io.id).length;
      if (count) for (const signal of ['di', 'do', 'ai', 'ao'] as const) values[`e3.io:${io.id}|${signal}`] = io[signal] * count;
    }
    return [{ entityId: e3EntityId(elementId), entityType: 'e3' as const, sourceId: 'e3flux' as const, values }];
  });
}

export async function officeSourceCatalog(projectId: string) {
  const db = getPrisma();
  const [attributeSetting, solutionSetting, registers, projects] = await Promise.all([
    soft(db.appSetting.findFirst({ where: { key: 'e3_attributes', userId: null } }), null),
    soft(db.appSetting.findFirst({ where: { key: 'e3_solutions', userId: null } }), null),
    soft(db.docRegister.findMany({ where: { projectId }, include: { items: true }, orderBy: { id: 'asc' } }), [] as any[]),
    soft(db.e3Project.findMany({ where: { fluxProjectId: projectId }, select: { id: true, name: true } }), [] as any[]),
  ]);
  const attributes = list(json(attributeSetting?.value).items);
  const solutions = json(solutionSetting?.value);
  const extras = registers.flatMap((register: any) => list(register.items).map((item: any) => ({ extra: json(item.extra), meta: json(item.meta) })));
  const dynamicVdr = extras.flatMap((record) => [
    ...Object.keys(record.extra).map((key) => ({ path: `vdr.extra.${key}`, title: `ВДР · ${key}`, entityType: 'vdr' as const })),
    ...Object.keys(record.meta).map((key) => ({ path: `vdr.meta.${key}`, title: `ВДР · ${key}`, entityType: 'vdr' as const })),
  ]);
  const attrKeys = new Set<string>(), overrideKeys = new Set<string>();
  const bindings = projects.length ? await soft(db.e3Binding.findMany({ where: { e3ProjectId: { in: projects.map((project: any) => project.id) } }, select: { sentAttrsJson: true, overridesJson: true } }), [] as any[]) : [];
  for (const binding of bindings) {
    for (const key of Object.keys(json(binding.sentAttrsJson))) attrKeys.add(key);
    for (const key of Object.keys(json(binding.overridesJson))) overrideKeys.add(key);
  }
  const configured = attributes.filter((item: any) => item && item.name && !item.removed).map((item: any) => ({ path: `e3.attr:|${item.name}`, title: `E3 · ${item.title || item.name}`, entityType: 'e3' as const }));
  const dynamicAttrs = [...attrKeys].map((key) => ({ path: `e3.attr:${key}`, title: `E3 · ${key}`, entityType: 'e3' as const }));
  const dynamicOverrides = [...overrideKeys].map((key) => ({ path: `e3.override:${key}`, title: `E3 · ручная правка · ${key}`, entityType: 'e3' as const }));
  const ioFields = list(solutions.ioTable).flatMap((io: any) => [
    { path: `e3.io:${io.id}|di`, title: `E3 IO · ${io.group} · ${io.name} · DI`, type: 'number' as const, entityType: 'e3' as const },
    { path: `e3.io:${io.id}|do`, title: `E3 IO · ${io.group} · ${io.name} · DO`, type: 'number' as const, entityType: 'e3' as const },
    { path: `e3.io:${io.id}|ai`, title: `E3 IO · ${io.group} · ${io.name} · AI`, type: 'number' as const, entityType: 'e3' as const },
    { path: `e3.io:${io.id}|ao`, title: `E3 IO · ${io.group} · ${io.name} · AO`, type: 'number' as const, entityType: 'e3' as const },
  ]);
  const e3Fields = [...E3_FIELDS, ...configured, ...dynamicAttrs, ...dynamicOverrides, ...ioFields];
  return {
    managementFields: [...new Map([...MANAGEMENT_FIELDS, ...dynamicVdr].map((field) => [field.path, field])).values()],
    e3fluxFields: [...new Map(e3Fields.map((field) => [field.path, field])).values()],
  };
}

export async function queryOfficeSource(projectId: string, sourceId: 'management' | 'e3flux'): Promise<{ rows: OfficeSourceRow[]; revision: string }> {
  const db = getPrisma();
  if (sourceId === 'management') {
    const [tags, registers, setting] = await Promise.all([
      db.tag.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
      soft(db.docRegister.findMany({ where: { projectId }, include: { items: true }, orderBy: { id: 'asc' } }), [] as any[]),
      soft(db.appSetting.findFirst({ where: { key: 'procurement_stages', userId: null } }), null),
    ]);
    const stages = json(setting?.value);
    const itemIds = registers.flatMap((register: any) => list(register.items).map((item: any) => item.id));
    const revisions = itemIds.length ? await soft(db.docRegisterItemRevision.findMany({ where: { itemId: { in: itemIds } }, orderBy: [{ date: 'asc' }, { id: 'asc' }] }), [] as any[]) : [];
    const rows = managementRows(tags, registers, Array.isArray(stages) ? stages : [], revisions);
    return { rows, revision: digest({ projectId, stages, tags: tags.map((tag: any) => [tag.id, tag.updatedAt, tag.metadata]), registers: registers.map((register: any) => [register.id, register.updatedAt, register.items]), revisions }) };
  }
  const [projects, elements, attrSetting, solutionSetting] = await Promise.all([
    soft(db.e3Project.findMany({ where: { fluxProjectId: projectId }, orderBy: { id: 'asc' } }), [] as any[]),
    db.componentElement.findMany({ where: { monoblock: { system: { projectId } } }, include: { tags: { select: { identifier: true } } }, orderBy: { id: 'asc' } }),
    soft(db.appSetting.findFirst({ where: { key: 'e3_attributes', userId: null } }), null),
    soft(db.appSetting.findFirst({ where: { key: 'e3_solutions', userId: null } }), null),
  ]);
  const bindings = projects.length
    ? await soft(db.e3Binding.findMany({ where: { e3ProjectId: { in: projects.map((item: any) => item.id) } }, orderBy: { id: 'asc' } }), [] as any[])
    : [];
  const attributes = list(json(attrSetting?.value).items);
  const storedBook = json(solutionSetting?.value);
  const book = { ...storedBook, solutions: list(storedBook.solutions), features: list(storedBook.features), ioTable: list(storedBook.ioTable), ioRules: list(storedBook.ioRules) } as E3SolutionBook;
  return { rows: e3Rows(elements, projects, bindings, book), revision: digest({ projectId, projects, bindings, attributes, book, elements }) };
}

export function sourceFields(sourceId: 'management' | 'e3flux', catalog: { managementFields: OfficeSourceField[]; e3fluxFields: OfficeSourceField[] }): OfficeSourceField[] {
  return sourceId === 'management' ? catalog.managementFields : catalog.e3fluxFields;
}
