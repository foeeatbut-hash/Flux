/**
 * Переводчик Flux Office: Таблица (Univer). ЗАГОТОВКА контракта — реализует
 * дорожка Таблицы.
 *
 * Ядро (режимы, план вставок, журнал, защита) уже в translation-common.ts:
 * `planSheet` считает вставки столбцов/строк и итоговые адреса, `composeInline`,
 * `validateTarget`, `makeRecord` — общие с Документом. Здесь остаётся то, что
 * знает о книге: чтение ячеек выбранной области и постановка плана в Univer
 * одной группой «назад» (IUndoRedoService.__tempBatchingUndoRedo, как
 * flux:sync-header-schema в sheets-collab.ts).
 *
 * Правила для реализации:
 *   - ключ фрагмента — имя книги FLUX_TR_<id> на исходной ячейке (`s:<id>`),
 *     у ещё не переведённой ячейки временный ключ `n:<лист>!<A1>`; место
 *     перевода (столбец/строка/лист) — имя FLUX_TRT_<id>. Имена сдвигаются
 *     вместе со вставкой строк и столбцов — так защищённые адреса переживают
 *     «соседний столбец» и «строку под оригиналом». Имена создаются вне
 *     истории «назад» (withoutHistory) и вычищаются из шага «назад» так же, как
 *     FLUX_ANCHOR_* (dropAnchorNamesFromHistory);
 *   - ячейки с формулой, числа, ячейки без букв (nothingToTranslate) не
 *     читаются; метки заголовков (FLUX_ANCHOR_*) — только в области «шапка», а
 *     подписи полей внутри них вынимаются знаками chipMarker();
 *   - перед постановкой — checkApplyItems(); любая ошибка при записи — откат
 *     уже записанного и ответ ok:false, книга без изменений.
 */
import type { SheetCell, SheetPlan, TrApplyRequest, TrApplyResult, TrReadRequest, TrReadResult, TrRecord } from './translation-common'

export interface SheetCellData { row: number; col: number; value: unknown; formula?: string }
export interface SheetData { name: string; cells: SheetCellData[] }

/** Снимок книги, нужный чистой части (в тестах — простые данные; в редакторе — из Univer). */
export interface SheetsEnv {
  sheets: SheetData[]
  activeSheet: string
  /** Выделение: прямоугольник на листе. */
  selection?: { sheet: string; r0: number; c0: number; r1: number; c1: number }
  /** Имена книги FLUX_TR_*, FLUX_TRT_*, FLUX_ANCHOR_* → ячейка. */
  names: Record<string, SheetCell>
  now?: number
  randomHex?: (length: number) => string
}

export interface SheetsApplyPlan {
  ok: boolean
  error?: string
  plan?: SheetPlan
  /** Имена, которые нужно создать после вставок (адреса уже итоговые). */
  nameOps?: Array<{ name: string; cell: SheetCell }>
  records: TrRecord[]
  removeRecords: TrRecord[]
  applied: number
  skipped: number
}

/** Чтение области: ячейки → фрагменты со статусом (new/current/stale/detached/replaced). */
export function readSheets(_env: SheetsEnv, _req: TrReadRequest): TrReadResult {
  throw new Error('not implemented: readSheets')
}

/** Проверка запроса и план постановки без изменения книги. */
export function planSheetsApply(_env: SheetsEnv, _req: TrApplyRequest): SheetsApplyPlan {
  throw new Error('not implemented: planSheetsApply')
}

/** Подключение к живой книге: ответ на запросы окна Flux (translation-bridge.ts). */
export interface SheetsTranslator {
  read(req: TrReadRequest): Promise<TrReadResult>
  /** Одна группа «назад»; откат при ошибке; new-file — через Save-As копии (original не тронут). */
  apply(req: TrApplyRequest): Promise<TrApplyResult>
  rollback(stepId: string): Promise<{ ok: boolean; error?: string }>
}
export function createSheetsTranslator(): SheetsTranslator {
  throw new Error('not implemented: createSheetsTranslator')
}
