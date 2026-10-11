/**
 * Типы Flux Guide: сообщения, карточки, действия.
 *
 * Ответ Guide всегда собран из проверенных частей: короткий вывод сверху,
 * ниже — данные в том виде, в каком они понятны для запроса (карточка, таблица,
 * список), источник и кнопки. Ничего не генерируется: всё приходит из
 * справочника или адресных выборок сервера.
 */

export type GuideActionKind =
  | 'navigate'      // открыть раздел программы
  | 'open-article'  // открыть статью справочника
  | 'tour'          // запустить обучающий сценарий
  | 'ask'           // задать уточняющий вопрос
  | 'focus-tag'     // открыть Теги на конкретном теге
  | 'focus-equipment' // открыть Оборудование на позиции
  | 'open-export'   // открыть штатную Выгрузку данных
  | 'export-table'  // выгрузить таблицу ответа в Excel
  | 'clarify';      // уточнение — подставить вариант в строку вопроса

export interface GuideAction {
  kind: GuideActionKind;
  label: string;
  route?: string;
  articleId?: string;
  tourId?: string;
  query?: string;
  tagId?: string;
  code?: string;
  componentId?: string;
  specKey?: string;
}

export interface GuideTable {
  title: string;
  columns: string[];
  rows: string[][];
  total?: number;
  note?: string;
}

export interface GuideCard {
  kind: 'tag' | 'component' | 'project' | 'info';
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  fields: Array<{ label: string; value: string }>;
  action?: GuideAction;
}

export interface GuideList {
  items: Array<{
    id: string;
    title: string;
    subtitle?: string;
    badge?: string;
    action?: GuideAction;
    actions?: GuideAction[];
  }>;
}

export interface GuideClarify {
  question: string;
  options: Array<{ label: string; detail?: string; query?: string; value?: string }>;
}

export interface GuideSource {
  label: string;
  at: string;
  articleId?: string;
  articleTitle?: string;
}

export interface GuideMessage {
  id: string;
  role: 'user' | 'guide';
  text: string;
  /** Короткий вывод — то, что отвечает на вопрос одной фразой */
  outcome?: string;
  actions?: GuideAction[];
  table?: GuideTable;
  cards?: GuideCard[];
  list?: GuideList;
  clarify?: GuideClarify;
  source?: GuideSource;
  status?: 'ok' | 'no-match' | 'permission' | 'unavailable' | 'need-project';
  /** Структурированный контекст для продолжения вопроса («их», «а без тегов», «выгрузи») */
  context?: {
    intent: string; label: string; projectId: string;
    equipmentType?: string; untagged?: boolean; missingField?: string;
    query?: string; systemName?: string; field?: string; code?: string; total?: number;
  };
}

export const uid = (): string => `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
