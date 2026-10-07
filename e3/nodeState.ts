/**
 * Состояние узла в списке E3Flux (docs/e3-integration.md, 6.2): один знак на
 * узел. Функция чистая: подбор и связь приходят готовыми, поэтому без E3 (связи
 * пока нет) она работает как «не в схеме / нужен ответ / нельзя выгрузить».
 *
 * Порядок важен: если выбрать решение нельзя, то «в схеме» узлу не помогает —
 * сначала показывается то, что требует действия человека.
 */
import type { E3NodeLink } from './bridgeTypes';
import type { E3Selection } from './solutionTypes';

export type E3NodeStateId = 'not-in-scheme' | 'in-scheme' | 'changed' | 'removed' | 'need-answer' | 'blocked' | 'edited-in-e3';

export const NODE_STATES: Record<E3NodeStateId, { mark: string; title: string; hint: string }> = {
  'not-in-scheme': { mark: '○', title: 'Не в схеме', hint: 'Ещё не выгружался в этот проект E3' },
  'in-scheme': { mark: '●', title: 'В схеме', hint: 'Выгружен, с тех пор не менялся' },
  'changed': { mark: '◐', title: 'Изменился', hint: 'Во Flux изменился после выгрузки: переподбор, тег, профиль или классификатор' },
  'removed': { mark: '✕', title: 'Снят', hint: 'Во Flux снят, а в схеме ещё стоит' },
  'need-answer': { mark: '?', title: 'Нужен ответ', hint: 'Не хватает признака, чтобы выбрать одно решение' },
  'blocked': { mark: '!', title: 'Нельзя выгрузить', hint: 'Решения нет или блока нет в базе E3' },
  'edited-in-e3': { mark: '⇄', title: 'Правлен в E3', hint: 'В E3 значение атрибута отличается от выгруженного' },
};

export function nodeState(selection: Pick<E3Selection, 'status'> | null, link?: E3NodeLink | null): E3NodeStateId {
  if (link?.removedInFlux) return 'removed';
  if (!selection || selection.status === 'none' || link?.blockMissing) return 'blocked';
  if (selection.status === 'many') return 'need-answer';
  if (!link?.bound) return 'not-in-scheme';
  if (link.editedInE3) return 'edited-in-e3';
  return link.changed ? 'changed' : 'in-scheme';
}
