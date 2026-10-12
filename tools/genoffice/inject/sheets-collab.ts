/**
 * Flux Office: одновременная правка Таблицы GenOffice.
 *
 * Сборка (tools/genoffice/build.mjs) кладёт этот файл в
 * apps/sheets/src/renderer/flux/, правка patches.mjs подключает его в App.tsx
 * и отдаёт сюда Univer и состояние книги (window.__fluxSheets).
 *
 * Как устроено:
 *   - своя мутация Univer (правка ячейки, строки, формат, лист…) уходит на
 *     сервер (server/officeSheetCollab.ts) и получает номер по порядку;
 *   - чужая применяется здесь той же мутацией с пометкой fromCollab — и
 *     журнал правок Таблицы (App.tsx) записывает её как обычную. Поэтому у
 *     держателя в файл попадают правки всех;
 *   - общий порядок — серверный. Если чужая правка той же ячейки дошла до
 *     сервера раньше моей, но пришла ко мне уже после моей — моя
 *     переигрывается поверх, и у всех одно и то же значение;
 *   - листы сопоставляются по имени: после записи держатель перестраивает
 *     книгу из файла, и номера листов у него другие, чем у остальных;
 *   - чужое применяется только к загруженной целиком книге (подгрузка иначе
 *     затёрла бы правку) и не во время записи держателем (книга после записи
 *     перестраивается, и правка пропала бы).
 *
 * Связь с окном Flux — ipcRenderer моста (tools/genoffice/shims/electron-renderer.js):
 * каналы «flux:x-*» окно разбирает само (src/screens/OfficeAppHost.tsx).
 */
import { journalSuppression } from '../univer-state'
import { ensureLazyRangeLoaded } from '../univer-sync'
import { waitForEditor } from './editor-readiness'
import { CustomCommandExecutionError, ICommandService, IUndoRedoService } from '@univerjs/core'
import '@univerjs/sheets-ui/facade'
import { createSheetsTokenOverlay } from './sheets-token-overlay'

interface Ipc {
  invoke(channel: string, ...args: unknown[]): Promise<any>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, fn: (e: unknown, ...args: any[]) => void): unknown
}
interface Op { id: string; params: unknown; sheets?: Record<string, string> }
interface Remote { seq: number; op: Op }

const MUTATION = 2 // CommandType.MUTATION
/** Производное: каждый считает сам (формулы) — рассылать нечего */
const LOCAL = /^(formula\.|formula-ui\.|sheet\.mutation\.set-worksheet-row-auto-height)/
/** Правки «записать значение»: переигрывать поверх чужой безопасно */
const IDEMPOTENT = /^sheet\.mutation\.(set-range-values|set-numfmt|set-col-width|set-row-height|set-worksheet-name)/
/** Ключи параметров, внутри которых — содержимое ячеек, а не ссылки на книгу и лист */
const SKIP_KEYS = new Set(['cellValue', 'value', 'values', 'cellData'])

const ipc = (): Ipc | undefined => (window as any).__fluxIpc
const hooks = (): { univerRef: { current: any }; lazyWorkbookRef: { current: any } } | undefined => (window as any).__fluxSheets
const fluxAnchorName = (anchorId: string): string => `FLUX_ANCHOR_${anchorId.replace(/[^A-Za-z0-9_]/g, '_')}`

let active = false
let key = ''
let applying = false
let maxRemote = 0
let localSeq = 0
const queue: Remote[] = []
const headerMergePreviews = new Map<string, { workbookId: string; sheetId: string; targetId: string; sourceId: string; schema: string; snapshot: string; expires: number }>()
/** Свои, ещё без номера */
const pending = new Map<number, Op>()
/** Свои с номером: переиграть, если придёт чужая с меньшим */
let mine: Array<{ seq: number; op: Op }> = []
/** Имена листов до последней правки: по ним чужие правки находят свой лист */
let names = new Map<string, string>()
let saving: { lazy: any; until: number } | null = null
let applyingFlux = false
let fluxReadOnly = false
const guardedRuntimes = new WeakSet<object>()
let headerTokenOverlay: ReturnType<typeof createSheetsTokenOverlay> | null = null

const api = () => hooks()?.univerRef.current?.univerAPI
const workbook = () => { try { return api()?.getActiveWorkbook() || null } catch { return null } }

/** Детерминированная подпись частей для нативной ячейки заголовка. */
function renderHeaderParts(parts: any[]): string {
  const labelFor = (binding: any): string => String(binding?.displayName || binding?.fieldKey || '')
  return parts.map((part: any) => {
    if (part?.kind === 'text') return String(part.text || '')
    if (part?.kind === 'operator') return ['+', '-', '*', '/', '(', ')'].includes(part.operator) ? part.operator : ''
    if (part?.kind === 'field') return labelFor(part.binding)
    if (part?.kind === 'union' && Array.isArray(part.alternatives)) return typeof part.label === 'string' ? part.label : part.alternatives.map(labelFor).join(' / ')
    return ''
  }).join('')
}

function refreshNames(): void {
  const wb = workbook()
  if (!wb) return
  const next = new Map<string, string>()
  try { for (const s of wb.getSheets()) next.set(s.getSheetId(), s.getSheetName()) } catch { return }
  names = next
}

/** Пройти параметры: книга → своя, лист → по имени; содержимое ячеек не трогать */
function walk(v: any, depth: number, fn: (o: any) => void): void {
  if (!v || typeof v !== 'object' || depth > 4) return
  if (Array.isArray(v)) { if (depth < 2) for (const x of v) walk(x, depth + 1, fn); return }
  fn(v)
  for (const [k, x] of Object.entries(v)) if (!SKIP_KEYS.has(k) && x && typeof x === 'object') walk(x, depth + 1, fn)
}

function sheetsOf(params: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  walk(params, 0, (o) => { if (typeof o.subUnitId === 'string' && names.has(o.subUnitId)) out[o.subUnitId] = names.get(o.subUnitId)! })
  return out
}

function localize(op: Op): unknown {
  const params = JSON.parse(JSON.stringify(op.params ?? {}))
  const wb = workbook()
  const unitId = wb?.getId()
  const byName = new Map<string, string>()
  for (const [id, n] of names) byName.set(n, id)
  walk(params, 0, (o) => {
    if (typeof o.unitId === 'string' && unitId) o.unitId = unitId
    if (typeof o.subUnitId === 'string') {
      const n = op.sheets?.[o.subUnitId]
      const local = n ? byName.get(n) : undefined
      if (local) o.subUnitId = local
    }
  })
  return params
}

/** Декодирование имени поля по договору office/fieldKeys.ts; здесь нельзя
 * импортировать исходный модуль, потому что build копирует inject отдельно. */
function decodeFieldKey(name: string): string | null {
  if (!name.startsWith('FLUX_') || /^FLUX_BLOCK_\d+$/.test(name)) return null
  const encoded = name.slice(5).replace(/__\d+$/, '')
  let key = ''
  for (let i = 0; i < encoded.length;) {
    if (encoded[i] !== '_') { key += encoded[i++]; continue }
    if (encoded[i + 1] === 'u') {
      const hex = encoded.slice(i + 2, i + 6)
      if (!/^[0-9A-F]{4}$/.test(hex)) return null
      key += String.fromCharCode(parseInt(hex, 16))
      i += 6
    } else {
      const hex = encoded.slice(i + 1, i + 3)
      if (!/^[0-9A-F]{2}$/.test(hex)) return null
      key += String.fromCharCode(parseInt(hex, 16))
      i += 3
    }
  }
  return key
}

function selectedTagField(wb: any): { tagId: string; identifier: string } | null {
  try {
    const cell = wb?.getActiveCell?.()
    const sheet = wb?.getActiveSheet?.()
    const a1 = (String(cell?.getA1Notation?.() || '').split(':')[0] ?? '').replace(/\$/g, '').toUpperCase()
    const sheetName = String(sheet?.getSheetName?.() || '')
    if (!cell || !a1 || !sheetName) return null
    const quotedSheet = sheetName.replace(/'/g, "''")
    for (const defined of wb.getDefinedNames?.() || []) {
      const name = String(defined?.getName?.() || '')
      const key = decodeFieldKey(name)
      const match = key && /^tag\[([^\]]+)\]\.identifier$/.exec(key)
      if (!match) continue
      const ref = String(defined?.getRef?.() ?? defined?.getFormulaOrRefString?.() ?? '').trim().replace(/^=/, '')
      // Именованная ссылка должна быть одной конкретной ячейкой этого листа;
      // диапазоны, иные листы и неоднозначные форматы пропускаем.
      const refMatch = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref)
      if (!refMatch) continue
      const refSheetValue = refMatch[1] ?? refMatch[2]
      if (refSheetValue === undefined) continue
      const refSheet = refSheetValue.replace(/''/g, "'")
      const refA1 = `${refMatch[3]!}${refMatch[4]!}`.toUpperCase()
      if (refSheet !== sheetName && refSheet !== quotedSheet) continue
      if (refA1 !== a1) continue
      const value = match[1]!
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
        ? { tagId: value, identifier: '' }
        : { tagId: '', identifier: value }
    }
  } catch { /* книга или named range ещё не готовы */ }
  return null
}

function selectedOfficeAnchor(wb: any): { kind: 'excel-range'; anchorId: string; sheetName: string; address: string } | null {
  try {
    const cell = wb?.getActiveCell?.();
    const sheet = wb?.getActiveSheet?.();
    const address = (String(cell?.getA1Notation?.() || '').split(':')[0] ?? '').replace(/\$/g, '').toUpperCase();
    const sheetName = String(sheet?.getSheetName?.() || '');
    if (!cell || !/^[A-Z]{1,3}\d+$/.test(address) || !sheetName) return null;
    const quoted = sheetName.replace(/'/g, "''");
    for (const defined of wb.getDefinedNames?.() || []) {
      const name = String(defined?.getName?.() || '');
      const match = /^FLUX_ANCHOR_([0-9a-f_]{36}|[0-9a-f-]{36})$/i.exec(name);
      if (!match) continue;
      const ref = String(defined?.getRef?.() ?? defined?.getFormulaOrRefString?.() ?? '').trim().replace(/^=/, '');
      const refMatch = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref);
      if (!refMatch) continue;
      const refSheetValue = refMatch[1] ?? refMatch[2];
      if (refSheetValue === undefined) continue;
      const refSheet = refSheetValue.replace(/''/g, "'");
      if ((refSheet === sheetName || refSheet === quoted) && (refMatch[3]! + refMatch[4]!).toUpperCase() === address) {
        const matchedAnchorId = match[1]!;
        const anchorId = matchedAnchorId.includes('_') ? matchedAnchorId.replaceAll('_', '-') : matchedAnchorId;
        return { kind: 'excel-range', anchorId, sheetName, address };
      }
    }
    // Стабильный ID создаётся в момент выбора. Он закрепится в книге только
    // при вставке метки; простое перемещение курсора ничего не меняет в файле.
    return { kind: 'excel-range', anchorId: globalThis.crypto.randomUUID(), sheetName, address };
  } catch { return null; }
}

/** Ячейки для меню берём из списка выделения Univer, а не из primary-клетки. */
function selectedHeaderCells(wb: any): Array<{ anchorId: string; kind: 'excel-range'; sheetName: string; address: string }> | null {
  try {
    const sheet = wb?.getActiveSheet?.()
    const selection = sheet?.getSelection?.()
    const ranges = selection?.getActiveRangeList?.()
    const sheetName = String(sheet?.getSheetName?.() || '')
    if (!sheetName || !Array.isArray(ranges) || (ranges.length !== 1 && ranges.length !== 2)) return null
    const cells = ranges.map((range: any) => {
      const address = String(range?.getA1Notation?.() || '').replace(/\$/g, '').toUpperCase()
      const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(address)
      if (!match) return null
      let column = 0
      for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64
      return { address, row: Number(match[2]), column }
    })
    if (cells.some((cell) => !cell) || (cells.length === 2 && (
      cells[0]!.row !== cells[1]!.row || Math.abs(cells[0]!.column - cells[1]!.column) !== 1
    ))) return null
    const quotedSheet = sheetName.replace(/'/g, "''")
    const names = new Map<string, string>()
    for (const defined of wb.getDefinedNames?.() || []) {
      const name = String(defined?.getName?.() || '')
      const anchor = /^FLUX_ANCHOR_([0-9a-f_]{36}|[0-9a-f-]{36})$/i.exec(name)
      if (!anchor) continue
      const ref = String(defined?.getRef?.() ?? defined?.getFormulaOrRefString?.() ?? '').trim().replace(/^=/, '')
      const match = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(ref)
      if (!match) continue
      const refSheet = (match[1] ?? match[2] ?? '').replace(/''/g, "'")
      if (refSheet !== sheetName && refSheet !== quotedSheet) continue
      const address = `${match[3]!}${match[4]!}`.toUpperCase()
      names.set(address, anchor[1]!.replaceAll('_', '-'))
    }
    // Только ранее привязанные заголовки открывают Flux; иначе обычное меню
    // таблицы должно остаться доступным.
    if (cells.some((cell) => !names.has(cell!.address))) return null
    return cells.map((cell) => ({
      anchorId: names.get(cell!.address)!,
      kind: 'excel-range',
      sheetName,
      address: cell!.address,
    }))
  } catch { return null }
}

function protectFluxHeaderCells(): void {
  const runtime = hooks()?.univerRef.current
  if (!runtime?.univer || guardedRuntimes.has(runtime)) return
  try {
    const commandService = runtime.univer.__getInjector().get(ICommandService)
    guardedRuntimes.add(runtime)
    commandService.beforeCommandExecuted((command: any) => {
      // Univer hooks every operation here; only mutations alter workbook data.
      // Read-only leaves cursor movement, selection and copy commands available.
      const trusted = journalSuppression.active || applying || applyingFlux
      if (fluxReadOnly && !trusted && command.type === MUTATION) {
        // A veto skips Univer's success-path stack cleanup, so remove this
        // exact dispatch before throwing; nested command frames are preserved.
        const stack = (commandService as unknown as { _commandExecutionStack?: unknown[] })._commandExecutionStack
        const index = stack?.indexOf(command) ?? -1
        if (index >= 0) stack?.splice(index, 1)
        throw new CustomCommandExecutionError('Книга Flux открыта только для чтения')
      }
      // Загрузка из файла и разрешённые правки соавтора восстанавливают ячейки.
      // Блокируем обычное редактирование, а не внутреннюю загрузку книги.
      if (journalSuppression.active || applying || applyingFlux || /^.*(?:undo|redo).*$/i.test(String(command.id))) return
      // «Назад» и «вперёд» воспроизводят уже разрешённые правки, в том числе вставку метки Flux в
      // защищённую ячейку: мутации внутри них не блокируем, иначе отмена привязки упирается в её же защиту
      const replaying = (commandService as unknown as { _commandExecutionStack?: Array<{ id?: string }> })._commandExecutionStack
      if (replaying?.some((item) => item?.id === 'univer.command.undo' || item?.id === 'univer.command.redo')) return
      const id = String(command.id || '')
      if (!/sheet\.(?:command|mutation)\.set-range-values$/i.test(id)) return
      const wb = workbook()
      if (!wb) return
      const protectedCells = new Set<string>()
      for (const defined of wb.getDefinedNames?.() || []) {
        const name = String(defined?.getName?.() || '')
        const match = /^FLUX_ANCHOR_([0-9a-f_]{36}|[0-9a-f-]{36})$/i.exec(name)
        if (!match) continue
        const ref = String(defined?.getRef?.() ?? defined?.getFormulaOrRefString?.() ?? '').trim().replace(/^=/, '')
        const m = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref)
        if (!m) continue
        const sheetNameValue = m[1] ?? m[2]
        if (sheetNameValue === undefined) continue
        const sheetName = sheetNameValue.replace(/''/g, "'")
        const sheet = wb.getSheets?.().find((s: any) => String(s.getSheetName()) === sheetName)
        if (sheet) protectedCells.add(`${sheet.getSheetId()}:${Number(m[4]!) - 1}:${columnNumber(m[3]!) - 1}`)
      }
      let blocked = false
      const inspect = (value: any, depth = 0): void => {
        if (blocked || !value || typeof value !== 'object' || depth > 6) return
        if (typeof value.subUnitId === 'string' && value.cellValue && typeof value.cellValue === 'object') {
          const matrix = value.cellValue
          for (const [r, row] of Object.entries(matrix)) {
            if (!row || typeof row !== 'object') continue
            for (const c of Object.keys(row)) if (protectedCells.has(`${value.subUnitId}:${Number(r)}:${Number(c)}`)) { blocked = true; return }
          }
        }
        if (typeof value.subUnitId === 'string' && ['startRow', 'endRow', 'startColumn', 'endColumn'].every((k) => Number.isFinite(Number(value[k])))) {
          for (const cell of protectedCells) {
            const [sheetId, row, col] = cell.split(':')
            if (sheetId === value.subUnitId && Number(row) >= Number(value.startRow) && Number(row) <= Number(value.endRow) && Number(col) >= Number(value.startColumn) && Number(col) <= Number(value.endColumn)) { blocked = true; return }
          }
        }
        for (const child of Object.values(value)) inspect(child, depth + 1)
      }
      inspect(command.params)
      if (!blocked) return
      const stack = (commandService as unknown as { _commandExecutionStack?: unknown[] })._commandExecutionStack
      const index = stack?.indexOf(command) ?? -1
      if (index >= 0) stack?.splice(index, 1)
      throw new CustomCommandExecutionError('Поле Flux защищено от обычного редактирования')
    })
  } catch (error) { console.warn('[flux] защита меток Таблиц не установлена', error) }
}

/**
 * Имена меток Flux (FLUX_ANCHOR_*) — реестр привязок, а не правка человека: в «назад» их не кладём.
 * Каждая замена имени получает новый внутренний номер, и отмена по старому номеру оставляла бы
 * в книге два одинаковых имени (сохранение падает: «имя определено дважды»).
 */
function withoutHistory<T>(wb: any, run: () => T): T {
  type Step = { undoMutations: unknown[]; redoMutations: unknown[] }
  const service = hooks()?.univerRef.current?.univer?.__getInjector?.().get(IUndoRedoService) as { _undoStacks?: Map<string, Step[]> } | undefined
  const stack = service?._undoStacks?.get(wb.getId())
  const before = stack?.length ?? 0
  // Внутри группы (__tempBatchingUndoRedo) новая запись не добавляет шаг, а дописывается в верхний
  const top = before ? stack![before - 1]! : null
  const undoLength = top?.undoMutations.length ?? 0
  const redoLength = top?.redoMutations.length ?? 0
  try { return run() } finally {
    if (stack && stack.length > before) stack.length = before
    if (top) { top.undoMutations.length = undoLength; top.redoMutations.length = redoLength }
  }
}

/**
 * Команды Univer над колонками и строками сами записывают в «назад» восстановление имён с их внутренними
 * номерами. После сохранения книга пересоздаётся из файла, номера имён меняются, и отмена возвращала бы
 * метку Flux вторым именем рядом с живым (сохранение падает: «имя определено дважды»). Метки Flux в
 * историю не входят — выбрасываем их из верхнего шага.
 */
function dropAnchorNamesFromHistory(wb: any): void {
  type Mutation = { id?: string; params?: { name?: string } }
  const service = hooks()?.univerRef.current?.univer?.__getInjector?.().get(IUndoRedoService) as { _undoStacks?: Map<string, Array<{ undoMutations: Mutation[]; redoMutations: Mutation[] }>> } | undefined
  const stack = service?._undoStacks?.get(wb.getId())
  const top = stack?.[stack.length - 1]
  if (!top) return
  const isAnchorName = (mutation: Mutation): boolean => /^formula\.mutation\.(?:set|remove)-defined-name$/.test(String(mutation.id)) && String(mutation.params?.name ?? '').startsWith('FLUX_ANCHOR_')
  top.undoMutations = top.undoMutations.filter((mutation) => !isAnchorName(mutation))
  top.redoMutations = top.redoMutations.filter((mutation) => !isAnchorName(mutation))
}

/**
 * Имя метки: существующее обновляем на месте, а не удаляем и создаём заново. У имени есть внутренний
 * номер, и записи «назад» (например, удаления колонки) хранят его: новое имя с новым номером при отмене
 * оставило бы в книге два одинаковых имени.
 */
function setAnchorName(wb: any, name: string, ref: string): void {
  const existing = wb.getDefinedName?.(name)
  if (!existing) { wb.insertDefinedName(name, ref); return }
  const plain = (value: unknown): string => String(value ?? '').replace(/^=/, '').replace(/'/g, '')
  if (plain(existing.getRef?.() ?? existing.getFormulaOrRefString?.()) === plain(ref)) return
  existing.setRef(ref)
}

function columnNumber(letters: string): number {
  let result = 0
  for (const letter of letters.toUpperCase()) result = result * 26 + letter.charCodeAt(0) - 64
  return result
}

function run(op: Op): void {
  const a = api()
  if (!a) return
  applying = true
  try { a.syncExecuteCommand(op.id, localize(op), { fromCollab: true }) } catch (err) { console.warn('[flux] чужая правка не применилась', op.id, err) }
  finally { applying = false }
  refreshNames()
}

/** Можно применять чужое: книга загружена целиком и не перестраивается после записи */
function ready(): boolean {
  const lazy = hooks()?.lazyWorkbookRef.current
  if (!lazy || !lazy.flags?.preloadComplete || !api()) return false
  if (saving) {
    if (saving.lazy && lazy === saving.lazy && Date.now() < saving.until) return false
    saving = null
  }
  return true
}

function drain(): void {
  if (!active || !queue.length || !ready()) return
  queue.sort((x, y) => x.seq - y.seq)
  let applied = 0
  while (queue.length) {
    const r = queue.shift()!
    if (r.seq <= maxRemote) continue
    run(r.op)
    maxRemote = r.seq
    applied++
    // Моя правка дошла до сервера позже этой — у всех она последняя
    const later = mine.filter((m) => m.seq > r.seq).map((m) => m.op).concat(Array.from(pending.values()))
    for (const op of later) if (IDEMPOTENT.test(op.id)) run(op)
  }
  mine = mine.filter((m) => m.seq > maxRemote)
  if (applied) ipc()?.send('flux:x-applied', applied)
}

function onCommand(ev: { id: string; type: number; params: unknown; options?: Record<string, unknown> }): void {
  if (!active || applying || ev.type !== MUTATION) return
  const o = ev.options || {}
  if (o.onlyLocal || o.fromCollab || o.fromChangeset || o.fromFormula || o.syncOnly) return
  // Подгрузка книги и служебная перестройка — не правки человека
  if (journalSuppression.active || LOCAL.test(ev.id)) return
  // Текст, который человек набирает в окне редактирования ячейки, живёт в служебном документе Univer.
  // В общую книгу уходит готовое значение ячейки, а не этот черновик: иначе журнал вечно «не сохранён»
  // и выпуск ревизии отвечает «есть несохранённые общие правки»
  if (String((ev.params as { unitId?: unknown } | null)?.unitId ?? '').startsWith('__INTERNAL_EDITOR__')) return
  let op: Op
  try { op = { id: ev.id, params: JSON.parse(JSON.stringify(ev.params ?? null)), sheets: sheetsOf(ev.params) } } catch { return }
  const local = ++localSeq
  pending.set(local, op)
  ipc()?.send('flux:x-op', local, op)
  refreshNames()
}

async function start(): Promise<void> {
  const link = ipc()
  if (!link) return
  // Ждём книгу: Univer создан и первая загрузка пошла
  while (!api() || !hooks()?.lazyWorkbookRef.current) await new Promise((r) => setTimeout(r, 300))
  const cfg = await link.invoke('flux:x-config').catch(() => null)
  if (!cfg?.collab) return
  key = String(cfg.key || '')
  refreshNames()
  link.on('flux:x-op', (_e, m: Remote) => { if (m && typeof m.seq === 'number') queue.push(m) })
  link.on('flux:x-ack', (_e, local: number, seq: number) => {
    const op = pending.get(local)
    pending.delete(local)
    if (op && typeof seq === 'number') mine.push({ seq, op })
  })
  // Запись держателем: книга потом перестроится из файла — чужое подождёт
  window.addEventListener('flux-sheets-save', (e: Event) => {
    const d = (e as CustomEvent).detail || {}
    if (d.phase === 'start') saving = { lazy: hooks()?.lazyWorkbookRef.current, until: Date.now() + 60_000 }
    else if (d.phase === 'end') {
      if (!d.ok) saving = null
      else if (saving) saving.until = Date.now() + 15_000
    }
  })
  api().addEvent(api().Event.CommandExecuted, onCommand)
  const r = await link.invoke('flux:x-want', 0).catch(() => null)
  for (const m of r?.ops || []) queue.push(m)
  active = true
  setInterval(drain, 80)
  link.send('flux:x-ready', key)
}

/** «B3» → «$B$3»: имя поля держится за ячейку, а не сдвигается с формулой */
const absolute = (a1: string): string => a1.replace(/^([A-Z]+)(\d+)$/i, (_m, c, r) => `$${c.toUpperCase()}$${r}`)

/**
 * Панель «Данные проекта»: значение — в выделенную ячейку, и на ней имя
 * FLUX_<ключ>. По имени «Обновить поля» потом находит ячейку в файле
 * (server/officeFields.ts), сколько бы строк ни вставили выше. Работает и в
 * личной книге, где совместной правки нет, — поэтому отдельно от start()
 */
async function fields(): Promise<void> {
  const link = ipc()
  if (!link) return
  while (!workbook()) await new Promise((r) => setTimeout(r, 300))
  // Canvas Таблицы не даёт надёжно определить слово под курсором. Поэтому
  // связываем только явно помеченную ячейку, если после клика она стала
  // активной и всё её значение — один #TAG. Книгу это не меняет.
  document.addEventListener('click', (event) => {
    // Панели и лента тоже кликабельны: сохранённая активная ячейка сама по
    // себе не доказывает, что человек щёлкнул именно по ней.
    if (!(event.target instanceof HTMLCanvasElement)) return
    setTimeout(() => {
      try {
        const wb = workbook()
        const anchor = selectedOfficeAnchor(wb)
        if (anchor) link.send('flux:anchor-selected', anchor)
        const field = selectedTagField(wb)
        if (field) {
          link.send('flux:tag-click', { projectId: '', ...field })
          return
        }
        const cell = wb?.getActiveCell?.()
        const value = cell?.getValue?.()
        if (typeof value !== 'string') return
        const match = /^#([A-Za-z0-9А-Яа-яЁё]+(?:-[A-Za-z0-9А-Яа-яЁё]+)*)$/.exec(value.trim())
        if (match) link.send('flux:tag-click', { projectId: '', tagId: '', identifier: match[1] })
      } catch { /* интерфейс книги может быть в переходном состоянии после щелчка */ }
    }, 0)
  }, true)
  link.on('flux:insert-field', (_e, m: { name?: string; value?: unknown; anchorId?: string }) => {
    const wb = workbook()
    const priorApplying = applyingFlux
    let result: { ok: boolean; cell?: string; error?: string } = { ok: false, error: 'Книга не готова' }
    try {
      if (fluxReadOnly) throw new Error('Книга Flux открыта только для чтения')
      const anchorId = String((m as any)?.anchorId || '')
      const binding = (m as any)?.binding
      if (headerTokenOverlay?.isEditing(anchorId) && binding && headerTokenOverlay.insertField(anchorId, binding, String(m?.value || ''))) {
        link.send('flux:field-inserted', { ok: true, inlineEditing: true, anchorId })
        return
      }
      const cell = wb?.getActiveCell?.() || wb?.getActiveRange?.()
      const sheet = wb?.getActiveSheet?.()
      if (!wb || !cell || !sheet || !m?.name) result = { ok: false, error: 'Выделите ячейку, куда поставить значение' }
      else {
        applyingFlux = true
        const a1 = String(cell.getA1Notation()).split(':')[0] ?? ''
        // Подпись ячейки — обычный шаг «назад»; имя метки в историю не попадает
        cell.setValue(m.value ?? '')
        const ref = `'${String(sheet.getSheetName()).replace(/'/g, "''")}'!${absolute(a1)}`
        const anchorId = /^[0-9a-f-]{36}$/i.test(String(m.anchorId || '')) ? String(m.anchorId) : ''
        withoutHistory(wb, () => {
          if (anchorId) {
            setAnchorName(wb, fluxAnchorName(anchorId), ref)
          } else if (m.name) {
            // Существующие источники Flux используют это имя при обновлении полей.
            try { wb.deleteDefinedName?.(m.name) } catch { /* прежней метки могло не быть */ }
            wb.insertDefinedName(m.name, ref)
          }
        })
        result = { ok: true, cell: `${sheet.getSheetName()}!${a1}` }
      }
    } catch (err: any) { result = { ok: false, error: String(err?.message || err) } }
    finally { applyingFlux = priorApplying }
    link.send('flux:field-inserted', result)
  })
}

void start()
void fields()

/** Вставка таблиц и обновление выгрузки: адреса держатся именами Excel. */
async function exportCommands(): Promise<void> {
  const link = ipc(); if (!link) return;
  const readyPromise = waitForEditor(() => {
    const lazy = hooks()?.lazyWorkbookRef.current
    return workbook() && lazy && (!lazy.flags || lazy.flags.preloadComplete === true) ? lazy : null
  }, 40_000, 100)
  // Панель Flux спрашивает схему заголовков сразу после открытия файла, пока
  // книга ещё догружается. Обработчик, поставленный только после готовности,
  // терял этот запрос: хост ждал ответа до таймаута и показывал пустую панель.
  // Поэтому слушаем с самого начала и отвечаем, когда книга готова.
  let headerSchemaReader: ((request: any) => void) | null = null
  const earlyHeaderRequests: any[] = []
  link.on('flux:get-header-schema', (_e, request: any) => {
    if (headerSchemaReader) headerSchemaReader(request)
    else earlyHeaderRequests.push(request)
  })
  const ready = await readyPromise
  if (!ready) {
    for (let i = 0; i < earlyHeaderRequests.length; i++) link.send('flux:header-schema-read', { ok: false, error: 'Книга не загрузилась. Повторите действие' })
    return
  }
  protectFluxHeaderCells()
  // «Вперёд» по Ctrl+Shift+Z, как в Word и в Excel: Univer знает только Ctrl+Y. В полях ввода
  // (имя ячейки, поиск) и в окне формулы заголовка клавиши остаются браузеру
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.code !== 'KeyZ') return
    const target = event.target as HTMLElement | null
    if (target?.closest?.('input, textarea, .flux-sheet-token-edit')) return
    event.preventDefault()
    event.stopImmediatePropagation()
    void api()?.redo?.()
  }, true)
  headerTokenOverlay = createSheetsTokenOverlay(link, (anchorId) => {
    const wb = workbook()
    const name = fluxAnchorName(anchorId)
    const defined = wb?.getDefinedNames?.().find((item: any) => String(item.getName()) === name)
    const ref = String(defined?.getRef?.() ?? defined?.getFormulaOrRefString?.() ?? '').trim().replace(/^=/, '')
    const match = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(ref)
    if (!wb || !match) return null
    const sheetName = (match[1] ?? match[2] ?? '').replace(/''/g, "'")
    const sheet = wb.getSheets?.().find((item: any) => String(item.getSheetName()) === sheetName)
    if (!sheet) return null
    const address = `${match[3]!.toUpperCase()}${match[4]!}`
    return { range: sheet.getRange(address), sheetName, address }
  }, (range, value) => {
    if (fluxReadOnly) return false
    const prior = applyingFlux
    applyingFlux = true
    try { range.setValues([[{ v: value }]]); return true } catch { return false } finally { applyingFlux = prior }
  }, () => !fluxReadOnly)
  const reply = (id: string, result: any) => link.send('flux:command-result', { id, ...result });
  document.addEventListener('contextmenu', (event) => {
    if (event.button !== 2 || !(event.target instanceof HTMLCanvasElement)) return
    const anchors = selectedHeaderCells(workbook())
    if (!anchors) return
    // Flux подменяет меню только для привязанного заголовка или пары соседних.
    // Для обычных ячеек и прочих диапазонов меню Univer остаётся.
    event.preventDefault()
    event.stopImmediatePropagation()
    link.send('flux:cell-actions', {
      editorKind: 'sheets',
      anchors,
      position: { x: event.clientX, y: event.clientY },
    })
  }, true)
  link.on('flux:set-read-only', (_e, message: any) => {
    const readOnly = message?.readOnly
    if (typeof readOnly !== 'boolean') { link.send('flux:read-only-changed', { ok: false, error: 'Режим только для чтения имеет неверный формат' }); return }
    fluxReadOnly = readOnly
    link.send('flux:read-only-changed', { ok: true, readOnly })
  })
  headerSchemaReader = (request: any) => {
    let result: any
    try {
      const wb = workbook(); const schema = request?.schema
      if (!wb || !schema || schema.version !== 1 || !Array.isArray(schema.anchors) || schema.anchors.length > 500) throw new Error('Схема заголовков имеет неверный формат')
      const definitions = new Map<string, any>((wb.getDefinedNames?.() || []).map((item: any) => [String(item.getName()), item]))
      const columnLetters = (col: number): string => { let s = ''; for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s }
      const parseRef = (raw: unknown): { sheet: any; row: number; col: number; address: string } | null => {
        const ref = String(raw || '').trim().replace(/^=/, '')
        const match = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(ref)
        if (!match) return null
        const sheetNameValue = match[1] ?? match[2]
        if (sheetNameValue === undefined) return null
        const sheetName = sheetNameValue.replace(/''/g, "'")
        const sheet = wb.getSheets?.().find((item: any) => String(item.getSheetName()) === sheetName)
        if (!sheet) return null
        const col = columnNumber(match[3]!) - 1; const row = Number(match[4]!) - 1
        return { sheet, row, col, address: `${match[3]!.toUpperCase()}${match[4]!}` }
      }
      const anchors = schema.anchors.map((anchor: any) => {
        const id = String(anchor?.id || '')
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || anchor.kind !== 'excel-range' || !Array.isArray(anchor.parts)) throw new Error('В схеме есть неверный якорь Excel')
        const ref = definitions.get(fluxAnchorName(id))
        const target = parseRef(ref?.getRef?.() ?? ref?.getFormulaOrRefString?.())
        const sheetName = target?.sheet.getSheetName?.() ?? anchor.sheetName
        const address = target?.address ?? String(anchor.address || '')
        const sheet = target?.sheet ?? wb.getSheets?.().find((item: any) => String(item.getSheetName()) === sheetName)
        const match = /^([A-Z]{1,3})([1-9]\d*)$/i.exec(address)
        if (!sheet || !match) throw new Error(`Ячейка заголовка ${id} не найдена в книге`)
        const row = target?.row ?? Number(match[2]!) - 1; const col = target?.col ?? columnNumber(match[1]!) - 1
        const displayText = String(sheet.getRange(row, col, 1, 1).getValues()?.[0]?.[0] ?? '')
        const liveParts = headerTokenOverlay?.getLiveParts(id)
        return { ...anchor, sheetName: String(sheet.getSheetName()), address: `${match[1]!.toUpperCase()}${match[2]!}`, parts: liveParts || anchor.parts, displayText: liveParts ? renderHeaderParts(liveParts) : displayText }
      })
      result = { ok: true, schema: { version: schema.version, anchors: anchors.map(({ displayText: _displayText, ...anchor }: any) => anchor) }, headers: anchors.map((anchor: any) => ({ anchorId: anchor.id, sheetName: anchor.sheetName, address: anchor.address, displayText: anchor.displayText, parts: anchor.parts })) }
    } catch (err: any) { result = { ok: false, error: String(err?.message || err) } }
    link.send('flux:header-schema-read', result)
  }
  // Запросы, пришедшие до готовности книги, обрабатываем теперь.
  for (const request of earlyHeaderRequests.splice(0)) headerSchemaReader(request)
  link.on('flux:sync-header-schema', async (_e, request: any) => {
    const payload = request?.payload ?? request ?? {}
    const priorApplying = applyingFlux
    let result: any
    try {
      if (fluxReadOnly) throw new Error('Книга Flux открыта только для чтения')
      const wb = workbook(); const schema = payload.schema; const removed = payload.removedAnchorIds ?? []
      if (!wb || !schema || schema.version !== 1 || !Array.isArray(schema.anchors) || schema.anchors.length > 500 || !Array.isArray(removed) || removed.length > 500) throw new Error('Схема заголовков имеет неверный формат')
      const labels = payload.displayLabels && typeof payload.displayLabels === 'object' ? payload.displayLabels : {}
      if (Object.values(labels).some((label: any) => typeof label !== 'string' || label.length > 2000)) throw new Error('Подписи заголовков имеют неверный формат')
      const seen = new Set<string>()
      const targets: Array<{ id: string; sheet: any; row: number; col: number; address: string; name: string; ref: string; value: string }> = []
      const definitions = new Map<string, any>((wb.getDefinedNames?.() || []).map((d: any) => [String(d.getName()), d]))
      const validBinding = (binding: any, anchorId: string): boolean => !!binding && typeof binding.fieldKey === 'string' && binding.fieldKey.length > 0 && binding.fieldKey.length <= 200 && typeof binding.sourceId === 'string' && binding.sourceId.length > 0 && binding.sourceId.length <= 200 && typeof binding.entityType === 'string' && binding.entityType.length > 0 && binding.entityType.length <= 200 && String(binding.anchorId || anchorId) === anchorId
      const columnLetters = (col: number): string => { let s = ''; for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s }
      const labelFor = (binding: any): string => String(labels[`${binding?.sourceId || ''}:${binding?.fieldKey || ''}`] ?? labels[binding?.fieldKey || ''] ?? binding?.displayName ?? binding?.fieldKey ?? '')
      const renderParts = (parts: any[]): string => parts.map((part: any) => {
        if (part?.kind === 'text') return String(part.text || '')
        if (part?.kind === 'operator') return ['+', '-', '*', '/', '(', ')'].includes(part.operator) ? part.operator : ''
        if (part?.kind === 'field') return labelFor(part.binding)
        if (part?.kind === 'union' && Array.isArray(part.alternatives)) return typeof part.label === 'string' ? part.label : part.alternatives.map(labelFor).join(' / ')
        throw new Error('В схеме есть неподдерживаемая часть заголовка')
      }).join('')
      for (const anchor of schema.anchors) {
        const id = String(anchor?.id || '')
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || seen.has(id) || !Array.isArray(anchor.parts) || anchor.parts.length > 500) throw new Error('В схеме есть неверный или повторный якорь')
        seen.add(id)
        if (anchor.kind !== 'excel-range' || typeof anchor.sheetName !== 'string' || !anchor.sheetName || typeof anchor.address !== 'string') throw new Error(`Для ячейки заголовка ${id} не задан адрес Excel`)
        for (const part of anchor.parts) {
          const valid = part?.kind === 'text' && typeof part.text === 'string' && part.text.length <= 10000
            || part?.kind === 'operator' && ['+', '-', '*', '/', '(', ')'].includes(part.operator)
            || part?.kind === 'field' && validBinding(part.binding, id)
            || part?.kind === 'union' && part.mode === 'first-match' && (part.label === undefined || (typeof part.label === 'string' && part.label.length <= 2000)) && Array.isArray(part.alternatives) && part.alternatives.length > 0 && part.alternatives.length <= 100 && part.alternatives.every((item: any) => validBinding(item, id) && Number.isInteger(item.priority) && item.priority >= 0)
          if (!valid) throw new Error(`В заголовке ${id} есть неподдерживаемая часть`)
        }
        const sheet = wb.getSheets?.().find((item: any) => String(item.getSheetName()) === anchor.sheetName)
        const address = anchor.address.replace(/\$/g, '').toUpperCase()
        const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(address)
        if (!sheet || !match) throw new Error(`Ячейка заголовка ${anchor.sheetName}!${anchor.address} не найдена`)
        const col = columnNumber(match[1]!) - 1; const row = Number(match[2]!) - 1
        const name = fluxAnchorName(id); const ref = `'${anchor.sheetName.replace(/'/g, "''")}'!$${match[1]!}$${match[2]!}`
        targets.push({ id, sheet, row, col, address, name, ref, value: renderParts(anchor.parts) })
      }
      if (removed.some((id: any) => !/^[0-9a-f-]{36}$/i.test(String(id))) || new Set(removed.map(String)).size !== removed.length || removed.some((id: any) => seen.has(String(id)))) throw new Error('Изменение схемы повторно удаляет или одновременно сохраняет якорь')
      const oldCells = targets.map((target) => ({ ...target, value: target.sheet.getRange(target.row, target.col, 1, 1).getValues()?.[0]?.[0] ?? '' }))
      const oldNames = new Map<string, string | null>()
      for (const target of targets) oldNames.set(target.name, definitions.has(target.name) ? String(definitions.get(target.name)?.getRef?.() ?? definitions.get(target.name)?.getFormulaOrRefString?.() ?? '') : null)
      for (const id of removed) {
        const name = fluxAnchorName(String(id)); const definition = definitions.get(name)
        if (definition) oldNames.set(name, String(definition.getRef?.() ?? definition.getFormulaOrRefString?.() ?? ''))
      }
      applyingFlux = true
      const syncRuntime = hooks()?.univerRef.current
      const undoBatch = syncRuntime?.univer?.__getInjector?.().get(IUndoRedoService)?.__tempBatchingUndoRedo(wb.getId())
      if (!undoBatch) { applyingFlux = priorApplying; throw new Error('Не удалось сгруппировать изменения схемы для отмены') }
      try {
        for (const target of targets) target.sheet.getRange(target.row, target.col, 1, 1).setValues([[{ v: target.value }]])
        // Группировка нужна подписям ячеек; имена меток вне истории (см. withoutHistory) и вне группы:
        // иначе их запись склеилась бы с предыдущим шагом человека
        undoBatch.dispose()
        withoutHistory(wb, () => {
          for (const target of targets) setAnchorName(wb, target.name, target.ref)
          for (const id of removed) wb.deleteDefinedName?.(fluxAnchorName(String(id)))
        })
      } catch (error) {
        for (const old of oldCells.reverse()) { try { old.sheet.getRange(old.row, old.col, 1, 1).setValues([[old.value]]) } catch { /* best-effort rollback */ } }
        for (const [name, ref] of oldNames) {
          try { wb.deleteDefinedName?.(name); if (ref) wb.insertDefinedName(name, ref) } catch { /* best-effort rollback */ }
        }
        throw error
      } finally { undoBatch.dispose(); applyingFlux = priorApplying }
      result = { ok: true, schemaVersion: schema.version, headers: targets.map(({ id, sheet, address, value }) => ({ anchorId: id, kind: 'excel-range', sheetName: sheet.getSheetName(), address, displayText: value })) }
    } catch (err: any) { applyingFlux = priorApplying; result = { ok: false, error: String(err?.message || err) } }
    link.send('flux:header-schema-synced', result)
  })
  link.on('flux:merge-header-columns', async (_e, request: any) => {
    const payload = request?.payload ?? request ?? {}
    const priorApplying = applyingFlux
    const replyMerge = (result: any) => link.send('flux:header-columns-merged', result)
    try {
      if (fluxReadOnly) throw new Error('Книга Flux открыта только для чтения')
      const wb = workbook()
      const schema = payload.schema
      const sourceSchema = payload.sourceSchema
      const targetId = String(payload.targetAnchorId || '')
      const sourceIds = Array.isArray(payload.sourceAnchorIds) ? payload.sourceAnchorIds.map(String) : []
      if (!wb || !schema || schema.version !== 1 || !Array.isArray(schema.anchors) || sourceIds.length !== 1 || !targetId || sourceIds[0] === targetId) throw new Error('План объединения заголовков имеет неверный формат')
      const sourceId = sourceIds[0]!
      const targetAnchor = schema.anchors.find((anchor: any) => String(anchor?.id || '') === targetId)
      const originalAnchors = sourceSchema?.version === 1 && Array.isArray(sourceSchema.anchors) ? sourceSchema.anchors : []
      const sourceAnchor = originalAnchors.find((anchor: any) => String(anchor?.id || '') === sourceId)
      const outputUnion = targetAnchor?.parts?.find((part: any) => part?.kind === 'union')
      if (!targetAnchor || !sourceAnchor || sourceAnchor.kind !== 'excel-range' || !originalAnchors.some((anchor: any) => String(anchor?.id || '') === targetId) || !outputUnion || outputUnion.mode !== 'first-match' || !Array.isArray(outputUnion.alternatives) || !outputUnion.alternatives.length || schema.anchors.some((anchor: any) => String(anchor?.id || '') === sourceId) || schema.anchors.length > 500) throw new Error('Один из выбранных заголовков отсутствует в исходной или выходной схеме')
      const definitions = new Map<string, any>((wb.getDefinedNames?.() || []).map((item: any) => [String(item.getName()), item]))
      const parseRef = (raw: unknown): { sheet: any; row: number; col: number; address: string } | null => {
        const ref = String(raw ?? '').trim().replace(/^=/, '')
        const match = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(ref)
        if (!match) return null
        const sheetName = (match[1] ?? match[2] ?? '').replace(/''/g, "'")
        const sheet = wb.getSheets?.().find((item: any) => String(item.getSheetName()) === sheetName)
        if (!sheet) return null
        const col = columnNumber(match[3]!) - 1
        const row = Number(match[4]!) - 1
        if (row < 0 || col < 0 || !Number.isSafeInteger(row)) return null
        return { sheet, row, col, address: `${match[3]!.toUpperCase()}${match[4]!}` }
      }
      const target = parseRef(definitions.get(fluxAnchorName(targetId))?.getRef?.() ?? definitions.get(fluxAnchorName(targetId))?.getFormulaOrRefString?.())
      const source = parseRef(definitions.get(fluxAnchorName(sourceId))?.getRef?.() ?? definitions.get(fluxAnchorName(sourceId))?.getFormulaOrRefString?.())
      if (!target || !source) throw new Error('Не найдены сохранённые ячейки заголовков')
      if (target.sheet.getSheetId() !== source.sheet.getSheetId() || target.row !== source.row || Math.abs(target.col - source.col) !== 1) throw new Error('Для объединения выберите соседние заголовки одного листа и строки')
      const sheet = target.sheet
      const currentRuntime = hooks()?.univerRef.current
      const lazyRef = hooks()?.lazyWorkbookRef
      const currentLazy = lazyRef?.current
      const originalWorkbookId = wb.getId()
      const lastRow = Math.max(target.row, Number(sheet.getLastRow?.() ?? target.row))
      const lastColumn = Math.max(target.col, source.col, Number(sheet.getLastColumn?.() ?? Math.max(target.col, source.col)))
      if ((lastRow + 1) * (lastColumn + 1) > 100000) throw new Error('Выбранный лист слишком велик для безопасной проверки')
      if (currentLazy && lazyRef && !currentLazy.flags?.preloadComplete) {
        // Staleness checks include the rest of the used sheet so a manual edit
        // to a neighboring column cannot slip through an old merge preview.
        const loadRange = { startRow: 0, endRow: lastRow, startColumn: 0, endColumn: lastColumn }
        if (!(await ensureLazyRangeLoaded(currentRuntime, lazyRef, sheet, loadRange, () => undefined))) throw new Error('Данные выбранных колонок ещё не загружены')
        if (hooks()?.univerRef.current !== currentRuntime || hooks()?.lazyWorkbookRef.current !== currentLazy || workbook()?.getId() !== originalWorkbookId) throw new Error('Книга изменилась во время проверки. Повторите действие')
      }
      const headerSnapshot = [target, source].map((location) => {
        const cell = location.sheet.getRange(location.row, location.col, 1, 1)
        return { row: location.row, col: location.col, value: cell.getValues?.()?.[0]?.[0], formula: String(cell.getFormulas?.()?.[0]?.[0] || '') }
      })
      const snapshots: Array<{ row: number; targetValue: any; sourceValue: any; targetFormula: string; sourceFormula: string }> = []
      const conflicts: Array<{ rowIndex: number; targetText: string; sourceText: string }> = []
      const hasContent = (value: any, formula: string): boolean => !!formula || (value !== null && value !== undefined && value !== '')
      const show = (value: any, formula: string): string => formula || (value === null || value === undefined ? '' : String(value))
      // Deleting a column also destroys cells above the selected header. These
      // cannot be moved safely as part of a header merge, so disclose each one
      // as a conflict before any native mutation.
      for (let row = 0; row < target.row; row++) {
        const sourceCell = sheet.getRange(row, source.col, 1, 1)
        const sourceValue = sourceCell.getValues?.()?.[0]?.[0]
        const sourceFormula = String(sourceCell.getFormulas?.()?.[0]?.[0] || '')
        if (hasContent(sourceValue, sourceFormula)) conflicts.push({ rowIndex: row + 1, targetText: '', sourceText: show(sourceValue, sourceFormula) })
      }
      // Output-label editing replaces the target header and removes the source
      // header. Formula headers are therefore surfaced as preview conflicts,
      // never silently overwritten or discarded.
      if (headerSnapshot.some((cell) => !!cell.formula)) {
        const targetHeader = headerSnapshot[target.col < source.col ? 0 : 1]!
        const sourceHeader = headerSnapshot[target.col < source.col ? 1 : 0]!
        conflicts.push({ rowIndex: target.row + 1, targetText: show(targetHeader.value, targetHeader.formula), sourceText: show(sourceHeader.value, sourceHeader.formula) })
      }
      for (let row = target.row + 1; row <= lastRow; row++) {
        const values = sheet.getRange(row, Math.min(target.col, source.col), 1, 2).getValues()?.[0] || []
        const formulas = sheet.getRange(row, Math.min(target.col, source.col), 1, 2).getFormulas?.()?.[0] || []
        const targetAt = target.col < source.col ? 0 : 1
        const sourceAt = 1 - targetAt
        const item = { row, targetValue: values[targetAt], sourceValue: values[sourceAt], targetFormula: String(formulas[targetAt] || ''), sourceFormula: String(formulas[sourceAt] || '') }
        snapshots.push(item)
        const targetHas = hasContent(item.targetValue, item.targetFormula)
        const sourceHas = hasContent(item.sourceValue, item.sourceFormula)
        const sameValue = JSON.stringify(item.targetValue ?? null) === JSON.stringify(item.sourceValue ?? null)
        const sameFormula = item.targetFormula === item.sourceFormula
        if (targetHas && sourceHas && !(sameValue && sameFormula)) conflicts.push({ rowIndex: row + 1, targetText: show(item.targetValue, item.targetFormula), sourceText: show(item.sourceValue, item.sourceFormula) })
      }
      const usedSheet = sheet.getRange(0, 0, lastRow + 1, lastColumn + 1)
      const snapshot = JSON.stringify({
        headers: headerSnapshot,
        rows: snapshots,
        usedSheet: { values: usedSheet.getValues?.() || [], formulas: usedSheet.getFormulas?.() || [] },
      })
      const schemaKey = JSON.stringify({ desired: schema, source: sourceSchema })
      if (payload.previewOnly === true) {
        for (const [token, item] of headerMergePreviews) if (item.expires < Date.now()) headerMergePreviews.delete(token)
        while (headerMergePreviews.size >= 100) headerMergePreviews.delete(headerMergePreviews.keys().next().value!)
        const previewToken = globalThis.crypto.randomUUID()
        headerMergePreviews.set(previewToken, { workbookId: originalWorkbookId, sheetId: String(sheet.getSheetId()), targetId, sourceId, schema: schemaKey, snapshot, expires: Date.now() + 120_000 })
        replyMerge({ ok: true, previewToken, conflicts })
        return
      }
      const previewToken = String(payload.previewToken || '')
      const preview = headerMergePreviews.get(previewToken)
      headerMergePreviews.delete(previewToken)
      if (payload.confirm !== true || !preview || preview.expires < Date.now() || preview.workbookId !== originalWorkbookId || preview.sheetId !== String(sheet.getSheetId()) || preview.targetId !== targetId || preview.sourceId !== sourceId || preview.schema !== schemaKey || preview.snapshot !== snapshot) throw new Error('Содержимое книги изменилось после предварительного просмотра. Проверьте объединение ещё раз')
      if (conflicts.length) { replyMerge({ ok: false, conflicts, error: 'В выбранных колонках есть разные непустые значения. Они сохранены без изменений' }); return }
      const sourceName = fluxAnchorName(sourceId)
      const sourceRef = String(definitions.get(sourceName)?.getRef?.() ?? definitions.get(sourceName)?.getFormulaOrRefString?.() ?? '')
      const namesToMove: Array<{ name: string; oldRef: string; newRef: string }> = []
      const headerCell = sheet.getRange(target.row, target.col, 1, 1)
      const oldHeader = { value: headerCell.getValues?.()?.[0]?.[0], formula: String(headerCell.getFormulas?.()?.[0]?.[0] || '') }
      if (oldHeader.formula) throw new Error('Заголовок выхода содержит формулу; сначала замените её обычной подписью')
      const bindingLabel = (binding: any): string => String(binding?.displayName || binding?.fieldKey || '')
      const outputLabel = String(targetAnchor.label || targetAnchor.parts?.find((part: any) => part?.kind === 'union')?.label || targetAnchor.parts?.map((part: any) => {
        if (part?.kind === 'text') return String(part.text || '')
        if (part?.kind === 'operator') return String(part.operator || '')
        if (part?.kind === 'field') return bindingLabel(part.binding)
        if (part?.kind === 'union') return Array.isArray(part.alternatives) ? part.alternatives.map(bindingLabel).join(' / ') : ''
        return ''
      }).join('') || '')
      if (!outputLabel.trim()) throw new Error('Для выходного заголовка задайте название')
      const letters = (column: number): string => {
        let result = ''
        for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + (value - 1) % 26) + result
        return result
      }
      for (const defined of wb.getDefinedNames?.() || []) {
        const name = String(defined?.getName?.() || '')
        if (!name || name === sourceName) continue
        const oldRef = String(defined?.getRef?.() ?? defined?.getFormulaOrRefString?.() ?? '')
        const location = parseRef(oldRef)
        if (location && location.sheet.getSheetId() === sheet.getSheetId() && location.col === source.col) {
          const newRef = `'${String(sheet.getSheetName()).replace(/'/g, "''")}'!$${letters(target.col)}$${location.row + 1}`
          namesToMove.push({ name, oldRef, newRef })
        }
      }
      applyingFlux = true
      const undoBatch = currentRuntime?.univer?.__getInjector?.().get(IUndoRedoService)?.__tempBatchingUndoRedo(originalWorkbookId)
      if (!undoBatch) { applyingFlux = priorApplying; throw new Error('Невозможно безопасно объединить команды в одно действие отмены') }
      try {
        for (const item of snapshots) {
          if (!hasContent(item.targetValue, item.targetFormula) && hasContent(item.sourceValue, item.sourceFormula)) {
            const targetCell = sheet.getRange(item.row, target.col, 1, 1)
            if (item.sourceFormula) targetCell.setFormulas([[item.sourceFormula]])
            else targetCell.setValues([[item.sourceValue]])
          }
        }
        headerCell.setValues([[{ v: outputLabel }]])
        // Метки Flux вне истории (см. withoutHistory); чужие имена Excel возвращаются вместе с колонкой
        const moveName = (item: { name: string; newRef: string }) => { wb.deleteDefinedName?.(item.name); wb.insertDefinedName(item.name, item.newRef) }
        for (const item of namesToMove) {
          if (item.name.startsWith('FLUX_ANCHOR_')) withoutHistory(wb, () => setAnchorName(wb, item.name, item.newRef)); else moveName(item)
        }
        withoutHistory(wb, () => wb.deleteDefinedName?.(sourceName))
        sheet.deleteColumn(source.col)
        dropAnchorNamesFromHistory(wb)
      } catch (error) {
        // До удаления колонки восстанавливаем только те выходные ячейки,
        // которые были заполнены данными исходной колонки.
        for (const item of snapshots) {
          if (!hasContent(item.targetValue, item.targetFormula) && hasContent(item.sourceValue, item.sourceFormula)) {
            try {
              const cell = sheet.getRange(item.row, target.col, 1, 1)
              if (item.targetFormula) cell.setFormulas([[item.targetFormula]])
              else cell.setValues([[item.targetValue ?? '']])
            } catch { /* сохраняем возможность откатить остальные строки */ }
          }
        }
        try { if (oldHeader.formula) headerCell.setFormulas([[oldHeader.formula]]); else headerCell.setValues([[oldHeader.value ?? '']]) } catch { /* откат продолжается, если ячейка заголовка недоступна */ }
        for (const item of namesToMove) {
          try { wb.deleteDefinedName?.(item.name); wb.insertDefinedName(item.name, item.oldRef) } catch { /* восстанавливаем остальные метки */ }
        }
        if (sourceRef) { try { wb.insertDefinedName(sourceName, sourceRef) } catch { /* имя уже могло сохраниться при ошибке редактора */ } }
        throw error
      } finally { undoBatch.dispose(); applyingFlux = priorApplying }

      const updatedDefinitions = new Map<string, any>((wb.getDefinedNames?.() || []).map((item: any) => [String(item.getName()), item]))
      const updatedSchema = { ...schema, anchors: schema.anchors.filter((anchor: any) => String(anchor.id) !== sourceId).map((anchor: any) => {
        const name = fluxAnchorName(String(anchor.id))
        const location = parseRef(updatedDefinitions.get(name)?.getRef?.() ?? updatedDefinitions.get(name)?.getFormulaOrRefString?.())
        return location ? { ...anchor, kind: 'excel-range', sheetName: String(location.sheet.getSheetName()), address: location.address } : anchor
      }) }
      const headerResponse = updatedSchema.anchors.map((anchor: any) => {
        const parts = Array.isArray(anchor.parts) ? anchor.parts : []
        const displayText = String(anchor.label || parts.map((part: any) => part?.kind === 'text' ? String(part.text || '') : part?.kind === 'operator' ? String(part.operator || '') : part?.kind === 'field' ? String(part.binding?.displayName || part.binding?.fieldKey || '') : part?.kind === 'union' ? String(part.label || part.alternatives?.map((item: any) => item?.displayName || item?.fieldKey).join(' / ') || '') : '').join(''))
        return { anchorId: anchor.id, kind: 'excel-range', sheetName: anchor.sheetName, address: anchor.address, displayText, parts }
      })
      const originalRows = Array.isArray(payload.rows) ? payload.rows : []
      const snapshotsByRow = new Map(snapshots.map((item) => [item.row + 1, item]))
      const updatedRows = originalRows.map((row: any) => {
        const cells = { ...(row?.cells || {}) }
        const values = { ...(row?.values || {}) }
        const sourceValue = values[sourceId]
        const targetValue = values[targetId]
        const sourceAddress = /^([A-Z]{1,3})([1-9]\d*)$/i.exec(String(cells[sourceId] || ''))
        const sourceSnapshot = sourceAddress ? snapshotsByRow.get(Number(sourceAddress[2])) : undefined
        if ((targetValue === undefined || targetValue === null || targetValue === '') && sourceSnapshot && hasContent(sourceSnapshot.sourceValue, sourceSnapshot.sourceFormula)) values[targetId] = sourceValue ?? show(sourceSnapshot.sourceValue, sourceSnapshot.sourceFormula)
        delete cells[sourceId]
        delete values[sourceId]
        const nextCells: Record<string, string> = {}
        for (const [anchorId, address] of Object.entries(cells)) {
          const priorAnchor = schema.anchors.find((item: any) => String(item.id) === anchorId)
          const oldLocation = parseRef(updatedDefinitions.get(fluxAnchorName(anchorId))?.getRef?.() ?? updatedDefinitions.get(fluxAnchorName(anchorId))?.getFormulaOrRefString?.())
          const parsedAddress = /^([A-Z]{1,3})([1-9]\d*)$/i.exec(String(address || ''))
          let col = -1
          if (parsedAddress) col = columnNumber(parsedAddress[1]!) - 1
          const anchorLocation = priorAnchor ? parseRef(`'${String(priorAnchor.sheetName || '').replace(/'/g, "''")}'!${priorAnchor.address || ''}`) : null
          const onEditedSheet = oldLocation?.sheet.getSheetId() === sheet.getSheetId() || anchorLocation?.sheet.getSheetId() === sheet.getSheetId()
          if (parsedAddress && onEditedSheet && col > source.col) col--
          if (parsedAddress) {
            let letters = ''; for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters
            nextCells[anchorId] = `${letters}${parsedAddress[2]!}`
          } else nextCells[anchorId] = String(address)
        }
        const anchorIds = Array.isArray(row?.anchorIds) ? row.anchorIds.filter((id: any) => String(id) !== sourceId) : []
        return { ...row, anchorIds, cells: nextCells, values }
      })
      refreshNames()
      replyMerge({ ok: true, schema: updatedSchema, headers: headerResponse, rows: updatedRows, conflicts: [] })
    } catch (error: any) {
      applyingFlux = priorApplying
      replyMerge({ ok: false, error: String(error?.message || error) })
    }
  })
  link.on('flux:insert-table', (_e, message: any) => {
    try {
      if (fluxReadOnly) throw new Error('Книга Flux открыта только для чтения')
      const wb = workbook(); const sheet = wb?.getActiveSheet(); const cell = wb?.getActiveCell?.();
      const rows = message?.payload?.rows;
      if (!sheet || !cell || !Array.isArray(rows) || !rows.length || rows.length > 10000) throw new Error('Выделите ячейку и таблицу до 10 000 строк');
      const range = cell.getRange(); const width = Math.max(...rows.map((r: any[]) => r.length));
      if (!width || width > 200) throw new Error('Допускается до 200 столбцов');
      sheet.getRange(range.startRow, range.startColumn, rows.length, width).setValues(rows.map((r: any[]) => Array.from({ length: width }, (_, i) => ({ v: r[i] ?? '' }))));
      reply(message.id, { ok: true });
    } catch (e: any) { reply(message?.id, { ok: false, error: e.message }); }
  });
  link.on('flux:refresh-export', async (_e, message: any) => {
    try {
      if (fluxReadOnly) throw new Error('Книга Flux открыта только для чтения')
      const wb = workbook(); const grid = message?.payload?.grid; const before = message?.payload?.before;
      if (!wb || !grid || grid.rows.length * grid.headers.length > 10000) throw new Error('За одно обновление допускается до 10 000 ячеек данных');
      const definitions = new Map<string, any>((wb.getDefinedNames?.() || []).map((d: any) => [d.getName(), d]));
      const locate = (name: string): { sheet: any; row: number; col: number } | null => {
        const d = definitions.get(name); const ref = String(d?.getFormulaOrRefString?.() || '');
        const m = /^=?'((?:[^']|'')+)'!\$?([A-Z]+)\$?(\d+)$/i.exec(ref) || /^=?([^'!]+)!\$?([A-Z]+)\$?(\d+)$/i.exec(ref);
        if (!m) return null;
        const sheet = wb.getSheets().find((s: any) => s.getSheetName() === m[1]!.replace(/''/g, "'"));
        let col = 0; for (const c of m[2]!.toUpperCase()) col = col * 26 + c.charCodeAt(0) - 64;
        return sheet ? { sheet, row: Number(m[3]!) - 1, col: col - 1 } : null;
      };
      const nameOf = (row: string, col: string): string => {
        let a = 2166136261; let b = 5381;
        for (const c of `${row}\u0000${col}`) { a = Math.imul(a ^ c.codePointAt(0)!, 16777619); b = Math.imul(b, 33) ^ c.codePointAt(0)!; }
        return `FXE_${(a >>> 0).toString(16)}_${(b >>> 0).toString(16)}`;
      };
      const letters = (col: number): string => { let s = ''; for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
      const firstHeader = grid.columnKeys.map((k: string) => locate(nameOf('@header', k))).find(Boolean);
      const sheet = firstHeader?.sheet || wb.getSheets().find((s: any) => s.getSheetName() === 'Данные') || wb.getActiveSheet();
      if (!sheet) throw new Error('Лист данных не найден');
      // Скрытый идентификатор строки не попадает в видимую загрузку Univer.
      // Без явной загрузки корректная строка выглядит чужой и пропускает новые формулы.
      const runtime = hooks()?.univerRef.current;
      const lazy = hooks()?.lazyWorkbookRef;
      if (runtime && lazy?.current && !lazy.current.flags?.preloadComplete) {
        const resident = [...definitions.keys()].filter(k => k.startsWith('FXE_')).map(locate).filter((p): p is NonNullable<typeof p> => !!p && p.sheet.getSheetId() === sheet.getSheetId());
        if (resident.length) {
          const range = { startRow: Math.min(...resident.map(p => p.row)), endRow: Math.max(...resident.map(p => p.row)), startColumn: Math.min(...resident.map(p => p.col)), endColumn: Math.max(...resident.map(p => p.col)) };
          if ((range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) > 100000) throw new Error('Связанные ячейки расположены слишком далеко друг от друга. Сократите рабочую область перед обновлением');
          if (!(await ensureLazyRangeLoaded(runtime, lazy, sheet, range, () => undefined))) throw new Error('Не удалось прочитать связанные ячейки книги. Дождитесь загрузки и повторите обновление');
        }
      }
      let lastRow = sheet.getLastRow(); let lastCol = sheet.getLastColumn();
      const headerRow = firstHeader?.row ?? 0;
      const oldRows = new Map<string, number>((before?.rowKeys || []).map((k: string, i: number) => [k, i]));
      const oldCols = new Map<string, number>((before?.columnKeys || []).map((k: string, i: number) => [k, i]));
      let updated = 0; let preserved = 0;
      const write = (rowKey: string, colKey: string, value: any, fallbackRow: number, fallbackCol: number, oldValue: any, formula = false): void => {
        const name = nameOf(rowKey, colKey); const found = locate(name); const target = found || { sheet, row: fallbackRow, col: fallbackCol };
        if (target.sheet.getSheetId() !== sheet.getSheetId()) { preserved++; return; }
        const cell = sheet.getRange(target.row, target.col, 1, 1);
        const current = cell.getValues()?.[0]?.[0]; const currentFormula = cell.getFormulas()?.[0]?.[0];
        // Новую область тоже не затираем, если пользователь уже занял её.
        if ((found && (currentFormula || (oldValue !== undefined && String(current ?? '') !== String(oldValue ?? '')))) || (!found && current !== null && current !== undefined && current !== '')) { preserved++; return; }
        cell.setValues([[formula ? { f: String(value || '').replace(/\{row\}/g, String(target.row + 1)) } : { v: value ?? '' }]]);
        if (!found) wb.insertDefinedName(name, `'${sheet.getSheetName().replace(/'/g, "''")}'!$${letters(target.col)}$${target.row + 1}`);
        updated++;
      };
      const identityHeader = locate(nameOf('@header', '@identity'));
      if (!identityHeader) throw new Error('Эта книга создана в старом формате. Создайте новую книгу; прежняя останется в Выгрузках');
      const identityCol = identityHeader.col;
      const cols = grid.columnKeys.map((k: string, i: number) => {
        const old = locate(nameOf('@header', k)); const col = old?.col ?? ++lastCol;
        write('@header', k, grid.headers[i], headerRow, col, before?.headers?.[oldCols.get(k)!]); return col;
      });
      grid.rows.forEach((r: any[], at: number) => {
        const rowKey = grid.rowKeys[at]; const oldAt = oldRows.get(rowKey);
        const identity = locate(nameOf(rowKey, '@identity'));
        // Сортировка переносит значения, но имена Excel могут остаться на старых
        // адресах. Такой ряд не обновляем, чтобы не подставить чужую позицию.
        if (oldAt !== undefined && (!identity || identity.sheet.getRange(identity.row, identity.col, 1, 1).getValues()?.[0]?.[0] !== rowKey)) { preserved += r.length; return; }
        const anchor = grid.columnKeys.map((k: string) => locate(nameOf(rowKey, k))).find(Boolean);
        const row = anchor?.row ?? ++lastRow;
        if (!identity) write(rowKey, '@identity', rowKey, row, identityCol, undefined);
        r.forEach((value: any, i: number) => write(rowKey, grid.columnKeys[i], grid.formulaTemplates?.[i] ?? value, row, cols[i], oldAt === undefined ? undefined : before?.rows?.[oldAt]?.[oldCols.get(grid.columnKeys[i])!], grid.formulas.includes(i)));
      });
      reply(message.id, { ok: true, updated, preserved, retainedRows: [...oldRows.keys()].filter(k => !grid.rowKeys.includes(k)).length });
    } catch (e: any) { reply(message?.id, { ok: false, error: e.message }); }
  });
  link.on('flux:apply-office-plan', async (_e, message: any) => {
    const payload = message?.payload ?? message ?? {};
    try {
      if (fluxReadOnly) throw new Error('Книга Flux открыта только для чтения')
      const wb = workbook();
      const writes = payload.writes;
      const schema = payload.schema;
      const previousRows = Array.isArray(payload.rows) ? payload.rows : [];
      if (!wb || !Array.isArray(writes) || !writes.length || writes.length > 100000) throw new Error('План заполнения пуст или слишком велик');
      if (!schema || !Array.isArray(schema.anchors) || schema.anchors.length > 1000) throw new Error('Схема документа не загружена');
      const definitions = new Map<string, any>((wb.getDefinedNames?.() || []).map((d: any) => [String(d.getName()), d]));
      const parseRef = (raw: unknown): { sheet: any; row: number; col: number; address: string } | null => {
        const ref = String(raw ?? '').trim().replace(/^=/, '');
        const m = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref);
        if (!m) return null;
        const sheetNameValue = m[1] ?? m[2];
        if (sheetNameValue === undefined) return null;
        const sheetName = sheetNameValue.replace(/''/g, "'");
        const sheet = wb.getSheets?.().find((s: any) => String(s.getSheetName()) === sheetName);
        if (!sheet) return null;
        let col = 0; for (const c of m[3]!.toUpperCase()) col = col * 26 + c.charCodeAt(0) - 64;
        const row = Number(m[4]) - 1;
        if (row < 0 || col < 1 || !Number.isSafeInteger(row)) return null;
        return { sheet, row, col: col - 1, address: `${m[3]!.toUpperCase()}${m[4]!}` };
      };
      const rangeFor = (name: string) => parseRef(definitions.get(name)?.getRef?.() ?? definitions.get(name)?.getFormulaOrRefString?.());
      const idHash = (value: string): string => {
        let a = 2166136261, b = 5381;
        for (const c of value) { const n = c.codePointAt(0)!; a = Math.imul(a ^ n, 16777619); b = Math.imul(b, 33) ^ n; }
        return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
      };
      const anchorById = new Map<string, any>(schema.anchors.map((anchor: any) => [String(anchor.id), anchor]));
      const columns = new Map<string, { sheet: any; col: number }>();
      for (const write of writes) {
        const anchorId = String(write?.anchorId ?? '');
        if (!anchorById.has(anchorId)) throw new Error('План содержит метку, которой нет в схеме');
        const target = rangeFor(fluxAnchorName(anchorId));
        if (!target) throw new Error(`Не найдена сохранённая ячейка метки ${anchorId}`);
        const old = columns.get(anchorId);
        if (old && (old.sheet.getSheetId() !== target.sheet.getSheetId() || old.col !== target.col)) throw new Error('Метка указывает на несколько ячеек');
        columns.set(anchorId, target);
        if (!write || typeof write.entityId !== 'string' || !write.entityId || write.entityId.length > 300 || !(typeof write.value === 'string' || (typeof write.value === 'number' && Number.isFinite(write.value)))) throw new Error('План содержит некорректное значение');
      }
      const writeKeys = new Set<string>();
      for (const write of writes) {
        const key = `${write.entityId}\u0000${write.anchorId}`;
        if (writeKeys.has(key)) throw new Error('План содержит повторную запись одной ячейки');
        writeKeys.add(key);
      }
      const priorById = new Map<string, any>(previousRows.map((row: any) => [String(row?.entityId ?? ''), row]));
      const byEntity = new Map<string, any[]>();
      for (const write of writes) { const list = byEntity.get(write.entityId) || []; list.push(write); byEntity.set(write.entityId, list); }
      const rowKey = (entityId: string, sheet: any) => `${entityId}\u0000${String(sheet.getSheetName())}`;
      const rowMarker = (entityId: string, sheet: any, prior: any, items: any[]) => {
        const binding = items.map((write: any) => anchorById.get(write.anchorId)?.parts?.find((part: any) => part?.kind === 'field')?.binding).find(Boolean) || {};
        const sourceId = String(prior?.sourceId || binding.sourceId || '');
        const entityType = String(prior?.entityType || binding.entityType || '');
        return `FLUX_ROW_${idHash(`${sourceId}\u0000${entityType}\u0000${entityId}\u0000${sheet.getSheetName()}`)}`;
      };
      const targetRows = new Map<string, number>();
      const lastRows = new Map<any, number>();
      for (const [entityId, items] of byEntity) {
        const prior = priorById.get(entityId);
        const grouped = new Map<any, any[]>();
        for (const item of items) { const sheet = columns.get(item.anchorId)!.sheet; const list = grouped.get(sheet) || []; list.push(item); grouped.set(sheet, list); }
        for (const [sheet, sheetItems] of grouped) {
          const marker = rowMarker(entityId, sheet, prior, sheetItems);
          const existing = rangeFor(marker);
          const priorItem = sheetItems.find((item) => typeof prior?.cells?.[item.anchorId] === 'string');
          const priorAddress = priorItem ? String(prior.cells[priorItem.anchorId]) : '';
          const priorRowMatch = /^([A-Z]{1,3})(\d+)$/i.exec(priorAddress);
          const priorRow = priorRowMatch ? Number(priorRowMatch[2]) - 1 : undefined;
          const chosen = existing && existing.sheet.getSheetId() === sheet.getSheetId() ? existing.row : priorRow;
          if (!lastRows.has(sheet)) lastRows.set(sheet, Number(sheet.getLastRow?.() ?? 0));
          if (chosen !== undefined && chosen >= 0) targetRows.set(rowKey(entityId, sheet), chosen);
          // getLastRow() возвращает индекс, а не количество строк.
          // Новую запись добавляем за занятой строкой, сохраняя ручные данные.
          else { const next = lastRows.get(sheet)! + 1; lastRows.set(sheet, next); targetRows.set(rowKey(entityId, sheet), next); }
        }
      }
      // После сохранения книга снова загружается частями. Пустое значение
      // незагруженной ячейки нельзя принимать за ручную правку или свободное место.
      const runtime = hooks()?.univerRef.current;
      const lazy = hooks()?.lazyWorkbookRef;
      const originalLazy = lazy?.current;
      if (runtime && originalLazy && !originalLazy.flags?.preloadComplete) {
        const ranges = new Map<any, { startRow: number; endRow: number; startColumn: number; endColumn: number }>();
        for (const [entityId, items] of byEntity) for (const write of items) {
          const target = columns.get(write.anchorId)!;
          const row = targetRows.get(rowKey(entityId, target.sheet))!;
          const range = ranges.get(target.sheet);
          ranges.set(target.sheet, range ? { startRow: Math.min(range.startRow, row), endRow: Math.max(range.endRow, row), startColumn: Math.min(range.startColumn, target.col), endColumn: Math.max(range.endColumn, target.col) } : { startRow: row, endRow: row, startColumn: target.col, endColumn: target.col });
        }
        for (const [sheet, range] of ranges) {
          if ((range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) > 100000) throw new Error('Связанные ячейки слишком далеко друг от друга. Сократите рабочую область');
          if (!(await ensureLazyRangeLoaded(runtime, lazy, sheet, range, () => undefined))) throw new Error('Связанные ячейки ещё не загружены. Повторите обновление');
        }
        if (hooks()?.univerRef.current !== runtime || lazy.current !== originalLazy || workbook()?.getId() !== wb.getId()) throw new Error('Книга изменилась во время чтения ячеек. Повторите обновление');
      }
      const targets = new Set<string>();
      const changes: Array<{ cell: any; old: any; write: any; row: number; col: number; sheet: any }> = [];
      const manualRows = new Set<string>();
      const inspected: Array<{ cell: any; old: any; write: any; row: number; col: number; sheet: any }> = [];
      for (const [entityId, items] of byEntity) {
        const prior = priorById.get(entityId);
        for (const write of items) {
          const anchor = columns.get(write.anchorId)!;
          const sheet = anchor.sheet;
          const row = targetRows.get(rowKey(entityId, sheet))!;
          const col = anchor.col;
          const targetKey = `${sheet.getSheetId()}:${row}:${col}`;
          if (targets.has(targetKey)) throw new Error('Две метки указывают на одну целевую ячейку');
          targets.add(targetKey);
          const cell = sheet.getRange(row, col, 1, 1);
          const old = { values: cell.getValues?.()?.[0]?.[0], formulas: cell.getFormulas?.()?.[0]?.[0] };
          const knownAddress = prior?.cells?.[write.anchorId];
          const currentValue = old.values;
          if (!knownAddress && ((currentValue !== null && currentValue !== undefined && currentValue !== '') || String(old.formulas ?? '') !== '')) throw new Error(`Ячейка ${write.anchorId} в строке ${row + 1} занята; ручное содержимое сохранено`);
          const expected = prior?.values?.[write.anchorId];
          if (knownAddress && (String(currentValue ?? '') !== String(expected ?? '') || String(old.formulas ?? '') !== '')) manualRows.add(entityId);
          inspected.push({ cell, old, write, row, col, sheet });
        }
      }
      changes.push(...inspected.filter((change) => !manualRows.has(change.write.entityId)));
      const insertedNames: string[] = [];
      try {
        applyingFlux = true;
        for (const change of changes) {
          change.cell.setValues([[{ v: change.write.value }]]);
          const name = rowMarker(change.write.entityId, change.sheet, priorById.get(change.write.entityId), byEntity.get(change.write.entityId) || []);
          if (!definitions.has(name)) {
            const colName = (() => { let n = change.col + 1, out = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out; return out; })();
            wb.insertDefinedName(name, `'${change.sheet.getSheetName().replace(/'/g, "''")}'!$${colName}$${change.row + 1}`);
            definitions.set(name, true); insertedNames.push(name);
          }
        }
      } catch (error) {
        for (const change of changes) {
          try {
            if (change.old.formulas) change.cell.setFormulas?.([[change.old.formulas]])
            else change.cell.setValues([[change.old.values ?? '']])
          } catch { /* откат продолжает восстановление остальных ячеек */ }
        }
        for (const name of insertedNames) { try { wb.deleteDefinedName?.(name); } catch { /* откат продолжается, даже если имя удалить нельзя */ } }
        throw error;
      } finally {
        applyingFlux = false;
      }
      const updatedRows = [...byEntity.entries()].map(([entityId, items]) => {
        const prior = priorById.get(entityId) || {};
        if (manualRows.has(entityId)) return prior;
        const cells = { ...(prior.cells || {}) } as Record<string, string>;
        const values = { ...(prior.values || {}) } as Record<string, string>;
        for (const write of manualRows.has(entityId) ? [] : items) {
          const anchor = columns.get(write.anchorId)!;
          const col = anchor.col;
          let colName = ''; for (let n = Number(col) + 1; n > 0; n = Math.floor((n - 1) / 26)) colName = String.fromCharCode(65 + (n - 1) % 26) + colName;
          cells[write.anchorId] = `${colName}${targetRows.get(rowKey(entityId, anchor.sheet))! + 1}`;
          values[write.anchorId] = String(write.value);
        }
        const binding = items.map((write: any) => anchorById.get(write.anchorId)?.parts?.find((part: any) => part?.kind === 'field')?.binding).find(Boolean) || {};
        const sourceId = String(prior.sourceId || binding.sourceId || '');
        const entityType = String(prior.entityType || binding.entityType || '');
        const sourceRevision = String(payload.sourceRevision || prior.sourceRevision || binding.sourceRevision || '');
        return { entityId, entityType, sourceId, sourceRevision, anchorIds: [...new Set([...(prior.anchorIds || []), ...items.map((w: any) => w.anchorId)])], cells, values };
      });
      const updatedById = new Map(updatedRows.map((row: any) => [String(row.entityId), row]));
      // Выборка обновляет свои строки; ручные и невыбранные связи остаются.
      const rows = [...priorById.entries()].map(([id, row]) => updatedById.get(id) || row)
        .concat(updatedRows.filter((row: any) => !priorById.has(String(row.entityId))));
      link.send('flux:office-plan-applied', { ok: true, appliedCount: changes.length, rows, manualRows: [...manualRows] });
    } catch (error: any) {
      link.send('flux:office-plan-applied', { ok: false, error: String(error?.message || error) });
    }
  });
  // Подписчик read-only установлен до готовности: Flux может отправить режим
  // сразу после editor-ready, пока не зарегистрированы остальные команды.
  link.send('flux:editor-ready', { app: 'sheets' })
}
void exportCommands();
