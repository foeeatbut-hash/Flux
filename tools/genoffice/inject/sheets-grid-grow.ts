/**
 * Бесконечная сетка таблицы, как в Excel: при прокрутке и уменьшении масштаба
 * справа и снизу появляются новые столбцы (…Z, AA, AB…) и строки.
 *
 * Зачем: редактор создаёт лист с минимумом 26 столбцов и 1000 строк, и сетка
 * обрывалась на Z. Менять размер листа при открытии на «как в Excel»
 * (16384 × 1 048 576) нельзя — часть кода обходит каждую клетку листа, и книга
 * зависла бы. Поэтому растим сетку по мере надобности — только вид:
 * мутация идёт с onlyLocal, без записи в «назад» и без отправки соавторам, а
 * пустые столбцы в файл не пишутся (запись берёт данные, а не размер сетки).
 */

/** Пределы Excel: дальше XFD и строки 1 048 576 сетка не растёт */
export const MAX_GRID_COLUMNS = 16384
export const MAX_GRID_ROWS = 1_048_576

/** Сколько клеток оставлять запасом за видимой областью и на сколько расти за раз */
const MARGIN_COLUMNS = 6
const MARGIN_ROWS = 20
const STEP_COLUMNS = 26
const STEP_ROWS = 200

const COLUMN_COUNT_MUTATION = 'sheet.mutation.set-worksheet-column-count'
const ROW_COUNT_MUTATION = 'sheet.mutation.set-worksheet-row-count'

/** Новый размер оси: нужен ли рост и до какого числа. null — расти не надо */
export function nextGridSize(visibleEnd: number, count: number, margin: number, step: number, limit: number): number | null {
  if (!Number.isFinite(visibleEnd) || !Number.isFinite(count) || count >= limit) return null
  if (visibleEnd < count - margin) return null
  // Видимый край мог уйти далеко (сильное уменьшение масштаба): растим сразу до него, а не по шагу
  const wanted = Math.max(count + step, visibleEnd + margin + step)
  return Math.min(limit, wanted)
}

interface GridApi {
  Event: Record<string, string>
  addEvent(name: string, handler: (params: unknown) => void): unknown
  getActiveWorkbook(): any
  syncExecuteCommand(id: string, params: unknown, options?: unknown): unknown
}

/** Подписывается на прокрутку и масштаб; возвращает функцию «проверить сейчас» (для проверок и повторов) */
export function installSheetsGridGrow(api: () => GridApi | undefined): () => number {
  let queued = false

  const check = (): number => {
    const a = api()
    const workbook = a?.getActiveWorkbook?.()
    const sheet = workbook?.getActiveSheet?.()
    if (!a || !workbook || !sheet) return 0
    let grown = 0
    // Несколько кругов: после роста видимый край при малом масштабе может снова упереться в новый край
    for (let round = 0; round < 40; round++) {
      const visible = sheet.getVisibleRange?.()
      if (!visible) break
      const columns = nextGridSize(Number(visible.endColumn), Number(sheet.getMaxColumns()), MARGIN_COLUMNS, STEP_COLUMNS, MAX_GRID_COLUMNS)
      const rows = nextGridSize(Number(visible.endRow), Number(sheet.getMaxRows()), MARGIN_ROWS, STEP_ROWS, MAX_GRID_ROWS)
      if (columns === null && rows === null) break
      const target = { unitId: workbook.getId(), subUnitId: sheet.getSheetId() }
      try {
        if (columns !== null) a.syncExecuteCommand(COLUMN_COUNT_MUTATION, { ...target, columnCount: columns }, { onlyLocal: true })
        if (rows !== null) a.syncExecuteCommand(ROW_COUNT_MUTATION, { ...target, rowCount: rows }, { onlyLocal: true })
      } catch (error) {
        console.warn('[flux] сетка не выросла', error)
        break
      }
      grown++
    }
    return grown
  }

  // Событий прокрутки много: проверяем раз в кадр, а не на каждое
  const schedule = (): void => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => { queued = false; check() })
  }

  const a = api()
  if (a) {
    for (const name of ['Scroll', 'SheetZoomChanged', 'ActiveSheetChanged']) {
      const event = a.Event?.[name]
      if (event) a.addEvent(event, schedule)
    }
  }
  return check
}
