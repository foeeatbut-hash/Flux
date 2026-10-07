/**
 * Подбор типового решения для позиции проекта (docs/e3-integration.md, 5.2).
 *
 * Класс решения берётся по типу позиции; ответы на признаки собираются из трёх
 * источников. Порядок силы: ручной ответ → подбор ОВ (правило) → профиль
 * проекта; раскладка листа — последняя, она отвечает только на свои признаки.
 * Остаются решения, у которых все названные признаки совпали.
 */
import type {
  E3Answer, E3AnswerFrom, E3Feature, E3FeatureRule, E3Position, E3Profile, E3ProfileThreshold, E3RuleSource, E3Selection, E3Solution, E3SolutionBook,
} from './solutionTypes';
import { normText } from './solutionDefaults';

const num = (s: string): number => Number(String(s).replace(/\s+/g, '').replace(',', '.'));
const isNum = (s: string): boolean => String(s).trim() !== '' && Number.isFinite(num(s));
const same = (a: string, b: string): boolean => (isNum(a) && isNum(b) ? num(a) === num(b) : normText(a) === normText(b));

/** `~часть` — содержит; иначе значение целиком (числа как числа) */
const matches = (raw: string, when: string): boolean => (when.startsWith('~') ? normText(raw).includes(normText(when.slice(1))) : same(raw, when));

/** Значение по источнику: подпозиции ищутся среди соседей по тегу владельца */
function resolve(source: E3RuleSource, position: E3Position, siblings: E3Position[]): string {
  if (source.kind === 'field' || source.kind === 'param') return position.read(source);
  const children = position.tag ? siblings.filter((s) => s.id !== position.id && s.parentTag === position.tag && s.role === source.role) : [];
  if (source.kind === 'count') return String(children.length);
  const probe: E3RuleSource = source.kind === 'child-param' ? { kind: 'param', name: source.name, ...(source.unit ? { unit: source.unit } : {}) } : { kind: 'field', key: source.key };
  for (const c of children) { const v = c.read(probe); if (String(v).trim()) return v; }
  return '';
}

function byRule(rule: E3FeatureRule, position: E3Position, siblings: E3Position[]): string | undefined {
  const raw = resolve(rule.source, position, siblings);
  // Нет данных: ответ даёт только «иначе» (двойной фильтр — «нет», вентилятор — обычный)
  if (!String(raw).trim()) return rule.otherwise;
  return rule.table.find((r) => matches(raw, r.when))?.answer ?? rule.otherwise;
}

function byProfile(entry: string | E3ProfileThreshold | undefined, position: E3Position, siblings: E3Position[]): string | undefined {
  if (entry === undefined) return undefined;
  if (typeof entry === 'string') return entry || undefined;
  const raw = resolve(entry.source, position, siblings);
  if (!isNum(raw)) return undefined;
  const n = num(raw);
  const step = [...entry.steps].sort((a, b) => a.upTo - b.upTo).find((s) => n <= s.upTo);
  return step ? step.answer : entry.above;
}

export function selectSolution(
  position: E3Position, siblings: E3Position[], book: E3SolutionBook, profile: E3Profile = {}, manual: Record<string, string> = {},
): E3Selection {
  const classes = (book.classMap || {})[position.cls] || [];
  const answers: E3Answer[] = [];
  const none = (): E3Selection => ({ status: 'none', candidates: [], answers, nearest: [] });
  if (!classes.length) return none();

  const answerOf = (id: string, mainClass: string): { value: string; from: E3AnswerFrom } | undefined => {
    if (manual[id] !== undefined && manual[id] !== '') return { value: manual[id], from: 'manual' };
    const rule = (book.rules || []).find((r) => r.featureId === id && r.mainClass === mainClass);
    const v = rule ? byRule(rule, position, siblings) : undefined;
    if (v !== undefined) return { value: v, from: 'ov' };
    const p = byProfile(profile[id], position, siblings);
    if (p !== undefined) return { value: p, from: 'profile' };
    const l = position.layout?.[id];
    return l ? { value: l, from: 'layout' } : undefined;
  };

  // Тип Flux отвечает нескольким основным классам: сначала класс
  let inClass = classes;
  if (classes.length > 1) {
    for (const c of classes) {
      const a = answerOf('@class', c);
      if (a && classes.includes(a.value)) { inClass = [a.value]; answers.push({ feature: '@class', value: a.value, from: a.from }); break; }
    }
  }
  const pool = (book.solutions || []).filter((s) => !s.removed && inClass.includes(s.mainClass));
  const feats: E3Feature[] = (book.features || []).filter((f) => inClass.includes(f.mainClass));
  const asked = new Map<string, string>();
  for (const f of feats) {
    const a = answerOf(f.id, f.mainClass);
    if (a) { answers.push({ feature: f.id, value: a.value, from: a.from }); asked.set(f.id, a.value); }
  }
  const diffOf = (s: E3Solution) => feats
    .filter((f) => f.mainClass === s.mainClass && asked.has(f.id) && !same(s.features?.[f.id] ?? '', asked.get(f.id)!))
    .map((f) => ({ feature: f.id, want: asked.get(f.id)!, have: s.features?.[f.id] ?? '' }));

  const candidates = pool.filter((s) => diffOf(s).length === 0);
  if (candidates.length === 1) return { status: 'one', solution: candidates[0], candidates, answers, nearest: [] };
  if (candidates.length > 1) {
    let missingFeature: string | undefined;
    if (classes.length > 1 && inClass.length > 1 && new Set(candidates.map((s) => s.mainClass)).size > 1) missingFeature = '@class';
    else {
      missingFeature = feats.find((f) => !asked.has(f.id) && new Set(candidates.filter((s) => s.mainClass === f.mainClass).map((s) => s.features?.[f.id] ?? '')).size > 1)?.id;
    }
    return { status: 'many', candidates, answers, missingFeature, nearest: [] };
  }
  const nearest = pool.map((solution) => ({ solution, diff: diffOf(solution) })).sort((a, b) => a.diff.length - b.diff.length || a.solution.id.localeCompare(b.solution.id)).slice(0, 5);
  return { status: 'none', candidates: [], answers, nearest };
}
