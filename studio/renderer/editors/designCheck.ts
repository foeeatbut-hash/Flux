/**
 * Автоматические проверки списка «Проверка перед готово» (раздел 8 docs/methodology/01-design.md),
 * которые можно сделать по одному описанию формы, без запуска: цвета только из токенов, подписи по
 * правилам текста (раздел 6), размеры по мерам (раздел 1), нет горизонтальной прокрутки в узком
 * окне, числа вправо, моноширинный только для кодов. То, что видно лишь на снимке (вес акцента,
 * тени, движение), здесь не проверяется — это остаётся глазу и зонду.
 *
 * Список рекламных слов, допустимые отступы и высоты строк берутся из выписки методологии, а не
 * дублируются. Функцию вызывает «Проверка перед отправкой».
 */
import { METHODOLOGY } from './methodology.generated';
import { resolveBinding } from './contractModel';
import type { ContractDraft, Finding } from './types';

/** Узкое окно подпрограммы, px: ниже этой ширины форма не должна прокручиваться вбок */
export const NARROW_WIDTH = 360;
const CELL_MIN = 72;

const SPACING = METHODOLOGY.spacing;
/** «мгновенный», «сквозной»… — слова в «ёлочках» правила про рекламные слова раздела 6 */
const AD_WORDS: string[] = (METHODOLOGY.textRules.find(rule => rule.startsWith('Без рекламных слов'))?.match(/«[^»]+»/g) ?? [])
  .map(word => word.slice(1, -1).toLowerCase());
const stem = (word: string) => word.length > 6 ? word.slice(0, word.length - 2) : word;

/** Строки таблиц и списков: «28–40 px» из списка раздела 8 */
const ROW_LIMITS = (() => {
  const match = METHODOLOGY.checklist.map(item => /не выходят за (\d+)–(\d+) px/.exec(item)).find(Boolean);
  return match ? { min: Number(match[1]), max: Number(match[2]) } : { min: 28, max: 40 };
})();

const COLOR_KEY = /colou?r|background|fill|stroke|shadow/i;
const COLOR_LITERAL = /^\s*(#[0-9a-f]{3,8}\b|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\()/i;
const TOKEN = /^\s*var\(\s*--flux-[a-z-]+\s*\)\s*$/;
const SIZE_KEY = /^(width|height|minWidth|maxWidth|minHeight|maxHeight|gap|padding\w*|margin\w*|fontSize|rowHeight|columnWidth)$/;

const KNOWN: Record<string, string[]> = {
  form: ['version', 'onDataChanged', 'groups', 'tables'],
  group: ['title', 'fields', 'visibleIf'],
  field: ['label', 'bind', 'kind', 'unit', 'allowed', 'min', 'max', 'required', 'placeholder', 'hint', 'visibleIf'],
  table: ['title', 'bind', 'columns', 'visibleIf'],
  column: ['label', 'key', 'align', 'unit'],
};

const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const pxValue = (value: unknown): number | null => {
  if (typeof value === 'number') return value;
  const match = typeof value === 'string' ? /^\s*(-?\d+(?:\.\d+)?)\s*(px)?\s*$/.exec(value) : null;
  return match ? Number(match[1]) : null;
};
const CODE_KEYS = /\.(itemCode|identifier|code|id)$/;

export function checkFormDesign(form: unknown, options: { contract?: ContractDraft } = {}): Finding[] {
  const out: Finding[] = [];
  const add = (rule: string, severity: Finding['severity'], path: string, message: string, source: string) =>
    out.push({ rule, severity, path, message, source: `${METHODOLOGY.source}, ${source}` });
  if (!isObject(form) || !Array.isArray(form.groups) || !Array.isArray(form.tables)) {
    add('form-shape', 'error', '', 'Описание формы не разобрать: ожидается version, groups и tables', 'раздел 5');
    return out;
  }

  const text = (value: unknown, path: string, kind: 'label' | 'title' | 'column', limit: number) => {
    if (typeof value !== 'string' || !value.trim()) {
      add('text-empty', 'error', path, `У ${{ label: 'поля', title: 'заголовка', column: 'колонки' }[kind]} нет текста`, 'раздел 6');
      return;
    }
    const lower = value.toLowerCase();
    for (const word of AD_WORDS) if (lower.includes(stem(word))) add('text-ad', 'warning', path, `Рекламное слово «${word}» в тексте «${value}»: подпись должна говорить, что будет`, 'раздел 6');
    if (/\*/.test(value)) add('text-asterisk', 'warning', path, `Звёздочка в подписи «${value}»: обязательное поле отмечается словом в ошибке при сохранении`, 'раздел 5, «Форма»');
    if (value.split(/[\s/(),.]+/).some(word => /^[А-ЯЁA-Z]{5,}$/.test(word))) add('text-caps', 'warning', path, `ЗАГЛАВНЫЕ буквы в «${value}»: заглавные допустимы только в аббревиатурах и кодах`, 'раздел 8');
    if (value.length > limit) add('text-long', 'warning', path, `Текст «${value}» длиннее ${limit} знаков и в узком окне не поместится в одну строку`, 'раздел 5, «Форма»');
    if (/[.…]$/.test(value.trim())) add('text-dot', 'warning', path, `Точка или многоточие в конце «${value}»: подпись — не предложение`, 'раздел 6');
  };

  const unknownKeys = (node: Record<string, any>, kind: string, path: string) => {
    for (const [key, value] of Object.entries(node)) {
      if (KNOWN[kind].includes(key)) continue;
      const at = `${path}.${key}`;
      if (COLOR_KEY.test(key) || (typeof value === 'string' && COLOR_LITERAL.test(value))) {
        if (typeof value !== 'string' || !TOKEN.test(value)) add('color-token', 'error', at, `Цвет «${String(value)}» не из токенов: берите var(--flux-…) — цвет несёт смысл и меняется вместе с темой`, 'раздел 3');
      }
      if (SIZE_KEY.test(key)) {
        const size = pxValue(value);
        if (size === null) add('measure-value', 'warning', at, `Размер «${String(value)}» не число в px`, 'раздел 1');
        else if (key === 'rowHeight' && (size < ROW_LIMITS.min || size > ROW_LIMITS.max)) add('measure-row', 'error', at, `Высота строки ${size} px вне ${ROW_LIMITS.min}–${ROW_LIMITS.max}`, 'раздел 1');
        else if (size % 4 !== 0 && !SPACING.includes(size)) add('measure-step', 'error', at, `Размер ${size} px не кратен 4 и не из ряда ${SPACING.join(', ')}`, 'раздел 1');
        if (/width/i.test(key) && size !== null && size > NARROW_WIDTH) add('narrow-scroll', 'error', at, `Ширина ${size} px больше узкого окна (${NARROW_WIDTH}): появится горизонтальная прокрутка`, 'раздел 8');
      }
    }
  };

  const contract = options.contract;
  unknownKeys(form, 'form', '');

  form.groups.forEach((group: any, g: number) => {
    const gp = `groups[${g}]`;
    if (!isObject(group)) return;
    unknownKeys(group, 'group', gp);
    text(group.title, `${gp}.title`, 'title', 48);
    const fields = Array.isArray(group.fields) ? group.fields : [];
    if (!fields.length) add('group-empty', 'warning', `${gp}.fields`, `Группа «${group.title ?? ''}» без полей: добавьте поле или уберите группу`, 'раздел 5, «Пустое состояние»');
    const seen = new Set<string>();
    fields.forEach((field: any, f: number) => {
      const fp = `${gp}.fields[${f}]`;
      if (!isObject(field)) return;
      unknownKeys(field, 'field', fp);
      text(field.label, `${fp}.label`, 'label', 32);
      const label = typeof field.label === 'string' ? field.label.trim().toLowerCase() : '';
      if (label && seen.has(label)) add('text-duplicate', 'warning', `${fp}.label`, `Подпись «${field.label}» повторяется в группе: поля не различить`, 'раздел 6');
      seen.add(label);
      if (typeof field.placeholder === 'string' && label && field.placeholder.trim().toLowerCase() === label) add('placeholder-repeat', 'warning', `${fp}.placeholder`, 'Подсказка в поле повторяет подпись: нужен пример значения («AHU-01»)', 'раздел 5, «Форма»');
      if (typeof field.hint === 'string' && (field.hint.trim().match(/[.!?](\s|$)/g) ?? []).length > 1) add('hint-sentence', 'warning', `${fp}.hint`, 'Пояснение длиннее одного предложения', 'раздел 6');
      if (typeof field.unit === 'string' && field.unit && typeof field.label === 'string' && field.label.includes(`(${field.unit})`)) add('unit-duplicate', 'warning', `${fp}.label`, `Единица «${field.unit}» уже указана отдельно: уберите её из подписи`, 'раздел 5, «Форма»');
      const bind = typeof field.bind === 'string' ? field.bind : '';
      const resolved = contract && bind ? resolveBinding(bind, contract) : null;
      const numeric = resolved?.ok && (resolved.type === 'number' || resolved.type === 'integer');
      if (field.kind === 'code' && numeric) add('code-mono', 'warning', `${fp}.kind`, `«${field.label}» — число, а не код: моноширинным набираются только коды`, 'раздел 8');
      if (field.kind !== 'code' && CODE_KEYS.test(bind) && bind.startsWith('flux.')) add('code-mono', 'warning', `${fp}.kind`, `«${field.label}» — код: наберите его моноширинным (kind: "code"), чтобы сверять по символу`, 'раздел 5');
    });
  });

  form.tables.forEach((table: any, t: number) => {
    const tp = `tables[${t}]`;
    if (!isObject(table)) return;
    unknownKeys(table, 'table', tp);
    text(table.title, `${tp}.title`, 'title', 48);
    const columns = Array.isArray(table.columns) ? table.columns : [];
    if (!columns.length) add('table-empty', 'error', `${tp}.columns`, `У таблицы «${table.title ?? ''}» нет колонок`, 'раздел 5, «Таблица»');
    if (columns.length * CELL_MIN > NARROW_WIDTH) add('narrow-scroll', 'warning', `${tp}.columns`, `${columns.length} колонок: в узком окне (${NARROW_WIDTH} px) на колонку остаётся меньше ${CELL_MIN} px — уберите лишние или вынесите в карточку`, 'раздел 8');
    let widths = 0;
    columns.forEach((column: any, c: number) => {
      const cp = `${tp}.columns[${c}]`;
      if (!isObject(column)) return;
      unknownKeys(column, 'column', cp);
      text(column.label, `${cp}.label`, 'column', 24);
      const size = pxValue(column.width);
      if (size !== null) widths += size;
      // Единица измерения у колонки означает числа, а числа выравниваются по правому краю
      if (typeof column.unit === 'string' && column.unit && column.align !== 'end') add('numbers-end', 'warning', `${cp}.align`, `Колонка «${column.label}» с единицей «${column.unit}» — числа: выровняйте по правому краю (align: "end")`, 'раздел 5, «Таблица»');
    });
    if (widths > NARROW_WIDTH) add('narrow-scroll', 'error', `${tp}.columns`, `Колонки вместе шире ${NARROW_WIDTH} px (${widths}): в узком окне появится горизонтальная прокрутка`, 'раздел 8');
  });
  return out;
}
