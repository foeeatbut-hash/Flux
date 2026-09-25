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

let active = false
let key = ''
let applying = false
let maxRemote = 0
let localSeq = 0
const queue: Remote[] = []
/** Свои, ещё без номера */
const pending = new Map<number, Op>()
/** Свои с номером: переиграть, если придёт чужая с меньшим */
let mine: Array<{ seq: number; op: Op }> = []
/** Имена листов до последней правки: по ним чужие правки находят свой лист */
let names = new Map<string, string>()
let saving: { lazy: any; until: number } | null = null

const api = () => hooks()?.univerRef.current?.univerAPI
const workbook = () => { try { return api()?.getActiveWorkbook() || null } catch { return null } }

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

void start()
