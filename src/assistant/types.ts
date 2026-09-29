/**
 * Из чего состоит ответ помощника.
 *
 * Типы вынесены из хранилища сюда, потому что собирают ответ уже не только
 * оно: своё сообщение отдают и разбор вопроса к руководству, и поиск по
 * почте. Держать описание ответа в хранилище значило бы, что каждый, кто
 * умеет отвечать, обязан от хранилища зависеть, — а зависимость должна идти
 * ровно наоборот.
 */

export interface AssistantAction {
  label: string;
  kind: 'tour' | 'export-excel' | 'export-word' | 'navigate' | 'ask'
      | 'focus-tag' | 'find-duplicates' | 'create-note' | 'open-section'
      | 'focus-equipment' | 'prompt-rename-tag' | 'cancel-input' | 'where-used';
  tourId?: string;
  route?: string;
  query?: string;
  tagId?: string;   // для focus-tag / prompt-rename-tag
  code?: string;    // для find-duplicates / prompt-rename-tag (текущий код)
  noteTitle?: string; // для create-note
  componentId?: string; // для focus-equipment: какой элемент открыть
  /** Для where-used: вид объекта и его номер — панель связей открывает разговор */
  usageKind?: string;
  usageId?: string;
  specKey?: string;     // для focus-equipment: какую характеристику подсветить
  danger?: boolean;     // акцент опасного действия
}

export interface AssistantTable {
  columns: string[];
  rows: (string | number)[][];
  title: string;
}

/** Интерактивный элемент списка (например, тег-дубликат с кнопками действий) */
export interface AssistantListItem {
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  actions: AssistantAction[];
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  actions?: AssistantAction[];
  table?: AssistantTable;
  list?: AssistantListItem[];
}

export const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/** Короткий помощник для сборки ответа. */
export const say = (text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage =>
  ({ id: uid(), role: 'assistant', text, ...extra });

// Ожидание ввода в диалоге: следующая реплика пользователя — не запрос,
// а значение для начатого действия (например, новый код переименовываемого тега)
export type PendingInput =
  | { kind: 'rename-tag'; tagId: string; oldCode: string }
  | null;

// Последний результат — для follow-up вопросов («а сколько их?», «выгрузи», «первый на холсте»)
export interface LastResult {
  kind: 'tags' | 'components' | 'duplicates';
  ids: string[];
  label: string;
}

// Преобразование подсказки раздела в кнопку-действие сообщения
export function toAction(s: { label: string; kind: 'ask' | 'tour'; query?: string; tourId?: string }): AssistantAction {
  return s.kind === 'tour'
    ? { label: s.label, kind: 'tour', tourId: s.tourId }
    : { label: s.label, kind: 'ask', query: s.query };
}
