/**
 * Палитра компонентов формы и методология к ней.
 *
 * Состав палитры — то, что рисует форма программы во Flux (modules/runtime/form.ts): группа с
 * полями, поле, поле-код, таблица, колонка. «Когда применять» и пример берутся из выписки
 * methodology.generated.ts (раздел 5 docs/methodology/01-design.md), здесь только связь
 * компонента с подразделом и строкой таблицы.
 */
import { METHODOLOGY } from './methodology.generated';
import type { ComponentKind } from './formModel';

/** Текст методологии для экрана: без разметки markdown (обратные кавычки, ссылки) */
export const plain = (text: string) => text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`/g, '');

export interface PaletteItem {
  kind: ComponentKind;
  title: string;
  /** Одна строка под названием: чем компонент отличается */
  summary: string;
  /** Подразделы раздела 5, откуда берётся «когда применять» */
  sections: string[];
  /** Строка таблицы раздела 5, откуда берётся пример (по началу названия) */
  row: string;
}

export const PALETTE: PaletteItem[] = [
  { kind: 'group', title: 'Группа', summary: 'Заголовок и поля под ним', sections: ['Настройки'], row: 'Группа и строка настройки' },
  { kind: 'field', title: 'Поле', summary: 'Подпись и значение из привязки', sections: ['Форма'], row: 'Поле, подпись' },
  { kind: 'code-field', title: 'Поле-код', summary: 'Значение моноширинным: код, тег', sections: ['Форма'], row: 'Поле, подпись' },
  { kind: 'table', title: 'Таблица', summary: 'Список из данных Flux по колонкам', sections: ['Таблица'], row: 'Таблица' },
  { kind: 'column', title: 'Колонка', summary: 'Одно поле элемента списка', sections: ['Таблица'], row: 'Таблица' },
];

export interface Guidance { when: string[]; example: string; source: string }

/** Тексты для карточки компонента: всё из методологии, ничего не набрано руками */
export function guidanceFor(item: PaletteItem): Guidance {
  const when = item.sections.flatMap(name => METHODOLOGY.sections[name] ?? []);
  if (item.kind === 'code-field' || item.kind === 'column') when.push(METHODOLOGY.fontRule);
  const shown = when.map(plain);
  const row = METHODOLOGY.components.find(component => component.what.startsWith(item.row));
  const example = row ? `${row.what}: ${row.cls}${row.component !== '—' ? `; ${row.component}` : ''}` : '';
  return { when: shown, example, source: `${METHODOLOGY.source}, раздел 5` };
}

/** Сводка правил оформления для вкладки «Правила»: раздел 6 и список раздела 8 */
export const RULES = {
  text: METHODOLOGY.textRules.map(plain),
  checklist: METHODOLOGY.checklist.map(plain),
  source: METHODOLOGY.source,
};
