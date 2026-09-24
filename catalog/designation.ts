/**
 * Строка обозначения клапана: сборка из параметров и разбор обратно.
 *
 * Сборка и разбор описаны одними и теми же позициями семейства (model.ts), и
 * это главное свойство модуля: что собрано — то и разбирается, и наоборот.
 * Проверяется кругом в scripts/test-valve-designation.ts на обозначениях из
 * настоящих бланков.
 *
 * Разбор перебором с возвратом, а не регулярным выражением «на всю строку»:
 * коды содержат дефис (`МН220-Т`, `SM24-S2-V`, сама серия `КПУ-1Н`), и то, где
 * кончается позиция, выясняется только тогда, когда следующая позиция
 * разобралась или нет.
 */
import {
  type Family, type Position, type ValveValues, type ParamDef, paramOf, withDefaults, num, formatKey,
} from './model';
import { foldCode, stripDecor } from './text';

// ── Шаблон позиции ──────────────────────────────────────────────────────────

type Token = { lit: string } | { param: string } | { sep: true };

const tokenCache = new Map<string, Token[]>();

/** `{W}{x}{H}` → [W, ×, H]. `{x}` — знак размера, он при выводе настраивается */
export function tokensOf(format: string): Token[] {
  const hit = tokenCache.get(format);
  if (hit) return hit;
  const out: Token[] = [];
  const re = /\{([A-Za-z0-9_]+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(format))) {
    if (m.index > last) out.push({ lit: format.slice(last, m.index) });
    out.push(m[1] === 'x' ? { sep: true } : { param: m[1] });
    last = m.index + m[0].length;
  }
  if (last < format.length) out.push({ lit: format.slice(last) });
  tokenCache.set(format, out);
  return out;
}

export function paramsOfFormat(format: string): string[] {
  return tokensOf(format).flatMap((t) => ('param' in t ? [t.param] : []));
}

// ── Сборка ──────────────────────────────────────────────────────────────────

export interface BuildOptions {
  /** Знак размера: `*` как в каталоге или `х` как в бланках */
  sizeSep?: string;
}

function hasValue(p: ParamDef | undefined, key: string, values: ValveValues): boolean {
  const v = values[key];
  if (v === undefined || v === null) {
    // Пустой код — законное значение: «без взрывозащиты» пишется ничем
    return !!p?.values?.some((x) => x.code === '');
  }
  if (p?.kind === 'number' || p?.size) return num(v) > 0;
  if (v === '') return !!p?.values?.some((x) => x.code === '');
  return true;
}

function renderFormat(f: Family, format: string, values: ValveValues, sizeSep: string): string {
  let out = '';
  for (const tok of tokensOf(format)) {
    if ('lit' in tok) out += tok.lit;
    else if ('sep' in tok) out += sizeSep;
    else {
      const p = paramOf(f, tok.param);
      const v = values[tok.param];
      out += p?.kind === 'number' || p?.size ? String(num(v)) : String(v ?? '');
    }
  }
  return out;
}

export interface BuildResult {
  text: string;
  /** Позиции, которые собрать не из чего: не хватает параметра */
  missing: Array<{ position: string; params: string[] }>;
  /** Где в строке какая позиция — для подсветки в мастере */
  spans: Array<{ position: string; from: number; to: number }>;
}

export function buildDesignation(f: Family, rawValues: ValveValues, opts: BuildOptions = {}): BuildResult {
  const values = withDefaults(f, rawValues);
  const sizeSep = opts.sizeSep ?? f.sizeSep ?? '*';
  const parts: string[] = [];
  const missing: BuildResult['missing'] = [];
  const spans: BuildResult['spans'] = [];
  let at = 0;
  for (const pos of f.positions) {
    const buildable = (fmt: string) => paramsOfFormat(fmt).every((k) => hasValue(paramOf(f, k), k, values));
    const remembered = pos.rememberFormat ? pos.formats[Number(values[formatKey(pos.key)])] : undefined;
    const format = remembered && buildable(remembered) ? remembered : pos.formats.find(buildable);
    if (!format) {
      if (pos.optional) continue;
      const need = paramsOfFormat(pos.formats[0]).filter((k) => !hasValue(paramOf(f, k), k, values));
      missing.push({ position: pos.key, params: need });
      parts.push('?');
      spans.push({ position: pos.key, from: at, to: at + 1 });
      at += 2;
      continue;
    }
    const piece = renderFormat(f, format, values, sizeSep);
    parts.push(piece);
    spans.push({ position: pos.key, from: at, to: at + piece.length });
    at += piece.length + 1;
  }
  return { text: parts.join('-'), missing, spans };
}

// ── Разбор ──────────────────────────────────────────────────────────────────

export interface ParseResult {
  familyId: string;
  values: ValveValues;
  /** Разобрано полностью */
  complete: boolean;
  /** Сколько позиций разобрано (для частичного) */
  positionsMatched: number;
  /** Неразобранный хвост строки */
  rest: string;
  /** На какой позиции разбор встал */
  stuckAt?: string;
}

interface Ctx {
  f: Family;
  s: string;
  budget: number;
  best: { pi: number; off: number; values: ValveValues };
}

/** Коды выбора, приведённые к ключу, — длинные первыми */
const choiceCache = new WeakMap<ParamDef, Array<{ code: string; key: string }>>();
function choicesOf(p: ParamDef): Array<{ code: string; key: string }> {
  let hit = choiceCache.get(p);
  if (!hit) {
    hit = (p.values || [])
      .map((v) => ({ code: v.code, key: foldCode(v.code) }))
      .sort((a, b) => b.key.length - a.key.length);
    choiceCache.set(p, hit);
  }
  return hit;
}

function* matchTokens(ctx: Ctx, tokens: Token[], ti: number, off: number, values: ValveValues): Generator<[number, ValveValues]> {
  if (--ctx.budget < 0) return;
  if (ti === tokens.length) { yield [off, values]; return; }
  const tok = tokens[ti];
  const s = ctx.s;
  if ('lit' in tok) {
    const lit = foldCode(tok.lit);
    if (s.startsWith(lit, off)) yield* matchTokens(ctx, tokens, ti + 1, off + lit.length, values);
    return;
  }
  if ('sep' in tok) {
    if (s[off] === '*') yield* matchTokens(ctx, tokens, ti + 1, off + 1, values);
    return;
  }
  const p = paramOf(ctx.f, tok.param);
  if (!p) return;
  if (p.kind === 'number' || p.size) {
    const m = /^\d+(?:[.,]\d+)?/.exec(s.slice(off));
    // Нулевое число — не размер и не диаметр: «1*000» — это код «без вылета»,
    // и если прочитать его как переходник диаметром 0, код потеряется
    if (m && parseFloat(m[0].replace(',', '.')) > 0) {
      yield* matchTokens(ctx, tokens, ti + 1, off + m[0].length, { ...values, [tok.param]: parseFloat(m[0].replace(',', '.')) });
    }
    return;
  }
  if (p.kind === 'text') {
    const m = /^[^-_]+/.exec(s.slice(off));
    if (m) yield* matchTokens(ctx, tokens, ti + 1, off + m[0].length, { ...values, [tok.param]: m[0] });
    return;
  }
  for (const c of choicesOf(p)) {
    if (s.startsWith(c.key, off)) {
      yield* matchTokens(ctx, tokens, ti + 1, off + c.key.length, { ...values, [tok.param]: c.code });
    }
  }
}

function* matchPositions(ctx: Ctx, pi: number, off: number, values: ValveValues): Generator<ValveValues> {
  if (--ctx.budget < 0) return;
  if (pi > ctx.best.pi || (pi === ctx.best.pi && off > ctx.best.off)) ctx.best = { pi, off, values };
  const positions = ctx.f.positions;
  if (pi === positions.length) {
    if (off === ctx.s.length) yield values;
    return;
  }
  const pos: Position = positions[pi];
  let start = off;
  if (pi > 0) {
    if (ctx.s[off] !== '-') {
      if (pos.optional) yield* matchPositions(ctx, pi + 1, off, values);
      return;
    }
    start = off + 1;
  }
  for (let fi = 0; fi < pos.formats.length; fi++) {
    for (const [end, v2] of matchTokens(ctx, tokensOf(pos.formats[fi]), 0, start, values)) {
      // Позиция кончается на дефисе или на конце строки — иначе «МН220» съел бы
      // начало «МН220-Т» и оставил разбор на полуслове
      if (end !== ctx.s.length && ctx.s[end] !== '-') continue;
      yield* matchPositions(ctx, pi + 1, end, pos.rememberFormat ? { ...v2, [formatKey(pos.key)]: fi } : v2);
    }
  }
  if (pos.optional) yield* matchPositions(ctx, pi + 1, off, values);
}

/** Разобрать строку по одному семейству */
export function parseWithFamily(f: Family, text: string): ParseResult {
  const s = foldCode(stripDecor(text));
  const ctx: Ctx = { f, s, budget: 60000, best: { pi: 0, off: 0, values: {} } };
  for (const values of matchPositions(ctx, 0, 0, {})) {
    return { familyId: f.id, values, complete: true, positionsMatched: f.positions.length, rest: '' };
  }
  const b = ctx.best;
  return {
    familyId: f.id,
    values: b.values,
    complete: false,
    positionsMatched: b.pi,
    rest: s.slice(b.off),
    stuckAt: f.positions[b.pi]?.key,
  };
}

/**
 * Разобрать строку по всему справочнику.
 *
 * Возвращает все семейства, разобравшие строку полностью, — у КПУ-2Н и
 * КПУ-2Н МЕТРО, например, одна серия, и различает их только код привода. Если
 * полностью не разобрало ни одно, — лучший частичный разбор: человеку важно
 * увидеть, на какой позиции строка перестала сходиться, а не «не распознано».
 */
export function parseDesignation(families: Family[], text: string): ParseResult[] {
  const s = foldCode(stripDecor(text));
  if (!s) return [];
  const candidates = families.filter((f) => {
    const series = f.positions[0]?.formats.map((fmt) => foldCode(fmt.replace(/\{[^}]+\}/g, ''))) || [];
    return series.some((code) => code && s.startsWith(code)) ||
      (f.aliases || []).some((a) => s.startsWith(foldCode(a)));
  });
  const results = candidates.map((f) => parseWithFamily(f, text));
  const full = results.filter((r) => r.complete);
  if (full.length) return full;
  return results.sort((a, b) => b.positionsMatched - a.positionsMatched).slice(0, 1);
}

/** Одинаковы ли два обозначения с точностью до оформления */
export function sameDesignation(a: string, b: string): boolean {
  return foldCode(stripDecor(a)) === foldCode(stripDecor(b));
}
