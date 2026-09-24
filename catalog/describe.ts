/**
 * Разбор произвольного описания в признаки.
 *
 * Описание приходит откуда угодно: строка MTO на двух языках, письмо, ТЗ,
 * строка чужой спецификации. Разбор не пытается «понять текст» — он ищет
 * известные приметы по словарю класса и записывает, где именно в тексте каждая
 * нашлась. Позиция нужна не для красоты: инженер видит подсвеченным, на что
 * программа опиралась, и может снять неверную примету одним щелчком.
 *
 * Словарь примет у каждого класса свой (catalog/valve/detect.ts); общими здесь
 * остаются только размер, тег и код продукции — они одинаковы для любого
 * оборудования.
 */
import type { Facts, FactValue } from './model';
import { foldText } from './text';

/** Найденная примета: какой признак, какое значение, где в тексте */
export interface Hit {
  key: string;
  value: FactValue;
  from: number;
  to: number;
  text: string;
  /** Примета снята человеком — в подборе не участвует */
  off?: boolean;
}

/**
 * Примета словаря класса. `re` ищется по приведённому тексту (foldText), поэтому
 * пишется в нижнем регистре. Чем выше `priority`, тем раньше примета занимает
 * свой кусок текста: «without spring return» должно сработать раньше, чем
 * «spring return», иначе реверсивный привод прочитается как пружинный.
 */
export interface Detector {
  key: string;
  re: RegExp;
  value: FactValue | ((m: RegExpExecArray) => FactValue);
  priority?: number;
}

export interface SizeHit {
  W?: number;
  H?: number;
  D?: number;
  from: number;
  to: number;
  text: string;
}

export interface Description {
  text: string;
  facts: Facts;
  hits: Hit[];
  size?: SizeHit;
  /** Все размеры, если их в тексте несколько (взяли первый) */
  sizes: SizeHit[];
  /** Коды типа из тегов: DF, DN… */
  tagTypes: string[];
  tags: string[];
  productCode?: string;
  /** Примета противоречит другой: «normally open» и «normally closed» в одном тексте */
  conflicts: Array<{ key: string; values: FactValue[] }>;
}

// ── Размер ──────────────────────────────────────────────────────────────────

const X = '\\s*[xх×*]\\s*';
const N = '(\\d{2,5})';
const H_MARK = '\\s*\\(\\s*[hн]\\s*\\)';

/**
 * Размер в любой записи из встреченных в MTO и бланках:
 *   900x400(h) — ширина × высота, высота помечена;
 *   200(h)x300 — высота первой;
 *   700x600    — без пометки: ширина × высота, как в обозначении КПУ (A×B);
 *   Ø900, ⌀900, D=900, DN900, диаметр 900 — круглый.
 * Запись «1100 (h) x1600» с пробелами — та же.
 */
const SIZE_RES: Array<{ re: RegExp; take: (m: RegExpExecArray) => Partial<SizeHit> }> = [
  { re: new RegExp(`${N}${H_MARK}${X}${N}`, 'gi'), take: (m) => ({ H: +m[1], W: +m[2] }) },
  { re: new RegExp(`${N}${X}${N}${H_MARK}`, 'gi'), take: (m) => ({ W: +m[1], H: +m[2] }) },
  { re: new RegExp(`(?:^|[^\\d.,])${N}${X}${N}(?![\\d(])`, 'gi'), take: (m) => ({ W: +m[1], H: +m[2] }) },
  { re: /(?:[øØ⌀]|\bdn|\bd\s*=|диаметр(?:ом)?|diameter)\s*[:=-]?\s*(\d{2,5})/gi, take: (m) => ({ D: +m[1] }) },
];

export function findSizes(text: string): SizeHit[] {
  const out: SizeHit[] = [];
  const taken: Array<[number, number]> = [];
  for (const { re, take } of SIZE_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      // У третьего шаблона в совпадение попадает символ перед числом —
      // отрезаем его, чтобы подсветка начиналась с цифры
      const lead = m[0].search(/\d|[øØ⌀]|dn|d\s*=|диам|diam/i);
      const from = m.index + Math.max(0, lead);
      const to = m.index + m[0].length;
      if (taken.some(([a, b]) => from < b && to > a)) continue;
      taken.push([from, to]);
      out.push({ ...take(m), from, to, text: text.slice(from, to) });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

// ── Теги и код продукции ────────────────────────────────────────────────────

/**
 * Тег оборудования: несколько групп через дефис, последняя — номер.
 * `3700-B01-DF-001`, `3700-B01-DN-001A`. Код типа — буквенная группа перед
 * номером (DF), по нему класс узнаёт, что это за изделие.
 */
export const TAG_RE = /\b[A-ZА-Я0-9]{2,}(?:-[A-ZА-Я0-9]{1,6}){2,}\b/g;

export function findTags(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text || '').matchAll(TAG_RE)) {
    const tag = m[0];
    // Чтобы размер «2800-1800» или обозначение не сошли за тег: у тега должна
    // быть буквенная группа и номер в конце
    if (!/-[A-ZА-Я]{1,4}-\d{2,}[A-ZА-Я]?$/i.test(tag)) continue;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

export function tagTypeOf(tag: string): string {
  const m = /-([A-ZА-Я]{1,4})-\d{2,}[A-ZА-Я]?$/i.exec(String(tag || '').trim());
  return m ? m[1].toUpperCase() : '';
}

/** Код продукции MTO: VVFIP009760 — пять букв и номер */
export function findProductCode(text: string): string | undefined {
  const m = /\b(?:E\s*=\s*)?([A-Z]{5})(\d{4,})\b/.exec(String(text || ''));
  return m ? m[1] + m[2] : undefined;
}

// ── Разбор ──────────────────────────────────────────────────────────────────

/**
 * `\b` и `\w` в JavaScript без флага `u` знают только латиницу: «\bн» не
 * находит «н» после пробела, а «возвратн\w*\s+пружин» не проходит через
 * «возвратной». Приметы пишутся привычно, а здесь переводятся в запись, для
 * которой кириллица — такие же буквы.
 */
const WCH = '[a-z\\u0430-\\u044f\\u0451\\d_]';
const BOUND = `(?:(?<!${WCH})(?=${WCH})|(?<=${WCH})(?!${WCH}))`;
const compiled = new WeakMap<RegExp, RegExp>();

export function cyrRe(re: RegExp): RegExp {
  let hit = compiled.get(re);
  if (!hit) {
    const src = re.source.replace(/\\w/g, WCH).replace(/\\b/g, BOUND);
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    hit = new RegExp(src, flags);
    compiled.set(re, hit);
  }
  return hit;
}

export function describe(text: string, detectors: Detector[], extra?: { tags?: string[]; productCode?: string }): Description {
  const src = String(text || '');
  const low = foldText(src);
  const hits: Hit[] = [];
  const taken: Array<[number, number]> = [];

  const ordered = [...detectors].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  for (const d of ordered) {
    const re = cyrRe(d.re);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(low))) {
      if (!m[0]) { re.lastIndex++; continue; }
      const from = m.index;
      const to = m.index + m[0].length;
      if (taken.some(([a, b]) => from < b && to > a)) continue;
      taken.push([from, to]);
      const value = typeof d.value === 'function' ? d.value(m) : d.value;
      if (value === undefined) continue;
      hits.push({ key: d.key, value, from, to, text: src.slice(from, to) });
    }
  }
  hits.sort((a, b) => a.from - b.from);

  const sizes = findSizes(src);
  const tags = extra?.tags?.length ? extra.tags : findTags(src);
  return summarize(src, hits, sizes, tags, extra?.productCode ?? findProductCode(src));
}

/**
 * Свести приметы в признаки. Отдельной функцией, потому что человек может снять
 * примету в окне — и признаки пересчитываются без повторного разбора.
 */
export function summarize(text: string, hits: Hit[], sizes: SizeHit[], tags: string[], productCode?: string): Description {
  const facts: Facts = {};
  const seen = new Map<string, FactValue[]>();
  for (const h of hits) {
    if (h.off) continue;
    const list = seen.get(h.key) || [];
    if (!list.includes(h.value)) list.push(h.value);
    seen.set(h.key, list);
    // Первая примета побеждает: в двуязычном описании английская часть идёт
    // первой, а русская повторяет её — расхождение показываем как конфликт
    if (facts[h.key] === undefined) facts[h.key] = h.value;
  }
  const conflicts = [...seen.entries()].filter(([, v]) => v.length > 1).map(([key, values]) => ({ key, values }));
  const size = sizes[0];
  if (size) facts.shape = size.D ? 'round' : 'rect';
  return {
    text,
    facts,
    hits,
    size,
    sizes,
    tags,
    tagTypes: [...new Set(tags.map(tagTypeOf).filter(Boolean))],
    productCode,
    conflicts,
  };
}
