/**
 * Сопоставление позиций расчёта с записями проекта при повторной загрузке.
 *
 * ID выдаётся изделию, а не пути в файле (docs/e3-integration.md, 1.3–1.4).
 * Путь — «бл2.1», «бл2.1/вентилятор1» — это адрес, и он меняется, когда расчёт
 * пересобирают. Поэтому запись ищется по шагам, от надёжного к приблизительному:
 *
 *   1. ключ источника — места в логике пока нет колонки: в выгрузках САПР ВЕЗА
 *      постоянного идентификатора узла не видно, и шаг остаётся пустым;
 *   2. тег из файла, уже стоящий на позиции этой установки;
 *   3. адрес — с проверкой, что изделие то же;
 *   4. переехавшие: пропала с одного адреса, на другом появилась такая же.
 *
 * Шаги 3–4 только предлагают: каждая спорная пара — строка плана с вариантами,
 * решение принимает инженер. Чистый модуль: ни базы, ни записи. План и запись
 * зовут одну и ту же функцию, иначе предпросмотр обещал бы одно, а в базе
 * получалось другое.
 */
import { classOf, kindOf, modelOf, classTitle, type ClassId, type Classifiable } from '../equipment/classes.js';
import { identityKeyOf, latinFix } from '../equipment/tagPolicy.js';
import { parseRuNumber } from './normalize.js';

/** Что решено с парой «позиция в файле — прежняя запись» */
export type MatchChoice = 'same' | 'reselect' | 'other';

export const CHOICE_LABEL: Record<MatchChoice, string> = {
  same: 'То же изделие',
  reselect: 'Переподобрано',
  other: 'Другое изделие',
};

/** Изделие в четырёх чертах: тип, вид, типоразмер, мощность (как подпись у CatalogLearn) */
export interface Sig { cls: ClassId; kind: string; model: string; power: number | null }

/** near — то же изделие; far — тот же тип, другой типоразмер; other — другой тип */
export type Closeness = 'near' | 'far' | 'other';

function groupsOf(specs: unknown): { params: { key: string; value: string }[] }[] {
  let s: any = specs;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch (_) { return []; } }
  return (Array.isArray(s?.groups) ? s.groups : []).map((g: any) => ({
    params: (Array.isArray(g?.params) ? g.params : []).map((p: any) => ({ key: String(p?.key || ''), value: String(p?.value ?? '') })),
  }));
}

/** Первая числовая «мощность»: у вентилятора, двигателя, нагревателя она одна и та же в файле и в базе */
function powerOf(specs: unknown): number | null {
  for (const g of groupsOf(specs)) for (const p of g.params) {
    if (!/мощност/i.test(p.key)) continue;
    const n = parseRuNumber(p.value);
    if (n !== null && n > 0) return n;
  }
  return null;
}

/**
 * Типоразмер из названия позиции. В выгрузках САПР марка стоит в названии
 * («Вентилятор ПРОБА62-100-… №2»), а в характеристиках её может не быть.
 * Номер экземпляра («№2») отрезается: это подпись для человека, а не изделие.
 */
const modelFromTitle = (name: unknown) => String(name ?? '').replace(/№\s*\d+/g, '').replace(/\s+/g, ' ').trim();

export function sigOf(p: Classifiable): Sig {
  const cls = classOf(p);
  return { cls, kind: kindOf(p, cls), model: modelOf(p.specs) || modelFromTitle(p.name), power: powerOf(p.specs) };
}

const foldModel = (s: string) => s.toLowerCase().replace(/[\s\-_.]/g, '');

/**
 * Похожи ли два изделия.
 *
 * Пустой признак ничего не опровергает: у блока без характеристик нет ни
 * марки, ни мощности, и обвинять его в «другом типоразмере» нечем. Мощность
 * сверяется с допуском 5 %: расчёт округляют по-разному, а изделие не меняется.
 */
export function closeness(a: Sig, b: Sig): Closeness {
  if (a.cls !== b.cls) return 'other';
  if (a.kind && b.kind && a.kind !== b.kind) return 'far';
  if (a.model && b.model && foldModel(a.model) !== foldModel(b.model)) return 'far';
  if (a.power !== null && b.power !== null && Math.abs(a.power - b.power) > Math.max(a.power, b.power) * 0.05) return 'far';
  return 'near';
}

/** Чем теснее сходство, тем выше счёт: нужен, чтобы из нескольких близких выбрать самую похожую */
function score(a: Sig, b: Sig): number {
  return (a.model && b.model && foldModel(a.model) === foldModel(b.model) ? 4 : 0)
    + (a.power !== null && b.power !== null && a.power === b.power ? 2 : 0)
    + (a.kind && b.kind && a.kind === b.kind ? 1 : 0);
}

/** Позиция нового файла в том виде, в каком её сопоставляют */
export interface FileItem {
  key: string;            // blockKey
  mb: string;             // '' у параметров самой установки
  code: string;           // itemCode
  title: string;
  parentKey: string;      // blockKey владельца; пусто у блока
  order: number;
  instanceNo?: number;
  tags: string[];         // как написано в файле
  sig: Sig;
}

/** Запись проекта в том же виде */
export interface DbItem {
  id: string;
  mb: string;             // '' у служебного блока установки
  code: string;
  title: string;
  parentId: string;
  order: number;
  instanceNo?: number;
  tags: string[];         // идентификаторы тегов, стоящих на позиции
  sig: Sig;
  row: any;               // строка базы целиком — запись берёт из неё версию и характеристики
}

export const addressOf = (x: { mb: string; code: string }) => (x.mb ? `${x.mb} / ${x.code}` : x.code);

/** Какой вариант стоит по умолчанию — таблица 1.4 */
export const defaultChoice = (c: Closeness): MatchChoice => (c === 'near' ? 'same' : c === 'far' ? 'reselect' : 'other');

export interface MatchRow {
  /** blockKey новой позиции — он же ключ выбора инженера */
  key: string;
  /** moved — переехала на другой адрес; address — по адресу стоит другое изделие */
  kind: 'moved' | 'address';
  closeness: Closeness;
  title: string;
  at: string;
  was: { id: string; title: string; at: string; tags: string[]; label: string };
  now: { label: string };
  why: string;
  options: { value: MatchChoice; label: string }[];
  default: MatchChoice;
  /** Вариант, который сработает: выбор инженера или умолчание */
  choice: MatchChoice;
}

export interface Resolution {
  /** Запись, в которую пишутся данные файла; пусто — позиция новая */
  element: DbItem | null;
  /** Прежняя запись, которую снимает «Переподобрано» или «Другое изделие» */
  replaces: DbItem | null;
  /** «Переподобрано»: связь «заменено на» ставится; «Другое изделие» — нет */
  linked: boolean;
  how: 'tag' | 'address' | 'moved' | 'new';
  row?: MatchRow;
}

const describe = (s: Sig) => [classTitle(s.cls), s.kind, s.model, s.power !== null ? `${s.power} кВт` : ''].filter(Boolean).join(', ');

/** Все написания тега, под которыми его могут узнать: как в файле и с исправлением раскладки */
function tagKeys(raw: string): string[] {
  const fix = latinFix(raw);
  return [...new Set([identityKeyOf(raw), ...(fix ? [identityKeyOf(fix.identifier)] : [])])].filter(Boolean);
}

const tailOf = (code: string, ownerCode: string) => (code.startsWith(`${ownerCode}/`) ? code.slice(ownerCode.length + 1) : code);

function depthOf(items: FileItem[]): Map<string, number> {
  const parent = new Map(items.map(i => [i.key, i.parentKey]));
  const depth = new Map<string, number>();
  for (const i of items) {
    let d = 0, k = i.parentKey;
    // Кольцо в данных не должно вешать сопоставление
    while (k && parent.has(k) && d < 50) { d++; k = parent.get(k)!; }
    depth.set(i.key, d);
  }
  return depth;
}

/**
 * Сопоставляет все позиции одной установки. `choices` — решения инженера по
 * строкам плана (blockKey → вариант); без решения действует умолчание.
 */
export function matchItems(
  blocks: FileItem[],
  existing: DbItem[],
  choices: Record<string, string> = {},
): Map<string, Resolution> {
  const out = new Map<string, Resolution>();
  // Снятые и ручные в сопоставлении не участвуют: первые вернёт отдельная
  // логика, вторых файл не знает
  const pool = existing.filter(e => e.row?.status !== 'REMOVED' && !e.row?.manual);
  const taken = new Map<string, string>();          // id записи → ключ позиции, которая её заняла
  const byAddr = new Map<string, DbItem[]>();
  for (const e of pool) {
    const k = `${e.mb}‖${e.code}`;
    (byAddr.get(k) ?? byAddr.set(k, []).get(k)!).push(e);
  }
  const free = (e: DbItem) => !taken.has(e.id);
  const claim = (b: FileItem, e: DbItem, how: Resolution['how']) => {
    taken.set(e.id, b.key);
    out.set(b.key, { element: e, replaces: null, linked: false, how });
  };
  const doubt = new Map<string, DbItem>();          // позиция → запись, с которой не сошлось

  // Установка — всегда по адресу, это служебный блок
  for (const b of blocks) {
    if (b.code !== '__unit__') continue;
    const e = (byAddr.get(`‖__unit__`) || []).find(free);
    if (e) claim(b, e, 'address');
  }
  const rest = () => blocks.filter(b => b.code !== '__unit__' && !out.has(b.key));

  // Шаг 2. Тег из файла, уже стоящий на позиции этой установки
  const byTag = new Map<string, DbItem[]>();
  for (const e of pool) {
    if (e.code === '__unit__') continue;
    for (const t of e.tags) {
      const k = identityKeyOf(t);
      (byTag.get(k) ?? byTag.set(k, []).get(k)!).push(e);
    }
  }
  for (const b of rest()) {
    const votes = new Map<string, { e: DbItem; n: number }>();
    for (const raw of b.tags) for (const k of tagKeys(raw)) for (const e of byTag.get(k) || []) {
      if (!free(e)) continue;
      const v = votes.get(e.id) || { e, n: 0 };
      v.n++; votes.set(e.id, v);
    }
    const best = [...votes.values()].sort((x, y) => y.n - x.n
      || Number(`${y.e.mb}‖${y.e.code}` === `${b.mb}‖${b.code}`) - Number(`${x.e.mb}‖${x.e.code}` === `${b.mb}‖${b.code}`))[0];
    if (!best) continue;
    // Тег называет эту позицию, даже если код другой; смена ТИПА под тем же
    // тегом — уже вопрос, а не ответ
    if (closeness(b.sig, best.e.sig) === 'other') doubt.set(b.key, best.e);
    else claim(b, best.e, 'tag');
  }

  // Шаг 3. Адрес — и то же ли изделие
  for (const b of rest()) {
    if (doubt.has(b.key)) continue;
    const e = (byAddr.get(`${b.mb}‖${b.code}`) || []).find(free);
    if (!e) continue;
    if (closeness(b.sig, e.sig) === 'near') claim(b, e, 'address');
    else doubt.set(b.key, e);
  }

  // Шаг 4. Переехавшие: тот же тип, близкие характеристики, другой адрес.
  // Владельцы идут раньше своих подпозиций: двигатель ищется внутри вентилятора,
  // с которым его владелец уже сошёлся, — это и есть самый сильный довод
  const depth = depthOf(blocks);
  const fileByKey = new Map(blocks.map(b => [b.key, b]));
  const elementOf = (key: string) => out.get(key)?.element?.id || '';
  const moves = new Map<string, DbItem>();          // позиция → запись, которая на неё переехала
  const inOwner = new Set<string>();                // переехали вместе с владельцем: внутри него они на месте
  for (let d = 0; d <= Math.max(0, ...depth.values()); d++) {
    const left = rest().filter(b => depth.get(b.key) === d && !moves.has(b.key));
    const spare = pool.filter(e => free(e) && e.code !== '__unit__' && ![...moves.values()].includes(e));
    const pairs: { b: FileItem; e: DbItem; s: number; gap: number; own: boolean }[] = [];
    for (const b of left) for (const e of spare) {
      if (closeness(b.sig, e.sig) !== 'near') continue;
      const ownerId = b.parentKey ? elementOf(b.parentKey) || moves.get(b.parentKey)?.id || '' : '';
      const own = !!ownerId && e.parentId === ownerId;
      pairs.push({
        b, e, own,
        s: score(b.sig, e.sig) + (own ? 3 : 0) + (e.mb === b.mb ? 1 : 0)
          + (b.instanceNo && e.instanceNo === b.instanceNo ? 0.5 : 0),
        gap: Math.abs(b.order - e.order),
      });
    }
    pairs.sort((x, y) => y.s - x.s || x.gap - y.gap || x.b.order - y.b.order);
    const usedB = new Set<string>(), usedE = new Set<string>();
    for (const p of pairs) {
      if (usedB.has(p.b.key) || usedE.has(p.e.id)) continue;
      usedB.add(p.b.key); usedE.add(p.e.id);
      moves.set(p.b.key, p.e);
      if (p.own) inOwner.add(p.b.key);
    }
  }

  const rowOf = (b: FileItem, e: DbItem, kind: MatchRow['kind']): MatchRow => {
    const c = closeness(b.sig, e.sig);
    const def = defaultChoice(c);
    const asked = choices[b.key] as MatchChoice | undefined;
    // «Переподобрано» возможно только в пределах одного типа
    const options = (['same', 'reselect', 'other'] as MatchChoice[])
      .filter(v => v !== 'reselect' || c !== 'other')
      .map(v => ({ value: v, label: CHOICE_LABEL[v] }));
    const choice = asked && options.some(o => o.value === asked) ? asked : def;
    const why = kind === 'moved'
      ? `«${b.title}» переехала с ${addressOf(e)} на ${addressOf(b)}`
      : c === 'other'
        ? `На ${addressOf(b)} раньше стояло «${describe(e.sig)}», теперь «${describe(b.sig)}»`
        : `На ${addressOf(b)} теперь другой типоразмер: было «${describe(e.sig)}», стало «${describe(b.sig)}»`;
    return {
      key: b.key, kind, closeness: c, title: b.title, at: addressOf(b),
      was: { id: e.id, title: e.title, at: addressOf(e), tags: e.tags, label: describe(e.sig) },
      now: { label: describe(b.sig) },
      why, options, default: def, choice,
    };
  };
  const settle = (b: FileItem, e: DbItem, kind: MatchRow['kind'], how: Resolution['how']) => {
    const row = rowOf(b, e, kind);
    taken.set(e.id, b.key);
    if (row.choice === 'same') out.set(b.key, { element: e, replaces: null, linked: false, how, row });
    else out.set(b.key, { element: null, replaces: e, linked: row.choice === 'reselect', how: 'new', row });
  };
  for (const b of blocks) {
    const e = moves.get(b.key);
    if (!e || out.has(b.key)) continue;
    // Двигатель внутри вентилятора, переехавшего вместе с ним, отдельного
    // вопроса не заслуживает: владелец сошёлся, и он остался внутри него
    const owner = b.parentKey ? out.get(b.parentKey)?.element : null;
    const ownerFile = b.parentKey ? fileByKey.get(b.parentKey) : undefined;
    // Хвост пути внутри владельца тот же («вентилятор1» под 1.3 и под 1.4):
    // если же он другой («вентилятор2» стал «вентилятор1»), это уже вопрос
    const sameTail = !!owner && !!ownerFile && tailOf(b.code, ownerFile.code) === tailOf(e.code, owner.code);
    if (inOwner.has(b.key) && owner && e.parentId === owner.id && sameTail) claim(b, e, 'moved');
    else settle(b, e, 'moved', 'moved');
  }
  // Спорные по адресу: записи, которые так никто и не забрал
  for (const b of blocks) {
    const e = doubt.get(b.key);
    if (!e || out.has(b.key) || !free(e)) continue;
    settle(b, e, 'address', 'address');
  }

  for (const b of blocks) if (!out.has(b.key)) out.set(b.key, { element: null, replaces: null, linked: false, how: 'new' });
  return out;
}
