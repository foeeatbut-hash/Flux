/**
 * Команды моста к E3.series (docs/e3-integration.md, 4.1) — только типы.
 *
 * Мост ничего не решает: он исполняет простые команды на компьютере инженера.
 * Реализации пока нет (мост — этап C), поэтому окно E3Flux работает против
 * этого интерфейса, а в браузере и без моста честно говорит, что связи нет.
 * Подбор, состояние узла и раскладка считаются в общем модуле `e3/` без COM.
 */

/** Габарит блока на листе, мм */
export interface E3Size { w: number; h: number }
export interface E3Rect extends E3Size { x: number; y: number }

export interface E3SheetInfo {
  /** «А3» */
  format: string;
  /** Размер листа, мм */
  size: E3Size;
  /** Рабочее поле внутри рамки, мм */
  work: E3Rect;
  /** Шаг сетки E3, мм */
  grid: number;
}

export interface E3Status {
  /** Запущенные E3: версия, открытый проект и активный лист */
  instances: { version: string; project?: string; sheet?: string; sheetInfo?: E3SheetInfo; readOnly?: string }[];
}

/** Блок или изделие базы E3: есть ли оно и из чего состоит */
export interface E3PartInfo { name: string; kind: 'block' | 'component' | 'symbol'; contents?: string[]; size?: E3Size }

/** Уже выгруженное: связь узла Flux с тем, что стоит в E3 */
export interface E3BoundBlock {
  /** ID позиции Flux (`FLUX_ID`) */
  positionId: string;
  /** Решение, по которому блок поставлен, и версия классификатора */
  solutionId: string;
  version: string;
  designation: string;
  sheet: string;
  rect: E3Rect;
  /** Версия позиции Flux на момент выгрузки: по ней видно, что узел изменился */
  positionVersion?: string;
  /** Значения атрибутов в E3 отличаются от выгруженных */
  editedInE3?: boolean;
  /** Значения атрибутов блока и его изделий: ключ `<изделие>|<имя>`, у самого блока изделие пусто */
  attrs?: Record<string, string>;
  /** К блоку проведены провода: инженер уже работает с ним, снимать его нельзя */
  wired?: boolean;
}

/**
 * Шаг плана выгрузки (8.2): листы → блоки → обозначения → атрибуты → атрибуты
 * связи. Шаг самодостаточен: мост не знает ни подбора, ни профиля, а только
 * что и куда записать. Номер шага в плане стабилен — по нему журнал выгрузки
 * понимает, что уже сделано, и продолжение не ставит вторых блоков.
 */
export interface E3PlanStep {
  kind: 'place' | 'designation' | 'attribute' | 'link' | 'remove';
  /** ID узла Flux */
  positionId: string;
  /** Словами: что делает шаг (для отчёта) */
  detail: string;
  /** Имя блока решения в базе E3 */
  block?: string;
  rect?: E3Rect;
  /** Отметка выгрузки: по ней продолжение находит блок, у которого ещё нет атрибутов связи */
  mark?: string;
  designation?: string;
  owner?: string;
  name?: string;
  value?: string;
  /** Атрибуты связи: версия узла и номер выгрузки */
  ver?: string;
}
export interface E3StepResult { step: E3PlanStep; ok: boolean; message?: string }

/** E3 отвечает «занято»: открыт диалог, идёт пересчёт */
export class E3BusyError extends Error { constructor(message = 'E3 занят: закройте открытые окна E3') { super(message); this.name = 'E3BusyError'; } }
/** Связь с E3 пропала посреди работы: E3 закрыли или он упал */
export class E3LostError extends Error { constructor(message = 'E3 закрыт во время выгрузки') { super(message); this.name = 'E3LostError'; } }

/**
 * Что мост умеет. Каждая команда — один вызов помощника; всё, что можно
 * посчитать без E3, считается снаружи.
 */
export interface E3Bridge {
  status(): Promise<E3Status>;
  /** Прочитать или поставить `FLUX_PROJECT` — ключ связи проекта E3 с проектом Flux */
  projectKey(set?: string): Promise<string | null>;
  listParts(names?: string[]): Promise<E3PartInfo[]>;
  sheetOccupancy(sheet?: string): Promise<E3Rect[]>;
  readBound(): Promise<E3BoundBlock[]>;
  /** Блоки на временный лист → изображение и габариты (демонстрация) */
  preview(solutionIds: string[]): Promise<{ solutionId: string; size: E3Size; image: string }[]>;
  /** План по шагам; после каждого шага результат уходит в `onStep` */
  apply(steps: E3PlanStep[], onStep: (r: E3StepResult) => void): Promise<void>;
}

/** Связь узла Flux с E3: пустая, пока выгрузки не было */
export interface E3NodeLink {
  /** Выгружен в E3 */
  bound: boolean;
  /** Во Flux изменился после выгрузки (переподбор, тег, профиль, классификатор) */
  changed?: boolean;
  /** Во Flux снят, а в схеме стоит */
  removedInFlux?: boolean;
  /** В E3 значение атрибута отличается от выгруженного */
  editedInE3?: boolean;
  /** Блока решения нет в базе E3 */
  blockMissing?: boolean;
}

/** Состояние связи с E3 для шапки (раздел 10; здесь — те, что бывают без моста) */
export type E3LinkState = 'browser' | 'no-bridge';
export const LINK_TEXT: Record<E3LinkState, string> = {
  browser: 'Выгрузка в E3 — только в настольной версии Flux',
  'no-bridge': 'Связь с E3.series появится в следующем обновлении',
};
