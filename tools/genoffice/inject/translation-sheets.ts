/**
 * Переводчик Flux Office: Таблица (Univer) — чистая часть, без редактора.
 *
 * Ядро (режимы, план вставок, журнал, защита) — в translation-common.ts.
 * Здесь то, что знает о книге как о данных: чтение ячеек выбранной области
 * (`readSheets`) и проверка запроса с планом постановки (`planSheetsApply`).
 * Живую постановку в Univer (одна группа «назад», имена, откат, копия файла)
 * делает translation-sheets-live.ts — он тянет Univer и потому отдельно: этот
 * файл читают и модульные тесты в Node.
 *
 * Правила:
 *   - ключ фрагмента — имя книги FLUX_TR_<id> на исходной ячейке (`s:<id>`),
 *     у ещё не переведённой ячейки временный ключ `n:<лист>!<A1>`; место
 *     перевода — имя FLUX_TRT_<id> (столбец/строка/лист; при замене и в одной
 *     ячейке — та же ячейка). Имена сдвигаются вместе со вставкой строк и
 *     столбцов — так адреса переживают «соседний столбец» и «строку под»;
 *   - ячейки с формулой, числа и ячейки без букв (nothingToTranslate) не
 *     читаются; ячейки-переводы (FLUX_TRT_ в другом месте) не читаются как
 *     оригиналы — иначе повторное чтение переводило бы перевод;
 *   - метки заголовков (FLUX_ANCHOR_*) читаются только в области «шапка»,
 *     подписи полей внутри них вынимаются знаками chipMarker(); сами защищённые
 *     ячейки шапки перезаписывать нельзя, поэтому для них доступны режимы
 *     «соседний столбец / строка под / новый лист»;
 *   - повторное применение того же способа пишет в то же место (без дублей),
 *     другим способом — отказ: иначе рядом остались бы два перевода.
 */
import {
  CHIP_MAX, MAX_UNITS, checkApplyItems, chipMarker, destinationOf, inlineLocation, makeRecord, normalizeText,
  peelTarget, planSheet, recordsByKey, statusOf, supersededBy,
} from './translation-common'
import type { SheetCell, SheetOp, SheetPlan, SheetUnit, TrApplyRequest, TrApplyResult, TrErrorCode, TrMode, TrPreviewItem, TrReadRequest, TrReadResult, TrRecord, TrScope, TrStatus, TrUnit } from './translation-common'
import { nothingToTranslate } from './translation-protect'

/** Часть ячейки шапки: обычный текст или плашка поля Flux (подпись для показа). */
export type SheetPart = { text: string } | { chip: string; fieldKey?: string }
export interface SheetCellData { row: number; col: number; value: unknown; formula?: string; /** Только у ячеек шапки с известными частями. */ parts?: SheetPart[] }
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
  code?: TrErrorCode
  plan?: SheetPlan
  /** Имена, которые нужно создать после вставок (адреса уже итоговые). */
  nameOps?: Array<{ name: string; cell: SheetCell }>
  records: TrRecord[]
  removeRecords: TrRecord[]
  preview?: TrPreviewItem[]
  applied: number
  skipped: number
}

/** Подключение к живой книге: ответ на запросы окна Flux (translation-bridge.ts). */
export interface SheetsTranslator {
  read(req: TrReadRequest): Promise<TrReadResult>
  /** Одна группа «назад»; откат при ошибке; new-file — через Save-As копии (original не тронут). */
  apply(req: TrApplyRequest): Promise<TrApplyResult>
  rollback(stepId: string): Promise<{ ok: boolean; error?: string; code?: TrErrorCode }>
}

/* ── Адреса ───────────────────────────────────────────────────────────── */

export const colLetters = (col: number): string => { let s = ''; for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s }
export const a1Of = (row: number, col: number): string => `${colLetters(col)}${row + 1}`
const cellId = (c: { sheet: string; row: number; col: number }): string => `${c.sheet}\u0000${c.row}\u0000${c.col}`
const SEL_MODES: TrMode[] = ['new-file', 'new-sheet', 'adjacent-column', 'adjacent-row', 'inline-before', 'inline-after', 'replace']
type Family = 'cell' | 'column' | 'row' | 'sheet'
const familyOf = (mode: string): Family | null => (mode === 'replace' || mode === 'new-file' || mode === 'inline-before' || mode === 'inline-after') ? 'cell'
  : mode === 'adjacent-column' ? 'column' : mode === 'adjacent-row' ? 'row' : mode === 'new-sheet' ? 'sheet' : null

/** Куда попадёт ячейка после вставок плана (вставки идут по порядку плана). */
export function shiftThrough(ops: SheetOp[], cell: SheetCell): SheetCell {
  let { row, col } = cell
  for (const op of ops) {
    if (op.op === 'insertColumn' && op.sheet === cell.sheet && col >= op.index) col++
    else if (op.op === 'insertRow' && op.sheet === cell.sheet && row >= op.index) row++
  }
  return { sheet: cell.sheet, row, col }
}

/* ── Просмотр книги ───────────────────────────────────────────────────── */

interface Cand {
  sheet: string; row: number; col: number
  /** Текст ячейки как есть (для предпросмотра). */
  raw: string
  /** Оригинал для перевода: плашки — знаками, у переведённой на месте ячейки — прежний оригинал. */
  source: string
  chips: number
  chipLabels: string[]
  chipKeys: Array<string | undefined>
  anchorId?: string
  id?: string
  record?: TrRecord
  status: TrStatus
  key: string
}

interface Scan { cands: Cand[]; skipped: number; byKey: Map<string, Cand>; cells: Map<string, SheetCellData>; trSource: Map<string, SheetCell>; trTarget: Map<string, SheetCell> }

function scanSheets(env: SheetsEnv, scope: TrScope | 'all', records: TrRecord[], destination: string): Scan {
  const trSource = new Map<string, SheetCell>()
  const trTarget = new Map<string, SheetCell>()
  const idAt = new Map<string, string>()
  const anchorAt = new Map<string, string>()
  for (const [name, cell] of Object.entries(env.names || {})) {
    const tr = /^FLUX_TR_([0-9a-f]+)$/.exec(name)
    const trt = /^FLUX_TRT_([0-9a-f]+)$/.exec(name)
    const anchor = /^FLUX_ANCHOR_(.+)$/.exec(name)
    if (tr) { trSource.set(tr[1]!, cell); idAt.set(cellId(cell), tr[1]!) }
    else if (trt) trTarget.set(trt[1]!, cell)
    else if (anchor) anchorAt.set(cellId(cell), anchor[1]!.replaceAll('_', '-'))
  }
  // Ячейки-переводы: не оригиналы
  const outputs = new Set<string>()
  for (const [id, target] of trTarget) {
    const src = trSource.get(id)
    if (!src || cellId(src) !== cellId(target)) outputs.add(cellId(target))
  }
  const cells = new Map<string, SheetCellData>()
  for (const sheet of env.sheets) for (const c of sheet.cells) cells.set(cellId({ sheet: sheet.name, row: c.row, col: c.col }), c)
  const byRecord = recordsByKey(records, destination)
  const inScope = (sheet: string, c: SheetCellData): boolean => {
    if (scope === 'sheet') return sheet === env.activeSheet
    if (scope === 'selection') { const s = env.selection; return !!s && s.sheet === sheet && c.row >= s.r0 && c.row <= s.r1 && c.col >= s.c0 && c.col <= s.c1 }
    return true
  }
  const cands: Cand[] = []
  const byKey = new Map<string, Cand>()
  let skipped = 0
  for (const sheet of env.sheets) {
    const sorted = [...sheet.cells].sort((a, b) => a.row - b.row || a.col - b.col)
    for (const c of sorted) {
      if (!inScope(sheet.name, c)) continue
      const at = { sheet: sheet.name, row: c.row, col: c.col }
      const where = cellId(at)
      const anchorId = anchorAt.get(where)
      if (scope === 'header' && !anchorId) continue
      if (scope !== 'header' && scope !== 'all' && anchorId) continue
      if (outputs.has(where)) continue
      if (c.formula) { skipped++; continue }
      let text: string
      let chips = 0
      const chipLabels: string[] = []
      const chipKeys: Array<string | undefined> = []
      if (anchorId && c.parts?.length) {
        text = c.parts.map((p) => {
          if ('text' in p) return p.text
          chipLabels.push(p.chip); chipKeys.push(p.fieldKey)
          return chipMarker(chips++)
        }).join('')
      } else if (typeof c.value === 'string') text = c.value
      else continue
      if (!text.trim()) continue
      if (chips > CHIP_MAX || nothingToTranslate(text.replace(/[-]/g, ' '))) { skipped++; continue }
      const id = idAt.get(where)
      const record = id ? byRecord.get(`s:${id}`) : undefined
      let source = text
      let status: TrStatus = 'new'
      if (id && record) {
        if (record.mode === 'replace' || record.mode === 'new-file') {
          if (normalizeText(text) === normalizeText(record.targetText)) { source = record.sourceText; status = 'replaced' } else status = statusOf(record, text, true)
        } else if (record.mode === 'inline-before' || record.mode === 'inline-after') {
          const peeled = peelTarget(text, record)
          if (peeled === null) status = 'detached'
          else { source = peeled; status = statusOf(record, peeled, true) }
        } else {
          const target = trTarget.get(id)
          const there = target ? cells.get(cellId(target)) : undefined
          status = statusOf(record, text, !!there && normalizeText(there.value) !== '')
        }
      }
      const cand: Cand = { ...at, raw: text, source, chips, chipLabels, chipKeys, anchorId, id, record, status, key: id ? `s:${id}` : `n:${sheet.name}!${a1Of(c.row, c.col)}` }
      cands.push(cand)
      byKey.set(cand.key, cand)
    }
  }
  return { cands, skipped, byKey, cells, trSource, trTarget }
}

/** Чтение области: ячейки → фрагменты со статусом (new/current/stale/detached/replaced). */
export function readSheets(env: SheetsEnv, req: TrReadRequest): TrReadResult {
  if (req.scope === 'selection' && !env.selection) return { ok: false, code: 'failed', error: 'Нет выделенной области' }
  const scan = scanSheets(env, req.scope, req.records || [], req.destination || 'en')
  if (scan.cands.length > MAX_UNITS) return { ok: false, code: 'too-many', error: `Фрагментов больше ${MAX_UNITS} — сузьте область` }
  const units: TrUnit[] = scan.cands.map((c) => ({
    key: c.key,
    source: c.source,
    chips: c.chips || undefined,
    location: { kind: 'excel-cell', sheet: c.sheet, row: c.row, col: c.col, address: a1Of(c.row, c.col) },
    status: c.status,
    targetText: c.record?.targetText,
    sourceId: c.anchorId ?? 'text',
    fieldKey: c.chipKeys.find(Boolean),
    displayLabel: c.chipLabels.length ? c.chipLabels.join(' / ') : undefined,
    stale: c.status === 'stale',
  }))
  return { ok: true, units, skipped: scan.skipped }
}

/* ── План постановки ──────────────────────────────────────────────────── */

const fail = (error: string, code: TrErrorCode): SheetsApplyPlan => ({ ok: false, error, code, records: [], removeRecords: [], applied: 0, skipped: 0 })
const codeOfCheck = (message: string): TrErrorCode => /не больше/.test(message) ? 'too-many'
  : /непроверенн/.test(message) ? 'not-confirmed'
  : /плашк|Защищённый|Перевод пуст/.test(message) ? 'protected-changed'
  : /не найден|изменился/.test(message) ? 'source-changed' : 'failed'

/** Проверка запроса и план постановки без изменения книги. */
export function planSheetsApply(env: SheetsEnv, req: TrApplyRequest): SheetsApplyPlan {
  const p = req.placement
  if (!p || !SEL_MODES.includes(p.mode)) return fail(`Режим «${p?.mode}» в Таблице не поддерживается`, 'unsupported-mode')
  const family = familyOf(p.mode)!
  const destination = destinationOf(req.direction)
  const prior = req.records || []
  const scan = scanSheets(env, 'all', prior, destination)
  // Предпросмотр можно просить до подтверждения; постановка без него отказывает
  const items = req.dryRun ? (req.items || []).map((i) => ({ ...i, confirmed: true })) : (req.items || [])
  const bad = checkApplyItems(items, (key) => scan.byKey.get(key)?.chips, (key) => scan.byKey.get(key)?.source)
  if (bad) return fail(bad, codeOfCheck(bad))

  const hex = env.randomHex || ((n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join(''))
  const units: SheetUnit[] = []
  const meta = new Map<string, { cand: Cand; id: string; fresh: boolean; target: string; itemKey: string }>()
  for (const item of items) {
    const cand = scan.byKey.get(item.key)!
    const old = cand.record && familyOf(cand.record.mode)
    if (cand.record && old !== family && cand.status !== 'detached') {
      return fail(`Ячейка ${a1Of(cand.row, cand.col)} уже переведена другим способом (${cand.record.mode}). Отмените прежнюю постановку или выберите тот же способ`, 'failed')
    }
    if (cand.anchorId && family === 'cell') {
      return fail('Подписи полей Flux в самой ячейке шапки защищены. Для шапки выберите соседний столбец, строку под оригиналом или новый лист', 'unsupported-mode')
    }
    if (cand.status === 'detached' && cand.record && (cand.record.mode === 'inline-before' || cand.record.mode === 'inline-after')) {
      return fail(`Ячейка ${a1Of(cand.row, cand.col)} изменена вручную: прежний перевод в ней не найден. Проверьте её и повторите`, 'source-changed')
    }
    const labels = cand.chipLabels.map((label, i) => { const k = cand.chipKeys[i]; return (k && req.displayLabels?.[k]) || label })
    let target = item.targetText
    for (let i = 0; i < cand.chips; i++) target = target.split(chipMarker(i)).join(labels[i] ?? '')
    let id = cand.id || hex(12)
    // Случайный номер не должен совпасть ни с каким уже занятым
    while (!cand.id && (meta.has(`s:${id}`) || scan.trSource.has(id))) id = hex(12)
    const trt = cand.id ? scan.trTarget.get(cand.id) : undefined
    let priorTarget: SheetCell | null = null
    if (trt && cand.record && familyOf(cand.record.mode) === family && family !== 'cell') {
      const okPlace = family === 'sheet' ? trt.sheet !== cand.sheet : trt.sheet === cand.sheet
      if (okPlace && env.sheets.some((s) => s.name === trt.sheet)) priorTarget = trt
    }
    units.push({ key: `s:${id}`, sheet: cand.sheet, row: cand.row, col: cand.col, source: cand.source, target, priorTarget })
    meta.set(`s:${id}`, { cand, id, fresh: !cand.id, target, itemKey: item.key })
  }

  const priorSheets: Record<string, string> = {}
  for (const [id, trt] of scan.trTarget) {
    const src = scan.trSource.get(id)
    if (src && src.sheet !== trt.sheet && env.sheets.some((s) => s.name === trt.sheet)) priorSheets[src.sheet] = trt.sheet
  }
  let plan: SheetPlan
  try { plan = planSheet(units, p, { existingSheets: env.sheets.map((s) => s.name), suffix: req.direction === 'ru-en' ? 'EN' : 'RU', priorSheets }) } catch (e) { return fail(String((e as Error)?.message || e), 'failed') }

  const sets = new Map<string, string>()
  for (const op of plan.ops) if (op.op === 'set') sets.set(cellId(op), op.value)
  const now = env.now ?? Date.now()
  const nameOps: Array<{ name: string; cell: SheetCell }> = []
  const records: TrRecord[] = []
  const preview: TrPreviewItem[] = []
  const inline = p.mode === 'inline-before' || p.mode === 'inline-after'
  for (const u of units) {
    const m = meta.get(u.key)!
    const target = plan.targets[u.key]!
    const srcFinal = shiftThrough(plan.ops, { sheet: u.sheet, row: u.row, col: u.col })
    if (m.fresh) nameOps.push({ name: `FLUX_TR_${m.id}`, cell: srcFinal })
    const existing = m.cand.id ? scan.trTarget.get(m.cand.id) : undefined
    const existingFinal = existing && shiftThrough(plan.ops, existing)
    if (!existingFinal || cellId(existingFinal) !== cellId(target)) nameOps.push({ name: `FLUX_TRT_${m.id}`, cell: target })
    records.push(makeRecord({
      sourceId: m.cand.anchorId ?? 'text', key: u.key, destination, placement: p, source: u.source, target: m.target, time: now,
      targetLocation: { ...(inline ? inlineLocation(p) : {}), kind: 'excel-cell', sheet: target.sheet, row: target.row, col: target.col, address: a1Of(target.row, target.col) },
    }))
    const there = scan.cells.get(cellId(existing || target))
    preview.push({
      key: m.itemKey,
      location: { kind: 'excel-cell', sheet: target.sheet, row: target.row, col: target.col, address: a1Of(target.row, target.col), source: a1Of(m.cand.row, m.cand.col) },
      before: family === 'cell' ? m.cand.raw : (u.priorTarget ? String(there?.value ?? '') : ''),
      after: sets.get(cellId(target)) ?? '',
      target: p.mode === 'new-file' ? 'new-file' : family === 'cell' ? 'same' : family === 'sheet' ? 'new-sheet' : 'new-cell',
    })
  }
  return { ok: true, plan, nameOps, records, removeRecords: supersededBy(prior.filter((r) => r.destination === destination), records), preview, applied: units.length, skipped: scan.skipped }
}
