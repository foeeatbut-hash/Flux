/**
 * Подбор изделия по описанию.
 *
 * Подбор не угадывает — он сравнивает признаки описания с тем, что семейство
 * может дать, и объясняет каждое решение: что совпало, что противоречит, чего
 * в описании не сказано. Инженер обязан иметь возможность проверить любой
 * вывод глазами (flux-data-safety, п. 8), поэтому у каждого кандидата есть
 * причины, а у каждого параметра — откуда взято значение.
 *
 * Числа сравниваются только точно или по правилу «не меньше» (огнестойкость).
 * Нечёткое совпадение допускается для слов, но не для цифр: EI 60 и EI 90 —
 * разные требования, а 900×400 и 900×450 — разные клапаны.
 */
import {
  type Catalog, type Family, type Facts, type FactDef, type FactValue, type ValveValues, type ParamDef,
  type EquipmentClass, textOf, withDefaults,
} from './model';
import type { Description } from './describe';
import { buildDesignation, parseDesignation } from './designation';
import { checkConfig, optionsFor, type Violation } from './rules';
import { signatureOf, foldText } from './text';

export type ReasonStatus = 'match' | 'mismatch' | 'unknown' | 'learned' | 'hint';

export interface Reason {
  key: string;
  status: ReasonStatus;
  text: string;
}

/** Откуда взялось значение параметра — для подписи рядом с ним */
export type ValueSource = 'text' | 'default' | 'rule' | 'learned' | 'designation' | 'choice';

export interface Question {
  param: string;
  label: string;
  options: Array<{ code: string; label: string }>;
}

export interface Candidate {
  familyId: string;
  score: number;
  /** 0…1: насколько подбор уверен в этом кандидате */
  confidence: number;
  values: ValveValues;
  sources: Record<string, ValueSource>;
  designation: string;
  reasons: Reason[];
  questions: Question[];
  violations: Violation[];
  /** Кандидат противоречит описанию по важному признаку — показываем, но не предлагаем */
  rejected: boolean;
}

/** Выученное соответствие «подпись описания → семейство и параметры» */
export interface Learned {
  signature: string;
  familyId: string;
  values: ValveValues;
  count?: number;
}

export interface MatchOptions {
  classId?: string;
  learned?: Learned[];
  /** Сколько кандидатов вернуть */
  limit?: number;
  sizeSep?: string;
}

const HARD_PENALTY = 60;

function factDefs(cls: EquipmentClass | undefined): Map<string, FactDef> {
  return new Map((cls?.facts || []).map((d) => [d.key, d]));
}

/**
 * Совпадает ли признак. Значение кода может перечислять варианты через «|»:
 * привод МН220 у КПУ бывает и пружинным (назначение О), и реверсивным (З, Д) —
 * код один, а смысл зависит от соседней позиции.
 */
export function eqFact(def: FactDef | undefined, want: FactValue, got: FactValue): boolean {
  if (want === undefined || got === undefined) return false;
  if (def?.atLeast && typeof want === 'number' && typeof got === 'number') return got >= want;
  if (typeof got === 'string' && got.includes('|')) return got.split('|').includes(String(want));
  return String(want) === String(got);
}

/** Что семейство может дать по признаку: фиксированное значение или набор из кодов */
function offerOf(f: Family, key: string): FactValue[] {
  if (f.facts && f.facts[key] !== undefined) return [f.facts[key]];
  const out: FactValue[] = [];
  for (const p of f.params) {
    for (const v of p.values || []) {
      if (v.deprecated) continue;
      const x = v.facts?.[key];
      if (x !== undefined && !out.includes(x)) out.push(x);
    }
  }
  return out;
}

const describeFact = (def: FactDef | undefined, key: string, v: FactValue): string => {
  const label = def ? textOf(def.label) : key;
  if (typeof v === 'boolean') return v ? label : `${label}: нет`;
  const named = def?.values?.find((x) => x.code === String(v));
  return `${label}: ${named ? textOf(named.label) : v}${def?.unit ? ' ' + def.unit : ''}`;
};

// ── Значения параметров по признакам ────────────────────────────────────────

function scoreValue(defs: Map<string, FactDef>, want: Facts, facts: Facts | undefined): number {
  if (!facts) return 0;
  let s = 0;
  for (const [k, v] of Object.entries(facts)) {
    if (want[k] === undefined) continue;
    const def = defs.get(k);
    if (eqFact(def, want[k], v)) {
      s += def?.weight ?? 1;
      // «Не меньше» — но чем ближе к требуемому, тем лучше: EI 90 на EI 60
      // лучше, чем EI 180, если оба есть
      if (def?.atLeast && typeof v === 'number' && typeof want[k] === 'number') s -= (v - (want[k] as number)) / 1000;
    } else return -Infinity;
  }
  return s;
}

function inferValues(
  f: Family, defs: Map<string, FactDef>, d: Description, learned?: Learned,
): { values: ValveValues; sources: Record<string, ValueSource>; questions: Question[] } {
  const values: ValveValues = {};
  const sources: Record<string, ValueSource> = {};
  const questions: Question[] = [];
  const want = d.facts;

  if (d.size?.D) { values.D = d.size.D; sources.D = 'text'; }
  else {
    if (d.size?.W) { values.W = d.size.W; sources.W = 'text'; }
    if (d.size?.H) { values.H = d.size.H; sources.H = 'text'; }
  }

  const low = foldText(d.text);
  for (const p of f.params) {
    if (p.kind !== 'choice' || !p.values?.length) continue;
    if (learned?.values[p.key] !== undefined) {
      values[p.key] = learned.values[p.key];
      sources[p.key] = 'learned';
      continue;
    }
    // Синоним, заведённый инженером в Каталоге, сильнее признаков: он и
    // заводится ровно там, где признаков не хватило
    const bySyn = p.values.find((v) => !v.deprecated && (v.synonyms || []).some((s) => s.trim() && low.includes(foldText(s.trim()))));
    if (bySyn) {
      values[p.key] = bySyn.code;
      sources[p.key] = 'text';
      continue;
    }
    const scored = p.values
      .filter((v) => !v.deprecated)
      .map((v) => ({ v, s: scoreValue(defs, want, v.facts) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    if (scored.length) {
      values[p.key] = scored[0].v.code;
      sources[p.key] = 'text';
      continue;
    }
    if (p.default !== undefined) { values[p.key] = p.default; sources[p.key] = 'default'; continue; }
    questions.push(questionOf(p));
  }
  return { values, sources, questions };
}

function questionOf(p: ParamDef): Question {
  return {
    param: p.key,
    label: textOf(p.label),
    options: (p.values || []).filter((v) => !v.deprecated).map((v) => ({ code: v.code, label: `${v.code} — ${textOf(v.label)}` })),
  };
}

/**
 * Довести значения до допустимых по правилам: код, выбранный по умолчанию и
 * запрещённый правилом, заменяется первым допустимым. Код, взятый из текста,
 * не трогаем — противоречие описания каталогу инженер должен увидеть, а не
 * получить молча исправленным.
 */
function settleByRules(f: Family, values: ValveValues, sources: Record<string, ValueSource>): void {
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const p of f.params) {
      if (p.kind !== 'choice') continue;
      if (sources[p.key] !== 'default' && sources[p.key] !== 'rule' && sources[p.key] !== undefined) continue;
      const opts = optionsFor(f, p.key, values);
      const cur = opts.find((o) => o.value.code === String(values[p.key] ?? p.default ?? ''));
      if (cur && cur.allowed) continue;
      const alt = opts.find((o) => o.allowed);
      if (alt && values[p.key] !== alt.value.code) {
        values[p.key] = alt.value.code;
        sources[p.key] = 'rule';
        changed = true;
      }
    }
    if (!changed) break;
  }
}

// ── Оценка семейства ────────────────────────────────────────────────────────

function scoreFamily(f: Family, cls: EquipmentClass | undefined, d: Description, learned: Learned | undefined, opts: MatchOptions): Candidate {
  const defs = factDefs(cls);
  const reasons: Reason[] = [];
  let score = f.match.bias ?? 0;
  let rejected = false;
  const m = f.match;
  const want = d.facts;

  const hard = (key: string, text: string) => { score -= HARD_PENALTY; rejected = true; reasons.push({ key, status: 'mismatch', text }); };

  if (want.kind !== undefined) {
    if (m.kinds.includes(String(want.kind))) { score += 5; reasons.push({ key: 'kind', status: 'match', text: describeFact(defs.get('kind'), 'kind', want.kind) }); }
    else hard('kind', `другой род изделия: ${describeFact(defs.get('kind'), 'kind', want.kind)}`);
  }
  if (want.function !== undefined && m.functions?.length) {
    if (m.functions.includes(String(want.function))) { score += 4; reasons.push({ key: 'function', status: 'match', text: describeFact(defs.get('function'), 'function', want.function) }); }
    else hard('function', `назначение не то: ${describeFact(defs.get('function'), 'function', want.function)}`);
  }
  if (want.shape && !f.shapes.includes(want.shape as any)) {
    hard('shape', want.shape === 'round' ? 'круглого сечения не бывает' : 'прямоугольного сечения не бывает');
  }

  for (const [key, v] of Object.entries(want)) {
    if (key === 'kind' || key === 'function' || key === 'shape' || v === undefined) continue;
    const def = defs.get(key);
    const w = def?.weight ?? 1;
    if (m.exclude && m.exclude[key] !== undefined && eqFact(def, v, m.exclude[key])) {
      hard(key, `исключено для семейства: ${describeFact(def, key, v)}`);
      continue;
    }
    const offer = offerOf(f, key);
    if (!offer.length) {
      // Про важный признак семейство молчит — это хуже, чем совпадение:
      // лепестковую заслонку просили, а у семейства о заслонке ни слова
      if (def?.hard) score -= w;
      reasons.push({ key, status: 'unknown', text: `в каталоге не указано: ${describeFact(def, key, v)}` });
      continue;
    }
    if (offer.some((o) => eqFact(def, v, o))) {
      score += 2 * w;
      // «Не меньше» — но с запасом ближе к требуемому лучше: на EI 60 скорее
      // КПУ-1Н (EI 90), чем КПУ-3 (EI 180)
      if (def?.atLeast && typeof v === 'number') {
        const fit = offer.filter((o): o is number => typeof o === 'number' && o >= v);
        if (fit.length) score -= (Math.min(...fit) - v) / 60;
      }
      reasons.push({ key, status: 'match', text: describeFact(def, key, v) });
    } else if (def?.hard) {
      hard(key, `не бывает: ${describeFact(def, key, v)}`);
    } else {
      score -= 2 * w;
      reasons.push({ key, status: 'mismatch', text: `не бывает: ${describeFact(def, key, v)}` });
    }
  }
  for (const [key, v] of Object.entries(m.require || {})) {
    const def = defs.get(key);
    if (want[key] === undefined) { score -= 1; continue; }
    if (!eqFact(def, want[key], v) && !eqFact(def, v, want[key])) hard(key, `семейству нужно: ${describeFact(def, key, v)}`);
  }
  for (const [key, v] of Object.entries(m.prefer || {})) {
    if (want[key] !== undefined && eqFact(defs.get(key), want[key], v)) score += 1;
  }
  for (const tt of d.tagTypes) {
    if (m.tagTypes?.includes(tt)) { score += 3; reasons.push({ key: 'tag', status: 'hint', text: `код в теге: ${tt}` }); }
  }
  if (d.productCode && m.productPrefixes?.some((p) => d.productCode!.startsWith(p))) {
    score += 4;
    reasons.push({ key: 'product', status: 'hint', text: `код продукции ${d.productCode}` });
  }
  const low = d.text.toLowerCase();
  for (const kw of m.keywords || []) {
    if (low.includes(kw.toLowerCase())) { score += 3; reasons.push({ key: 'keyword', status: 'hint', text: `слово «${kw}»` }); }
  }
  if (learned) {
    score += 25;
    reasons.push({ key: 'learned', status: 'learned', text: `так уже выбирали${learned.count ? ` (${learned.count} раз)` : ''}` });
  }

  const inferred = inferValues(f, defs, d, learned);
  settleByRules(f, inferred.values, inferred.sources);
  const violations = checkConfig(f, inferred.values);
  for (const v of violations) {
    if (v.level !== 'error') continue;
    score -= v.ruleId === 'size' || v.ruleId === 'shape' ? 2 : 3;
    reasons.push({ key: v.param || v.ruleId, status: 'mismatch', text: v.message });
  }
  const designation = buildDesignation(f, inferred.values, { sizeSep: opts.sizeSep }).text;

  const matched = reasons.filter((r) => r.status === 'match' || r.status === 'hint' || r.status === 'learned').length;
  const bad = reasons.filter((r) => r.status === 'mismatch').length;
  const unknown = reasons.filter((r) => r.status === 'unknown').length + inferred.questions.length;
  let confidence = matched / (matched + bad * 2 + unknown * 0.5 + 1);
  if (learned) confidence = Math.max(confidence, 0.9);
  if (rejected) confidence = Math.min(confidence, 0.15);

  return {
    familyId: f.id,
    score,
    confidence: Math.round(confidence * 100) / 100,
    values: inferred.values,
    sources: inferred.sources,
    designation,
    reasons,
    questions: inferred.questions,
    violations,
    rejected,
  };
}

// ── Обозначение прямо в тексте ──────────────────────────────────────────────

/**
 * Если в тексте уже написано обозначение («КПУ-1Н-О-В-1000х800-…»), разбирать
 * описание незачем: строка каталога сама говорит всё. Ищем её по словам текста,
 * начинающимся с кода известного семейства.
 */
export function designationsIn(families: Family[], text: string) {
  // Пробел у дефиса — опечатка набора («2800х1800 -2*ф»), а не граница слова
  const words = String(text || '').replace(/\s*-\s*/g, '-').split(/[\s;,]+/)
    .map((w) => w.trim()).filter((w) => /\d/.test(w) && w.includes('-'));
  const out: Array<{ word: string; familyId: string; values: ValveValues }> = [];
  for (const w of words) {
    const res = parseDesignation(families, w).filter((r) => r.complete);
    if (res[0]) out.push({ word: w, familyId: res[0].familyId, values: res[0].values });
  }
  return out;
}

// ── Подбор ──────────────────────────────────────────────────────────────────

export function matchDescription(catalog: Catalog, d: Description, opts: MatchOptions = {}): Candidate[] {
  const families = catalog.families.filter((f) => !opts.classId || f.classId === opts.classId);
  const clsOf = (f: Family) => catalog.classes.find((c) => c.id === f.classId);

  const direct = designationsIn(families, d.text);
  if (direct.length) {
    const hit = direct[0];
    const f = families.find((x) => x.id === hit.familyId)!;
    const values = withDefaults(f, hit.values);
    const sources = Object.fromEntries(Object.keys(values).map((k) => [k, 'designation' as ValueSource]));
    return [{
      familyId: f.id, score: 100, confidence: 1, values, sources,
      designation: buildDesignation(f, values, { sizeSep: opts.sizeSep }).text,
      reasons: [{ key: 'designation', status: 'match', text: `обозначение в тексте: ${hit.word}` }],
      questions: [], violations: checkConfig(f, values), rejected: false,
    }];
  }

  const sig = signatureOf(d.text);
  const learnedFor = (f: Family) => opts.learned?.find((l) => l.familyId === f.id && l.signature === sig);
  const list = families.map((f) => scoreFamily(f, clsOf(f), d, learnedFor(f), opts));
  list.sort((a, b) => Number(a.rejected) - Number(b.rejected) || b.score - a.score);

  // Два кандидата почти равны — уверенность первого честно снижаем: выбор
  // между ними должен сделать человек, а не порядок строк в справочнике
  if (list.length > 1 && !list[0].rejected && !list[1].rejected && list[0].score - list[1].score < 2) {
    list[0].confidence = Math.round(list[0].confidence * 0.75 * 100) / 100;
  }
  return list.slice(0, opts.limit ?? 5);
}

/** Уровень уверенности словами — одинаковый в ведомости, подборе и импорте */
export function confidenceLevel(c: number): 'high' | 'medium' | 'low' {
  return c >= 0.7 ? 'high' : c >= 0.4 ? 'medium' : 'low';
}
