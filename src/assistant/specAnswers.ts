/**
 * Ответы помощника про характеристики позиции: «какой расход у 3700-…».
 *
 * Живёт отдельно от хранилища по двум причинам. Здесь сходятся три словаря —
 * величин, обозначений и русской морфологии, — и это самостоятельное знание,
 * а не часть разговора. И вторая: разбор запроса можно проверить скриптом, а
 * хранилище с сетью и состоянием — нет.
 */
import { matchLabel, fieldByUniqueUnit, stemRu, FIELDS, FieldDef } from '../import/dictionary';
import { resolveSymbol, looksLikeSymbol } from '../import/symbols';
import { levenshtein } from './nlp';
import type { AssistantData } from './data';
import { uid, type AssistantMessage } from './types';

export type CompSpec = { key: string; value: string; unit: string; group: string };
export type CompData = AssistantData['components'][number];

/**
 * Поле, о котором спрашивает пользователь.
 *
 * Простого «есть ли синоним в строке» мало: инженер пишет «какой расхот»,
 * «мощностя двигателя», а в бланках половина величин подписана не словом, а
 * условным обозначением — «какой L у 3700-…». Поэтому сначала многословные
 * синонимы подстрокой, затем — сравнение по основам слов с допуском на одну
 * опечатку, и в конце справочник обозначений.
 */
export function askedField(lower: string, raw = lower): FieldDef | null {
  let best: FieldDef | null = null, bestLen = 0;
  // Многословные синонимы («расход воздуха», «тепловая мощность») — подстрокой
  for (const f of FIELDS) {
    for (const syn of f.synonyms) {
      if (syn.includes(' ') && lower.includes(syn) && syn.length > bestLen) { best = f; bestLen = syn.length; }
    }
  }
  if (best) return best;

  const words = lower.split(/[^A-Za-zА-Яа-яЁё0-9]+/).filter(Boolean);
  const stems = words.map(stemRu);
  for (const f of FIELDS) {
    for (const syn of f.synonyms) {
      if (syn.includes(' ') || syn.length < 3) continue;
      const ss = stemRu(syn);
      for (let i = 0; i < words.length; i++) {
        const hit = stems[i] === ss
          || (ss.length >= 5 && stems[i].length >= 5 && levenshtein(stems[i], ss) <= 1);
        if (hit && syn.length > bestLen) { best = f; bestLen = syn.length; }
      }
    }
  }
  if (best) return best;

  // «Какой L у 3700-…» — обозначение вместо слова. Регистр здесь решает
  // («N» — мощность, «n» — обороты), поэтому смотрим ИСХОДНЫЙ текст запроса, а
  // не приведённый к нижнему регистру. Берём только однозначные обозначения:
  // «L» без единицы значит и расход, и длину — такую догадку выдавать нельзя.
  for (const w of raw.split(/[^A-Za-zА-Яа-яЁё0-9]+/).filter(Boolean)) {
    if (!looksLikeSymbol(w)) continue;
    const sm = resolveSymbol(w);
    if (!sm || (sm.rivals || []).length) continue;
    const f = FIELDS.find(x => x.id === sm.field);
    if (f) return f;
  }
  return null;
}
// Характеристика компонента, соответствующая полю (по подписи, затем по единице).
// При дублях (в бланках бывает «0 м³/ч» рядом с реальным) предпочитаем ненулевое.
export function specForField(specs: CompSpec[], field: FieldDef): CompSpec | null {
  const byLabel = specs.filter(s => { const m = matchLabel(s.key); return !!m && m.field.id === field.id; });
  const byUnit = specs.filter(s => s.unit && fieldByUniqueUnit(s.unit) === field.id);
  const cand = byLabel.length ? byLabel : byUnit;
  return cand.find(s => s.value && !/^0([.,]0+)?$/.test(s.value.trim())) || cand[0] || null;
}
/**
 * Тег в проекте есть, а изделия за ним нет. Ответ должен это назвать: молчаливый
 * переход к карточке тега выглядел так, будто на вопрос про расход ответили
 * этапом закупки.
 */
export function tagWithoutEquipment(data: AssistantData, code: string): AssistantMessage | null {
  const lc = code.toLowerCase();
  const tag = data.tags.find(t => (t.identifier || '').toLowerCase() === lc);
  if (!tag) return null;
  if (findComponentByCode(data.components, code)) return null;
  return {
    id: uid(), role: 'assistant',
    text: `У тега «${tag.identifier}» нет привязанного оборудования — характеристики брать неоткуда.\n`
      + 'Характеристики живут у изделия: привяжите тег к позиции в «Оборудовании» — или загрузите бланк, там связь предлагается сама.',
    actions: [{ label: 'Открыть «Оборудование»', kind: 'open-section', route: '/equipment' }],
  };
}

// Компонент по коду тега / itemCode / имени
export function findComponentByCode(comps: CompData[], code: string): CompData | null {
  const lc = code.toLowerCase();
  return comps.find(c =>
    (c.tags || []).some(t => (t || '').toLowerCase() === lc)
    || (c.itemCode || '').toLowerCase() === lc
    || (c.name || '').toLowerCase().includes(lc)) || null;
}
