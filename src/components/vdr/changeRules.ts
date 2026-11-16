/**
 * Правила «что изменилось» для ВДР: какие поля строки и реестра видит человек.
 *
 * Сравниваются запись, какой её показывала карточка в момент действия, и
 * `current` из отказа сервера (общий вид: голая запись, как её отдаёт чтение).
 * Входят только видимые поля: номера, названия, тип, ревизия, причина, язык,
 * даты, статус, код рассмотрения, исполнитель, замечания, теги, свои колонки;
 * у реестра — реквизиты титула и подписанты. Служебное (id, версия, даты
 * записи, тот же `extra` целиком, счётчики) в перечень не попадает.
 *
 * Имена вместо идентификаторов (исполнитель, менеджер, подписанты, статус,
 * колонки) приходят от экрана: то, что человек видит в списках, и то, что он
 * прочтёт в перечне, должно совпадать.
 *
 * Без React и сети: наборы гоняют правила на голых объектах.
 */
import { changesBetween, type ChangeRule, type FieldChange } from '../../lib/recordChanges';

/** Имена для перечня: что видит человек вместо кодов и идентификаторов */
export interface VdrNames {
  /** Сотрудники: id → имя */
  users?: Map<string, string> | Record<string, string>;
  /** Статусы: код → название */
  statuses?: Record<string, string>;
  /** Свои колонки реестра: ключ → название */
  columns?: Array<{ key: string; title: string; titleRu?: string; field?: string }>;
  /** Шаблоны документооборота: id → название */
  standards?: Record<string, string>;
}

/** Имена для перечня из того, что экран уже держит: сотрудники, статусы, колонки реестра, шаблоны. */
export function vdrNames(src: {
  users?: Array<{ id: string; name: string }>;
  statusMeta?: Record<string, { label: string }>;
  columns?: VdrNames['columns'];
  standards?: Array<{ id: string; name: string }>;
}): VdrNames {
  return {
    users: new Map((src.users || []).map((u) => [u.id, u.name])),
    statuses: Object.fromEntries(Object.entries(src.statusMeta || {}).map(([code, m]) => [code, m.label])),
    columns: src.columns,
    standards: Object.fromEntries((src.standards || []).map((s) => [s.id, s.name])),
  };
}

const lookup = (map: VdrNames['users'], id: unknown): string => {
  const key = String(id ?? '');
  if (!key) return '';
  const name = map instanceof Map ? map.get(key) : map?.[key];
  return name || key;
};

/** Дата без времени, как её видит человек: «04.11.2026» */
export function dayText(value: unknown): string {
  if (!value) return '';
  const raw = String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleDateString('ru-RU');
}

function jsonList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  try { const v = JSON.parse(String(raw || '[]')); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

/** Главные теги строки — по строке на каждый (коды текстом, как в карточке). */
export function tagRows(record: any): Array<{ label: string; value: unknown }> {
  return jsonList(record?.equipmentTags).map((t) => ({ label: `Тег ${t}`, value: 'указан' }));
}

/** Свои колонки строки: название колонки → значение. Колонки, которых нет у реестра, не показываются (их не видно и в карточке). */
function extraRows(names: VdrNames): (record: any) => Array<{ label: string; value: unknown }> {
  const cols = (names.columns || []).filter((c) => !c.field);
  return (record) => {
    const extra = record?.extra && typeof record.extra === 'object' ? record.extra : {};
    return cols.map((c) => ({ label: c.titleRu || c.title || c.key, value: extra[c.key] }));
  };
}

export function itemRules(names: VdrNames = {}): ChangeRule[] {
  return [
    { label: '№ подрядчика', value: (r) => r.contractorNo },
    { label: '№ заказчика', value: (r) => r.ownerNo },
    { label: '№ поставщика', value: (r) => r.vendorNo },
    { label: 'Тип (VDR-код)', value: (r) => r.vdrCode },
    { label: 'Наименование (рус)', value: (r) => r.titleRu },
    { label: 'Наименование (англ)', value: (r) => r.titleEn },
    { label: 'Ревизия', value: (r) => r.revision },
    { label: 'Причина', value: (r) => r.reasonForIssue },
    { label: 'Язык', value: (r) => r.language },
    { label: 'Дата выпуска', value: (r) => dayText(r.issueDate) },
    { label: 'Срок след. ревизии', value: (r) => dayText(r.dueDate) },
    { label: 'Статус', value: (r) => (r.status ? names.statuses?.[r.status] || r.status : '') },
    { label: 'Код рассмотрения', value: (r) => r.reviewCode },
    { label: 'Исполнитель', value: (r) => lookup(names.users, r.assigneeId) },
    { label: 'Замечания', value: (r) => r.remarks },
    { label: 'Теги', rows: tagRows },
    { label: 'Дополнительные колонки', rows: extraRows(names) },
  ];
}

/** Свои колонки реестра: по строке на колонку, значение — «есть». Переименование колонки покажется как «убрана» и «появилась». */
function columnRows(record: any): Array<{ label: string; value: unknown }> {
  const cols: any[] = Array.isArray(record?.columnsConfig) ? record.columnsConfig : [];
  return cols.filter((c) => c && !c.field).map((c) => ({ label: `Колонка «${c.titleRu || c.title || c.key}»`, value: 'есть' }));
}

export function registerRules(names: VdrNames = {}): ChangeRule[] {
  return [
    { label: 'Название реестра', value: (r) => r.name },
    { label: 'Шаблон', value: (r) => (r.standardId ? names.standards?.[r.standardId] || r.standardId : '') },
    { label: 'Подрядчик', value: (r) => r.contractor },
    { label: 'Заказчик', value: (r) => r.owner },
    { label: '№ проекта подрядчика', value: (r) => r.contractorProjectNo },
    { label: '№ проекта заказчика', value: (r) => r.ownerProjectNo },
    { label: 'Поставщик', value: (r) => r.vendor },
    { label: 'Заказ (PO)', value: (r) => r.poNumber },
    { label: 'Заявка на материалы (MR)', value: (r) => r.materialRequisition },
    { label: 'Название оборудования', value: (r) => r.equipmentTitle },
    { label: '№ ВДР (подрядчик)', value: (r) => r.contractorDocNo },
    { label: '№ ВДР (заказчик)', value: (r) => r.ownerDocNo },
    { label: '№ ВДР (поставщик)', value: (r) => r.vendorDocNo },
    { label: 'Менеджер', value: (r) => lookup(names.users, r.managerId) },
    { label: 'Разработал', value: (r) => r.preparedBy },
    { label: 'Проверил', value: (r) => r.checkedBy },
    { label: 'Утвердил', value: (r) => r.approvedBy },
    { label: 'Ревизия ВДР', value: (r) => r.revision },
    { label: 'Свои колонки', rows: columnRows },
  ];
}

/** Перечень изменений строки: `shown` — строка, какой её видел экран, `current` — из отказа. */
export function itemChanges(shown: unknown, current: unknown, names: VdrNames = {}): FieldChange[] {
  return changesBetween(shown, current, itemRules(names));
}

/** Перечень изменений реестра (реквизиты, подписанты, свои колонки). */
export function registerChanges(shown: unknown, current: unknown, names: VdrNames = {}): FieldChange[] {
  return changesBetween(shown, current, registerRules(names));
}
