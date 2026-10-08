/**
 * «Добавить недостающее»: дописать в уже существующую книгу стартовые признаки,
 * правила и правила IO, которых в ней нет (docs/e3-integration.md, 5.2–5.4).
 *
 * Книга хранится целиком, поэтому новые стартовые настройки сами в неё не
 * попадают: без этого действия владельцу пришлось бы заводить их руками или
 * терять свои правки, перезагрузив каталог. Здесь только добавление: что в
 * книге уже есть (по ключу), не меняется — ни признак, ни правило, ни ответ
 * решения, который человек уже дал. План виден до записи (flux-data-safety).
 *
 * Модуль чистый: без React, без сервера, без сети.
 */
import { DEFAULT_IO_RULES } from './ioDefaults';
import { DEFAULT_CLASS_MAP, DEFAULT_FEATURES, DEFAULT_RULES, suggestFeatures } from './solutionDefaults';
import type { E3Feature, E3FeatureRule, E3IoRule, E3Solution, E3SolutionBook } from './solutionTypes';

export interface E3MissingDefaults {
  features: E3Feature[];
  rules: E3FeatureRule[];
  ioRules: E3IoRule[];
  /** Типы Flux, которых нет в связи типов с классами */
  classMap: string[];
  /** Решения, которым дописаны ответы на новые признаки (id → дописанное) */
  filled: { id: string; features: Record<string, string>; confirmed: boolean }[];
}

export const missingCount = (m: E3MissingDefaults): number => m.features.length + m.rules.length + m.ioRules.length + m.classMap.length + m.filled.length;

const ruleKey = (r: { mainClass: string; featureId: string }): string => `${r.mainClass}|${r.featureId}`;

export function planMissingDefaults(book: E3SolutionBook): E3MissingDefaults {
  const haveFeature = new Set((book.features || []).map((f) => f.id));
  const features = DEFAULT_FEATURES.filter((f) => !haveFeature.has(f.id));
  const haveRule = new Set((book.rules || []).map(ruleKey));
  const rules = DEFAULT_RULES.filter((r) => !haveRule.has(ruleKey(r)));
  const haveIo = new Set((book.ioRules || []).map((r) => r.id));
  const ioRules = DEFAULT_IO_RULES.filter((r) => !haveIo.has(r.id));
  const classMap = Object.keys(DEFAULT_CLASS_MAP).filter((k) => !(k in (book.classMap || {})));

  // Ответы новых признаков для решений, которые были разобраны, когда этих признаков ещё не было
  const filled: E3MissingDefaults['filled'] = [];
  if (features.length) {
    const allFeatures = [...(book.features || []), ...features];
    const fresh = new Set(features.map((f) => f.mainClass));
    for (const s of book.solutions || []) {
      if (s.removed || !fresh.has(s.mainClass)) continue;
      const sug = suggestFeatures(s, { features: allFeatures, dictionary: book.dictionary || {} });
      const add: Record<string, string> = {};
      for (const f of features) if (f.mainClass === s.mainClass && s.features?.[f.id] === undefined && f.id in sug.features) add[f.id] = sug.features[f.id];
      if (Object.keys(add).length) filled.push({ id: s.id, features: add, confirmed: s.featuresConfirmed && !sug.ambiguous.length && !sug.unknown.length });
    }
  }
  return { features, rules, ioRules, classMap, filled };
}

/** Книга с дописанным недостающим: порядок существующего сохраняется, новое — в конец */
export function applyMissingDefaults(book: E3SolutionBook, missing: E3MissingDefaults = planMissingDefaults(book)): Partial<E3SolutionBook> {
  const fill = new Map(missing.filled.map((f) => [f.id, f]));
  const solutions: E3Solution[] = (book.solutions || []).map((s) => {
    const f = fill.get(s.id);
    return f ? { ...s, features: { ...f.features, ...s.features }, featuresConfirmed: f.confirmed } : s;
  });
  const classMap = { ...(book.classMap || {}) };
  for (const k of missing.classMap) classMap[k] = [...DEFAULT_CLASS_MAP[k]];
  return {
    features: [...(book.features || []), ...missing.features],
    rules: [...(book.rules || []), ...missing.rules],
    ioRules: [...(book.ioRules || []), ...missing.ioRules],
    classMap,
    solutions,
  };
}
