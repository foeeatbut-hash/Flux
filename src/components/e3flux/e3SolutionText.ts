/**
 * Слова каталога типовых решений: как назвать источник правила, вид признака и
 * поле из файла. Таблицы, карточки и окно плана говорят одинаково.
 */
import { E3_FIELD_TITLES } from '../../../e3/attributes';
import type { E3FeatureKind, E3FeatureRule, E3RuleSource, E3Solution } from '../../../e3/solutionTypes';

export const KIND_TITLES: Record<E3FeatureKind, string> = { ov: 'из подбора ОВ', profile: 'из профиля проекта', layout: 'из раскладки листа' };

/** Подпись поля из файла в списке «поле: было → стало» плана загрузки */
export const SOLUTION_FIELD_TITLES: Record<string, string> = {
  mainClass: 'Основной класс', subclass: 'Класс', short: 'Краткое обозначение', name: 'Название схемы', description: 'Описание',
  pdf: 'Ссылка на PDF', e3p: 'Ссылка на .e3p', twoLevel: 'Двухуровневая', inCad: 'Есть в САПР', items: 'Список изделий', symbols: 'Список символов', note: 'Пояснение',
};

export const fieldText = (v: unknown): string => (typeof v === 'boolean' ? (v ? 'да' : 'нет') : String(v ?? '').trim() || '—');

export function ruleSourceText(s: E3RuleSource): string {
  const unit = (u?: string) => (u ? `, ${u}` : '');
  switch (s.kind) {
    case 'field': return E3_FIELD_TITLES[s.key] || s.key;
    case 'param': return `${s.name}${unit(s.unit)}`;
    case 'count': return `число подпозиций «${s.role}»`;
    case 'child-param': return `${s.name}${unit(s.unit)} у «${s.role}»`;
    case 'child-field': return `${E3_FIELD_TITLES[s.key] || s.key} у «${s.role}»`;
  }
}

export const ruleTableText = (r: E3FeatureRule): string =>
  [...r.table.map((t) => `${t.when} → ${t.answer}`), ...(r.otherwise !== undefined ? [`иначе → ${r.otherwise || '—'}`] : [])].join('; ');

/** Решение одной строкой: «08.01.38 · Клапан_К230_КП2» */
export const solutionLine = (s: Pick<E3Solution, 'id' | 'name'>): string => `${s.id} · ${s.name}`;
