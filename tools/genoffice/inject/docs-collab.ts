/**
 * Flux Office: одновременная правка Документа — часть, живущая внутри
 * редактора GenOffice.
 *
 * Сборка (tools/genoffice/build.mjs) кладёт этот файл в
 * apps/docs/src/renderer/flux/ и подключает правками patches.mjs. Снаружи —
 * окно Flux (src/screens/OfficeHost.tsx): оно пересылает обновления между
 * этим редактором и сервером (server/officeCollab.ts) через мост
 * (flux-bridge.js: onFluxEvent / fluxTell).
 *
 * Как устроено:
 *   - тело документа — Y.XmlFragment через y-prosemirror: буквы соавтора
 *     появляются по мере ввода, курсоры видны;
 *   - всё, что редактор сохраняет вне тела (колонтитулы, разделы, нумерация
 *     списков, стили, примечания, сноски, подложка…), — общая карта
 *     Y.Map('side'): иначе нумерация нового списка или колонтитул второго
 *     участника пропали бы, когда файл запишет держатель;
 *   - у всех один исходник сеанса (окно открывает его, а не текущий файл):
 *     редактор помнит абзацы номерами блоков исходника, и сохранение с
 *     разных исходников испортило бы файл;
 *   - после записи файл не перечитывается (правка в file-actions.ts):
 *     перечитывание заменило бы документ у всех и сменило исходник.
 */
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import {
  prosemirrorToYXmlFragment, redoCommand, undoCommand, yCursorPlugin, ySyncPlugin, yUndoPlugin, ySyncPluginKey, yUndoPluginKey,
} from 'y-prosemirror'
import { UndoRedo } from '@tiptap/extensions'
import type { Editor } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { isPhasedContentPending } from '../phased-content'
import { waitForEditor } from './editor-readiness'

/** Свои изменения уходят на сервер, пришедшие — нет */
const REMOTE = 'flux-remote'

/**
 * Состояние редактора вне тела документа: [значение, сеттер].
 * Флаги «изменено» идут отдельными ключами: держатель пишет в файл только
 * то, что помечено изменённым.
 */
const SIDE: Array<[string, string]> = [
  ['section', 'setSection'], ['sectionDirty', 'setSectionDirty'],
  ['sections', 'setSections'], ['sectionsDirty', 'setSectionsDirty'],
  ['trailingStartType', 'setTrailingStartType'],
  ['pageColor', 'setPageColor'], ['pageColorDirty', 'setPageColorDirty'],
  ['header', 'setHeader'], ['headerDirty', 'setHeaderDirty'],
  ['footer', 'setFooter'], ['footerDirty', 'setFooterDirty'],
  ['hfVariants', 'setHfVariants'], ['hfVariantsDirty', 'setHfVariantsDirty'],
  ['sectionHfEdits', 'setSectionHfEdits'],
  ['titlePg', 'setTitlePg'], ['titlePgDirty', 'setTitlePgDirty'],
  ['evenOddHf', 'setEvenOddHf'], ['evenOddHfDirty', 'setEvenOddHfDirty'],
  ['pgNumEdit', 'setPgNumEdit'], ['pgNumDirtySections', 'setPgNumDirtySections'],
  ['pendingNumbering', 'setPendingNumbering'],
  ['defaultFonts', 'setDefaultFonts'],
  ['styleUpserts', 'setStyleUpserts'],
  ['comments', 'setComments'], ['commentsDirty', 'setCommentsDirty'],
  ['watermark', 'setWatermark'], ['watermarkDirty', 'setWatermarkDirty'],
  ['watermarkStyle', 'setWatermarkStyle'], ['watermarkPicture', 'setWatermarkPicture'],
  ['inkAnnotations', 'setInkAnnotations'], ['inksDirty', 'setInksDirty'],
  ['footnotes', 'setFootnotes'], ['endnotes', 'setEndnotes'], ['notesDirty', 'setNotesDirty'],
  ['sources', 'setSources'], ['sourcesDirty', 'setSourcesDirty'],
  ['themeFonts', 'setThemeFonts'], ['themeFontsDirty', 'setThemeFontsDirty'],
  ['themeColors', 'setThemeColors'], ['themeColorsDirty', 'setThemeColorsDirty'],
  ['protection', 'setProtection'], ['protectionDirty', 'setProtectionDirty'],
  ['removePersonalInfo', 'setRemovePersonalInfo'], ['removePersonalInfoDirty', 'setRemovePersonalInfoDirty'],
]

interface Port {
  on: (event: string, fn: (payload: any) => void) => () => void
  tell: (op: string, payload: unknown) => void
}

interface CollabState {
  /** Сеанс идёт: отмена — общая, после записи файл не перечитывается */
  active: boolean
  ydoc: Y.Doc | null
  awareness: Awareness | null
}

const state: CollabState = { active: false, ydoc: null, awareness: null }
;(globalThis as any).__fluxCollab = state

const port = (): Port | null => {
  const d = (window as any).desktop
  if (!d?.onFluxEvent || !d?.fluxTell) return null
  return { on: (e, fn) => d.onFluxEvent(e, fn), tell: (op, p) => d.fluxTell(op, p) }
}
const ctxNow = (): any => (window as any).__fluxCtxRef?.current || null

/**
 * Отмена и возврат: в сеансе — общая история Yjs (отменяется только своё),
 * вне сеанса — обычная история редактора. Подменяет UndoRedo в списке
 * расширений (правка patches.mjs), кнопки и клавиши остаются прежними.
 */
export const FluxUndoRedo = UndoRedo.extend({
  addCommands() {
    const parent = (this.parent?.() || {}) as Record<string, any>
    return {
      ...parent,
      undo: () => (props: any) => (state.active ? undoCommand(props.state, props.dispatch) : parent.undo()(props)),
      redo: () => (props: any) => (state.active ? redoCommand(props.state, props.dispatch) : parent.redo()(props)),
    } as any
  },
})

const stable = (v: unknown): string => {
  try { return JSON.stringify(v === undefined ? null : v) } catch (_) { return '' }
}

function whenReady(): Promise<Editor> {
  return new Promise((resolve) => {
    const tick = () => {
      const ctx = ctxNow()
      if (ctx?.editor && ctx.doc && !isPhasedContentPending()) resolve(ctx.editor)
      else setTimeout(tick, 100)
    }
    tick()
  })
}

const fieldGuardKey = new PluginKey('fluxFieldGuard')
const cellAnchorIds = new WeakMap<object, string>()
const isFluxField = (mark: any) => mark?.type?.name === 'instrField' && /^\s*DOCPROPERTY\s+"flux:[^"]+"\s*$/i.test(String(mark.attrs?.instr || ''))
const bookmarkName = (anchorId: string) => `FLUX_${anchorId.replaceAll('-', '')}`
const isFluxBookmark = (value: unknown) => /^FLUX(?:_|ROW_|TABLE_)/i.test(String(value || ''))
const anchorIdFromBookmark = (value: unknown): string | null => {
  const match = /^FLUX_([0-9a-f]{32})$/i.exec(String(value || ''))
  if (!match) return null
  const hex = match[1].toLowerCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function selectionTouchesFluxField(state: any, key: string): boolean {
  const { from, to, empty } = state.selection
  if (!empty) {
    let found = false
    state.doc.nodesBetween(from, to, (node: any) => {
      if (node.isText && (node.marks || []).some(isFluxField)) found = true
    })
    return found
  }
  const probe = key === 'Backspace' ? from - 1 : from
  if (probe < 0 || probe >= state.doc.content.size) return false
  const $probe = state.doc.resolve(probe)
  const node = key === 'Backspace' ? $probe.nodeAfter : $probe.nodeAfter
  return !!node?.isText && (node.marks || []).some(isFluxField)
}

function installFluxFieldGuard(editor: Editor): void {
  try { editor.unregisterPlugin(fieldGuardKey) } catch { /* первый запуск */ }
  editor.registerPlugin(new Plugin({
    key: fieldGuardKey,
    filterTransaction(tr, state) {
      const syncChange = tr.getMeta(ySyncPluginKey)
      const undoState = yUndoPluginKey.getState(state)
      if (!tr.docChanged || tr.getMeta('fluxFieldCommand') || tr.getMeta('history$') || tr.getMeta('uiEvent') === 'undo' || tr.getMeta('uiEvent') === 'redo' || syncChange?.isChangeOrigin || undoState?.undoManager?.undoing || undoState?.undoManager?.redoing) return true
      let blocked = false
      for (const step of tr.steps) {
        const ranges: number[][] = []
        step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => { ranges.push([oldStart, oldEnd, newStart, newEnd]) })
        for (const [from, to, newFrom, newTo] of ranges) {
          if (to > from) {
            state.doc.nodesBetween(from, to, (node: any) => {
              if (node.isText && (node.marks || []).some(isFluxField)) blocked = true
            })
          } else if (from > 0 && from < state.doc.content.size) {
            const $pos = state.doc.resolve(from)
            const before = $pos.nodeBefore, after = $pos.nodeAfter
            if ([before, after].every((node: any) => node?.isText && (node.marks || []).some(isFluxField))) blocked = true
            if (newTo > newFrom) tr.doc.nodesBetween(newFrom, newTo, (node: any) => {
              if (node.isText && (node.marks || []).some(isFluxField)) blocked = true
            })
          }
        }
      }
      return !blocked
    },
    props: {
      handleKeyDown(view, event) {
        if (event.key !== 'Backspace' && event.key !== 'Delete') return false
        // Поле нельзя стереть случайным Backspace; сначала его явно выбирают
        // и удаляют командой Flux, чтобы таблица не теряла привязку незаметно.
        return selectionTouchesFluxField(view.state, event.key)
      },
    },
  }))
}

function docAnchor(editor: Editor): { kind: 'word-row'; anchorId: string; documentPart: string } | null {
  const selection = editor.state.selection
  for (let depth = selection.$from.depth; depth > 0; depth--) {
    const cell = selection.$from.node(depth)
    if (!['docTableCell', 'docTableHeader'].includes(cell.type.name)) continue
    let anchorId: string | undefined
    cell.descendants((node: any) => {
      if (anchorId || !['docParagraph', 'paragraph'].includes(node.type.name)) return
      const names = [...(node.attrs?.bookmarks || []), ...(node.attrs?.hiddenBookmarks || [])]
      anchorId = names.map(anchorIdFromBookmark).find(Boolean) || undefined
    })
    anchorId ||= cellAnchorIds.get(cell)
    if (!anchorId) { anchorId = globalThis.crypto.randomUUID(); cellAnchorIds.set(cell, anchorId) }
    return { kind: 'word-row', anchorId, documentPart: 'word/document.xml' }
  }
  return null
}

function persistDocAnchor(editor: Editor, anchorId: string): boolean {
  const selection = editor.state.selection
  let cellDepth = -1
  let paragraphDepth = -1
  for (let depth = selection.$from.depth; depth > 0; depth--) {
    const node = selection.$from.node(depth)
    if (paragraphDepth < 0 && ['docParagraph', 'paragraph'].includes(node.type.name)) paragraphDepth = depth
    if (['docTableCell', 'docTableHeader'].includes(node.type.name)) { cellDepth = depth; break }
  }
  if (cellDepth < 0 || paragraphDepth <= cellDepth) return false
  const pos = selection.$from.before(paragraphDepth)
  const paragraph = editor.state.doc.nodeAt(pos)
  if (!paragraph) return false
  const name = bookmarkName(anchorId)
  const existing = [...(paragraph.attrs?.bookmarks || []), ...(paragraph.attrs?.hiddenBookmarks || [])]
  if (!existing.includes(name)) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, {
    ...paragraph.attrs,
    hiddenBookmarks: [...(paragraph.attrs?.hiddenBookmarks || []), name],
  }))
  return true
}

function officeRowBookmark(sourceId: string, entityType: string, entityId: string, tableIdentity: string): string {
  let a = 2166136261, b = 5381
  const raw = `${sourceId}\u0000${entityType}\u0000${entityId}\u0000${tableIdentity}`
  for (const c of raw) { const n = c.codePointAt(0)!; a = Math.imul(a ^ n, 16777619); b = Math.imul(b, 33) ^ n }
  return `FLUXROW_${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`
}

function officeTableBookmark(): string {
  return `FLUXTABLE_${globalThis.crypto.randomUUID().replaceAll('-', '')}`
}

function paragraphBookmarks(node: any): string[] {
  return [...(node.attrs?.bookmarks || []), ...(node.attrs?.hiddenBookmarks || [])].map(String)
}

function rowBookmarks(row: any): string[] {
  const found: string[] = []
  row.descendants((node: any) => {
    if (['docParagraph', 'paragraph'].includes(node.type.name)) found.push(...paragraphBookmarks(node))
  })
  return found
}

function ensureTableBookmark(editor: Editor, table: any, identity: string): any {
  const rows: any[] = []; table.forEach((row: any) => rows.push(row))
  if (!rows.length) throw new Error('Таблица не содержит строк')
  const cells: any[] = []; rows[0].forEach((cell: any) => cells.push(cell))
  if (!cells.length) throw new Error('Строка заголовков пуста')
  const paragraphs: any[] = []; cells[0].forEach((child: any) => paragraphs.push(child))
  const at = paragraphs.findIndex((child) => ['docParagraph', 'paragraph'].includes(child.type.name))
  if (at < 0) throw new Error('В первой ячейке таблицы нет абзаца для служебной метки')
  const paragraph = paragraphs[at]
  if (paragraphBookmarks(paragraph).includes(identity)) return table
  const attrs = { ...paragraph.attrs, hiddenBookmarks: [...(paragraph.attrs?.hiddenBookmarks || []), identity] }
  paragraphs[at] = paragraph.type.create(attrs, paragraph.content)
  cells[0] = cells[0].type.create(cells[0].attrs, Fragment.fromArray(paragraphs))
  rows[0] = rows[0].type.create(rows[0].attrs, Fragment.fromArray(cells))
  return table.type.create(table.attrs, Fragment.fromArray(rows))
}

function setRowIdentity(row: any, identity: string): any {
  let changed = false
  const cells: any[] = []
  row.forEach((cell: any, cellIndex: number) => {
    let first = true
    const content: any[] = []
    cell.forEach((child: any) => {
      if (first && ['docParagraph', 'paragraph'].includes(child.type.name)) {
        const attrs = { ...child.attrs }
        const hidden = [...(attrs.hiddenBookmarks || [])].filter((b: string) => !isFluxBookmark(b))
        attrs.hiddenBookmarks = [...hidden, ...(cellIndex === 0 ? [identity] : [])]
        content.push(child.type.create(attrs, child.content))
        first = false
        changed = true
      } else content.push(child)
    })
    cells.push(cell.type.create(cell.attrs, Fragment.fromArray(content)))
  })
  return changed ? row.type.create(row.attrs, Fragment.fromArray(cells)) : row
}

function rowWithValues(editor: Editor, styleRow: any, valuesByColumn: Map<number, string>, identity: string, preserveUnbound: boolean): any {
  const cells: any[] = []
  let valid = true
  styleRow.forEach((cell: any, index: number) => {
    const value = valuesByColumn.get(index)
    if (value === undefined && preserveUnbound) { cells.push(cell); return }
    const children: any[] = []
    let usedParagraph = false
    cell.forEach((child: any) => {
      if (['docParagraph', 'paragraph'].includes(child.type.name) && !usedParagraph) {
        usedParagraph = true
        const attrs = { ...child.attrs }
        attrs.bookmarks = [...(attrs.bookmarks || [])].filter((b: string) => !isFluxBookmark(b))
        attrs.hiddenBookmarks = [...(attrs.hiddenBookmarks || [])].filter((b: string) => !isFluxBookmark(b))
        if (index === 0) attrs.hiddenBookmarks = [...attrs.hiddenBookmarks, identity]
        const text = value ? [editor.schema.text(value)] : null
        children.push(child.type.create(attrs, text))
      } else if (['docParagraph', 'paragraph'].includes(child.type.name)) {
        const attrs = { ...child.attrs, bookmarks: [...(child.attrs?.bookmarks || [])].filter((b: string) => !isFluxBookmark(b)), hiddenBookmarks: [...(child.attrs?.hiddenBookmarks || [])].filter((b: string) => !isFluxBookmark(b)) }
        children.push(child.type.create(attrs))
      } else { valid = false; children.push(child) }
    })
    if (!usedParagraph) valid = false
    const cellType = editor.schema.nodes.docTableCell || cell.type
    cells.push(cellType.create(cell.attrs, Fragment.fromArray(children)))
  })
  if (!valid || !cells.length) throw new Error('Для заполнения поддерживаются таблицы с обычными абзацами в ячейках')
  return editor.schema.nodes.docTableRow.create(styleRow.attrs, Fragment.fromArray(cells))
}

function applyDocOfficePlan(editor: Editor, payload: any): { ok: boolean; rows?: any[]; appliedCount?: number; manualRows?: string[]; error?: string } {
  const writes = payload?.writes
  const schema = payload?.schema
  const priorRows = Array.isArray(payload?.rows) ? payload.rows : []
  if (!Array.isArray(writes) || !writes.length || writes.length > 100000 || !Array.isArray(schema?.anchors)) return { ok: false, error: 'План заполнения пуст или схема не загружена' }
  const anchorIds = new Set<string>(schema.anchors.map((anchor: any) => String(anchor.id)))
  const writeKey = new Set<string>()
  for (const write of writes) {
    const key = `${write?.entityId}\u0000${write?.anchorId}`
    if (!write || typeof write.entityId !== 'string' || !write.entityId || !anchorIds.has(String(write.anchorId)) || !(typeof write.value === 'string' || (typeof write.value === 'number' && Number.isFinite(write.value))) || writeKey.has(key)) return { ok: false, error: 'План содержит некорректные или повторные записи' }
    writeKey.add(key)
  }
  const anchorsById = new Map<string, any>(schema.anchors.map((anchor: any) => [String(anchor.id), anchor]))
  const tables: Array<{ pos: number; node: any; anchorColumns: Map<string, number>; headerIndex: number; identity: string }> = []
  editor.state.doc.descendants((table: any, pos: number) => {
    if (table.type.name !== 'docTable') return
    const rows: any[] = []
    table.forEach((row: any) => rows.push(row))
    const anchorColumns = new Map<string, number>()
    let headerIndex = -1
    rows.forEach((row, rowIndex) => row.forEach((cell: any, col: number) => {
      const marks: string[] = []
      cell.descendants((node: any) => { if (['docParagraph', 'paragraph'].includes(node.type.name)) marks.push(...paragraphBookmarks(node)) })
      for (const mark of marks) {
        const id = anchorIds.has(mark) ? mark : anchorIds.has(anchorIdFromBookmark(mark) || '') ? anchorIdFromBookmark(mark)! : null
        if (id) { anchorColumns.set(id, col); if (headerIndex < 0 || rowIndex < headerIndex) headerIndex = rowIndex }
      }
    }))
    if (anchorColumns.size) {
      const identity = rowBookmarks(table).find((mark) => /^FLUXTABLE_[0-9a-f]{32}$/i.test(mark)) || officeTableBookmark()
      tables.push({ pos, node: table, anchorColumns, headerIndex, identity })
    }
    return false
  })
  for (const anchorId of new Set(writes.map((write: any) => String(write.anchorId)))) if (!tables.some((table) => table.anchorColumns.has(anchorId))) return { ok: false, error: `В документе не найдена сохранённая метка ${anchorId}` }
  const priorById = new Map<string, any>(priorRows.map((row: any) => [String(row?.entityId || ''), row]))
  const byEntity = new Map<string, any[]>()
  for (const write of writes) { const list = byEntity.get(write.entityId) || []; list.push(write); byEntity.set(write.entityId, list) }
  const workingTables = new Map<number, any>()
  const manualRows = new Set<string>()
  const outputRows = new Map<string, any>()
  let appliedCount = 0
  for (const [entityId, entityWrites] of byEntity) {
    const prior = priorById.get(entityId) || {}
    const entityTables = new Map(workingTables)
    const rowIdentityByAnchor = new Map<string, string>()
    let isManual = false
    for (const table of tables) {
      const writesForTable = entityWrites.filter((write) => table.anchorColumns.has(String(write.anchorId)))
      if (!writesForTable.length) continue
      const sourceTable = ensureTableBookmark(editor, entityTables.get(table.pos) || table.node, table.identity)
      const tableRows: any[] = []; sourceTable.forEach((row: any) => tableRows.push(row))
      const binding = writesForTable.map((write) => anchorsById.get(String(write.anchorId))?.parts?.find((part: any) => part?.kind === 'field')?.binding).find(Boolean) || {}
      const rowIdentity = officeRowBookmark(String(prior.sourceId || binding.sourceId || ''), String(prior.entityType || binding.entityType || ''), entityId, table.identity)
      for (const write of writesForTable) rowIdentityByAnchor.set(String(write.anchorId), rowIdentity)
      const existingIndex = tableRows.findIndex((row) => rowBookmarks(row).includes(rowIdentity))
      const header = tableRows[table.headerIndex]
      if (!header) throw new Error('Строка заголовков таблицы не найдена')
      if (existingIndex >= 0) {
        const existing = tableRows[existingIndex]
        existing.forEach((cell: any, col: number) => {
          const write = writesForTable.find((item) => table.anchorColumns.get(String(item.anchorId)) === col)
          if (!write) return
          const anchorId = String(write.anchorId)
          const expected = prior.values?.[anchorId]
          const actual: string[] = []
          cell.descendants((node: any) => { if (node.isText) actual.push(node.text) })
          if (expected !== undefined && actual.join('') !== String(expected)) isManual = true
        })
      }
      const source = existingIndex >= 0 ? tableRows[existingIndex] : header
      const valuesByColumn = new Map<number, string>()
      for (const write of writesForTable) valuesByColumn.set(table.anchorColumns.get(String(write.anchorId))!, String(write.value))
      const nextRow = rowWithValues(editor, source, valuesByColumn, rowIdentity, existingIndex >= 0)
      if (existingIndex >= 0) {
        const nextTable = sourceTable.copy(sourceTable.content.replaceChild(existingIndex, nextRow))
        entityTables.set(table.pos, nextTable)
      } else {
        const nextTable = sourceTable.copy(sourceTable.content.append(Fragment.from(nextRow)))
        entityTables.set(table.pos, nextTable)
      }
    }
    if (isManual) { manualRows.add(entityId); continue }
    appliedCount += entityWrites.length
    for (const [pos, node] of entityTables) if (node !== workingTables.get(pos)) workingTables.set(pos, node)
    const cells = { ...(prior.cells || {}) } as Record<string, string>
    const values = { ...(prior.values || {}) } as Record<string, string | number>
    const binding = entityWrites.map((write) => anchorsById.get(String(write.anchorId))?.parts?.find((part: any) => part?.kind === 'field')?.binding).find(Boolean) || {}
    for (const write of entityWrites) { cells[String(write.anchorId)] = rowIdentityByAnchor.get(String(write.anchorId)) || ''; values[String(write.anchorId)] = write.value }
    outputRows.set(entityId, { entityId, entityType: String(prior.entityType || binding.entityType || ''), sourceId: String(prior.sourceId || binding.sourceId || ''), sourceRevision: String(payload.sourceRevision || prior.sourceRevision || binding.sourceRevision || ''), anchorIds: [...new Set([...(prior.anchorIds || []), ...entityWrites.map((write: any) => String(write.anchorId))])], cells, values })
  }
  if (workingTables.size) {
    const tr = editor.state.tr
    for (const table of tables.filter((candidate) => workingTables.has(candidate.pos)).sort((a, b) => b.pos - a.pos)) tr.replaceWith(table.pos, table.pos + table.node.nodeSize, workingTables.get(table.pos))
    tr.setMeta('fluxFieldCommand', true)
    editor.view.dispatch(tr.scrollIntoView())
  }
  return { ok: true, appliedCount, rows: [...priorById.values()].map((row: any) => outputRows.get(String(row.entityId)) || row).concat([...outputRows].filter(([id]) => !priorById.has(id)).map(([, row]) => row)), manualRows: [...manualRows] }
}

async function installFluxFields(): Promise<void> {
  const p = port()
  if (!p) return
  const editor = await whenReady()
  installFluxFieldGuard(editor)
    const report = () => p.tell('flux:anchor-selected', docAnchor(editor))
  editor.on('selectionUpdate', report)
  editor.on('destroy', () => editor.off('selectionUpdate', report))
  p.on('insertFluxField', async (request: any) => {
    const key = String(request?.fieldKey || '')
    const label = String(request?.displayText ?? `{{${key}}}`)
    // Поля каталога содержат пути, пробелы и русские названия параметров.
    // Разрешаем их, но не кавычки, управляющие знаки и обратную косую черту,
    // иначе ключ сможет изменить границы инструкции Word.
    const safeKey = key.length <= 200 && !/["\\\r\n\u0000-\u001f]/.test(key)
    let result: any = { ok: false, fieldKey: key, error: 'Ключ поля не поддерживается' }
    if (safeKey && label.length <= 2000) {
      try {
        const ed = await whenReady()
        const selectedAnchor = docAnchor(ed)
        const anchorId = String(request?.anchorId || selectedAnchor?.anchorId || '')
        if (!anchorId || !persistDocAnchor(ed, anchorId)) throw new Error('Выберите ячейку таблицы: якорь не сохранён')
        const instr = `DOCPROPERTY "flux:${key}"`
        const markType = ed.state.schema.marks.instrField
        if (!markType) throw new Error('Нативная метка Word недоступна')
        const { from, to } = ed.state.selection
        const tr = ed.state.tr.replaceWith(from, to, ed.schema.text(label, [markType.create({ instr })])).setMeta('fluxFieldCommand', true)
        ed.view.dispatch(tr.scrollIntoView())
        const ok = true
        const anchor = docAnchor(ed)
        result = { ok, fieldKey: key, ...(anchor ? { anchorId: anchor.anchorId, anchor } : { anchorId }), ...(ok ? {} : { error: 'Поле не вставлено в текущую позицию' }) }
      } catch (err: any) { result = { ok: false, fieldKey: key, error: String(err?.message || err) } }
    }
    p.tell('flux:field-inserted', result)
  })
  p.on('removeFluxField', () => {
    const { state, view } = editor
    const { from, to, empty } = state.selection
    let range: { from: number; to: number } | null = null
    const scanFrom = empty ? Math.max(0, from - 1) : from
    const scanTo = empty ? Math.min(state.doc.content.size, from + 1) : to
    state.doc.nodesBetween(scanFrom, scanTo, (node: any, pos: number) => {
      if (!range && node.isText && (node.marks || []).some(isFluxField)) range = { from: pos, to: pos + node.nodeSize }
    })
    if (range) view.dispatch(state.tr.delete(range.from, range.to).setMeta('fluxFieldCommand', true).scrollIntoView())
  })
  p.on('applyFluxPlan', (request: any) => {
    let result: any
    try { result = applyDocOfficePlan(editor, request) } catch (err: any) { result = { ok: false, error: String(err?.message || err) } }
    p.tell('flux:office-plan-applied', result)
  })
}

// Flux tokens use GenOffice's existing `instrField` mark and are serialized
// by its Word field converter. The ordinary editor remains untouched.
void installFluxFields()

/** Возвращает тег только когда щелчок пришёлся внутрь явно набранного #TAG. */
function tagAtPoint(root: HTMLElement, x: number, y: number): string | null {
  const doc = root.ownerDocument as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null; caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
  let node: Node | null = null
  let offset = -1
  const range = doc.caretRangeFromPoint?.(x, y)
  if (range) { node = range.startContainer; offset = range.startOffset }
  else {
    const caret = doc.caretPositionFromPoint?.(x, y)
    if (caret) { node = caret.offsetNode; offset = caret.offset }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null
  const text = node.textContent || ''
  const re = /(^|[^\p{L}\p{N}_])#([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*)/gu
  for (let m: RegExpExecArray | null; (m = re.exec(text));) {
    const start = m.index + m[1].length
    const end = start + m[0].length - m[1].length
    if (offset >= start && offset < end) return m[2]
  }
  return null
}

/** Читает только инструкцию Word-поля; видимое слово и соседний текст не угадываются. */
export function tagTargetFromFieldInstruction(instruction: string): { tagId: string; identifier: string } | null {
  const match = /^\s*DOCPROPERTY\s+"flux:tag\[([^\]\r\n]+)\]\.identifier"\s*$/i.exec(instruction)
  if (!match) return null
  const value = match[1]
  const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  return isId ? { tagId: value, identifier: '' } : { tagId: '', identifier: value }
}

function fieldTagAtTarget(target: EventTarget | null): { tagId: string; identifier: string } | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  const field = element?.closest('[data-instr-field]')
  return field ? tagTargetFromFieldInstruction(field.getAttribute('data-instr-field') || '') : null
}

let started = false

/** Подключить редактор к сеансу совместной правки */
async function start(cfg: { name: string; color: string }, p: Port): Promise<void> {
  if (started) return
  started = true
  const editor = await whenReady()
  const ydoc = new Y.Doc()
  const fragment = ydoc.getXmlFragment('prosemirror')
  const side = ydoc.getMap<string>('side')
  const awareness = new Awareness(ydoc)
  awareness.setLocalStateField('user', { name: cfg.name, color: cfg.color })
  state.ydoc = ydoc
  state.awareness = awareness

  ydoc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== REMOTE) p.tell('y', u) })
  awareness.on('update', ({ added, updated, removed }: any, origin: unknown) => {
    if (origin === REMOTE) return
    p.tell('y-aware', encodeAwarenessUpdate(awareness, added.concat(updated, removed)))
  })
  p.on('y-aware', (u: Uint8Array) => { try { applyAwarenessUpdate(awareness, u, REMOTE) } catch (_) {} })
  window.addEventListener('beforeunload', () => removeAwarenessStates(awareness, [ydoc.clientID], 'local'))

  // Состояние вне тела: сравниваем с последним известным и шлём разницу
  const known = new Map<string, string>()
  const publish = () => {
    const ctx = ctxNow()
    if (!ctx) return
    ydoc.transact(() => {
      for (const [key] of SIDE) {
        const json = stable(ctx[key])
        if (!json || known.get(key) === json) continue
        known.set(key, json)
        side.set(key, json)
      }
    })
  }
  const applySide = (keys: Iterable<string>) => {
    const ctx = ctxNow()
    if (!ctx) return
    for (const key of keys) {
      const pair = SIDE.find(([k]) => k === key)
      const json = side.get(key)
      if (!pair || json === undefined || known.get(key) === json) continue
      known.set(key, json)
      try { ctx[pair[1]]?.(JSON.parse(json)) } catch (_) { /* повреждённое значение не валит редактор */ }
    }
  }

  const bind = () => {
    // Своя история редактора в сеансе не нужна: она отменила бы и чужие правки
    try { editor.unregisterPlugin('history') } catch (_) {}
    editor.registerPlugin(ySyncPlugin(fragment))
    editor.registerPlugin(yUndoPlugin({ protectedNodes: new Set(['docParagraph']) }))
    editor.registerPlugin(yCursorPlugin(awareness))
    state.active = true
    applySide(side.keys())
    side.observe((e) => { if (e.transaction.origin === REMOTE) applySide(e.keysChanged) })
    setInterval(publish, 300)
    p.tell('collab-ready', null)
  }

  // Сервер решает, кто засевает: ровно один, первый, кому можно писать.
  // Остальные получают уже набранное и рисуют из него. Тот же ответ
  // приходит после переподключения — тогда просто сводим пропущенное
  let bound = false
  p.on('y-state', (payload: any) => {
    if (payload && payload.seed) {
      if (bound) return
      prosemirrorToYXmlFragment(editor.state.doc, fragment)
      publish()
    } else if (payload) {
      Y.applyUpdate(ydoc, payload as Uint8Array, REMOTE)
    }
    if (!bound) { bound = true; bind() }
  })
  // Связь вернулась: отдать серверу всё своё (что не дошло) и забрать чужое
  p.on('y-resync', () => {
    p.tell('y', Y.encodeStateAsUpdate(ydoc))
    const mine = awareness.getLocalState()
    if (mine) p.tell('y-aware', encodeAwarenessUpdate(awareness, [ydoc.clientID]))
    p.tell('y-want', null)
  })
  p.tell('y-want', null)
}

/** Точка входа: зовётся из App (правка patches.mjs) один раз */
export function installFluxCollab(): void {
  const p = port()
  if (!p) return
  // Мост сообщает hello при загрузке страницы. Готовность окна объявляем
  // отдельно, когда GenOffice уже создал документ и редактор действительно может работать.
  void waitForEditor(() => {
    const ctx = ctxNow()
    return ctx?.editor && ctx.doc && !isPhasedContentPending() ? ctx.editor : null
  }, 30_000).then((editor) => { if (editor) p.tell('flux:editor-ready', { app: 'docs' }) })
  // Тег передаётся по самому клику: слова вокруг него и содержимое документа
  // не размечаются и не меняются. Project/tag ids дополняет окно Flux.
  void whenReady().then((editor) => {
    editor.view.dom.addEventListener('click', (event) => {
      const target = event.target
      if (target instanceof Element && target.closest('a')) return
      const field = fieldTagAtTarget(target)
      if (field) {
        p.tell('flux:tag-click', { projectId: '', ...field })
        return
      }
      const identifier = tagAtPoint(editor.view.dom, event.clientX, event.clientY)
      if (identifier) p.tell('flux:tag-click', { projectId: '', tagId: '', identifier })
    }, true)
  })
  p.on('collab', (cfg: any) => { if (cfg && cfg.on) void start(cfg, p) })
  p.on('y', (u: Uint8Array) => { if (state.ydoc) Y.applyUpdate(state.ydoc, u, REMOTE) })
  // Панель «Данные проекта»: метка {{ключ}} в место курсора. В поле Word её
  // превращает «Обновить поля» (server/officeFields.ts, fillDocxMarkers): поле
  // с кодом GenOffice сам не вставляет, а текст метки переживает любую правку
  p.on('insertTable', async (message: any) => {
    try {
      const rows = message?.rows;
      if (!Array.isArray(rows) || !rows.length || rows.length > 501) throw new Error('Таблица должна содержать до 500 строк');
      // hello сообщает о мосте, а не о готовности редактора; коротко ждём
      // редактор, иначе ранняя команда из панели выглядела как «вставлено».
      const ed = await waitForEditor(() => {
        const ctx = ctxNow()
        return ctx?.editor && ctx.doc && !isPhasedContentPending() ? ctx.editor : null
      }, 7_000)
      if (!ed) throw new Error('Редактор не готов — таблица не вставлена');
      const content = { type: 'docTable', content: rows.map((row: any[], at: number) => ({ type: 'docTableRow', content: row.map(value => ({ type: at === 0 ? 'docTableHeader' : 'docTableCell', content: [{ type: 'docParagraph', content: String(value ?? '') ? [{ type: 'text', text: String(value) }] : [] }] })) })) };
      const ok = ed.chain().focus().insertContent(content).run(); p.tell('flux:table-inserted', { ok });
    } catch (err: any) { p.tell('flux:table-inserted', { ok: false, error: err.message }); }
  });
  p.on('insertText', async (text: unknown) => {
    const ed = await waitForEditor(() => {
      const ctx = ctxNow()
      return ctx?.editor && ctx.doc && !isPhasedContentPending() ? ctx.editor : null
    }, 7_000)
    const ok = !!ed && typeof text === 'string' && !!text && ed.chain().focus().insertContent(text).run()
    p.tell('flux:text-inserted', { ok, ...(ok ? {} : { error: 'Редактор не готов — текст не вставлен' }) })
  })
}

// Подключение при загрузке редактора: мост Flux к этому времени уже стоит
installFluxCollab()
