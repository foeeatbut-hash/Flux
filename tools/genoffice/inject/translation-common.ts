/**
 * Переводчик Flux Office: общее ядро для Документа и Таблицы.
 *
 * Здесь только чистые функции, без редактора и DOM: сборка кладёт файл в оба
 * редактора (tools/genoffice/build.mjs), а модульные тесты читают его прямо из
 * репозитория (scripts/test-translation-placement.ts). Сам перевод текста идёт
 * в окне Flux существующим движком и памятью (src/translate/*); редактор лишь
 * читает фрагменты и ставит готовый перевод по выбранному режиму.
 *
 * Что здесь решено и почему:
 *   - устаревание перевода определяется по хешу ИСХОДНОГО текста, записанному
 *     вместе с переводом: правка пробелов не считается правкой, правка слова —
 *     считается, и повторное применение заменяет прежний перевод, а не
 *     дописывает второй;
 *   - плашки параметров Flux и прочие атомы абзаца уходят в перевод как
 *     служебные знаки из области частного использования и обязаны вернуться
 *     ровно по одному разу — иначе применение отклоняется целиком;
 *   - технические фрагменты (коды, числа, размеры) проверяются тем же
 *     защитным алгоритмом, что и обычный переводчик (translation-protect.ts —
 *     копия src/translate/protect.ts, второго алгоритма нет).
 */
import { protect } from './translation-protect'

export type TrApp = 'docs' | 'sheets'
export type TrScope = 'document' | 'sheet' | 'selection' | 'header'
export type TrMode =
  | 'new-file' | 'new-page' | 'after-paragraph' | 'inline-before' | 'inline-after' | 'replace'
  | 'new-sheet' | 'adjacent-column' | 'adjacent-row'

/** Каноническая форма команды окна Flux (src/translate/placement.ts: toRuntimePlacement). */
export interface TrPlacement {
  mode: TrMode
  scope: TrScope
  separator: 'newline' | 'custom'
  customSeparator?: string
  order: 'source-first' | 'target-first'
  sourceRevision: string
}

/** Запись журнала перевода в части Flux файла (server/officeBindings.ts). */
export interface TrRecord {
  sourceId: string
  key: string
  destination: string
  revision: string
  time: number
  mode: string
  scope: string
  targetLocation: Record<string, unknown>
  targetText: string
  sourceText: string
  /** Хеш исходного текста на момент перевода: по нему находят устаревшие переводы. */
  sourceHash: string
}

export type TrStatus = 'new' | 'current' | 'stale' | 'detached' | 'replaced'

/** Предел числа фрагментов за одно чтение: больше — человек сужает область. */
export const MAX_UNITS = 2000

/* ── Хеш и сравнение исходного текста ─────────────────────────────────── */

/** Пробелы и переносы не считаются правкой исходника. */
export function normalizeText(text: unknown): string {
  return String(text ?? '').replace(/[\s ]+/g, ' ').trim()
}

/** 64 бита из двух 32-битных хешей: коротко, детерминированно, без криптографии. */
export function sourceHash(text: unknown): string {
  let a = 2166136261
  let b = 5381
  for (const c of normalizeText(text)) {
    const n = c.codePointAt(0)!
    a = Math.imul(a ^ n, 16777619)
    b = Math.imul(b, 33) ^ n
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`
}

/** Состояние перевода относительно текущего исходника. targetPresent: null — не проверялось. */
export function statusOf(record: TrRecord | undefined, currentSource: string, targetPresent: boolean | null): TrStatus {
  if (!record) return 'new'
  if (sourceHash(currentSource) !== record.sourceHash) return 'stale'
  if (targetPresent === false) return 'detached'
  return 'current'
}

/* ── Разделитель и порядок ────────────────────────────────────────────── */

/** Перенос строки — как есть; остальные знаки обрамляются пробелами, если свой разделитель не задал их сам. */
export function separatorOf(p: Pick<TrPlacement, 'separator' | 'customSeparator'>): string {
  if (p.separator === 'newline') return '\n'
  const raw = String(p.customSeparator ?? '/').slice(0, 30)
  if (!raw) return ' '
  if (/^\s|\s$/.test(raw)) return raw
  return ` ${raw} `
}

/** Перевод идёт первым: режим «перед» или выбранный порядок «перевод → оригинал». */
export function targetFirst(p: Pick<TrPlacement, 'mode' | 'order'>): boolean {
  if (p.mode === 'inline-before') return true
  if (p.mode === 'inline-after') return false
  return p.order === 'target-first'
}

/** Текст «внутри той же ячейки или строки» из оригинала и перевода. */
export function composeInline(source: string, target: string, p: TrPlacement): string {
  const sep = separatorOf(p)
  return targetFirst(p) ? `${target}${sep}${source}` : `${source}${sep}${target}`
}

/** Как был расположен перевод в строке — записывается в targetLocation и нужен, чтобы позже отделить его от оригинала. */
export function inlineLocation(p: TrPlacement): { separator: string; targetFirst: boolean } {
  return { separator: separatorOf(p), targetFirst: targetFirst(p) }
}

/**
 * Оригинал строки, в которую раньше вставили перевод. null — строка уже не
 * похожа на «оригинал + разделитель + перевод» (человек правил её руками):
 * тогда повторное применение остановится и скажет об этом, а не угадает.
 */
export function peelTarget(text: string, record: Pick<TrRecord, 'targetText' | 'targetLocation'>): string | null {
  const raw = record.targetLocation as { separator?: string; targetFirst?: boolean; inline?: { separator?: string; targetFirst?: boolean } } | undefined
  const loc = raw?.inline ?? raw
  if (!loc || typeof loc.separator !== 'string') return null
  const { separator, targetFirst: first } = loc
  const target = record.targetText
  if (first) return text.startsWith(target + separator) ? text.slice(target.length + separator.length) : null
  return text.endsWith(separator + target) ? text.slice(0, text.length - separator.length - target.length) : null
}

/* ── Плашки и защита технических фрагментов ───────────────────────────── */

/** Служебные знаки плашек: конец области частного использования, куда protect() не дотягивается. */
export const CHIP_BASE = 0xe5c0
export const CHIP_MAX = 24
export const chipMarker = (index: number): string => String.fromCharCode(CHIP_BASE + index)
const CHIP_RE = /[-]/g

export function chipMarkersIn(text: string): string[] {
  return String(text).match(CHIP_RE) || []
}

const countOf = (haystack: string, needle: string): number => (needle ? haystack.split(needle).length - 1 : 0)

/**
 * Перевод годится к постановке: каждая плашка на месте ровно один раз и каждый
 * технический фрагмент оригинала присутствует в нём без изменений.
 * Вернуть текст ошибки или null.
 */
export function validateTarget(source: string, target: string, chipCount = 0): string | null {
  if (!normalizeText(target)) return 'Перевод пуст'
  const expected = Array.from({ length: chipCount }, (_, i) => chipMarker(i))
  const present = chipMarkersIn(target)
  for (const marker of expected) {
    if (present.filter((m) => m === marker).length !== 1) return 'В переводе потеряна или повторена плашка параметра Flux — верните её на место'
  }
  if (present.length !== expected.length) return 'В переводе лишний служебный знак плашки'
  const { slots } = protect(source)
  const seen = new Set<string>()
  for (const token of slots) {
    if (seen.has(token)) continue
    seen.add(token)
    if (countOf(target, token) < countOf(source, token)) return `Защищённый фрагмент «${token}» изменён или потерян в переводе`
  }
  return null
}

/* ── Журнал переводов ─────────────────────────────────────────────────── */

export const recordKey = (r: Pick<TrRecord, 'sourceId' | 'key' | 'destination'>): string => `${r.sourceId}\u0000${r.key}\u0000${r.destination}`

/** Прежние записи того же фрагмента на тот же язык: их заменяет новая, дублей в журнале нет. */
export function supersededBy(prior: TrRecord[], next: TrRecord[]): TrRecord[] {
  const fresh = new Set(next.map(recordKey))
  return prior.filter((r) => fresh.has(recordKey(r)))
}

export function makeRecord(input: {
  sourceId?: string; key: string; destination: string; placement: TrPlacement
  source: string; target: string; targetLocation: Record<string, unknown>; time?: number
}): TrRecord {
  return {
    sourceId: input.sourceId || 'text',
    key: input.key,
    destination: input.destination,
    revision: String(input.placement.sourceRevision || '').slice(0, 200),
    time: input.time ?? Date.now(),
    mode: input.placement.mode,
    scope: input.placement.scope,
    targetLocation: input.targetLocation,
    targetText: input.target.slice(0, 32767),
    sourceText: input.source.slice(0, 32767),
    sourceHash: sourceHash(input.source),
  }
}

/** Индекс записей по ключу фрагмента: для одного ключа берётся последняя запись на язык. */
export function recordsByKey(records: TrRecord[], destination: string): Map<string, TrRecord> {
  const map = new Map<string, TrRecord>()
  for (const r of records) {
    if (r.destination !== destination) continue
    const old = map.get(r.key)
    if (!old || old.time <= r.time) map.set(r.key, r)
  }
  return map
}

/* ── Таблица: план постановки ─────────────────────────────────────────── */

export interface SheetCell { sheet: string; row: number; col: number }
export interface SheetUnit extends SheetCell {
  key: string
  source: string
  target: string
  /** Где этот перевод стоит сейчас (по записи журнала и именам); null — перевода в книге нет. */
  priorTarget?: SheetCell | null
}
export type SheetOp =
  | { op: 'insertColumn'; sheet: string; index: number }
  | { op: 'insertRow'; sheet: string; index: number }
  | { op: 'createSheet'; name: string }
  | { op: 'set'; sheet: string; row: number; col: number; value: string }

export interface SheetPlan {
  /** Шаги по порядку. Адреса в `set` — уже с учётом всех вставок, что стоят в плане раньше. */
  ops: SheetOp[]
  /** Итоговое место перевода каждого фрагмента. */
  targets: Record<string, SheetCell>
  /** Новые листы: исходный → созданный. */
  createdSheets: Record<string, string>
}

const INVALID_SHEET = /[\[\]:*?/\\]/g

/** Имя листа по правилам Excel: до 31 знака, без []:*?/\, без повторов (без учёта регистра). */
export function uniqueSheetName(base: string, existing: string[], suffix = 'EN'): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()))
  const clean = String(base).replace(INVALID_SHEET, ' ').replace(/^'+|'+$/g, '').trim() || 'Лист'
  const tail = ` (${suffix})`
  for (let n = 1; n < 1000; n++) {
    const extra = n === 1 ? tail : `${tail} ${n}`
    const name = clean.slice(0, Math.max(1, 31 - extra.length)).trimEnd() + extra
    if (!taken.has(name.toLowerCase())) return name
  }
  throw new Error('Не удалось подобрать имя нового листа')
}

const bySheet = <T extends { sheet: string }>(items: T[]): Map<string, T[]> => {
  const map = new Map<string, T[]>()
  for (const item of items) map.set(item.sheet, [...(map.get(item.sheet) || []), item])
  return map
}

/**
 * План постановки перевода в Таблицу по режиму. Вставки столбцов и строк идут
 * справа налево и снизу вверх: так адреса оставшихся вставок не плывут, а
 * итоговые адреса перевода считаются заранее и записываются в журнал.
 */
export function planSheet(units: SheetUnit[], p: TrPlacement, env: { existingSheets: string[]; suffix?: string; priorSheets?: Record<string, string> }): SheetPlan {
  const ops: SheetOp[] = []
  const targets: Record<string, SheetCell> = {}
  const createdSheets: Record<string, string> = {}
  const set = (cell: SheetCell, value: string, key: string) => {
    ops.push({ op: 'set', sheet: cell.sheet, row: cell.row, col: cell.col, value })
    targets[key] = { sheet: cell.sheet, row: cell.row, col: cell.col }
  }

  if (p.mode === 'replace' || p.mode === 'new-file') {
    for (const u of units) set(u, u.target, u.key)
    return { ops, targets, createdSheets }
  }
  if (p.mode === 'inline-before' || p.mode === 'inline-after') {
    for (const u of units) set(u, composeInline(u.source, u.target, p), u.key)
    return { ops, targets, createdSheets }
  }

  if (p.mode === 'adjacent-column' || p.mode === 'adjacent-row') {
    const column = p.mode === 'adjacent-column'
    const pos = (c: SheetCell) => (column ? c.col : c.row)
    for (const [sheet, list] of bySheet(units)) {
      // Новая линия нужна только там, где перевода ещё нет
      const lines = [...new Set(list.filter((u) => !u.priorTarget).map(pos))].sort((a, b) => a - b)
      for (const line of [...lines].reverse()) ops.push(column ? { op: 'insertColumn', sheet, index: line + 1 } : { op: 'insertRow', sheet, index: line + 1 })
      // сдвиг линии после вставок: сколько вставленных линий (индекс line+1) лежит не правее неё
      const shift = (at: number) => lines.filter((line) => line + 1 <= at).length
      for (const u of list) {
        const prior = u.priorTarget
        const cell: SheetCell = prior
          ? (column ? { sheet, row: prior.row, col: prior.col + shift(prior.col) } : { sheet, row: prior.row + shift(prior.row), col: prior.col })
          : (column ? { sheet, row: u.row, col: u.col + shift(u.col) + 1 } : { sheet, row: u.row + shift(u.row) + 1, col: u.col })
        set(cell, u.target, u.key)
      }
    }
    return { ops, targets, createdSheets }
  }

  if (p.mode === 'new-sheet') {
    const existing = [...env.existingSheets]
    for (const [sheet, list] of bySheet(units)) {
      const prior = list.find((u) => u.priorTarget)?.priorTarget?.sheet || env.priorSheets?.[sheet]
      let name = prior
      if (!name) {
        name = uniqueSheetName(sheet, existing, env.suffix || 'EN')
        existing.push(name)
        ops.push({ op: 'createSheet', name })
      }
      createdSheets[sheet] = name
      for (const u of list) set({ sheet: name, row: u.priorTarget ? u.priorTarget.row : u.row, col: u.priorTarget ? u.priorTarget.col : u.col }, u.target, u.key)
    }
    return { ops, targets, createdSheets }
  }
  throw new Error(`Режим «${p.mode}» не поддерживается в Таблице`)
}

/* ── Обмен с окном Flux ───────────────────────────────────────────────── */

export interface TrUnit {
  key: string
  source: string
  /** Сколько плашек и атомов вынуто из исходника (знаки chipMarker(0..n-1)). */
  chips?: number
  location: Record<string, unknown>
  status: TrStatus
  /** Последний известный перевод (из журнала) — для устаревших и уже применённых. */
  targetText?: string
  sourceId?: string
  fieldKey?: string
  displayLabel?: string
  stale?: boolean
  verified?: boolean
}

/** Коды отказа редактора: окно Flux по ним решает, что сказать человеку и можно ли повторить. */
export type TrErrorCode =
  | 'not-ready'        // редактор ещё не загрузил документ или книгу целиком
  | 'read-only'        // файл открыт только для чтения
  | 'busy'             // постановка уже идёт, второй запрос отклонён
  | 'too-many'         // больше MAX_UNITS фрагментов — сузить область
  | 'source-changed'   // исходник изменился после чтения — прочитать заново
  | 'not-confirmed'    // есть фрагмент без подтверждения
  | 'protected-changed' // плашка или технический фрагмент потеряны в переводе
  | 'unsupported-mode' // режим не поддерживается этим редактором
  | 'cannot-rollback'  // после постановки были другие правки: откат только вручную (Ctrl+Z)
  | 'failed'

export interface TrReadRequest { scope: TrScope; records?: TrRecord[]; destination?: string; schema?: unknown }
export interface TrReadResult { ok: boolean; units?: TrUnit[]; skipped?: number; error?: string; code?: TrErrorCode }
/** Строка предпросмотра: что было и что станет, без изменений документа. */
export interface TrPreviewItem { key: string; location: Record<string, unknown>; before: string; after: string; target: 'same' | 'new-block' | 'new-cell' | 'new-sheet' | 'new-file' }
export interface TrRollbackRequest { stepId: string }
export interface TrRollbackResult { ok: boolean; error?: string; code?: TrErrorCode }
export interface TrApplyItem { key: string; source: string; targetText: string; confirmed?: boolean; location?: Record<string, unknown>; sourceId?: string; fieldKey?: string }
export interface TrApplyRequest {
  items: TrApplyItem[]
  placement: TrPlacement
  direction: 'ru-en' | 'en-ru'
  records?: TrRecord[]
  schema?: unknown
  displayLabels?: Record<string, string>
  /** true — ничего не менять, вернуть только предпросмотр (preview). */
  dryRun?: boolean
}
export interface TrApplyResult {
  ok: boolean
  error?: string
  code?: TrErrorCode
  preview?: TrPreviewItem[]
  records?: TrRecord[]
  removeRecords?: TrRecord[]
  /** Номер шага «назад», которым можно откатить постановку, пока человек не продолжил правки. */
  stepId?: string
  applied?: number
  skipped?: number
  /** Новый DOCX / новая книга: байты или запрос на сохранение копии (оригинал не тронут). */
  copy?: { bytes: ArrayBuffer; suggestedName?: string }
  copyRequest?: { kind: 'sheets-save-as'; saved: boolean }
  headerSchema?: unknown
  displayLabels?: Record<string, string>
}

export const destinationOf = (direction: 'ru-en' | 'en-ru'): string => (direction === 'ru-en' ? 'en' : 'ru')

/** Проверка запроса постановки до любых изменений: ничего не меняем, пока всё не проверено. */
export function checkApplyItems(items: TrApplyItem[], chipsOf: (key: string) => number | undefined, sourceOf: (key: string) => string | undefined): string | null {
  if (!Array.isArray(items) || !items.length) return 'Нет фрагментов для постановки'
  if (items.length > MAX_UNITS) return `За один раз можно поставить не больше ${MAX_UNITS} фрагментов — сузьте область`
  const seen = new Set<string>()
  for (const item of items) {
    if (!item || typeof item.key !== 'string' || typeof item.targetText !== 'string') return 'Запрос постановки повреждён'
    if (seen.has(item.key)) return 'Один фрагмент указан дважды'
    seen.add(item.key)
    if (item.confirmed !== true) return 'Есть непроверенный фрагмент — подтвердите перевод перед постановкой'
    const current = sourceOf(item.key)
    if (current === undefined) return 'Фрагмент не найден — документ изменился после чтения, прочитайте его заново'
    if (normalizeText(current) !== normalizeText(item.source)) return 'Исходный текст изменился после чтения — прочитайте документ заново'
    const bad = validateTarget(current, item.targetText, chipsOf(item.key) || 0)
    if (bad) return bad
  }
  return null
}
