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
    const a1 = String(cell?.getA1Notation?.() || '').split(':')[0].replace(/\$/g, '').toUpperCase()
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
      const refSheet = (refMatch[1] || refMatch[2]).replace(/''/g, "'")
      const refA1 = `${refMatch[3]}${refMatch[4]}`.toUpperCase()
      if (refSheet !== sheetName && refSheet !== quotedSheet) continue
      if (refA1 !== a1) continue
      const value = match[1]
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
        ? { tagId: value, identifier: '' }
        : { tagId: '', identifier: value }
    }
  } catch { /* книга или named range ещё не готовы */ }
  return null
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
  link.on('flux:insert-field', (_e, m: { name?: string; value?: unknown }) => {
    const wb = workbook()
    let result: { ok: boolean; cell?: string; error?: string } = { ok: false, error: 'Книга не готова' }
    try {
      const cell = wb?.getActiveCell?.() || wb?.getActiveRange?.()
      const sheet = wb?.getActiveSheet?.()
      if (!wb || !cell || !sheet || !m?.name) result = { ok: false, error: 'Выделите ячейку, куда поставить значение' }
      else {
        const a1 = String(cell.getA1Notation()).split(':')[0]
        cell.setValue(m.value ?? '')
        const ref = `'${String(sheet.getSheetName()).replace(/'/g, "''")}'!${absolute(a1)}`
        try { wb.deleteDefinedName?.(m.name) } catch { /* имени не было */ }
        wb.insertDefinedName(m.name, ref)
        result = { ok: true, cell: `${sheet.getSheetName()}!${a1}` }
      }
    } catch (err: any) { result = { ok: false, error: String(err?.message || err) } }
    link.send('flux:field-inserted', result)
  })
}

void start()
void fields()

/** Вставка таблиц и обновление выгрузки: адреса держатся именами Excel. */
async function exportCommands(): Promise<void> {
  const link = ipc(); if (!link) return;
  while (!workbook()) await new Promise(r => setTimeout(r, 300));
  const reply = (id: string, result: any) => link.send('flux:command-result', { id, ...result });
  link.on('flux:insert-table', (_e, message: any) => {
    try {
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
      const wb = workbook(); const grid = message?.payload?.grid; const before = message?.payload?.before;
      if (!wb || !grid || grid.rows.length * grid.headers.length > 10000) throw new Error('За одно обновление допускается до 10 000 ячеек данных');
      const definitions = new Map<string, any>((wb.getDefinedNames?.() || []).map((d: any) => [d.getName(), d]));
      const locate = (name: string): { sheet: any; row: number; col: number } | null => {
        const d = definitions.get(name); const ref = String(d?.getFormulaOrRefString?.() || '');
        const m = /^=?'((?:[^']|'')+)'!\$?([A-Z]+)\$?(\d+)$/i.exec(ref) || /^=?([^'!]+)!\$?([A-Z]+)\$?(\d+)$/i.exec(ref);
        if (!m) return null;
        const sheet = wb.getSheets().find((s: any) => s.getSheetName() === m[1].replace(/''/g, "'"));
        let col = 0; for (const c of m[2].toUpperCase()) col = col * 26 + c.charCodeAt(0) - 64;
        return sheet ? { sheet, row: Number(m[3]) - 1, col: col - 1 } : null;
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
}
void exportCommands();
