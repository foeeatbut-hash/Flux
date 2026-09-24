/**
 * Позиция ведомости Конструктора и реквизиты документа — общий договор окна,
 * сервера и отрисовки бланка.
 *
 * Позиция — это тег(и) из MTO, количество и выбранная конфигурация изделия из
 * Каталога. Идентификатор позиции для человека — тег: по нему повторный импорт
 * новой ревизии MTO понимает, что строка та же, а не новая.
 */
import type { Text2, ValveValues } from './model';
import { t2 } from './model';

export type ItemStatus = 'draft' | 'matched' | 'checked' | 'issued';

export interface ActuatorInfo {
  /** Марка привода, если отличается от кода в обозначении */
  model?: string;
  count?: number;
  /** Теги приводов; пусто — выводятся из тегов позиции по правилу класса */
  tags?: string[];
  boxTags?: string[];
  boxModel?: string;
  glands?: string;
}

export interface HeatingInfo {
  voltage?: string;
  kw300?: string;
  kwStart?: string;
  sections?: string;
  tags?: string[];
}

export interface SourceRef {
  file?: string;
  sheet?: string;
  row?: number;
  /** Ревизия документа-источника: AN3, 3… */
  rev?: string;
}

export interface MatchInfo {
  confidence: number;
  reasons: Array<{ key: string; status: string; text: string }>;
  alternatives?: Array<{ familyId: string; score: number; designation: string }>;
  questions?: Array<{ param: string; label: string }>;
}

export interface SelectionItemData {
  id: string;
  classId: string;
  tags: string[];
  qty: number;
  familyId?: string;
  values: ValveValues;
  designation: string;
  /** Обозначение правлено руками и не пересобирается из параметров */
  designationManual?: boolean;
  sourceText?: string;
  sourceRef?: SourceRef;
  match?: MatchInfo;
  /** Номер строки б/з, если задан руками; иначе считается при выпуске */
  orderLine?: string;
  actuator?: ActuatorInfo;
  heating?: HeatingInfo;
  notes?: string;
  status: ItemStatus;
  /** Поля, поправленные человеком: импорт их не перезаписывает */
  overrides?: string[];
  sort: number;
  updatedAt?: string;
}

/**
 * Реквизиты документа. Список полей открытый: шаблон может сослаться на
 * любое `{doc.<ключ>}`, а здесь описаны те, что есть в бланках E06, чтобы окно
 * показало их понятными подписями.
 */
export type ListHeader = Record<string, string>;

export const HEADER_FIELDS: Array<{ key: string; label: Text2; group: 'doc' | 'parties' | 'numbers' }> = [
  { key: 'docNo', label: t2('Номер документа', 'Document No.'), group: 'numbers' },
  { key: 'docTitle', label: t2('Наименование документа', 'Document title'), group: 'doc' },
  { key: 'object', label: t2('Объект', 'Object'), group: 'doc' },
  { key: 'objectEn', label: t2('Объект (англ.)', 'Object (EN)'), group: 'doc' },
  { key: 'subobject', label: t2('Подобъект', 'Sub-object'), group: 'doc' },
  { key: 'plant', label: t2('Установка', 'Plant'), group: 'doc' },
  { key: 'stage', label: t2('Стадия', 'Stage'), group: 'doc' },
  { key: 'customer', label: t2('Заказчик', 'Customer'), group: 'parties' },
  { key: 'owner', label: t2('Владелец', 'Owner'), group: 'parties' },
  { key: 'contractor', label: t2('Подрядчик', 'Contractor'), group: 'parties' },
  { key: 'vendor', label: t2('Поставщик', 'Vendor'), group: 'parties' },
  { key: 'executor', label: t2('Исполнитель', 'Prepared by'), group: 'parties' },
  { key: 'phone', label: t2('Телефон/факс', 'Phone/Fax'), group: 'parties' },
  { key: 'email', label: t2('E-mail', 'E-mail'), group: 'parties' },
  { key: 'contractorProjectNo', label: t2('Номер проекта подрядчика', 'Contractor project No.'), group: 'numbers' },
  { key: 'ownerProjectNo', label: t2('Номер проекта владельца', 'Owner project No.'), group: 'numbers' },
  { key: 'poNo', label: t2('Номер заказа (PO)', 'Purchase order No.'), group: 'numbers' },
  { key: 'mrNo', label: t2('Номер заявки (MR)', 'Material requisition No.'), group: 'numbers' },
  { key: 'contract', label: t2('Контракт', 'Contract'), group: 'numbers' },
  { key: 'date', label: t2('Дата бланк-заказа', 'Order date'), group: 'doc' },
  { key: 'orderLinePattern', label: t2('Шаблон номера строки б/з', 'Order line pattern'), group: 'numbers' },
];

export const DEFAULT_ORDER_LINE = '{orderNo}-{n}-КОМ';

export interface IssueInfo {
  rev: string;
  date: string;
  reason: string;
  prepared?: string;
  checked?: string;
  approved?: string;
}

/** Ключ листа: семейство или семейство + исполнение */
export function groupKeyOf(familyId: string | undefined, exec: string | undefined, byExec: boolean): string {
  return byExec ? `${familyId || '—'}|${exec || ''}` : familyId || '—';
}
