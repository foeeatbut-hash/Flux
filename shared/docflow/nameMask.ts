/**
 * Проверка имени файла по маске проекта (docs/docflow-program.md, 4.2).
 *
 * Один модуль для Проводника и ДО: и меню «Документооборот ▸», и «Назначить
 * файл…», и «Сверка с папкой», и сервер, который принимает связь, спрашивают
 * одно и то же. Две проверки, которые разошлись бы на одном имени, дали бы
 * связь, которую одна сторона считает правильной, а другая — нет.
 *
 * Маска — текст с полями в фигурных скобках: `{шифр}_{ред}`. Поле `{шифр}`
 * раскрывается маской шифра (`{заказ}-{установка}-{тип}-{номер}`), поэтому имя
 * «3700-B01-E02-001_B.pdf» читается до отдельных полей.
 */
import type { DocflowConfig } from './config';

export const MASK_FIELDS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'шифр', label: 'Шифр', hint: 'шифр документа целиком (по маске шифра)' },
  { key: 'проект', label: 'Проект', hint: 'код проекта' },
  { key: 'договор', label: 'Договор', hint: 'номер договора' },
  { key: 'заказ', label: 'Заказ', hint: 'номер заказа' },
  { key: 'установка', label: 'Установка', hint: 'установка / титул' },
  { key: 'тип', label: 'Тип', hint: 'код типа документа (E02)' },
  { key: 'номер', label: 'Номер', hint: 'порядковый номер' },
  { key: 'ред', label: 'Ревизия', hint: 'A, B, C… или 0, 1, 2…' },
  { key: 'тег', label: 'Тег', hint: 'тег оборудования' },
  { key: 'язык', label: 'Язык', hint: 'RU, EN' },
];
const KNOWN = new Set(MASK_FIELDS.map((f) => f.key));
const labelOf = (key: string) => MASK_FIELDS.find((f) => f.key === key)?.label || key;

type Part = { field: string } | { literal: string };

/** Маска → части. Неизвестное поле — ошибка маски, а не тихий литерал. */
export function maskParts(mask: string): Part[] {
  const parts: Part[] = [];
  const re = /\{([^{}]+)\}/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(mask))) {
    if (m.index > at) parts.push({ literal: mask.slice(at, m.index) });
    parts.push({ field: m[1].trim().toLowerCase() });
    at = m.index + m[0].length;
  }
  if (at < mask.length) parts.push({ literal: mask.slice(at) });
  return parts;
}

/** Ошибки самой маски: показываются в конструкторе до сохранения. */
export function maskErrors(mask: string, kind: 'file' | 'cipher' | 'folder' = 'file'): string[] {
  const errors: string[] = [];
  if (kind !== 'folder' && !String(mask || '').trim()) return ['Маска пуста'];
  if (/[{}]/.test(String(mask).replace(/\{[^{}]+\}/g, ''))) errors.push('Незакрытая фигурная скобка');
  const parts = maskParts(mask);
  for (const p of parts) if ('field' in p && !KNOWN.has(p.field)) errors.push(`Неизвестное поле «${p.field}»`);
  if (kind === 'cipher' && parts.some((p) => 'field' in p && (p.field === 'шифр' || p.field === 'ред'))) errors.push('Шифр не может содержать шифр или ревизию');
  for (let i = 1; i < parts.length; i++) {
    if ('field' in parts[i] && 'field' in parts[i - 1]) errors.push(`Между полями «${(parts[i - 1] as any).field}» и «${(parts[i] as any).field}» нужен разделитель`);
  }
  if (kind !== 'folder') {
    const seen = new Set<string>();
    for (const p of parts) if ('field' in p) { if (seen.has(p.field)) errors.push(`Поле «${p.field}» встречается дважды`); seen.add(p.field); }
  }
  return errors;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Маска файла с раскрытым `{шифр}`: части и где начинается/кончается шифр. */
function expanded(config: Pick<DocflowConfig, 'masks'>): Part[] {
  const out: Part[] = [];
  for (const p of maskParts(config.masks.file)) {
    if ('field' in p && p.field === 'шифр' && config.masks.cipher.trim()) {
      out.push({ literal: '\u0001' });
      out.push(...maskParts(config.masks.cipher));
      out.push({ literal: '\u0002' });
    } else out.push(p);
  }
  return out;
}

function regexOf(parts: Part[]): RegExp {
  let src = '';
  parts.forEach((p, i) => {
    if ('literal' in p) {
      if (p.literal === '\u0001') src += '(?<шифр>';
      else if (p.literal === '\u0002') src += ')';
      else src += escape(p.literal);
      return;
    }
    // Поле кончается на первом знаке следующего разделителя: иначе «3700-B01»
    // прочиталось бы одним полем. Последнее поле берёт остаток целиком — тег
    // «П-2» в конце имени содержит дефис и должен читаться весь
    const next = parts.slice(i + 1).find((x): x is { literal: string } => 'literal' in x && !/^[\u0001\u0002]$/.test(x.literal));
    const stop = next ? escape(next.literal[0]) : '';
    src += `(?<${p.field}>${stop ? `[^${stop}]+` : '.+'})`;
  });
  return new RegExp(`^${src}$`, 'iu');
}

export interface ParsedName { ok: boolean; base: string; ext: string; fields: Record<string, string>; problems: string[] }

export function splitExt(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: '' };
}

/** Имя файла → поля. Не сходится — подсказка, чего не хватает: «нет ревизии». */
export function parseFileName(config: Pick<DocflowConfig, 'masks' | 'vdrTypes'>, name: string): ParsedName {
  const { base, ext } = splitExt(String(name || '').trim());
  const parts = expanded(config);
  if (parts.some((p) => 'field' in p && !KNOWN.has(p.field))) return { ok: false, base, ext, fields: {}, problems: ['Маска имени проекта с ошибкой'] };
  const m = regexOf(parts).exec(base);
  if (m?.groups) {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.groups)) if (v !== undefined) fields[k] = v;
    const problems: string[] = [];
    if (fields['тип'] && config.vdrTypes.length && !config.vdrTypes.some((t) => same(t.code, fields['тип']))) problems.push(`неизвестный тип «${fields['тип']}»`);
    return { ok: true, base, ext, fields, problems };
  }
  // Подсказка: пробуем маску без одного поля (и разделителя перед ним) — если
  // так сходится, именно этого поля в имени и нет
  const problems: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!('field' in p)) continue;
    const without = parts.filter((_, j) => j !== i && !(j === i - 1 && 'literal' in parts[j] && !/[\u0001\u0002]/.test((parts[j] as any).literal)));
    if (regexOf(without).test(base)) problems.push(`нет поля «${labelOf(p.field)}»`);
  }
  if (!problems.length) problems.push(`имя не читается по маске «${config.masks.file}»`);
  return { ok: false, base, ext, fields: {}, problems };
}

const norm = (s: string) => String(s || '').trim().toUpperCase().replace(/[АВЕКМНОРСТХ]/g, (c) => 'ABEKMHOPCTX'['АВЕКМНОРСТХ'.indexOf(c)]);
export const same = (a: string, b: string) => norm(a) === norm(b);

/** Ревизия по схеме проекта: буквы A, B… для причин «на рассмотрение», цифры для окончательных, плюс особые. */
export function revisionValid(config: Pick<DocflowConfig, 'reasons' | 'specialRevisions'>, rev: string): boolean {
  const r = norm(rev);
  if (!r) return false;
  if (r === norm(config.specialRevisions.void) || r === norm(config.specialRevisions.superseded)) return true;
  const kinds = new Set(config.reasons.map((x) => x.revKind));
  if (!kinds.size) kinds.add('letter').add('digit');
  return (kinds.has('letter') && /^[A-Z]{1,2}$/.test(r)) || (kinds.has('digit') && /^\d{1,3}$/.test(r));
}

export interface RowForCheck {
  contractorNo?: string; ownerNo?: string; vendorNo?: string; vdrCode?: string; revision?: string; language?: string;
  tags?: string[]; projectCode?: string; poNumber?: string;
}
export type CheckState = 'match' | 'mismatch' | 'missing' | 'unknown' | 'new';
export interface FieldCheck { field: string; label: string; state: CheckState; inName: string; inRow: string; blocking: boolean; text: string }
export interface NameCheck { ok: boolean; parsed: ParsedName; fields: FieldCheck[]; blocking: FieldCheck[]; warnings: FieldCheck[]; revision: string; isNewRevision: boolean }

/**
 * Сверка имени со строкой ВДР. Блокируют связь: имя не по маске, другой шифр,
 * другой тип, ревизия не по схеме. Остальное — предупреждения.
 */
export function checkName(config: DocflowConfig, name: string, row: RowForCheck): NameCheck {
  const parsed = parseFileName(config, name);
  const fields: FieldCheck[] = [];
  const add = (field: string, state: CheckState, inName: string, inRow: string, blocking: boolean, text: string) =>
    fields.push({ field, label: labelOf(field), state, inName, inRow, blocking, text });
  if (!parsed.ok) {
    for (const p of parsed.problems) add('имя', 'unknown', parsed.base, '', true, p);
    return finish(parsed, fields, '', false);
  }
  const f = parsed.fields;
  const rowCipher = String(row[config.masks.cipherSource] || '');
  let cipher = f['шифр'];
  if (cipher === undefined && maskParts(config.masks.cipher).every((p) => !('field' in p) || f[p.field] !== undefined)) {
    cipher = buildFromMask(config.masks.cipher, f);
  }
  if (cipher !== undefined) {
    if (!rowCipher) add('шифр', 'missing', cipher, '', false, 'у строки нет шифра');
    else if (same(cipher, rowCipher)) add('шифр', 'match', cipher, rowCipher, false, 'шифр совпал');
    else add('шифр', 'mismatch', cipher, rowCipher, true, `в имени шифр ${cipher}, в строке ${rowCipher}`);
  }
  if (f['тип'] !== undefined) {
    const known = !config.vdrTypes.length || config.vdrTypes.some((t) => same(t.code, f['тип']));
    if (row.vdrCode && !same(f['тип'], row.vdrCode)) add('тип', 'mismatch', f['тип'], row.vdrCode, true, `в имени тип ${f['тип']}, в строке ${row.vdrCode}`);
    else if (!known) add('тип', 'unknown', f['тип'], row.vdrCode || '', false, `неизвестный тип «${f['тип']}»`);
    else add('тип', 'match', f['тип'], row.vdrCode || '', false, 'тип совпал');
  }
  let revision = '';
  let isNew = false;
  if (f['ред'] !== undefined) {
    revision = f['ред'].toUpperCase();
    if (!revisionValid(config, revision)) add('ред', 'unknown', revision, row.revision || '', true, `ревизия «${revision}» не по схеме проекта`);
    else if (row.revision && same(revision, row.revision)) add('ред', 'match', revision, row.revision, false, 'ревизия совпала');
    else { isNew = true; add('ред', 'new', revision, row.revision || '', false, `ревизия ${revision} — новая для строки (сейчас ${row.revision || '—'})`); }
  } else add('ред', 'missing', '', row.revision || '', false, 'в маске нет ревизии');
  const soft = (field: string, inRow: string | undefined, label: string) => {
    if (f[field] === undefined) return;
    if (!inRow) add(field, 'missing', f[field], '', false, `у строки нет поля «${label}»`);
    else if (same(f[field], inRow)) add(field, 'match', f[field], inRow, false, `${label}: совпало`);
    else add(field, 'mismatch', f[field], inRow, false, `в имени ${label.toLowerCase()} ${f[field]}, в строке ${inRow}`);
  };
  soft('язык', row.language, 'Язык');
  soft('проект', row.projectCode, 'Проект');
  // Заказ внутри шифра уже сверен вместе с шифром целиком
  if (f['шифр'] === undefined) soft('заказ', row.poNumber, 'Заказ');
  if (f['тег'] !== undefined) {
    const tags = row.tags || [];
    if (!tags.length) add('тег', 'missing', f['тег'], '', false, 'у строки нет тегов');
    else if (tags.some((t) => same(t, f['тег']))) add('тег', 'match', f['тег'], tags.join(', '), false, 'тег совпал');
    else add('тег', 'mismatch', f['тег'], tags.join(', '), false, `тега ${f['тег']} нет у строки`);
  }
  return finish(parsed, fields, revision, isNew);
}

function finish(parsed: ParsedName, fields: FieldCheck[], revision: string, isNewRevision: boolean): NameCheck {
  const blocking = fields.filter((x) => x.blocking);
  const warnings = fields.filter((x) => !x.blocking && x.state !== 'match' && x.state !== 'new');
  return { ok: parsed.ok && !blocking.length, parsed, fields, blocking, warnings, revision, isNewRevision };
}

function buildFromMask(mask: string, values: Record<string, string>): string {
  return maskParts(mask).map((p) => ('literal' in p ? p.literal : values[p.field] ?? '')).join('');
}

/** Поля строки, из которых собирается имя: шифр раскладывается обратно маской шифра. */
export function rowFields(config: DocflowConfig, row: RowForCheck, revision?: string): Record<string, string> {
  const cipher = String(row[config.masks.cipherSource] || '');
  const values: Record<string, string> = { шифр: cipher, тип: row.vdrCode || '', ред: revision || row.revision || '', язык: row.language || '', тег: row.tags?.[0] || '', проект: row.projectCode || '', заказ: row.poNumber || '' };
  const parts = maskParts(config.masks.cipher);
  if (cipher && parts.length) {
    const m = regexOf(parts).exec(cipher);
    if (m?.groups) for (const [k, v] of Object.entries(m.groups)) if (v !== undefined && !values[k]) values[k] = v;
  }
  return values;
}

/** Правильное имя файла для строки: «Переименовать в {правильное имя}». Пусто — собрать нельзя. */
export function buildFileName(config: DocflowConfig, row: RowForCheck, ext: string, revision?: string): string {
  const values = rowFields(config, row, revision);
  const parts = maskParts(config.masks.file);
  if (parts.some((p) => 'field' in p && !values[p.field])) return '';
  const base = buildFromMask(config.masks.file, values).replace(/[\\/:*?"<>|]/g, '_').trim();
  return base ? `${base}${ext}` : '';
}

/** Путь папки внутри назначенной папки по маске структуры: `{тип}/{шифр}/{ред}` → «E02/3700-…/B». */
export function folderPath(mask: string, values: Record<string, string>): string {
  if (!String(mask || '').trim()) return '';
  return buildFromMask(mask, values).split(/[\\/]+/).map((s) => s.trim().replace(/[:*?"<>|]/g, '_')).filter(Boolean).join('/');
}

/** Служебный файл по правилам «Не документ»: `*.bak`, `~$*`. */
export function isIgnored(config: Pick<DocflowConfig, 'masks'>, name: string): boolean {
  return config.masks.ignore.some((rule) => {
    const re = new RegExp(`^${rule.split('*').map(escape).join('.*')}$`, 'i');
    return re.test(name);
  });
}

/**
 * Подпапка внутри назначенной папки проекта по маске структуры (раздел 5):
 * куда ДО кладёт файл ревизии (`work`) или файл возврата (`returns`).
 */
export function placementFolder(config: DocflowConfig, kind: keyof DocflowConfig['folders'], row: RowForCheck, revision?: string): string {
  return folderPath(config.folders[kind], rowFields(config, row, revision));
}
