/**
 * Выражения полей бланка: `{путь|фильтр:аргумент}` среди обычного текста.
 *
 * Язык намеренно маленький: пути к данным и десяток фильтров. Формулы Excel в
 * бланке не нужны — бланк не считает, а показывает, и всё, что нужно
 * посчитать (номер строки б/з, теги привода, сумма по листу), считается при
 * сборке данных. Зато выражение читается глазами и не ломается от вставки
 * строки, как ссылка `=A11` в бланках E06.
 */
import type { Text2 } from '../model';
import type { BlankLang } from './model';

export type Scope = Record<string, unknown>;

function isText2(v: unknown): v is Text2 {
  return !!v && typeof v === 'object' && 'ru' in (v as any) && typeof (v as any).ru === 'string';
}

/** Значение в нужном языке. RU+EN — через « / », как на титулах E06 */
export function inLang(v: unknown, lang: BlankLang): unknown {
  if (isText2(v)) {
    if (lang === 'en') return v.en || v.ru;
    if (lang === 'ru+en') return v.en && v.en !== v.ru ? `${v.ru} / ${v.en}` : v.ru;
    return v.ru;
  }
  return v;
}

export function lookup(path: string, scopes: Scope[]): unknown {
  const parts = path.split('.');
  for (const scope of scopes) {
    let cur: unknown = scope;
    let ok = true;
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in (cur as any)) cur = (cur as any)[p];
      else { ok = false; break; }
    }
    if (ok) return cur;
  }
  return undefined;
}

function fmtDate(v: unknown): string {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function toText(v: unknown, lang: BlankLang): string {
  const x = inLang(v, lang);
  if (x === undefined || x === null) return '';
  if (Array.isArray(x)) return x.map((y) => toText(y, lang)).filter(Boolean).join(', ');
  if (typeof x === 'number') return Number.isInteger(x) ? String(x) : String(Math.round(x * 1000) / 1000).replace('.', ',');
  if (typeof x === 'boolean') return x ? (lang === 'en' ? 'yes' : 'да') : (lang === 'en' ? 'no' : 'нет');
  if (typeof x === 'object') return '';
  return String(x);
}

/** Фильтры. Аргумент — после двоеточия, до следующей «|» */
const FILTERS: Record<string, (v: unknown, arg: string, lang: BlankLang) => unknown> = {
  join: (v, arg, lang) => (Array.isArray(v) ? v.map((x) => toText(x, lang)).filter(Boolean).join(arg === '' ? ', ' : arg.replace(/\\n/g, '\n')) : v),
  lines: (v, _a, lang) => (Array.isArray(v) ? v.map((x) => toText(x, lang)).filter(Boolean).join('\n') : v),
  default: (v, arg, lang) => (toText(v, lang) === '' ? arg : v),
  upper: (v, _a, lang) => toText(v, lang).toUpperCase(),
  lower: (v, _a, lang) => toText(v, lang).toLowerCase(),
  date: (v) => fmtDate(v),
  count: (v) => (Array.isArray(v) ? v.length : v ? 1 : 0),
  first: (v) => (Array.isArray(v) ? v[0] : v),
  ru: (v) => (isText2(v) ? v.ru : v),
  en: (v) => (isText2(v) ? v.en || v.ru : v),
  /** «да/нет» по-своему: `{item.heating|yesno:есть/нет}` */
  yesno: (v, arg) => { const [y, n] = (arg || 'да/нет').split('/'); return v ? y : n ?? ''; },
  /** Префикс, только если значение есть: `{group.exec|prefix:-}` */
  prefix: (v, arg, lang) => (toText(v, lang) ? arg + toText(v, lang) : ''),
  suffix: (v, arg, lang) => (toText(v, lang) ? toText(v, lang) + arg : ''),
};

export const FILTER_NAMES = Object.keys(FILTERS);

const FIELD = /\{([^{}]+)\}/g;

/**
 * Подставить поля. Выражение из одного поля отдаёт значение как есть (число
 * остаётся числом — в Excel оно ляжет числом, а не текстом).
 */
export function evalExpr(expr: string | undefined, scopes: Scope[], lang: BlankLang): string | number {
  let src = String(expr ?? '');
  // Поля подставляются изнутри наружу: `{orderLine|default:{n}}` сначала
  // получает номер строки, потом уже решает, нужен ли он
  for (let pass = 0; pass < 4; pass++) {
    if (!src.includes('{')) return src;
    const single = /^\{([^{}]+)\}$/.exec(src.trim());
    if (single) {
      const v = evalField(single[1], scopes, lang);
      const x = inLang(v, lang);
      return typeof x === 'number' ? x : toText(v, lang);
    }
    const next = src.replace(FIELD, (_m, body: string) => toText(evalField(body, scopes, lang), lang));
    if (next === src) return src;
    src = next;
  }
  return src;
}

function evalField(body: string, scopes: Scope[], lang: BlankLang): unknown {
  const [head, ...filters] = splitPipes(body);
  let v: unknown = lookup(head.trim(), scopes);
  for (const f of filters) {
    const at = f.indexOf(':');
    const name = (at < 0 ? f : f.slice(0, at)).trim();
    const arg = at < 0 ? '' : f.slice(at + 1);
    const fn = FILTERS[name];
    if (fn) v = fn(v, arg, lang);
  }
  return v;
}

/** «|» внутри аргумента join пишется как «\|» */
function splitPipes(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { out.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  out.push(cur);
  return out;
}

/** Поля, на которые ссылается выражение, — для подсказки «чего не хватает» */
export function fieldsOf(expr: string | undefined): string[] {
  const out: string[] = [];
  for (const m of String(expr ?? '').matchAll(FIELD)) out.push(splitPipes(m[1])[0].trim());
  return out;
}

export function textIn(t: Text2 | undefined, lang: BlankLang): string {
  return toText(t, lang);
}
