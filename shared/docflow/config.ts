import { normalizeKits, type DocflowKit } from './kits';
import { normalizeClassMappings, type EquipmentClassMapping } from './classMapping';
import { normalizeRevisionRules, DEFAULT_REVISION_RULES, type DocflowRevisionRules } from './revisions';

/**
 * Настройки документооборота проекта (docs/docflow-program.md, раздел 5).
 *
 * Один модуль для сервера и окна: что лежит в настройках, какие значения по
 * умолчанию, как читаются старые глобальные стандарты (`DocStandard`) и чем
 * отличаются два набора — для предпросмотра переноса между проектами.
 *
 * Имена полей `reviewCodes`, `reasons`, `specialRevisions`, `vdrTypes` взяты
 * у прежнего стандарта намеренно: реестр, выгрузка и сроки читают их как
 * раньше, а настройки проекта — надмножество стандарта, а не новый формат.
 */

export type DocflowTone = 'slate' | 'sky' | 'emerald' | 'amber' | 'rose' | 'violet';
export interface DocflowStatus { code: string; label: string; tone: DocflowTone; /** Строку в этом статусе можно выпускать. */ issue: boolean }
export interface DocflowReviewCode { code: string; label: string; action: 'accept' | 'revise' | 'info'; deadlineDays: number; /** Статус строки после кода; пусто — по действию. */ status?: string }
export interface DocflowReason { code: string; label: string; revKind: 'letter' | 'digit' }
export interface DocflowDocType { code: string; titleRu: string; titleEn: string; stage?: '' | 'П' | 'Р'; template?: string }
export type CipherSource = 'contractorNo' | 'ownerNo' | 'vendorNo';
export interface DocflowMasks {
  /** Имя файла без расширения: `{шифр}_{ред}`. */
  file: string;
  /** Шифр документа: `{заказ}-{установка}-{тип}-{номер}`. */
  cipher: string;
  /** Какой шифр строки ВДР сравнивается с шифром в имени. */
  cipherSource: CipherSource;
  /** Служебные файлы, которые «Сверка с папкой» не считает документами. */
  ignore: string[];
}
export interface DocflowFolders { work: string; issue: string; returns: string; incoming: string }
export interface DocflowSigners { developed: string; checked: string; approved: string; normControl: string }
export interface DocflowDeadline { type: string; from: string; days: number; workdays: boolean }
export interface DocflowConfig {
  statuses: DocflowStatus[];
  reasons: DocflowReason[];
  specialRevisions: { void: string; superseded: string };
  /** Схема ревизий: порядок букв и первая цифра; по ней сервер проверяет, что выпускается следующая ревизия. */
  revisionRules: DocflowRevisionRules;
  reviewCodes: DocflowReviewCode[];
  vdrTypes: DocflowDocType[];
  masks: DocflowMasks;
  folders: DocflowFolders;
  equipmentClasses: EquipmentClassMapping[];
  kits: DocflowKit[];
  deadlines: { milestones: Array<{ code: string; label: string; date: string }>; byType: DocflowDeadline[] };
  signers: DocflowSigners;
  columns: Array<{ key: string; title: string }>;
}

// Статусы по умолчанию — решение владельца (раздел 13). Коды DRAFT, READY,
// REMARKS, ACCEPTED остались прежними: по ним работают уведомления и выгрузка.
export const DEFAULT_STATUSES: DocflowStatus[] = [
  { code: 'DRAFT', label: 'В работе', tone: 'slate', issue: false },
  { code: 'CHECK', label: 'На проверке', tone: 'violet', issue: false },
  { code: 'READY', label: 'Согласован', tone: 'emerald', issue: true },
  { code: 'ISSUED', label: 'Выдан', tone: 'sky', issue: false },
  { code: 'REMARKS', label: 'Замечания', tone: 'amber', issue: true },
  { code: 'ACCEPTED', label: 'Принят', tone: 'sky', issue: false },
  { code: 'VOID', label: 'Аннулирован', tone: 'rose', issue: false },
];

export const DEFAULT_DOCFLOW_CONFIG: DocflowConfig = {
  statuses: DEFAULT_STATUSES,
  reasons: [
    { code: 'IFR', label: 'Issued for Review / Для рассмотрения', revKind: 'letter' },
    { code: 'IFI', label: 'Issued for Information / Для информации', revKind: 'letter' },
    { code: 'IFU', label: 'Issued for Use / Для использования', revKind: 'digit' },
    { code: 'CEF', label: 'Certified Final / Окончательный', revKind: 'digit' },
  ],
  specialRevisions: { void: 'V', superseded: 'S' },
  revisionRules: DEFAULT_REVISION_RULES,
  reviewCodes: [
    { code: '1', label: 'Принято', action: 'accept', deadlineDays: 0 },
    { code: '2', label: 'Принято с замечаниями', action: 'revise', deadlineDays: 10 },
    { code: '3', label: 'Отклонено', action: 'revise', deadlineDays: 10 },
    { code: '4', label: 'Для сведения', action: 'info', deadlineDays: 0 },
  ],
  vdrTypes: [
    { code: 'E02', titleRu: 'Общий вид', titleEn: 'General arrangement', stage: 'Р', template: '' },
    { code: 'C32', titleRu: 'Опросный лист', titleEn: 'Data sheet', stage: 'Р', template: '' },
    { code: 'C01', titleRu: 'Габаритный чертёж', titleEn: 'Outline drawing', stage: 'Р', template: '' },
  ],
  masks: { file: '{шифр}_{ред}', cipher: '{заказ}-{установка}-{тип}-{номер}', cipherSource: 'contractorNo', ignore: ['*.bak', '~$*', 'Thumbs.db', 'desktop.ini'] },
  folders: { work: '{тип}', issue: '{ред}', returns: '{тип}/{шифр}/{ред}', incoming: '' },
  equipmentClasses: [],
  kits: [],
  deadlines: { milestones: [], byType: [] },
  signers: { developed: '', checked: '', approved: '', normControl: '' },
  columns: [],
};

const text = (v: unknown, max = 500): string => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const list = <T>(v: unknown, map: (x: any) => T | null, max = 500): T[] =>
  (Array.isArray(v) ? v : []).slice(0, max).map(map).filter((x): x is T => x !== null);
const TONES: DocflowTone[] = ['slate', 'sky', 'emerald', 'amber', 'rose', 'violet'];
const SOURCES: CipherSource[] = ['contractorNo', 'ownerNo', 'vendorNo'];

/** Метки прежнего стандарта (`{docNo}_{rev}_{lang}`) → поля маски проекта. */
const LEGACY_TOKENS: Record<string, string> = {
  docNo: 'шифр', rev: 'ред', lang: 'язык', type: 'тип', seq: 'номер', po: 'заказ', contract: 'договор', wbs: 'установка', tag: 'тег', project: 'проект',
};
export function legacyMask(mask: string): string {
  return String(mask || '').replace(/\{([A-Za-z]+)\}/g, (all, name) => (LEGACY_TOKENS[name] ? `{${LEGACY_TOKENS[name]}}` : all));
}

/**
 * Приводит что угодно к полным настройкам: недостающие разделы — по
 * умолчанию, лишнее отбрасывается. Так читаются и настройки проекта, и
 * прежний глобальный стандарт, у которого нет статусов, масок папок и т. д.
 */
export function normalizeDocflowConfig(raw: any): DocflowConfig {
  const d = DEFAULT_DOCFLOW_CONFIG;
  const r = raw && typeof raw === 'object' ? raw : {};
  const statuses = list<DocflowStatus>(r.statuses, (s) => (s && text(s.code, 40).trim()
    ? { code: text(s.code, 40).trim(), label: text(s.label, 80) || text(s.code, 40), tone: TONES.includes(s.tone) ? s.tone : 'slate', issue: !!s.issue } : null), 50);
  const masks = r.masks && typeof r.masks === 'object' ? r.masks : {};
  // Прежний стандарт хранил маски строками в корне и в своих метках
  const fileMask = text(masks.file, 200) || (r.fileNameMask ? legacyMask(r.fileNameMask) : d.masks.file);
  const cipherMask = text(masks.cipher, 200) || (r.docNumberMask ? legacyMask(r.docNumberMask) : d.masks.cipher);
  const folders = r.folders && typeof r.folders === 'object' ? r.folders : {};
  const signers = r.signers && typeof r.signers === 'object' ? r.signers : {};
  const deadlines = r.deadlines && typeof r.deadlines === 'object' ? r.deadlines : {};
  return {
    statuses: statuses.length ? statuses : d.statuses.map((s) => ({ ...s })),
    reasons: Array.isArray(r.reasons) ? list<DocflowReason>(r.reasons, (x) => (x ? { code: text(x.code, 20), label: text(x.label, 200), revKind: x.revKind === 'digit' ? 'digit' : 'letter' } : null), 50) : d.reasons.map((x) => ({ ...x })),
    specialRevisions: { void: text(r.specialRevisions?.void, 4) || d.specialRevisions.void, superseded: text(r.specialRevisions?.superseded, 4) || d.specialRevisions.superseded },
    revisionRules: normalizeRevisionRules(r.revisionRules),
    reviewCodes: Array.isArray(r.reviewCodes) ? list<DocflowReviewCode>(r.reviewCodes, (x) => (x ? {
      code: text(x.code, 20), label: text(x.label, 200), action: x.action === 'accept' || x.action === 'info' ? x.action : 'revise',
      deadlineDays: Math.max(0, Math.min(3650, Number(x.deadlineDays) || 0)), ...(x.status ? { status: text(x.status, 40) } : {}),
    } : null), 50) : d.reviewCodes.map((x) => ({ ...x })),
    vdrTypes: Array.isArray(r.vdrTypes) ? list<DocflowDocType>(r.vdrTypes, (x) => (x ? {
      code: text(x.code, 20).trim(), titleRu: text(x.titleRu, 300), titleEn: text(x.titleEn, 300),
      stage: x.stage === 'П' || x.stage === 'Р' ? x.stage : '', template: text(x.template, 500),
    } : null), 2000) : d.vdrTypes.map((x) => ({ ...x })),
    masks: {
      file: fileMask, cipher: cipherMask,
      cipherSource: SOURCES.includes(masks.cipherSource) ? masks.cipherSource : d.masks.cipherSource,
      ignore: Array.isArray(masks.ignore) ? list<string>(masks.ignore, (x) => (text(x, 100).trim() || null), 50) : [...d.masks.ignore],
    },
    folders: {
      work: typeof folders.work === 'string' ? text(folders.work, 200) : d.folders.work,
      issue: typeof folders.issue === 'string' ? text(folders.issue, 200) : d.folders.issue,
      returns: typeof folders.returns === 'string' ? text(folders.returns, 200) : d.folders.returns,
      incoming: typeof folders.incoming === 'string' ? text(folders.incoming, 200) : d.folders.incoming,
    },
    equipmentClasses: normalizeClassMappings(r.equipmentClasses),
    kits: normalizeKits(r.kits),
    deadlines: {
      milestones: list(deadlines.milestones, (m: any) => (m && text(m.code, 40) ? { code: text(m.code, 40), label: text(m.label, 200), date: text(m.date, 30) } : null), 100),
      byType: list<DocflowDeadline>(deadlines.byType, (m: any) => (m && text(m.type, 20) ? { type: text(m.type, 20), from: text(m.from, 40), days: Math.max(0, Number(m.days) || 0), workdays: m.workdays !== false } : null), 500),
    },
    signers: { developed: text(signers.developed, 200), checked: text(signers.checked, 200), approved: text(signers.approved, 200), normControl: text(signers.normControl, 200) },
    columns: list(r.columns, (c: any) => (c && text(c.key, 80) ? { key: text(c.key, 80), title: text(c.title, 200) } : null), 200),
  };
}

/** Разделы настроек: их отмечают галочками при переносе из проекта в проект. */
export const DOCFLOW_SECTIONS: Array<{ key: string; label: string; fields: (keyof DocflowConfig)[] }> = [
  { key: 'statuses', label: 'Статусы', fields: ['statuses'] },
  { key: 'revisions', label: 'Ревизии и причины выпуска', fields: ['reasons', 'specialRevisions', 'revisionRules'] },
  { key: 'reviewCodes', label: 'Коды рассмотрения', fields: ['reviewCodes'] },
  { key: 'types', label: 'Типы документов', fields: ['vdrTypes'] },
  { key: 'masks', label: 'Маски', fields: ['masks'] },
  { key: 'folders', label: 'Папки', fields: ['folders'] },
  { key: 'equipmentClasses', label: 'Классы оборудования', fields: ['equipmentClasses'] },
  { key: 'kits', label: 'Комплекты', fields: ['kits'] },
  { key: 'deadlines', label: 'Сроки', fields: ['deadlines'] },
  { key: 'signers', label: 'Подписанты', fields: ['signers'] },
  { key: 'columns', label: 'Колонки ВДР', fields: ['columns'] },
];

/** Перенос выбранных разделов: остальное у проекта-получателя не трогается. */
export function mergeSections(target: DocflowConfig, source: DocflowConfig, sections: string[]): DocflowConfig {
  const next: any = JSON.parse(JSON.stringify(target));
  for (const section of DOCFLOW_SECTIONS) {
    if (!sections.includes(section.key)) continue;
    for (const field of section.fields) next[field] = JSON.parse(JSON.stringify(source[field]));
  }
  return normalizeDocflowConfig(next);
}

const keyed = (value: unknown, byType = false): Map<string, string> | null => {
  if (!Array.isArray(value)) return null;
  const map = new Map<string, string>();
  value.forEach((row: any, i) => map.set(String(byType ? row?.type ?? i : row?.code ?? row?.key ?? row?.classId ?? row?.type ?? i), JSON.stringify(row)));
  return map;
};

/**
 * Что изменится в каждом разделе: «добавится E05», «изменится C32», «маска
 * имени: {шифр}_{ред} → {шифр}-{ред}». Пустой список строк — раздел совпадает.
 */
export function diffSections(before: DocflowConfig, after: DocflowConfig, sections = DOCFLOW_SECTIONS.map((s) => s.key)): Array<{ key: string; label: string; lines: string[] }> {
  const out: Array<{ key: string; label: string; lines: string[] }> = [];
  for (const section of DOCFLOW_SECTIONS) {
    if (!sections.includes(section.key)) continue;
    const lines: string[] = [];
    for (const field of section.fields) {
      const a = (before as any)[field];
      const b = (after as any)[field];
      const ka = keyed(a, field === 'equipmentClasses');
      const kb = keyed(b, field === 'equipmentClasses');
      if (ka && kb) {
        for (const [k, v] of kb) if (!ka.has(k)) lines.push(`добавится ${k}`); else if (ka.get(k) !== v) lines.push(`изменится ${k}`);
        for (const k of ka.keys()) if (!kb.has(k)) lines.push(`уберётся ${k}`);
        if (!lines.length && JSON.stringify(a) !== JSON.stringify(b)) lines.push('изменится порядок');
      } else if (a && b && typeof a === 'object') {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
          const x = JSON.stringify(a[k] ?? '');
          const y = JSON.stringify(b[k] ?? '');
          if (x !== y) lines.push(`${k}: ${String(a[k] ?? '—') || '—'} → ${String(b[k] ?? '—') || '—'}`);
        }
      }
    }
    out.push({ key: section.key, label: section.label, lines });
  }
  return out;
}
