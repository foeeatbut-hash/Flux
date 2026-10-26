/**
 * Что в документе устарело относительно данных проекта: общий договор сервера
 * (server/officeChanges.ts) и панели Flux (FluxChangesList). Одна запись — одно
 * значение в одной ячейке: «где · было → стало».
 */
export type OfficeChangeKind =
  /** Значение в источнике другое */
  | 'changed'
  /** У позиции появилось значение, которого в документе не было */
  | 'added'
  /** В источнике значения больше нет; документ его не стирает */
  | 'cleared'
  /** Позиции больше нет в источнике; строка в документе остаётся */
  | 'row-removed';

export interface OfficeChange {
  kind: OfficeChangeKind;
  entityId: string;
  /** Тег или наименование позиции — по чему человек узнаёт строку */
  entityLabel: string;
  anchorId: string;
  /** Заголовок колонки так, как он виден в документе */
  column: string;
  /** Лист и ячейка (Таблица); у Документа — пусто, место называет entityLabel и column */
  sheet?: string;
  address?: string;
  /** Документ: закладка строки таблицы, к которой редактор может перейти */
  bookmark?: string;
  was: string | null;
  now: string | null;
  unit?: string;
  /** Значение в ячейке правили руками: «Обновить» эту строку не заменит */
  manual?: boolean;
}

export interface OfficeChangesResult {
  /** Есть ли расхождения с источником */
  stale: boolean;
  count: number;
  /** Сколько строк документа проверено */
  rows: number;
  changes: OfficeChange[];
  checkedAt: string;
}
