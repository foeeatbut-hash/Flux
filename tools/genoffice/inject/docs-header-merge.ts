import type { Editor } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { CellSelection, TableMap } from '@tiptap/pm/tables'

type NativeOfficePart = { kind: 'text'; text: string } | { kind: 'operator'; operator: '+' | '-' | '*' | '/' | '(' | ')' } | { kind: 'field'; binding: any } | { kind: 'union'; mode: 'first-match'; alternatives: any[] }
type HeaderDependencies = {
  validateHeaderSchema(schema: any): boolean
  wordParagraphForSchema(editor: Editor, paragraph: any, anchor: any, labels: Record<string, string>): any
  readNativeHeader(editor: Editor, anchorId: string, schemaAnchor?: any): NativeOfficePart[] | null
  anchorIdFromBookmark(value: unknown): string | null
  isFluxField(mark: any): boolean
}

export function createWordHeaderActions(editor: Editor, deps: HeaderDependencies) {
  const { validateHeaderSchema, wordParagraphForSchema, readNativeHeader, anchorIdFromBookmark, isFluxField } = deps
  const pendingHeaderMerges = new Map<string, string>()
  const paragraphBookmarks = (node: any): string[] => [...(node.attrs?.bookmarks || []), ...(node.attrs?.hiddenBookmarks || [])].map(String)
  const rowBookmarks = (row: any): string[] => {
    const found: string[] = []
    row.descendants((node: any) => { if (['docParagraph', 'paragraph'].includes(node.type.name)) found.push(...paragraphBookmarks(node)) })
    return found
  }
type HeaderAnchorRef = { anchorId: string; kind: 'word-row'; documentPart: 'word/document.xml'; parts: NativeOfficePart[] }

function paragraphAnchorIds(node: any): string[] {
  return [...(node.attrs?.bookmarks || []), ...(node.attrs?.hiddenBookmarks || [])]
    .map(anchorIdFromBookmark).filter(Boolean) as string[]
}

function cellAnchorId(cell: any): string | null {
  let found: string | null = null
  cell.descendants((node: any) => {
    if (found || !['docParagraph', 'paragraph'].includes(node.type.name)) return
    found = paragraphAnchorIds(node)[0] || null
  })
  return found
}

function selectedHeaderCells(editor: Editor, schema: any): { anchors: HeaderAnchorRef[]; tablePos: number; table: any; row: number; columns: number[] } | null {
  const selection = editor.state.selection
  if (!(selection instanceof CellSelection)) return null
  const selected: Array<{ pos: number; node: any }> = []
  selection.forEachCell((node: any, pos: number) => selected.push({ pos, node }))
  const unique = [...new Map(selected.map((cell) => [cell.pos, cell])).values()]
  if (unique.length !== 2) return null
  const $cell = editor.state.doc.resolve(selection.$anchorCell.pos)
  let tableDepth = -1
  for (let depth = $cell.depth; depth > 0; depth--) {
    if ($cell.node(depth).type.name === 'docTable') { tableDepth = depth; break }
  }
  if (tableDepth < 0) return null
  const table = $cell.node(tableDepth)
  const tablePos = $cell.before(tableDepth)
  const map = TableMap.get(table)
  const positions = unique.map(({ pos, node }) => ({ pos, node, rect: map.findCell(pos - tablePos - 1) }))
  if (positions.some(({ node, rect }) => !['docTableHeader', 'docTableCell'].includes(node.type.name) || rect.right - rect.left !== 1 || rect.bottom - rect.top !== 1)) return null
  const row = positions[0].rect.top
  const columns = positions.map(({ rect }) => rect.left).sort((a, b) => a - b)
  if (positions.some(({ rect }) => rect.top !== row) || columns[1] !== columns[0] + 1) return null
  const anchors = positions.sort((a, b) => a.rect.left - b.rect.left).map(({ node }) => {
    const anchorId = cellAnchorId(node)
    const schemaAnchor = schema?.anchors?.find((item: any) => item?.id === anchorId)
    if (!anchorId || !schemaAnchor) return null
    const parts = readNativeHeader(editor, anchorId, schemaAnchor)
    return parts ? { anchorId, kind: 'word-row' as const, documentPart: 'word/document.xml' as const, parts } : null
  })
  if (anchors.some((anchor) => !anchor)) return null
  const schemaIds = new Set((schema?.anchors || []).map((item: any) => String(item?.id || '')))
  let headerRow = -1
  table.forEach((rowNode: any, rowIndex: number) => {
    let bound = false
    rowNode.forEach((cell: any) => { if (schemaIds.has(String(cellAnchorId(cell) || ''))) bound = true })
    if (bound && headerRow < 0) headerRow = rowIndex
  })
  if (row !== headerRow) return null
  return { anchors: anchors as HeaderAnchorRef[], tablePos, table, row, columns }
}

function selectedBoundHeaderAnchors(editor: Editor, schema: any): HeaderAnchorRef[] | null {
  const cellSelection = selectedHeaderCells(editor, schema)
  if (cellSelection) return cellSelection.anchors
  const selection = editor.state.selection
  if (selection instanceof CellSelection) return null
  for (let depth = selection.$from.depth; depth > 0; depth--) {
    const cell = selection.$from.node(depth)
    if (!['docTableHeader', 'docTableCell'].includes(cell.type.name)) continue
    if (!selection.empty && (selection.$to.depth < depth || selection.$from.before(depth) !== selection.$to.before(depth))) return null
    const anchorId = cellAnchorId(cell)
    const anchor = schema?.anchors?.find((item: any) => item?.id === anchorId)
    if (!anchorId || !anchor) return null
    const selectionCell = selection.$from
    let tableDepth = -1
    for (let current = depth - 1; current > 0; current--) if (selectionCell.node(current).type.name === 'docTable') { tableDepth = current; break }
    if (tableDepth < 0) return null
    const table = selectionCell.node(tableDepth)
    const rowIndex = selectionCell.index(tableDepth)
    let headerRow = -1
    const schemaIds = new Set((schema?.anchors || []).map((item: any) => String(item?.id || '')))
    table.forEach((rowNode: any, at: number) => {
      let bound = false
      rowNode.forEach((candidate: any) => { if (schemaIds.has(String(cellAnchorId(candidate) || ''))) bound = true })
      if (bound && headerRow < 0) headerRow = at
    })
    if (rowIndex !== headerRow) return null
    const parts = readNativeHeader(editor, anchorId, anchor)
    return parts ? [{ anchorId, kind: 'word-row', documentPart: 'word/document.xml', parts }] : null
  }
  return null
}

function cellText(cell: any): string {
  let text = ''
  cell.descendants((node: any) => {
    if (node.isText && !(node.marks || []).some(isFluxField)) text += node.text
  })
  return text.trim()
}

function cellHasFluxRowBookmark(cell: any): boolean {
  let found = false
  cell.descendants((node: any) => {
    if (['docParagraph', 'paragraph'].includes(node.type.name) && paragraphBookmarks(node).some((mark) => /^FLUXROW_/i.test(mark))) found = true
  })
  return found
}

function carryCellBookmarks(left: any, right: any): any {
  const publicNames = new Set<string>()
  const hiddenNames = new Set<string>()
  right.descendants((node: any) => {
    if (!['docParagraph', 'paragraph'].includes(node.type.name)) return
    for (const name of node.attrs?.bookmarks || []) publicNames.add(String(name))
    for (const name of node.attrs?.hiddenBookmarks || []) hiddenNames.add(String(name))
  })
  if (!publicNames.size && !hiddenNames.size) return left
  const children: any[] = []; left.forEach((child: any) => children.push(child))
  const paragraphIndex = children.findIndex((child) => ['docParagraph', 'paragraph'].includes(child.type.name))
  if (paragraphIndex < 0) return left
  const paragraph = children[paragraphIndex]
  const attrs = {
    ...paragraph.attrs,
    bookmarks: [...new Set([...(paragraph.attrs?.bookmarks || []), ...publicNames])],
    hiddenBookmarks: [...new Set([...(paragraph.attrs?.hiddenBookmarks || []), ...hiddenNames])],
  }
  children[paragraphIndex] = paragraph.type.create(attrs, paragraph.content)
  return left.type.create(left.attrs, Fragment.fromArray(children))
}

function headerMergeConflictText(targetText: string, sourceText: string): boolean {
  return !!targetText && !!sourceText && targetText !== sourceText
}

function unselectedColumnAnchors(anchorIds: string[][], sourceId: string): string[] {
  return [...new Set(anchorIds.flat().filter((id) => id !== sourceId))]
}

function isEmptyRowValue(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

function mergeOfficeRowsAfterHeaderMerge(rows: any[], targetId: string, sourceId: string, actualByBookmark: Map<string, { text: string; targetBookmark: boolean }>): any[] {
  return rows.map((row: any) => {
    if (!row || typeof row !== 'object') return row
    const priorCells = row.cells && typeof row.cells === 'object' ? row.cells : {}
    const priorValues = row.values && typeof row.values === 'object' ? row.values : {}
    const hasSelectedReference = (Array.isArray(row.anchorIds) && row.anchorIds.some((id: string) => id === targetId || id === sourceId)) || Object.hasOwn(priorCells, targetId) || Object.hasOwn(priorCells, sourceId) || Object.hasOwn(priorValues, targetId) || Object.hasOwn(priorValues, sourceId)
    if (!hasSelectedReference) return row

    const cells = { ...priorCells }
    const values = { ...priorValues }
    const targetPrior = values[targetId]
    const sourcePrior = values[sourceId]
    let targetValue = isEmptyRowValue(targetPrior) ? sourcePrior : targetPrior
    const bookmark = String(cells[targetId] || cells[sourceId] || '')
    const actual = bookmark ? actualByBookmark.get(bookmark) : undefined
    if (actual) {
      if (actual.text) targetValue = actual.text
      else targetValue = undefined
      if (actual.targetBookmark) cells[targetId] = bookmark
      else delete cells[targetId]
    } else if (!cells[targetId] && cells[sourceId]) cells[targetId] = cells[sourceId]
    delete cells[sourceId]
    delete values[sourceId]
    if (targetValue === undefined) delete values[targetId]
    else values[targetId] = targetValue

    const anchorIds = new Set<string>((Array.isArray(row.anchorIds) ? row.anchorIds : []).filter((id: string) => id !== sourceId))
    anchorIds.add(targetId)
    return { ...row, anchorIds: [...anchorIds], cells, values }
  })
}

function actualMergedColumnValues(table: any, targetColumn: number): Map<string, { text: string; targetBookmark: boolean }> {
  const actual = new Map<string, { text: string; targetBookmark: boolean }>()
  table.forEach((row: any) => {
    const identity = rowBookmarks(row).find((bookmark) => /^FLUXROW_/i.test(bookmark))
    if (!identity) return
    const cells: any[] = []; row.forEach((cell: any) => cells.push(cell))
    const target = cells[targetColumn]
    if (!target) return
    actual.set(identity, { text: cellText(target), targetBookmark: rowBookmarks(row).includes(identity) })
  })
  return actual
}

async function mergeDocHeaderColumns(editor: Editor, request: any): Promise<any> {
  if (!editor.isEditable) throw new Error('Документ открыт только для чтения')
  const schema = request?.schema
  if (!validateHeaderSchema(schema)) throw new Error('Схема заголовков имеет неверный формат')
  const targetId = String(request?.targetAnchorId || '')
  const sourceIds = Array.isArray(request?.sourceAnchorIds) ? request.sourceAnchorIds.map(String) : []
  if (!targetId || sourceIds.length !== 1 || sourceIds[0] === targetId || !schema.anchors.some((anchor: any) => anchor.id === targetId) || sourceIds.some((id: string) => schema.anchors.some((anchor: any) => anchor.id === id))) {
    throw new Error('Объединение должно сохранить целевой якорь и удалить ровно один исходный')
  }
  const desiredTarget = schema.anchors.find((anchor: any) => anchor.id === targetId)
  if (!desiredTarget.parts.some((part: any) => part.kind === 'union' && part.mode === 'first-match' && part.alternatives.length > 1)) {
    throw new Error('Целевой столбец должен содержать объединение параметров по первому непустому значению')
  }
  const tableHits: Array<{ pos: number; node: any }> = []
  editor.state.doc.descendants((node: any, pos: number) => {
    if (node.type.name === 'docTable') tableHits.push({ pos, node })
  })
  const hits = tableHits.filter(({ node }) => {
    let foundTarget = false, foundSource = false
    node.descendants((child: any) => {
      if (!['docParagraph', 'paragraph'].includes(child.type.name)) return
      const ids = paragraphAnchorIds(child)
      if (ids.includes(targetId)) foundTarget = true
      if (ids.includes(sourceIds[0])) foundSource = true
    })
    return foundTarget && foundSource
  })
  if (hits.length !== 1) throw new Error('Два якоря должны находиться в одной таблице')
  const { pos: tablePos, node: table } = hits[0]
  const map = TableMap.get(table)
  const rows: any[] = []; table.forEach((row: any) => rows.push(row))
  for (const row of rows) {
    const cells: any[] = []; row.forEach((cell: any) => cells.push(cell))
    if (cells.length !== map.width || cells.some((cell) => Number(cell.attrs?.colspan || 1) !== 1 || Number(cell.attrs?.rowspan || 1) !== 1)) throw new Error('Объединение поддерживает только таблицы без объединённых ячеек')
  }
  const locateAnchor = (anchorId: string): { row: number; col: number; cell: any } | null => {
    for (let row = 0; row < rows.length; row++) {
      let result: { row: number; col: number; cell: any } | null = null
      rows[row].forEach((cell: any, _offset: number, col: number) => {
        if (cellAnchorId(cell) === anchorId) result = { row, col, cell }
      })
      if (result) return result
    }
    return null
  }
  const target = locateAnchor(targetId), source = locateAnchor(sourceIds[0])
  let headerRow = -1
  rows.forEach((row: any, rowIndex: number) => {
    let bound = false
    row.forEach((cell: any) => { if (cellAnchorId(cell)) bound = true })
    if (bound && headerRow < 0) headerRow = rowIndex
  })
  if (!target || !source || target.row !== source.row || target.row !== headerRow || source.col !== target.col + 1 || !['docTableCell', 'docTableHeader'].includes(target.cell.type.name) || !['docTableCell', 'docTableHeader'].includes(source.cell.type.name)) throw new Error('Выберите два соседних Flux-заголовка одной строки таблицы')
  if (map.width <= source.col) throw new Error('Столбец исходного заголовка отсутствует в таблице')
  const otherSourceAnchors: string[][] = []
  for (const row of rows) {
    const cells: any[] = []; row.forEach((cell: any) => cells.push(cell))
    const ids: string[] = []
    cells[source.col].descendants((node: any) => { if (['docParagraph', 'paragraph'].includes(node.type.name)) ids.push(...paragraphAnchorIds(node)) })
    otherSourceAnchors.push(ids)
  }
  if (unselectedColumnAnchors(otherSourceAnchors, sourceIds[0]).length) throw new Error('Исходный столбец содержит другие Flux-якоря. Удалите или переместите их перед объединением.')

  const conflicts: Array<{ rowIndex: number; targetText: string; sourceText: string }> = []
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    if (rowIndex === headerRow) continue
    const cells: any[] = []; rows[rowIndex].forEach((cell: any) => cells.push(cell))
    const left = cellText(cells[target.col]), right = cellText(cells[source.col])
    if (headerMergeConflictText(left, right)) conflicts.push({ rowIndex, targetText: left, sourceText: right })
  }
  const fingerprintInput = JSON.stringify({ table: table.toJSON(), schema, rows: request.rows ?? null, targetId, sourceIds })
  if (!globalThis.crypto?.subtle) throw new Error('Нельзя проверить предварительный просмотр объединения в этом контексте')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprintInput))
  const fingerprint = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  if (request?.previewOnly) {
    const previewToken = fingerprint
    pendingHeaderMerges.set(previewToken, fingerprint)
    while (pendingHeaderMerges.size > 20) pendingHeaderMerges.delete(pendingHeaderMerges.keys().next().value!)
    return { ok: true, preview: true, previewToken, conflicts, schema, rows: Array.isArray(request.rows) ? request.rows : [], headers: schema.anchors.map((anchor: any) => ({ anchorId: anchor.id, parts: anchor.parts })) }
  }
  const token = String(request?.previewToken || '')
  if (request?.confirm !== true || !token || pendingHeaderMerges.get(token) !== fingerprint) throw new Error('Предварительный просмотр устарел. Обновите его перед объединением.')
  if (conflicts.length) return { ok: false, conflicts, schema, rows: Array.isArray(request.rows) ? request.rows : [], error: 'В обоих столбцах есть данные. Сначала разрешите конфликты в диалоге объединения.' }
  pendingHeaderMerges.delete(token)

  const rowsOut: any[] = []
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const cells: any[] = []; rows[rowIndex].forEach((cell: any) => cells.push(cell))
    const left = cells[target.col], right = cells[source.col]
    const leftWidths = Array.isArray(left.attrs?.colwidth) ? left.attrs.colwidth : null
    const rightWidths = Array.isArray(right.attrs?.colwidth) ? right.attrs.colwidth : null
    const mergedWidth = leftWidths?.length && rightWidths?.length && Number.isFinite(Number(leftWidths[0])) && Number.isFinite(Number(rightWidths[0]))
      ? [Number(leftWidths[0]) + Number(rightWidths[0])]
      : leftWidths || rightWidths
    const mergedAttrs = mergedWidth ? { ...left.attrs, colwidth: mergedWidth } : left.attrs
    let output = left
    if (rowIndex === target.row) {
      const paragraphIndex = (() => { let index = -1; left.forEach((child: any, at: number) => { if (index < 0 && ['docParagraph', 'paragraph'].includes(child.type.name)) index = at }); return index })()
      if (paragraphIndex < 0) throw new Error('В целевой ячейке заголовка отсутствует абзац')
      const children: any[] = []; left.forEach((child: any) => children.push(child))
      children[paragraphIndex] = wordParagraphForSchema(editor, children[paragraphIndex], desiredTarget, request.displayLabels || {})
      output = left.type.create(mergedAttrs, Fragment.fromArray(children))
    } else if (!cellText(left) && cellText(right)) {
      output = left.type.create(mergedAttrs, right.content)
    } else if (!cellText(left) && !cellText(right) && cellHasFluxRowBookmark(right) && !cellHasFluxRowBookmark(left)) {
      output = left.type.create(mergedAttrs, right.content)
    } else if (rowBookmarks(right).some((bookmark) => !rowBookmarks(left).includes(bookmark))) {
      output = carryCellBookmarks(left.type.create(mergedAttrs, left.content), right)
    } else output = left.type.create(mergedAttrs, left.content)
    const compact: any[] = []
    cells.forEach((cell, col) => { if (col === target.col) compact.push(output); else if (col !== source.col) compact.push(cell) })
    rowsOut.push(rows[rowIndex].type.create(rows[rowIndex].attrs, Fragment.fromArray(compact)))
  }
  const nextTable = table.type.create(table.attrs, Fragment.fromArray(rowsOut))
  const priorRows = Array.isArray(request.rows) ? request.rows : []
  const mergedRows = mergeOfficeRowsAfterHeaderMerge(priorRows, targetId, sourceIds[0], actualMergedColumnValues(nextTable, target.col))
  const tr = editor.state.tr.replaceWith(tablePos, tablePos + table.nodeSize, nextTable).setMeta('fluxFieldCommand', true)
  editor.view.dispatch(tr.scrollIntoView())
  const headers = schema.anchors.map((anchor: any) => ({ ...anchor, parts: readNativeHeader(editor, String(anchor.id), anchor) || [] }))
  return { ok: true, schema: { version: schema.version, anchors: headers }, rows: mergedRows, headers: headers.map((anchor: any) => ({ anchorId: anchor.id, parts: anchor.parts })) }
}

function focusHeaderFormula(editor: Editor, request: any): boolean {
  if (!editor.isEditable) throw new Error('Документ открыт только для чтения')
  const anchorId = String(request?.anchorId || '')
  if (!validateHeaderSchema(request?.schema) || !request.schema.anchors.some((anchor: any) => anchor.id === anchorId)) throw new Error('Схема формулы не содержит целевой ячейки')
  let target: any = null
  editor.state.doc.descendants((node: any, pos: number) => {
    if (target || !['docParagraph', 'paragraph'].includes(node.type.name)) return
    if (paragraphAnchorIds(node).includes(anchorId)) target = { pos, paragraph: node }
  })
  if (!target) throw new Error('Ячейка заголовка больше не найдена в документе')
  const { pos, paragraph } = target
  const first = paragraph.firstChild
  const alreadyHasEquals = !!first?.isText && first.text.startsWith('=')
  let tr = editor.state.tr
  const preserveText = request?.preserveText === true
  if (!preserveText && !alreadyHasEquals) {
    const marks = first?.isText ? first.marks.filter((mark: any) => !isFluxField(mark)) : []
    tr.insert(pos + 1, editor.schema.text('=', marks))
    tr.setMeta('fluxFieldCommand', true)
    editor.view.dispatch(tr)
    tr = editor.state.tr
  }
  // Курсор, уже стоящий в этой ячейке (после вставки метки в его позицию), не трогаем:
  // перенос в конец ломал бы ввод посреди формулы. Выделение ячеек или чужой абзац — в конец.
  const current = editor.state.selection
  const inside = current instanceof TextSelection && current.from > pos && current.to <= pos + 1 + paragraph.content.size
  if (preserveText && inside) {
    editor.view.focus()
    return true
  }
  const nextPos = preserveText ? pos + 1 + paragraph.content.size : pos + 2
  const selection = TextSelection.create(tr.doc, Math.min(nextPos, tr.doc.content.size))
  editor.view.dispatch(tr.setSelection(selection).scrollIntoView())
  editor.view.focus()
  return true
}


  return {
    cellAnchorId,
    selectedBoundHeaderAnchors: (schema: any) => selectedBoundHeaderAnchors(editor, schema),
    merge: (request: any) => mergeDocHeaderColumns(editor, request),
    focusFormula: (request: any) => focusHeaderFormula(editor, request),
    isCellSelection: () => editor.state.selection instanceof CellSelection,
  }
}
