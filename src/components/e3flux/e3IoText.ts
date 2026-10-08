/**
 * Слова таблицы IO и правил состава: как назвать условие, число изделий и
 * ссылку на строку. Таблица правил, диалог правила и окно подбора говорят
 * одинаково. Условия в диалоге набираются текстом «признак = значения» —
 * разбор и обратная запись здесь же, чтобы они не расходились.
 */
import { refText } from '../../../e3/ioTable';
import type { E3IoCond, E3IoCount, E3IoRule } from '../../../e3/solutionTypes';

export type FeatureTitle = (id: string) => string;

export const ioCondText = (c: E3IoCond, title: FeatureTitle): string => `${title(c.feature)} ${c.not ? '≠' : '='} ${c.values.join(' / ')}`;

export const ioWhenText = (rule: Pick<E3IoRule, 'when'>, title: FeatureTitle): string => (rule.when.length ? rule.when.map((c) => ioCondText(c, title)).join('; ') : 'всегда');

export function ioCountText(c: E3IoCount, title: FeatureTitle): string {
  if (c.kind === 'one') return '1';
  if (c.kind === 'children') return `подпозиции «${c.role}»`;
  const shift = c.offset ? ` ${c.offset > 0 ? '+' : '−'} ${Math.abs(c.offset)}` : '';
  return `${title(c.feature)}${shift}${c.cap !== undefined ? `, не больше ${c.cap}` : ''}`;
}

export const ioRefText = refText;

/** Условия по строке: «признак = значение / значение» или «признак != значение» */
export const condsToText = (conds: E3IoCond[]): string => conds.map((c) => `${c.feature} ${c.not ? '!=' : '='} ${c.values.join(' / ')}`).join('\n');

export function parseConds(text: string): { conds: E3IoCond[]; errors: string[] } {
  const conds: E3IoCond[] = [];
  const errors: string[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = line.match(/^([\w.\-]+)\s*(!=|≠|=)\s*(.+)$/);
    const values = m ? [...new Set(m[3].split(/\s*[/,;]\s*/).map((v) => v.trim()).filter(Boolean))] : [];
    if (!m || !values.length) { errors.push(`Условие ${i + 1}: нужно «признак = значение» или «признак != значение»`); return; }
    conds.push({ feature: m[1], values, ...(m[2] === '=' ? {} : { not: true }) });
  });
  return { conds, errors };
}
