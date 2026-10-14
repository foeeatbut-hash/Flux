/**
 * Переводчик Flux Office: Документ.
 *
 * Модуль работает с JSON ProseMirror (editor.getJSON()), а не с живым
 * редактором: чтение, разбор абзацев, план постановки и его применение к JSON
 * — чистые функции, их проверяет scripts/test-translation-placement.ts. Живой
 * редактор подключает translation-bridge.ts: он превращает правки (WordEdit) в
 * одну транзакцию, то есть в один шаг «назад».
 *
 * Как фрагмент находит свой перевод после правок и повторного открытия:
 *   - исходный абзац получает скрытую закладку FLUX_7a<30 hex> — её видит и
 *     разбор DOCX Flux (закладки FLUX_<32 hex> относятся к скрытым), поэтому
 *     она переживает сохранение; это же ключ фрагмента `w:<30 hex>`;
 *   - абзац с переводом (после абзаца, новая страница) получает закладку
 *     FLUX_7b<те же 30 hex>: повторный перевод находит и обновляет его, а не
 *     вставляет второй.
 *
 * Атомы абзаца — плашки параметров Flux, поля, ссылки, картинки, формулы —
 * уходят в перевод служебными знаками и возвращаются ровно на свои места.
 */
import { nothingToTranslate } from './translation-protect'
import {
  CHIP_MAX, MAX_UNITS, chipMarker, chipMarkersIn, checkApplyItems, composeInline, destinationOf, inlineLocation, makeRecord, normalizeText,
  peelTarget, recordsByKey, separatorOf, sourceHash, statusOf, supersededBy, targetFirst,
  type TrApplyRequest, type TrApplyResult, type TrErrorCode, type TrPlacement, type TrPreviewItem, type TrReadRequest, type TrReadResult,
  type TrRecord, type TrRollbackRequest, type TrRollbackResult, type TrUnit,
} from './translation-common'
import type { EditorTranslator } from './translation-bridge'

export interface PmMark { type: string; attrs?: Record<string, any> }
export interface PmJson { type: string; attrs?: Record<string, any>; content?: PmJson[]; marks?: PmMark[]; text?: string }

export type WordEdit =
  /** Заменить содержимое абзаца и, если нужно, поправить его свойства (закладки). */
  | { kind: 'setInline'; path: number[]; content: PmJson[]; attrs?: Record<string, any> }
  /** Вставить новый блок сразу после блока по пути. */
  | { kind: 'insertAfter'; path: number[]; node: PmJson }
  /** Дописать блок в конец тела документа. */
  | { kind: 'append'; node: PmJson }
  /** Свойства блока без смены содержимого (закладка исходника). */
  | { kind: 'setAttrs'; path: number[]; attrs: Record<string, any> }

export interface WordEnv {
  doc: PmJson
  /** Узел без содержимого по схеме редактора (для позиций выделения). */
  isLeaf: (type: string) => boolean
  selection?: { from: number; to: number }
  /** Случайные шестнадцатеричные знаки; подменяется в тестах. */
  randomHex?: (length: number) => string
  now?: number
}

/* ── Закладки ─────────────────────────────────────────────────────────── */

const SRC_RE = /^FLUX_7a([0-9a-f]{30})$/i
const TGT_RE = /^FLUX_7b([0-9a-f]{30})$/i
const ANCHOR_RE = /^FLUX_(?!7[ab])[0-9a-f]{32}$/i
const TEXT_BLOCKS = new Set(['docParagraph', 'docHeading', 'docListItem'])
/** Знаки текста, которые не переводятся и возвращаются на место (форматирование поля и ссылки сохраняется). */
const ATOM_MARKS = new Set(['instrField', 'refField', 'ctrlCheckbox', 'del', 'docSym', 'revisionOriginal', 'link'])
const DROP_MARKS = new Set([...ATOM_MARKS, 'comment', 'ins', 'rprChange'])
const FLUX_INSTR = /^\s*DOCPROPERTY\s+"flux:([^"]+)"\s*$/i

const bookmarksOf = (node: PmJson): string[] => [...(node.attrs?.bookmarks || []), ...(node.attrs?.hiddenBookmarks || [])].map(String)

const newId = (env: WordEnv): string => {
  const hex = env.randomHex ? env.randomHex(30) : Array.from({ length: 30 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  // 13-я цифра UUID — версия [1-8]: у наших закладок там «f», чтобы их не принять за метку схемы
  return hex.slice(0, 10) + 'f' + hex.slice(11)
}

/** `v1:<sourceId>:<ключ>` из инструкции DOCPROPERTY плашки Flux. */
export function fluxFieldOf(instr: string): { sourceId: string; fieldKey: string } | null {
  const identity = FLUX_INSTR.exec(String(instr || ''))?.[1]
  if (!identity) return null
  if (!identity.startsWith('v1:')) return { sourceId: '', fieldKey: identity }
  const parts = identity.split(':')
  let key = parts.slice(2).join(':')
  try { key = decodeURIComponent(key) } catch { /* ключ не закодирован */ }
  return { sourceId: parts[1] || '', fieldKey: key }
}

/* ── Разбор абзаца ────────────────────────────────────────────────────── */

export interface Atom { marker: string; nodes: PmJson[]; label: string; field?: { sourceId: string; fieldKey: string } }
export interface Block {
  path: number[]
  node: PmJson
  from: number
  to: number
  /** Исходник: текст со знаками на месте плашек и атомов. */
  text: string
  /** То же, но знаки заменены их подписями (то, что видит читатель). */
  rendered: string
  atoms: Atom[]
  baseMarks: PmMark[]
  srcId: string
  tgtId: string
  header: boolean
  /** Причина, по которой абзац нельзя переводить; '' — можно. */
  skip: string
  /** Номер среди одинаковых абзацев без закладки: нужен для временного ключа. */
  key: string
}

const atomMarkOf = (node: PmJson): PmMark | null => (node.marks || []).find((m) => ATOM_MARKS.has(m.type)) || null
const baseMarksOf = (node: PmJson): PmMark[] => (node.marks || []).filter((m) => !DROP_MARKS.has(m.type)).map((m) => ({ type: m.type, ...(m.attrs ? { attrs: m.attrs } : {}) }))

function analyzeInline(content: PmJson[] | undefined): { text: string; atoms: Atom[]; baseMarks: PmMark[] } {
  let text = ''
  const atoms: Atom[] = []
  let baseMarks: PmMark[] | null = null
  let last: { key: string; atom: Atom } | null = null
  for (const node of content || []) {
    if (node.type === 'text') {
      const mark = atomMarkOf(node)
      if (mark) {
        const key = `${mark.type}:${JSON.stringify(mark.attrs || {})}`
        if (last && last.key === key) { last.atom.nodes.push(node); last.atom.label += node.text || '' }
        else {
          const atom: Atom = { marker: chipMarker(atoms.length), nodes: [node], label: node.text || '' }
          if (mark.type === 'instrField') { const f = fluxFieldOf(String(mark.attrs?.instr || '')); if (f) atom.field = f }
          atoms.push(atom); text += atom.marker; last = { key, atom }
        }
      } else {
        text += node.text || ''
        last = null
        if (!baseMarks) baseMarks = baseMarksOf(node)
      }
    } else if (node.type === 'hardBreak' && !node.attrs?.pageBreak && !node.attrs?.colBreak) {
      text += '\n'; last = null
    } else {
      atoms.push({ marker: chipMarker(atoms.length), nodes: [node], label: '' })
      text += atoms[atoms.length - 1].marker; last = null
    }
  }
  return { text, atoms, baseMarks: baseMarks || [] }
}

/** Знаки атомов заменены подписями. */
export function renderLabels(text: string, atoms: Atom[]): string {
  let out = text
  for (const atom of atoms) out = out.split(atom.marker).join(atom.label)
  return out
}

function sizeOf(node: PmJson, env: WordEnv): number {
  if (node.type === 'text') return (node.text || '').length
  if (env.isLeaf(node.type)) return 1
  return 2 + (node.content || []).reduce((sum, child) => sum + sizeOf(child, env), 0)
}

/** Все абзацы тела с путями и позициями; плашки уже вынуты. */
export function analyzeDoc(env: WordEnv): Block[] {
  const blocks: Block[] = []
  const seenIds = new Set<string>()
  const occurrences = new Map<string, number>()
  const walk = (node: PmJson, path: number[], pos: number): Block[] => {
    const found: Block[] = []
    let offset = pos + 1
    ;(node.content || []).forEach((child, index) => {
      const childPath = [...path, index]
      const size = sizeOf(child, env)
      if (TEXT_BLOCKS.has(child.type)) found.push(makeBlock(child, childPath, offset, offset + size))
      else if (child.content?.length) {
        const inner = walk(child, childPath, offset)
        // Строка таблицы с метками параметров целиком считается шапкой
        if (child.type === 'docTableRow' && inner.some(isAnchorBlock)) inner.forEach((b) => { b.header = true })
        found.push(...inner)
      }
      offset += size
    })
    return found
  }
  const makeBlock = (node: PmJson, path: number[], from: number, to: number): Block => {
    const { text, atoms, baseMarks } = analyzeInline(node.content)
    const marks = bookmarksOf(node)
    let srcId = marks.map((b) => SRC_RE.exec(b)?.[1]).find(Boolean)?.toLowerCase() || ''
    const tgtId = marks.map((b) => TGT_RE.exec(b)?.[1]).find(Boolean)?.toLowerCase() || ''
    // Скопированный абзац несёт чужую закладку: ключ у первого, остальные получают свои при постановке
    if (srcId && seenIds.has(srcId)) srcId = ''
    if (srcId) seenIds.add(srcId)
    const skip = atoms.length > CHIP_MAX ? 'слишком много плашек и вложений в абзаце' : tgtId ? 'это перевод, а не оригинал' : nothingToTranslate(text.replace(/[-]/g, ' ')) ? 'нечего переводить' : ''
    let key = ''
    if (srcId) key = `w:${srcId}`
    else {
      const base = sourceHash(text)
      const n = occurrences.get(base) || 0
      occurrences.set(base, n + 1)
      key = `n:${base}:${n}`
    }
    return { path, node, from, to, text, rendered: renderLabels(text, atoms), atoms, baseMarks, srcId, tgtId, header: false, skip, key }
  }
  const all = walk(env.doc, [], -1)
  blocks.push(...all)
  return blocks
}

function isAnchorBlock(b: Block): boolean {
  return bookmarksOf(b.node).some((m) => ANCHOR_RE.test(m)) || b.atoms.some((a) => !!a.field)
}

/* ── Чтение ───────────────────────────────────────────────────────────── */

function inScope(b: Block, scope: TrPlacement['scope'], env: WordEnv): boolean {
  if (scope === 'header') return b.header
  if (scope === 'selection') return !!env.selection && b.from < env.selection.to && b.to > env.selection.from
  return true
}

interface Resolved { block: Block; source: string; record?: TrRecord; status: TrUnit['status']; targetBlock?: Block; tgtId: string }

function resolve(blocks: Block[], records: TrRecord[], destination: string): Resolved[] {
  const targets = new Map<string, Block>()
  for (const b of blocks) if (b.tgtId) targets.set(b.tgtId, b)
  const byKey = recordsByKey(records, destination)
  const out: Resolved[] = []
  for (const block of blocks) {
    if (block.skip) continue
    const record = byKey.get(block.key)
    let source = block.text
    let present: boolean | null = null
    let targetBlock: Block | undefined
    let replaced = false
    if (record) {
      if (record.mode === 'inline-before' || record.mode === 'inline-after') {
        const peeled = peelTarget(block.text, record)
        present = peeled !== null
        if (peeled !== null) source = peeled
      } else if (record.mode === 'replace') {
        replaced = normalizeText(block.rendered) === normalizeText(record.targetText)
        if (replaced) source = record.sourceText
      } else if (record.mode === 'after-paragraph' || record.mode === 'new-page') {
        targetBlock = block.srcId ? targets.get(block.srcId) : undefined
        present = !!targetBlock
      }
    }
    const status = replaced ? 'replaced' : statusOf(record, source, present)
    out.push({ block, source, record, status, targetBlock, tgtId: block.srcId })
  }
  return out
}

export function readWord(env: WordEnv, req: TrReadRequest): TrReadResult {
  const blocks = analyzeDoc(env)
  const destination = req.destination || 'en'
  const resolved = resolve(blocks, req.records || [], destination)
  const picked = resolved.filter((r) => inScope(r.block, req.scope, env))
  if (picked.length > MAX_UNITS) return { ok: false, error: `В области ${picked.length} фрагментов — за один раз можно не больше ${MAX_UNITS}. Выделите часть документа` }
  const units: TrUnit[] = picked.map(({ block, source, record, status }) => {
    const field = block.atoms.find((a) => a.field)?.field
    return {
      key: block.key, source, chips: block.atoms.length, status,
      location: { kind: 'word', path: block.path, from: block.from, to: block.to, ...(block.header ? { header: true } : {}) },
      ...(record ? { targetText: record.targetText } : {}),
      ...(field ? { sourceId: field.sourceId, fieldKey: field.fieldKey, displayLabel: renderLabels(block.text, block.atoms) } : {}),
      ...(status === 'stale' ? { stale: true } : {}),
      ...(status === 'current' || status === 'replaced' ? { verified: true } : {}),
    }
  })
  const skipped = blocks.length - resolved.length
  return { ok: true, units, skipped }
}

/* ── Построение содержимого ───────────────────────────────────────────── */

/** Перенос строки — настоящий перенос Word, остальное — текст с оформлением первого прогона. */
function textNodes(text: string, marks: PmMark[]): PmJson[] {
  const out: PmJson[] = []
  text.split('\n').forEach((line, i) => {
    if (i) out.push({ type: 'hardBreak' })
    if (line) out.push({ type: 'text', text: line, ...(marks.length ? { marks } : {}) })
  })
  return out
}

/** Содержимое из строки со знаками: атомы возвращаются узлами (real) или обычным текстом их подписи. */
function contentFrom(text: string, atoms: Atom[], marks: PmMark[], real: boolean): PmJson[] {
  const out: PmJson[] = []
  let buffer = ''
  const flush = () => { if (buffer) { out.push(...textNodes(buffer, marks)); buffer = '' } }
  for (const ch of text) {
    const atom = atoms.find((a) => a.marker === ch)
    if (!atom) { buffer += ch; continue }
    flush()
    if (real) out.push(...atom.nodes.map((n) => structuredClone(n)))
    else if (atom.label) buffer += atom.label
  }
  flush()
  return out
}

/** Закладка-ключ исходника: прежняя (например, унаследованная копированием абзаца) заменяется. */
const withBookmark = (node: PmJson, name: string): Record<string, any> => {
  const hidden = (node.attrs?.hiddenBookmarks || []) as string[]
  return { hiddenBookmarks: [...hidden.filter((b) => !SRC_RE.test(b)), name] }
}

/** Копия блока с переводом: без служебных закладок оригинала, чтобы метки Flux не двоились. */
function translatedCopy(block: Block, content: PmJson[], tgtName: string, pageBreak: boolean): PmJson {
  return {
    type: block.node.type,
    attrs: { ...(block.node.attrs || {}), docxIndex: null, styleId: block.node.attrs?.styleId ?? null, bookmarks: null, hiddenBookmarks: [tgtName], commentStarts: null, commentEnds: null, pageBreakBefore: pageBreak },
    ...(content.length ? { content } : {}),
  }
}

/* ── План постановки ──────────────────────────────────────────────────── */

export interface WordPlan {
  ok: boolean
  error?: string
  edits: WordEdit[]
  records: TrRecord[]
  removeRecords: TrRecord[]
  applied: number
  skipped: number
  /** Ключи фрагментов запроса (item.key) в том же порядке, что records. Необязательно: прежние потребители плана его не читают. */
  keys?: string[]
  /** Предпросмотр по записям плана (dryRun). */
  preview?: TrPreviewItem[]
}

const lexicographic = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1)
  }
  return 0
}

export function planWord(env: WordEnv, req: TrApplyRequest): WordPlan {
  const fail = (error: string): WordPlan => ({ ok: false, error, edits: [], records: [], removeRecords: [], applied: 0, skipped: 0 })
  const p = req.placement
  const destination = destinationOf(req.direction)
  const blocks = analyzeDoc(env)
  const resolved = resolve(blocks, req.records || [], destination)
  const byKey = new Map(resolved.map((r) => [r.block.key, r]))
  if (!req.items?.length) return { ok: true, edits: [], records: [], removeRecords: [], applied: 0, skipped: 0 }
  const problem = checkApplyItems(req.items, (key) => byKey.get(key)?.block.atoms.length, (key) => byKey.get(key)?.source)
  if (problem) return fail(problem)

  const edits: WordEdit[] = []
  const records: TrRecord[] = []
  const keys: string[] = []
  const preview: TrPreviewItem[] = []
  const now = env.now ?? Date.now()
  const appended: PmJson[] = []
  let skipped = 0
  let pageBreakPending = !resolved.some((r) => r.status !== 'new' && r.targetBlock) // нет прежнего перевода — новая страница нужна
  const ordered = [...req.items].sort((a, b) => lexicographic(byKey.get(a.key)!.block.path, byKey.get(b.key)!.block.path))

  for (const item of ordered) {
    const r = byKey.get(item.key)!
    const { block, record } = r
    // Тот же перевод уже стоит: повторная постановка ничего не дублирует
    if (r.status === 'current' && record && normalizeText(record.targetText) === normalizeText(renderLabels(item.targetText, block.atoms))) { skipped++; continue }
    const id = block.srcId || newId(env)
    const key = `w:${id}`
    const srcName = `FLUX_7a${id}`
    const tgtName = `FLUX_7b${id}`
    const targetRendered = renderLabels(item.targetText, block.atoms)
    const marks = block.baseMarks
    const bookmarkAttrs = block.srcId ? undefined : withBookmark(block.node, srcName)
    let location: Record<string, unknown> = { kind: 'word', bookmark: tgtName }
    const source = r.source

    if (p.mode === 'replace' || p.mode === 'new-file') {
      edits.push({ kind: 'setInline', path: block.path, content: contentFrom(item.targetText, block.atoms, marks, true), attrs: bookmarkAttrs ? { ...bookmarkAttrs } : undefined })
      location = { kind: 'word', bookmark: srcName }
    } else if (p.mode === 'inline-before' || p.mode === 'inline-after') {
      const sep = textNodes(separatorOf(p), marks)
      const target = textNodes(targetRendered, marks)
      let sourceContent: PmJson[]
      if (record && (record.mode === 'inline-before' || record.mode === 'inline-after') && peelTarget(block.text, record) !== null) {
        sourceContent = contentFrom(source, block.atoms, marks, true)
      } else sourceContent = block.node.content ? structuredClone(block.node.content) : []
      const content = targetFirst(p) ? [...target, ...sep, ...sourceContent] : [...sourceContent, ...sep, ...target]
      edits.push({ kind: 'setInline', path: block.path, content, attrs: bookmarkAttrs ? { ...bookmarkAttrs } : undefined })
      location = { kind: 'word', bookmark: srcName, inline: inlineLocation(p) }
    } else if (p.mode === 'after-paragraph' || p.mode === 'new-page') {
      if (bookmarkAttrs) edits.push({ kind: 'setAttrs', path: block.path, attrs: bookmarkAttrs })
      const existing = r.targetBlock
      const content = contentFrom(item.targetText, block.atoms, marks, false)
      if (existing) {
        edits.push({ kind: 'setInline', path: existing.path, content })
      } else if (p.mode === 'after-paragraph') {
        edits.push({ kind: 'insertAfter', path: block.path, node: translatedCopy(block, content, tgtName, false) })
      } else {
        appended.push(translatedCopy(block, content, tgtName, pageBreakPending))
        pageBreakPending = false
      }
    } else return fail(`Режим «${p.mode}» не поддерживается в Документе`)

    const next = makeRecord({ sourceId: block.atoms.find((a) => a.field)?.field?.sourceId || 'text', key, destination, placement: p, source, target: targetRendered, targetLocation: location, time: now })
    next.sourceText = source
    next.sourceHash = sourceHash(source)
    records.push(next)
    keys.push(item.key)
    const before = renderLabels(source, block.atoms)
    const inline = p.mode === 'inline-before' || p.mode === 'inline-after'
    preview.push({
      key: item.key, location: { kind: 'word', path: block.path, from: block.from, to: block.to },
      before, after: inline ? composeInline(before, targetRendered, p) : targetRendered,
      target: p.mode === 'new-file' ? 'new-file' : p.mode === 'after-paragraph' || p.mode === 'new-page' ? 'new-block' : 'same',
    })
  }
  for (const node of appended) edits.push({ kind: 'append', node })
  // Прежние записи тех же фрагментов заменяются новыми — дублей в журнале нет
  const removeRecords = supersededBy(req.records || [], records)
  return { ok: true, edits, records, removeRecords, applied: records.length, skipped, keys, preview }
}

/** Порядок применения: с конца документа, чтобы пути и позиции ранних правок не сдвигались; дописывание в конец — первым. */
export function orderEdits(edits: WordEdit[]): WordEdit[] {
  return edits.map((edit, i) => ({ edit, i })).sort((a, b) => {
    const pa = 'path' in a.edit ? a.edit.path : null
    const pb = 'path' in b.edit ? b.edit.path : null
    if (!pa && !pb) return a.i - b.i
    if (!pa) return -1
    if (!pb) return 1
    return lexicographic(pb, pa) || a.i - b.i
  }).map((x) => x.edit)
}

/* ── Применение правок к JSON ─────────────────────────────────────────── */

/** Применить правки к копии документа: путь для новой книги и для проверок. */
export function applyEditsToJson(doc: PmJson, edits: WordEdit[]): PmJson {
  const copy = structuredClone(doc)
  const at = (path: number[]): { parent: PmJson; index: number; node: PmJson } => {
    let parent = copy
    for (let i = 0; i < path.length - 1; i++) parent = parent.content![path[i]]
    const index = path[path.length - 1]
    return { parent, index, node: parent.content![index] }
  }
  // Вставки меняют номера только позади себя, поэтому идём с конца документа
  const ordered = orderEdits(edits).map((edit) => ({ edit }))
  for (const { edit } of ordered) {
    if (edit.kind === 'append') { copy.content = [...(copy.content || []), structuredClone(edit.node)]; continue }
    const { parent, index, node } = at(edit.path)
    if (edit.kind === 'insertAfter') { parent.content!.splice(index + 1, 0, structuredClone(edit.node)); continue }
    if (edit.attrs) node.attrs = { ...(node.attrs || {}), ...edit.attrs }
    if (edit.kind === 'setInline') node.content = structuredClone(edit.content)
  }
  return copy
}

/** Тексты абзацев документа по порядку: удобно сравнивать результат. */
export function blockTexts(doc: PmJson): string[] {
  const out: string[] = []
  const walk = (node: PmJson) => {
    if (TEXT_BLOCKS.has(node.type)) { out.push((node.content || []).map((c) => (c.type === 'text' ? c.text : c.type === 'hardBreak' ? '\n' : '￼')).join('')); return }
    for (const child of node.content || []) walk(child)
  }
  walk(doc)
  return out
}

export { chipMarkersIn }


/* ── Живой редактор ───────────────────────────────────────────────────── */

/** Что нужно от окружения редактора помимо самого Tiptap; подставляет translation-bridge (в тестах не нужно). */
export interface WordHost {
  /** DOCX из JSON документа: file-actions.buildDocBytes с подменённым editor.getJSON — оригинал и состояние редактора не трогаются. */
  buildBytes?: (json: PmJson) => Promise<Uint8Array | null>
  /** Имя копии для «Новый файл». */
  suggestedName?: () => string
}

const LIVE_MODES = new Set(['replace', 'new-file', 'after-paragraph', 'new-page', 'inline-before', 'inline-after'])
const STEPS_KEPT = 20

/** Код отказа по тексту ошибки checkApplyItems/readWord: контракт TrErrorCode не расширяем, окно Flux читает код. */
function codeOfProblem(message: string): TrErrorCode {
  if (/непроверенн/i.test(message)) return 'not-confirmed'
  if (/плашк|Защищённый|служебный знак/i.test(message)) return 'protected-changed'
  if (/изменился|не найден/i.test(message)) return 'source-changed'
  if (/не больше/i.test(message)) return 'too-many'
  return 'failed'
}

/** Инструкции полей Flux документа — их набор не должен меняться при переводе. */
function fluxInstructions(doc: PmJson): string {
  const found: string[] = []
  const walk = (node: PmJson) => {
    if (node.type === 'text') for (const mark of node.marks || []) if (mark.type === 'instrField' && FLUX_INSTR.test(String(mark.attrs?.instr || ''))) found.push(`${mark.attrs!.instr}|${node.text}`)
    for (const child of node.content || []) walk(child)
  }
  walk(doc)
  return found.sort().join('\n')
}

/**
 * Позиция блока по пути из JSON (индексы детей от корня). Возвращает позицию ПЕРЕД узлом в исходном документе:
 * пути строятся по editor.getJSON(), а он повторяет структуру doc один в один.
 */
function posOfPath(doc: any, path: number[]): number {
  let node = doc
  let pos = 0
  path.forEach((index, i) => {
    for (let j = 0; j < index; j++) pos += node.child(j).nodeSize
    node = node.child(index)
    if (i < path.length - 1) pos += 1
  })
  return pos
}

export function createWordTranslator(editorLike: unknown, host: WordHost = {}): EditorTranslator {
  const editor = editorLike as any
  let busy = false
  const steps: Array<{ id: string; before: any; after: any }> = []

  const envOf = (): WordEnv => {
    const sel = editor.state.selection
    return { doc: editor.getJSON() as PmJson, isLeaf: (type) => !!editor.schema.nodes[type]?.isLeaf, selection: { from: sel.from, to: sel.to } }
  }
  const yManager = (): any => {
    // Совместный сеанс: шаги «назад» ведёт Yjs UndoManager, а не prosemirror-history (как FluxUndoRedo в docs-collab)
    if (!(globalThis as any).__fluxCollab?.active) return null
    const plugin = editor.state.plugins.find((x: any) => x.key === 'y-undo$')
    return plugin ? plugin.getState(editor.state)?.undoManager || null : null
  }
  /** Граница истории: следующая правка (человека или наша) не склеивается с предыдущей. */
  const closeHistory = (): void => {
    yManager()?.stopCapturing()
    const tr = editor.state.tr.setMeta('closeHistory$', true)
    editor.view.dispatch(tr)
  }
  const fail = (code: TrErrorCode, error: string): any => ({ ok: false, code, error })

  /** Правки плана — в одну транзакцию. Позиции берутся из исходного документа и переносятся через уже внесённые шаги. */
  function buildTransaction(edits: WordEdit[]): any {
    const schema = editor.schema
    const Fragment = (editor.state.doc.content as any).constructor
    const base = editor.state.doc
    const tr = editor.state.tr
    const fragmentOf = (content: PmJson[]) => (content.length ? Fragment.fromArray(content.map((n) => schema.nodeFromJSON(n))) : Fragment.empty)
    for (const edit of orderEdits(edits)) {
      if (edit.kind === 'append') { tr.insert(tr.doc.content.size, schema.nodeFromJSON(edit.node)); continue }
      const at = tr.mapping.map(posOfPath(base, edit.path))
      const node = tr.doc.nodeAt(at)
      if (!node) throw new Error('Абзац по пути не найден — документ изменился')
      if (edit.kind === 'insertAfter') { tr.insert(at + node.nodeSize, schema.nodeFromJSON(edit.node)); continue }
      if (edit.attrs) tr.setNodeMarkup(at, undefined, { ...node.attrs, ...edit.attrs }, node.marks)
      if (edit.kind === 'setInline') {
        const current = tr.doc.nodeAt(at)!
        tr.replaceWith(at + 1, at + current.nodeSize - 1, fragmentOf(edit.content))
      }
    }
    // Плашки Flux в замене переставляются целиком — охранник полей (docs-collab) пропускает такие правки по метке
    tr.setMeta('fluxFieldCommand', true).setMeta('closeHistory$', true)
    return tr
  }

  async function doApply(req: TrApplyRequest): Promise<TrApplyResult> {
    if (!editor?.state || !editor.view) return fail('not-ready', 'Редактор ещё не загрузил документ')
    const mode = req.placement?.mode
    if (!LIVE_MODES.has(mode)) return fail('unsupported-mode', `Режим «${mode}» не поддерживается в Документе`)
    const writes = !req.dryRun && mode !== 'new-file'
    if (writes && editor.isEditable === false) return fail('read-only', 'Документ открыт только для чтения — перевод не поставлен')
    const env = envOf()
    const plan = planWord(env, req)
    if (!plan.ok) return fail(codeOfProblem(plan.error || ''), plan.error || 'Перевод не поставлен')
    const common = { records: plan.records, removeRecords: plan.removeRecords, applied: plan.applied, skipped: plan.skipped }
    if (req.dryRun) return { ok: true, preview: plan.preview || [], ...common }
    if (!plan.edits.length) return { ok: true, ...common }
    // Плашки и поля Flux обязаны пережить любой режим: проверка на копии, до единого изменения документа
    const trial = applyEditsToJson(env.doc, plan.edits)
    if (fluxInstructions(trial) !== fluxInstructions(env.doc)) return fail('protected-changed', 'Поля параметров Flux изменились бы при постановке — документ не тронут')

    if (mode === 'new-file') {
      if (!host.buildBytes) return fail('not-ready', 'Сохранение копии недоступно в этом редакторе')
      const bytes = await host.buildBytes(trial)
      if (!bytes) return fail('failed', 'Копия документа не собрана')
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      return { ok: true, copy: { bytes: copy, suggestedName: host.suggestedName?.() }, ...common }
    }

    let tr: any
    try { tr = buildTransaction(plan.edits) } catch (err: any) { return fail('failed', `Перевод не поставлен, документ цел: ${String(err?.message || err)}`) }
    const before = editor.state.doc
    closeHistory()
    editor.view.dispatch(tr)
    // Фильтры редактора (охранник полей) могут отклонить транзакцию молча: документ тогда прежний
    if (editor.state.doc === before || !editor.state.doc.eq(tr.doc)) return fail('failed', 'Редактор отклонил правку — документ не тронут')
    closeHistory()
    const id = `wt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    steps.push({ id, before, after: editor.state.doc })
    if (steps.length > STEPS_KEPT) steps.shift()
    return { ok: true, stepId: id, ...common }
  }

  return {
    async read(req: TrReadRequest): Promise<TrReadResult> {
      if (!editor?.state) return { ok: false, code: 'not-ready', error: 'Редактор ещё не загрузил документ' }
      try {
        const result = readWord(envOf(), req)
        return result.ok ? result : { ...result, code: codeOfProblem(result.error || '') }
      } catch (err: any) { return { ok: false, code: 'failed', error: String(err?.message || err) } }
    },
    async apply(req: TrApplyRequest): Promise<TrApplyResult> {
      if (busy) return fail('busy', 'Постановка перевода уже идёт')
      busy = true
      try { return await doApply(req) } catch (err: any) { return fail('failed', String(err?.message || err)) } finally { busy = false }
    },
    async rollback(req: TrRollbackRequest): Promise<TrRollbackResult> {
      const index = steps.findIndex((s) => s.id === req.stepId)
      if (index < 0) return fail('cannot-rollback', 'Шаг перевода уже не найден — отмените вручную (Ctrl+Z)')
      const step = steps[index]
      // Откат только своего верхнего шага: любая правка после постановки меняет документ, и тогда решает человек
      if (index !== steps.length - 1 || !editor.state.doc.eq(step.after)) return fail('cannot-rollback', 'После перевода были другие правки — отмените вручную (Ctrl+Z)')
      if (busy) return fail('busy', 'Постановка перевода ещё идёт')
      editor.commands.undo()
      if (!editor.state.doc.eq(step.before)) {
        editor.commands.redo()
        return fail('failed', 'Отмена не вернула прежний документ — перевод оставлен, отмените вручную (Ctrl+Z)')
      }
      steps.splice(index, 1)
      return { ok: true }
    },
  }
}
