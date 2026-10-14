/**
 * Переводчик Flux Office: Таблица (Univer) — подключение к живой книге.
 *
 * Чистая часть (чтение, план, журнал) — в translation-sheets.ts. Здесь то, что
 * касается Univer:
 *   - снимок книги для чистой части (ячейки, имена FLUX_TR_/FLUX_TRT_/FLUX_ANCHOR_*, выделение);
 *   - постановка плана ОДНОЙ группой «назад» (IUndoRedoService.__tempBatchingUndoRedo,
 *     как flux:sync-header-schema в sheets-collab.ts): вставки, новый лист, значения;
 *   - имена FLUX_*: создаются и сдвигаются вне истории «назад», потому что у
 *     имени внутренний номер, и отмена по старому номеру после записи книги
 *     оставляла бы в книге два одинаковых имени. Вместо этого к шагу «назад»
 *     привязаны два снимка имён (до и после), и когда шаг уходит в «вперёд»
 *     или возвращается, имена выставляются по снимку, а не по номерам;
 *   - откат только своего верхнего шага (иначе cannot-rollback);
 *   - «новый файл»: правки ставятся одним шагом, ответ несёт copyRequest {saved:false} и stepId;
 *     копию сохраняет окно Flux (Save-As), затем откатывает шаг — оригинал не тронут;
 *   - каналы flux:translation-*-request → flux:translation-read|applied|rolled-back.
 */
import { IUndoRedoService } from '@univerjs/core'
import { colLetters, planSheetsApply, readSheets } from './translation-sheets'
import type { SheetCellData, SheetData, SheetPart, SheetsEnv, SheetsTranslator } from './translation-sheets'
import type { SheetCell, TrApplyRequest, TrApplyResult, TrErrorCode, TrReadRequest, TrReadResult } from './translation-common'
import { TRANSLATION_CHANNELS } from './translation-bridge'

type Names = Record<string, string>
interface Mutation { id?: string; params?: { name?: string } }
interface Step { undoMutations: Mutation[]; redoMutations: Mutation[] }
interface UndoService { _undoStacks?: Map<string, Step[]>; _redoStacks?: Map<string, Step[]>; undoRedoStatus$?: { subscribe: (fn: () => void) => { unsubscribe: () => void } }; __tempBatchingUndoRedo(unitId: string): { dispose(): void } }

const hooks = (): { univerRef: { current: any }; lazyWorkbookRef: { current: any }; } | undefined => (window as any).__fluxSheets
const api = () => hooks()?.univerRef.current?.univerAPI
const workbook = (): any => { try { return api()?.getActiveWorkbook() || null } catch { return null } }
const undoService = (): UndoService | undefined => hooks()?.univerRef.current?.univer?.__getInjector?.().get(IUndoRedoService)
const plain = (value: unknown): string => String(value ?? '').trim().replace(/^=/, '')
const quoteSheet = (name: string): string => `'${name.replace(/'/g, "''")}'`
const refOf = (cell: SheetCell): string => `${quoteSheet(cell.sheet)}!$${colLetters(cell.col)}$${cell.row + 1}`
const hex = (n: number): string => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => (b & 15).toString(16)).join('')

function parseRef(ref: string): SheetCell | null {
  const m = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(plain(ref))
  if (!m) return null
  let col = 0
  for (const letter of m[3]!.toUpperCase()) col = col * 26 + letter.charCodeAt(0) - 64
  return { sheet: (m[1] ?? m[2] ?? '').replace(/''/g, "'"), row: Number(m[4]) - 1, col: col - 1 }
}

/* ── Снимок книги ─────────────────────────────────────────────────────── */

const textOf = (cell: any): unknown => {
  const stream = cell?.p?.body?.dataStream
  if (typeof stream === 'string') return stream.replace(/\r\n$/, '').replace(/\r/g, '\n')
  return cell?.v
}

function nameRefs(wb: any, prefix: string): Names {
  const out: Names = {}
  try {
    for (const defined of wb.getDefinedNames?.() || []) {
      const name = String(defined?.getName?.() || '')
      if (name.startsWith(prefix)) out[name] = plain(defined?.getRef?.() ?? defined?.getFormulaOrRefString?.())
    }
  } catch { /* книга ещё не готова */ }
  return out
}

/** Части ячейки шапки, известные редактору (sheets-collab.ts): подпись поля — плашкой. */
function headerParts(anchorId: string, shown: unknown): SheetPart[] | undefined {
  const parts = (window as any).__fluxHeaderParts?.(anchorId) as any[] | null | undefined
  if (!Array.isArray(parts) || !parts.length) return undefined
  const label = (b: any): string => String(b?.label || b?.displayName || b?.fieldKey || '')
  const out: SheetPart[] = []
  for (const part of parts) {
    if (part?.kind === 'text') out.push({ text: String(part.text || '') })
    else if (part?.kind === 'operator') out.push({ text: String(part.operator || '') })
    else if (part?.kind === 'field') out.push({ chip: label(part.binding), fieldKey: part.binding?.fieldKey })
    else if (part?.kind === 'union') out.push({ chip: String(part.label || (part.alternatives || []).map(label).join(' / ')), fieldKey: part.alternatives?.[0]?.fieldKey })
  }
  const rendered = out.map((p) => ('text' in p ? p.text : p.chip)).join('')
  // Ячейку правили руками после схемы — частям верить нельзя
  return rendered === String(shown ?? '') ? out : undefined
}

function snapshot(wb: any): SheetsEnv {
  const refs = nameRefs(wb, 'FLUX_')
  const names: Record<string, SheetCell> = {}
  for (const [name, ref] of Object.entries(refs)) {
    if (!/^FLUX_(?:TR_|TRT_|ANCHOR_)/.test(name)) continue
    const cell = parseRef(ref)
    if (cell) names[name] = cell
  }
  const anchorAt = new Map<string, string>()
  for (const [name, cell] of Object.entries(names)) {
    const m = /^FLUX_ANCHOR_(.+)$/.exec(name)
    if (m) anchorAt.set(`${cell.sheet}\u0000${cell.row}\u0000${cell.col}`, m[1]!.replaceAll('_', '-'))
  }
  const sheets: SheetData[] = []
  for (const fs of wb.getSheets()) {
    const name = String(fs.getSheetName())
    const cells: SheetCellData[] = []
    fs.getSheet().getCellMatrix().forValue((row: number, col: number, cell: any) => {
      if (!cell) return undefined
      const formula = cell.f || cell.si ? String(cell.f || '=') : undefined
      const value = textOf(cell)
      if (!formula && (value === undefined || value === null || value === '')) return undefined
      const data: SheetCellData = { row, col, value, ...(formula ? { formula } : {}) }
      const anchorId = anchorAt.get(`${name}\u0000${row}\u0000${col}`)
      if (anchorId && !formula) { const parts = headerParts(anchorId, value); if (parts) data.parts = parts }
      cells.push(data)
      return undefined
    })
    sheets.push({ name, cells })
  }
  const active = wb.getActiveSheet()
  let selection: SheetsEnv['selection']
  try {
    const r = active?.getSelection?.()?.getActiveRange?.()?.getRange?.()
    if (r) selection = { sheet: String(active.getSheetName()), r0: r.startRow, c0: r.startColumn, r1: r.endRow, c1: r.endColumn }
  } catch { /* выделения нет */ }
  return { sheets, activeSheet: String(active?.getSheetName?.() || ''), selection, names, randomHex: hex }
}

/* ── Имена вне истории «назад» ────────────────────────────────────────── */

const isFluxNameMutation = (m: Mutation): boolean => /^formula\.mutation\.(?:set|remove)-defined-name$/.test(String(m.id)) && String(m.params?.name ?? '').startsWith('FLUX_')

/** Записи имён в «назад» не кладём (см. шапку): что успело попасть в шаг — выбрасываем. */
function withoutHistory<T>(wb: any, run: () => T): T {
  const stack = undoService()?._undoStacks?.get(wb.getId())
  const before = stack?.length ?? 0
  const top = before ? stack![before - 1]! : null
  const undoLength = top?.undoMutations.length ?? 0
  const redoLength = top?.redoMutations.length ?? 0
  // Любая запись в «назад» очищает «вперёд»; имена возвращаются после отмены, и повтор нужен целым
  const redo = undoService()?._redoStacks?.get(wb.getId())
  const redoKept = redo ? [...redo] : []
  try { return run() } finally {
    if (redo) { redo.length = 0; redo.push(...redoKept) }
    if (stack && stack.length > before) stack.length = before
    if (top) { top.undoMutations.length = undoLength; top.redoMutations.length = redoLength }
  }
}

function putName(wb: any, name: string, ref: string): void {
  const existing = wb.getDefinedName?.(name)
  if (!existing) { wb.insertDefinedName(name, ref); return }
  if (plain(existing.getRef?.() ?? existing.getFormulaOrRefString?.()).replace(/'/g, '') === plain(ref).replace(/'/g, '')) return
  existing.setRef(ref)
}

/** Имена FLUX_ — как в снимке; те, что есть только сейчас, удаляются. Меняются лишь `names`. */
function restoreNames(wb: any, target: Names, names: Iterable<string>): void {
  withoutHistory(wb, () => {
    for (const name of names) {
      const want = target[name]
      try {
        if (want === undefined) { if (wb.getDefinedName?.(name)) wb.deleteDefinedName?.(name) } else putName(wb, name, want)
      } catch (error) { console.warn('[flux] имя перевода не восстановлено', name, error) }
    }
  })
}

/* ── Шаги «назад», поставленные переводчиком ──────────────────────────── */

interface Tracked { id: string; step: Step; before: Names; after: Names; where: 'undo' | 'redo' | 'gone' }
const tracked: Tracked[] = []
let watching = false

function stacksOf(wb: any): { undo: Step[]; redo: Step[] } {
  const service = undoService()
  const id = wb.getId()
  return { undo: service?._undoStacks?.get(id) || [], redo: service?._redoStacks?.get(id) || [] }
}

function scanTracked(): void {
  const wb = workbook()
  if (!wb) return
  const { undo, redo } = stacksOf(wb)
  for (const t of tracked) {
    const where = undo.includes(t.step) ? 'undo' : redo.includes(t.step) ? 'redo' : 'gone'
    if (where === t.where) continue
    t.where = where
    if (where === 'redo') restoreNames(wb, t.before, new Set([...Object.keys(t.before), ...Object.keys(t.after)]))
    else if (where === 'undo') restoreNames(wb, t.after, new Set([...Object.keys(t.before), ...Object.keys(t.after)]))
  }
  for (let i = tracked.length - 1; i >= 0; i--) if (tracked[i]!.where === 'gone') tracked.splice(i, 1)
}

function watch(): void {
  if (watching) return
  watching = true
  let subscribed: unknown
  const ensure = (): void => {
    const status = undoService()?.undoRedoStatus$
    if (status && status !== subscribed) { subscribed = status; status.subscribe(() => setTimeout(scanTracked, 0)) }
  }
  ensure()
  // Подстраховка: сервис пересоздаётся вместе с книгой
  setInterval(() => { ensure(); scanTracked() }, 300)
}

/* ── Постановка ───────────────────────────────────────────────────────── */

const ready = (): boolean => {
  const lazy = hooks()?.lazyWorkbookRef.current
  return !!lazy && (!lazy.flags || lazy.flags.preloadComplete === true) && !!workbook()
}
const codeOf = (error: unknown): TrErrorCode => /только для чтения/.test(String((error as Error)?.message || error)) ? 'read-only' : 'failed'

async function undoOwn(wb: any, entry: Tracked): Promise<boolean> {
  const { undo } = stacksOf(wb)
  if (undo[undo.length - 1] !== entry.step) return false
  await api().undo()
  scanTracked()
  return true
}

export function createSheetsTranslator(): SheetsTranslator {
  let busy = false
  watch()

  /** Группа «назад»: вставки, листы, значения; имена — после, вне истории. */
  async function place(wb: any, req: TrApplyRequest): Promise<{ ok: true; result: TrApplyResult; entry: Tracked } | { ok: false; result: TrApplyResult }> {
    const planned = planSheetsApply(snapshot(wb), req)
    if (!planned.ok || !planned.plan) return { ok: false, result: { ok: false, error: planned.error, code: planned.code } }
    if (req.dryRun) return { ok: false, result: { ok: true, preview: planned.preview, applied: planned.applied, skipped: planned.skipped } }
    const namesBefore = nameRefs(wb, 'FLUX_')
    const active = wb.getActiveSheet()?.getSheetName()
    const { undo } = stacksOf(wb)
    const depth = undo.length
    const batch = undoService()!.__tempBatchingUndoRedo(wb.getId())
    let failure: unknown
    // Univer дописывает «назад» операций группы подряд (в прямом порядке), а откатывать их надо
    // в обратном: сначала значения, потом вставленные столбцы. Куски по операциям запоминаем и
    // после группы складываем в обратном порядке
    const segments: Mutation[][] = []
    let taken = 0
    try {
      for (const op of planned.plan.ops) {
        if (op.op === 'createSheet') wb.insertSheet(op.name)
        else {
          const sheet = wb.getSheetByName?.(op.sheet) || wb.getSheets().find((s: any) => s.getSheetName() === op.sheet)
          if (!sheet) throw new Error(`Лист «${op.sheet}» не найден`)
          if (op.op === 'insertColumn') sheet.insertColumns(op.index, 1)
          else if (op.op === 'insertRow') sheet.insertRows(op.index, 1)
          else sheet.getRange(op.row, op.col, 1, 1).setValues([[{ v: op.value, t: 1 }]])
        }
        const group = stacksOf(wb).undo[depth]
        if (group) { segments.push(group.undoMutations.slice(taken)); taken = group.undoMutations.length }
      }
    } catch (error) { failure = error } finally { batch.dispose() }
    const grew = stacksOf(wb).undo.length > depth
    const step = grew ? stacksOf(wb).undo.at(-1)! : null
    try { if (active && wb.getActiveSheet()?.getSheetName() !== active) wb.setActiveSheet(wb.getSheetByName(active)) } catch { /* вид не важен */ }
    if (!failure && step) {
      try {
        step.undoMutations = segments.reverse().flat()
        // Метки Flux сдвигаются Univer-ом вместе со вставкой; в шаг «назад» они не входят (см. шапку)
        step.undoMutations = step.undoMutations.filter((m) => !isFluxNameMutation(m))
        step.redoMutations = step.redoMutations.filter((m) => !isFluxNameMutation(m))
        withoutHistory(wb, () => { for (const op of planned.nameOps || []) putName(wb, op.name, refOf(op.cell)) })
      } catch (error) { failure = error }
    }
    if (failure || !step) {
      // Ничего не оставляем: свой шаг отменяем, имена возвращаем по снимку
      if (step) { try { await api().undo() } catch { /* ниже имена всё равно вернутся */ } }
      restoreNames(wb, namesBefore, new Set([...Object.keys(namesBefore), ...Object.keys(nameRefs(wb, 'FLUX_'))]))
      return { ok: false, result: { ok: false, error: String((failure as Error)?.message || failure || 'Постановка не изменила книгу'), code: codeOf(failure) } }
    }
    const entry: Tracked = { id: `tr-${hex(10)}`, step, before: namesBefore, after: nameRefs(wb, 'FLUX_'), where: 'undo' }
    tracked.push(entry)
    return { ok: true, entry, result: { ok: true, records: planned.records, removeRecords: planned.removeRecords, stepId: entry.id, applied: planned.applied, skipped: planned.skipped } }
  }

  return {
    async read(req: TrReadRequest): Promise<TrReadResult> {
      if (busy) return { ok: false, code: 'busy', error: 'Постановка перевода ещё идёт' }
      const wb = workbook()
      if (!wb || !ready()) return { ok: false, code: 'not-ready', error: 'Книга ещё загружается' }
      try { return readSheets(snapshot(wb), req) } catch (error) { return { ok: false, code: 'failed', error: String((error as Error)?.message || error) } }
    },

    async apply(req: TrApplyRequest): Promise<TrApplyResult> {
      if (busy) return { ok: false, code: 'busy', error: 'Постановка перевода уже идёт' }
      const wb = workbook()
      if (!wb || !ready()) return { ok: false, code: 'not-ready', error: 'Книга ещё загружается' }
      busy = true
      try {
        const placed = await place(wb, req)
        if (!placed.ok) return placed.result
        // Новый файл: правки поставлены, копию сохраняет окно Flux ("Сохранить как" с именем и
        // подготовленными сведениями перевода: saved:false) и затем откатывает шаг по stepId —
        // оригинал на диске и в окне остаётся прежним
        if (req.placement.mode === 'new-file') return { ...placed.result, copyRequest: { kind: 'sheets-save-as', saved: false } }
        return placed.result
      } catch (error) {
        return { ok: false, code: codeOf(error), error: String((error as Error)?.message || error) }
      } finally { busy = false }
    },

    async rollback(stepId: string): Promise<{ ok: boolean; error?: string; code?: TrErrorCode }> {
      if (busy) return { ok: false, code: 'busy', error: 'Постановка перевода ещё идёт' }
      const wb = workbook()
      const entry = tracked.find((t) => t.id === stepId)
      if (!wb || !entry) return { ok: false, code: 'cannot-rollback', error: 'Этот шаг уже нельзя отменить автоматически: нажмите «Назад» вручную' }
      if (entry.where === 'redo') return { ok: true }
      busy = true
      try {
        if (await undoOwn(wb, entry)) return { ok: true }
        return { ok: false, code: 'cannot-rollback', error: 'После перевода были другие правки: отмените их или нажмите «Назад» вручную' }
      } catch (error) { return { ok: false, code: 'failed', error: String((error as Error)?.message || error) } } finally { busy = false }
    },
  }
}

/* ── Каналы окна Flux ─────────────────────────────────────────────────── */

export function installSheetsTranslationBridge(translator: SheetsTranslator): void {
  const ipc = (window as any).__fluxIpc as { on(c: string, fn: (e: unknown, ...a: any[]) => void): unknown; send(c: string, ...a: unknown[]): void } | undefined
  if (!ipc) return
  const channels = TRANSLATION_CHANNELS.sheets
  const answer = (channel: string, request: any, work: (body: any) => Promise<object>): void => {
    const body = request?.payload ?? request ?? {}
    const requestId = request?.requestId ?? body?.requestId
    work(body).then((result) => ipc.send(channel, requestId === undefined ? result : { ...result, requestId }), (error) => ipc.send(channel, { ok: false, code: 'failed', error: String(error?.message || error), ...(requestId === undefined ? {} : { requestId }) }))
  }
  ipc.on(channels.read.event, (_e, request) => answer(channels.read.answer, request, (body) => translator.read(body)))
  ipc.on(channels.apply.event, (_e, request) => answer(channels.apply.answer, request, (body) => translator.apply(body)))
  ipc.on(channels.rollback.event, (_e, request) => answer(channels.rollback.answer, request, (body) => translator.rollback(String(body?.stepId || ''))))
}

/** Подключение при загрузке редактора; translator доступен и напрямую: window.__fluxTranslation. */
const translator = createSheetsTranslator()
;(window as any).__fluxTranslation = translator
// Для проверок: что лежит в стеках «назад» и «вперёд»
;(translator as any).debug = () => {
  const wb = workbook()
  const { undo, redo } = stacksOf(wb)
  const sum = (steps: Step[]) => steps.map((s) => ({ undo: s.undoMutations.map((m) => m.id), redo: s.redoMutations.length }))
  return { undo: sum(undo), redo: sum(redo), tracked: tracked.map((t) => [t.id, t.where]) }
}
installSheetsTranslationBridge(translator)
