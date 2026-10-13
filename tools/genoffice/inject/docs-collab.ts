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
import { createDocsHistoryMarks } from './docs-history-marks'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import {
  prosemirrorToYXmlFragment, redoCommand, undoCommand, yCursorPlugin, ySyncPlugin, yUndoPlugin, ySyncPluginKey, yUndoPluginKey,
} from 'y-prosemirror'
import { UndoRedo } from '@tiptap/extensions'
import type { Editor } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { createWordHeaderActions } from './docs-header-merge'
import { installParameterChipStyle } from './parameter-chip-style'
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
      undo: () => (props: any) => {
        const manager = yUndoPluginKey.getState(props.state)?.undoManager
        // После открытия другого файла module-global active может быть старым;
        // тогда используем историю текущего редактора, если Yjs-плагина нет.
        if (!state.active || !manager) return parent.undo()(props)
        // Yjs синхронно меняет состояние. Tiptap не должен вслед за ним
        // отправить транзакцию, созданную до этой перемены.
        props.tr.setMeta('preventDispatch', true)
        return undoCommand(props.state, props.dispatch)
      },
      redo: () => (props: any) => {
        const manager = yUndoPluginKey.getState(props.state)?.undoManager
        if (!state.active || !manager) return parent.redo()(props)
        props.tr.setMeta('preventDispatch', true)
        return redoCommand(props.state, props.dispatch)
      },
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
function fluxFieldIdentity(mark: any): { fieldKey: string; sourceId?: string } | null {
  const instruction = /^\s*DOCPROPERTY\s+"flux:([^"]+)"\s*$/i.exec(String(mark?.attrs?.instr || ''))?.[1]
  if (!instruction) return null
  const composite = /^v1:([^:]+):(.+)$/.exec(instruction)
  if (!composite) return { fieldKey: instruction }
  try { return { sourceId: decodeURIComponent(composite[1]), fieldKey: decodeURIComponent(composite[2]) } } catch { return null }
}
function fluxInstruction(anchor: any, binding: any): string {
  const sources = new Set<string>()
  for (const part of anchor.parts || []) {
    const candidates = part?.kind === 'field' ? [part.binding] : part?.kind === 'union' ? part.alternatives : []
    for (const candidate of candidates) if (candidate?.fieldKey === binding.fieldKey) sources.add(String(candidate.sourceId))
  }
  const identity = sources.size > 1 ? `v1:${encodeURIComponent(binding.sourceId)}:${encodeURIComponent(binding.fieldKey)}` : binding.fieldKey
  return `DOCPROPERTY "flux:${identity}"`
}
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

/**
 * Границы поля Flux, к которому относится Backspace/Delete: при пустом выделении — поле
 * рядом с кареткой, при непустом — оно же, если выделение лежит внутри одного поля.
 */
function fluxFieldRange(state: any, key: string): { from: number; to: number } | null {
  const { from, to, empty } = state.selection
  const probe = empty ? (key === 'Backspace' ? from - 1 : from) : from
  if (probe < 0 || probe >= state.doc.content.size) return null
  const $probe = state.doc.resolve(probe)
  const parent = $probe.parent
  const start = $probe.start()
  let range: { from: number; to: number } | null = null
  let cursor = start
  let run: { from: number; to: number; instr: string } | null = null
  parent.forEach((child: any) => {
    const mark = child.isText ? (child.marks || []).find(isFluxField) : null
    const end = cursor + child.nodeSize
    if (mark) {
      const instr = String(mark.attrs?.instr || '')
      if (run && run.instr === instr && run.to === cursor) run.to = end
      else run = { from: cursor, to: end, instr }
      if (!range && probe >= run.from && probe < end) range = run
    } else run = null
    cursor = end
  })
  const found = range as { from: number; to: number } | null
  if (!found) return null
  return empty || (from >= found.from && to <= found.to) ? { from: found.from, to: found.to } : null
}

/**
 * Любая регистрация плагина пересобирает виды всех плагинов; вид yUndo при
 * уничтожении отключает UndoManager от документа Yjs, а новый вид его не
 * подключает обратно. Если сеанс совместной правки уже привязан, отмена
 * молча перестаёт собирать правки (гонка с приходом y-state). Поэтому
 * плагин отмены снимаем и ставим заново: состояние поля тогда создаётся с
 * новым UndoManager.
 */
function reviveUndoManager(editor: Editor): void {
  const plugins = editor.state.plugins
  const index = plugins.findIndex((plugin) => (plugin as unknown as { key: string }).key === 'y-undo$')
  if (index < 0) return
  const without = plugins.filter((_, i) => i !== index)
  editor.view.updateState(editor.state.reconfigure({ plugins: without }))
  editor.view.updateState(editor.state.reconfigure({ plugins: [
    ...without.slice(0, index), yUndoPlugin({ protectedNodes: new Set(['docParagraph']) }), ...without.slice(index),
  ] }))
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
      // Через событие DOM, а не handleKeyDown: при выделенном поле Backspace раньше нас
      // перехватывает клавиатурная карта редактора (deleteSelection), и поле не удалялось бы.
      handleDOMEvents: {
        keydown(view, event) {
          // Текст у края или между полей: браузер не ставит каретку между двумя нередактируемыми
          // метками, а набранный знак унаследовал бы метку поля и был бы заблокирован защитой.
          // Поэтому знак вставляем сами обычным текстом: так пишутся «(», «+», «)» вокруг полей.
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
            const { state } = view
            const { from, to } = state.selection
            if (from !== to || !(state.selection instanceof TextSelection)) return false
            const $pos = state.doc.resolve(from)
            const nextToField = [$pos.nodeBefore, $pos.nodeAfter].some((node: any) => node?.isText && (node.marks || []).some(isFluxField))
            if (!nextToField || !view.editable) return false
            const marks = ($pos.marks() || []).filter((mark: any) => !isFluxField(mark))
            view.dispatch(state.tr.replaceWith(from, to, state.schema.text(event.key, marks)).setMeta('fluxFieldCommand', true).scrollIntoView())
            event.preventDefault()
            return true
          }
          if (event.key !== 'Backspace' && event.key !== 'Delete') return false
          const stop = (): true => { event.preventDefault(); return true }
          if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return selectionTouchesFluxField(view.state, event.key) ? stop() : false
          // Поле не стирается случайно: первое нажатие выделяет его целиком, второе
          // удаляет (как чип). Остальные случаи у поля по-прежнему блокируются.
          const range = fluxFieldRange(view.state, event.key)
          if (!range) return selectionTouchesFluxField(view.state, event.key) ? stop() : false
          const { from, to, empty } = view.state.selection
          if (from === range.from && to === range.to) view.dispatch(view.state.tr.delete(range.from, range.to).setMeta('fluxFieldCommand', true).scrollIntoView())
          else if (empty) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)))
          return stop()
        },
      },
    },
  }))
  reviveUndoManager(editor)
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

type NativeOfficePart = { kind: 'text'; text: string } | { kind: 'operator'; operator: '+' | '-' | '*' | '/' | '(' | ')' } | { kind: 'field'; binding: any } | { kind: 'union'; mode: 'first-match'; alternatives: any[] }

function splitNativeText(text: string, followsField: boolean): NativeOfficePart[] {
  // Арифметика считается только в ячейке, начинающейся с «=»; иначе «Т/А» и «№-1» остаются текстом
  const number = '(?:\\d+(?:[.,]\\d*)?|[.,]\\d+)'
  const prefixOperator = new RegExp(`^(\\s*)([+*\\-/])\\s*(${number})(.*)$`).exec(text)
  if (prefixOperator && (followsField || prefixOperator[2] === '*' || prefixOperator[2] === '/')) {
    const out: NativeOfficePart[] = []
    if (prefixOperator[1]) out.push({ kind: 'text', text: prefixOperator[1] })
    out.push({ kind: 'operator', operator: prefixOperator[2] as any }, { kind: 'text', text: prefixOperator[3] })
    if (prefixOperator[4]) out.push({ kind: 'text', text: prefixOperator[4] })
    return out
  }
  const standalone = /^(\s*)([+\-*/()])(\s*)$/.exec(text)
  if (standalone) {
    const out: NativeOfficePart[] = []
    if (standalone[1]) out.push({ kind: 'text', text: standalone[1] })
    out.push({ kind: 'operator', operator: standalone[2] as any })
    if (standalone[3]) out.push({ kind: 'text', text: standalone[3] })
    return out
  }
  const binary = new RegExp(`^(.*?${number}\\s*)([+*\\-/])\\s*(${number})(.*)$`).exec(text)
  if (binary) return [
    ...(binary[1] ? [{ kind: 'text', text: binary[1] } as NativeOfficePart] : []),
    { kind: 'operator', operator: binary[2] as any }, { kind: 'text', text: binary[3] },
    ...(binary[4] ? [{ kind: 'text', text: binary[4] } as NativeOfficePart] : []),
  ]
  return text ? [{ kind: 'text', text }] : []
}

/** Считывает живую последовательность абзаца: обычный текст между Word-полями
 * важен для предпросмотра, поэтому порядок берётся из дерева редактора. */
function readNativeHeader(editor: Editor, anchorId: string, schemaAnchor?: any): NativeOfficePart[] | null {
  let found: NativeOfficePart[] | null = null
  editor.state.doc.descendants((paragraph: any) => {
    if (found || !['docParagraph', 'paragraph'].includes(paragraph.type.name)) return
    if (![...(paragraph.attrs?.bookmarks || []), ...(paragraph.attrs?.hiddenBookmarks || [])].some((name: unknown) => anchorIdFromBookmark(name) === anchorId)) return
    const native: Array<{ text: string; identity?: { fieldKey: string; sourceId?: string } }> = []
    paragraph.descendants((node: any) => {
      if (node.isText) {
        const mark = (node.marks || []).find(isFluxField)
        native.push({ text: node.text, ...(mark ? { identity: fluxFieldIdentity(mark) || undefined } : {}) })
      }
    })
    const schemaParts = schemaAnchor?.parts || []
    const claimed = new Set<number>()
    const assigned = native.map((item) => {
      if (!item.identity) return null
      const match = schemaParts.findIndex((part: any, index: number) => {
        if (claimed.has(index)) return false
        const bindings = part?.kind === 'field' ? [part.binding] : part?.kind === 'union' ? part.alternatives : []
        return bindings.some((binding: any) => binding?.fieldKey === item.identity!.fieldKey && (!item.identity!.sourceId || binding.sourceId === item.identity!.sourceId))
      })
      if (match < 0) return null
      claimed.add(match)
      return { schemaIndex: match, part: schemaParts[match] }
    })
    const nativeText = native.map((item) => item.text).join('')
    const renderedSchema = schemaParts.map((part: any, index: number) => {
      if (part.kind === 'text') return part.text
      if (part.kind === 'operator') return part.operator
      const tokenIndex = assigned.findIndex((entry) => entry?.schemaIndex === index)
      return tokenIndex < 0 ? null : native[tokenIndex].text
    })
    const schemaTokenCount = schemaParts.filter((part: any) => part.kind === 'field' || part.kind === 'union').length
    const hasExactKnownSchema = claimed.size === schemaTokenCount && assigned.every((entry, index) => !native[index].identity || !!entry) && renderedSchema.every((part: string | null) => part !== null) && renderedSchema.join('') === nativeText
    const isFormula = nativeText.trimStart().startsWith('=')
    // Без ведущего «=» знаки — обычный текст, даже если в схеме они остались операторами
    const plainText = (list: NativeOfficePart[]): NativeOfficePart[] => isFormula ? list : list.reduce<NativeOfficePart[]>((out, part) => {
      const piece: NativeOfficePart = part.kind === 'operator' ? { kind: 'text', text: part.operator } : part
      const prior = out[out.length - 1]
      if (piece.kind === 'text' && prior?.kind === 'text') out[out.length - 1] = { kind: 'text', text: prior.text + piece.text }
      else out.push(piece)
      return out
    }, [])
    if (hasExactKnownSchema) { found = plainText(schemaParts); return }
    const parts: NativeOfficePart[] = []
    let followsField = false
    const emittedUnions = new Set<number>()
    native.forEach((item, index) => {
      const match = assigned[index]
      if (match?.part?.kind === 'field') { parts.push(match.part); followsField = true; return }
      if (match?.part?.kind === 'union') {
        if (!emittedUnions.has(match.schemaIndex)) { parts.push(match.part); emittedUnions.add(match.schemaIndex) }
        followsField = true; return
      }
      const textParts = isFormula ? splitNativeText(item.text, followsField) : (item.text ? [{ kind: 'text', text: item.text } as NativeOfficePart] : [])
      parts.push(...textParts)
      followsField = false
    })
    found = plainText(parts)
  })
  return found
}

function wordParagraphForSchema(editor: Editor, paragraph: any, anchor: any, labels: Record<string, string>): any {
  const existingFields = new Map<string, any>()
  const existingTextMarks = new Map<string, any[]>()
  const plainMarks: any[] = []
  paragraph.descendants((node: any) => {
    if (!node.isText) return
    const mark = (node.marks || []).find(isFluxField)
    const identity = mark && fluxFieldIdentity(mark)
    const key = identity && `${identity.sourceId || ''}\u0000${identity.fieldKey}`
    if (key && !existingFields.has(key)) existingFields.set(key, node)
    if (!mark) {
      if (!plainMarks.length) plainMarks.push(...(node.marks || []))
      if (!existingTextMarks.has(node.text)) existingTextMarks.set(node.text, node.marks || [])
    }
  })
  const parts: any[] = []
  const fieldMarkType = editor.state.schema.marks.instrField
  const appendText = (value: string, marks?: any[]): void => { if (value) parts.push(editor.schema.text(value, marks || existingTextMarks.get(value) || plainMarks)) }
  const labelFor = (binding: any): string => {
    const label = labels[`${binding.sourceId}:${binding.fieldKey}`] ?? labels[binding.fieldKey]
    return typeof label === 'string' ? label : existingFields.get(`${binding.sourceId}\u0000${binding.fieldKey}`)?.text || existingFields.get(`\u0000${binding.fieldKey}`)?.text || binding.fieldKey
  }
  for (const part of anchor.parts) {
    if (part.kind === 'text') { appendText(part.text); continue }
    if (part.kind === 'operator') { appendText(part.operator); continue }
    const binding = part.kind === 'field' ? part.binding : part.alternatives[0]
    const fieldKey = String(binding.fieldKey)
    const existingNode = existingFields.get(`${binding.sourceId}\u0000${fieldKey}`) || existingFields.get(`\u0000${fieldKey}`)
    const existingMarks = existingNode?.marks || []
    const extraMarks = existingMarks.filter((mark: any) => !isFluxField(mark))
    const fluxMark = fieldMarkType.create({ instr: fluxInstruction(anchor, binding) })
    const marks = [...(extraMarks.length ? extraMarks : plainMarks.filter((mark: any) => !isFluxField(mark))), fluxMark]
    const visible = part.kind === 'field' ? labelFor(binding) : (typeof part.label === 'string' ? part.label : part.alternatives.map(labelFor).join(' / '))
    appendText(visible, marks)
  }
  return paragraph.type.create(paragraph.attrs, Fragment.fromArray(parts))
}

function validateHeaderSchema(schema: any): boolean {
  if (!schema || schema.version !== 1 || !Array.isArray(schema.anchors) || schema.anchors.length > 500) return false
  const seen = new Set<string>()
  const validBinding = (binding: any, anchorId: string): boolean => !!binding && typeof binding.fieldKey === 'string' && binding.fieldKey.length > 0 && binding.fieldKey.length <= 200 && !/["\\\r\n\u0000-\u001f]/.test(binding.fieldKey) && typeof binding.sourceId === 'string' && binding.sourceId.length > 0 && binding.sourceId.length <= 200 && typeof binding.entityType === 'string' && binding.entityType.length > 0 && binding.entityType.length <= 200 && String(binding.anchorId || anchorId) === anchorId
  for (const anchor of schema.anchors) {
    if (!anchor || anchor.kind !== 'word-row' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(anchor.id || '')) || seen.has(anchor.id) || !Array.isArray(anchor.parts) || anchor.parts.length > 500) return false
    seen.add(anchor.id)
    for (const part of anchor.parts) {
      if (part?.kind === 'text' && typeof part.text === 'string' && part.text.length <= 10000) continue
      if (part?.kind === 'operator' && ['+', '-', '*', '/', '(', ')'].includes(part.operator)) continue
      if (part?.kind === 'field' && validBinding(part.binding, anchor.id)) continue
      if (part?.kind === 'union' && part.mode === 'first-match' && (part.label === undefined || (typeof part.label === 'string' && part.label.length <= 200)) && Array.isArray(part.alternatives) && part.alternatives.length > 0 && part.alternatives.length <= 100 && part.alternatives.every((item: any) => validBinding(item, anchor.id) && Number.isInteger(item.priority) && item.priority >= 0)) continue
      return false
    }
  }
  return true
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
  row.forEach((cell: any, _offset: number, cellIndex: number) => {
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
  // Второй аргумент ProseMirror — смещение в тексте. Колонка — третий;
  // её номер сохраняется после изменения длины соседней ячейки.
  styleRow.forEach((cell: any, _offset: number, index: number) => {
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
    rows.forEach((row, rowIndex) => row.forEach((cell: any, _offset: number, col: number) => {
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
        existing.forEach((cell: any, _offset: number, col: number) => {
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
  let liveHeaderSchema: any = null
  const headerActions = createWordHeaderActions(editor, { validateHeaderSchema, wordParagraphForSchema, readNativeHeader, anchorIdFromBookmark, isFluxField })
  installFluxFieldGuard(editor)
  installParameterChipStyle()
    const report = () => p.tell('flux:anchor-selected', docAnchor(editor))
  // Текст, набранный в ячейке-формуле между метками, надо донести до схемы: после паузы в наборе
  // сообщаем окну Flux, и оно сверяет схему с ячейкой (в ячейке без «=» ничего не делаем)
  let formulaTimer: ReturnType<typeof setTimeout> | undefined
  const reportFormulaEdit = () => {
    clearTimeout(formulaTimer)
    formulaTimer = setTimeout(() => {
      const parent = editor.state.selection.$from.parent
      if (parent.textContent.trimStart().startsWith('=') && docAnchor(editor)) p.tell('flux:formula-edited', {})
    }, 1500)
  }
  editor.on('update', reportFormulaEdit)
  editor.on('destroy', () => { clearTimeout(formulaTimer); editor.off('update', reportFormulaEdit) })
  editor.on('selectionUpdate', report)
  editor.on('destroy', () => editor.off('selectionUpdate', report))
  const onHeaderContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null
    const cellElement = target?.closest('td,th')
    if (!cellElement || !editor.view.dom.contains(cellElement)) return
    let clickedAnchorId: string | null = null
    try {
      const $clicked = editor.state.doc.resolve(editor.view.posAtDOM(cellElement, 0))
      for (let depth = $clicked.depth; depth > 0; depth--) {
        if (['docTableHeader', 'docTableCell'].includes($clicked.node(depth).type.name)) { clickedAnchorId = headerActions.cellAnchorId($clicked.node(depth)); break }
      }
    } catch { return }
    if (!clickedAnchorId) return
    let anchors: ReturnType<typeof headerActions.selectedBoundHeaderAnchors> = null
    try { anchors = headerActions.selectedBoundHeaderAnchors(liveHeaderSchema) } catch { return }
    if (!anchors?.some((anchor) => anchor.anchorId === clickedAnchorId)) return
    event.preventDefault()
    event.stopPropagation()
    p.tell('flux:cell-actions', {
      editorKind: 'docs',
      anchors,
      position: { x: event.clientX, y: event.clientY },
    })
  }
  editor.view.dom.addEventListener('contextmenu', onHeaderContextMenu, true)
  editor.on('destroy', () => editor.view.dom.removeEventListener('contextmenu', onHeaderContextMenu, true))
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
        if (!ed.isEditable) throw new Error('Документ открыт только для чтения')
        const selectedAnchor = docAnchor(ed)
        const explicitAnchor = typeof request?.anchorId === 'string' && request.anchorId.length > 0
        const anchorId = String(explicitAnchor ? request.anchorId : selectedAnchor?.anchorId || '')
        if (explicitAnchor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(anchorId)) throw new Error('ID якоря Word имеет неверный формат')
        if (explicitAnchor && headerActions.isCellSelection()) headerActions.focusFormula({ anchorId, schema: liveHeaderSchema, caret: 'end', preserveText: true })
        // Новый add-on передаёт anchorId и работает только в ячейке таблицы;
        // старые вызовы без якоря сохраняют совместимость в обычном тексте.
        if (explicitAnchor && !persistDocAnchor(ed, anchorId)) throw new Error('Выберите ячейку таблицы: якорь не сохранён')
        const binding = request?.binding
        const sourceId = typeof binding?.sourceId === 'string' && binding.fieldKey === key ? binding.sourceId : ''
        const identity = sourceId ? `v1:${encodeURIComponent(sourceId)}:${encodeURIComponent(key)}` : key
        const instr = `DOCPROPERTY "flux:${identity}"`
        const markType = ed.state.schema.marks.instrField
        if (!markType) throw new Error('Нативная метка Word недоступна')
        const { from, to } = ed.state.selection
        const tr = ed.state.tr.replaceWith(from, to, ed.schema.text(label, [markType.create({ instr })])).setMeta('fluxFieldCommand', true)
        ed.view.dispatch(tr.scrollIntoView())
        const ok = true
        const anchor = docAnchor(ed)
        result = { ok, fieldKey: key, ...(anchor ? { anchorId: anchor.anchorId, anchor } : explicitAnchor ? { anchorId } : {}) }
      } catch (err: any) { result = { ok: false, fieldKey: key, error: String(err?.message || err) } }
    }
    p.tell('flux:field-inserted', result)
  })
  p.on('removeFluxField', () => {
    if (!editor.isEditable) return
    const { state, view } = editor
    const { from, to, empty } = state.selection
    const ranges: Array<{ from: number; to: number }> = []
    const scanFrom = empty ? Math.max(0, from - 1) : from
    const scanTo = empty ? Math.min(state.doc.content.size, from + 1) : to
    state.doc.nodesBetween(scanFrom, scanTo, (node: any, pos: number) => {
      if (!ranges.length && node.isText && (node.marks || []).some(isFluxField)) ranges.push({ from: pos, to: pos + node.nodeSize })
    })
    const range = ranges[0]
    if (range) view.dispatch(state.tr.delete(range.from, range.to).setMeta('fluxFieldCommand', true).scrollIntoView())
  })
  // Шаги «назад», помеченные действиями Flux: отмена и повтор возвращают и схему в файле (хост пишет её сам)
  const historyMarks = createDocsHistoryMarks(() => yUndoPluginKey.getState(editor.state)?.undoManager as any, (step) => p.tell('flux:history-step', step))
  editor.on('transaction', historyMarks.attach)
  editor.on('destroy', () => editor.off('transaction', historyMarks.attach))
  p.on('markFluxHistory', (request: any) => {
    p.tell('flux:history-marked', { ok: true, marked: historyMarks.mark(String(request?.id || ''), Number(request?.since) || 0) })
  })
  p.on('getFluxHeaderSchema', (request: any) => {
    let result: any
    try {
      const schema = request?.schema
      if (!validateHeaderSchema(schema)) throw new Error('Схема заголовков имеет неверный формат')
      const anchors = schema.anchors.map((anchor: any) => {
        const parts = readNativeHeader(editor, String(anchor.id), anchor)
        if (!parts) throw new Error(`Ячейка заголовка ${anchor.id} больше не найдена в документе`)
        return { ...anchor, parts }
      })
      liveHeaderSchema = { version: schema.version, anchors }
      result = { ok: true, schema: { version: schema.version, anchors }, headers: anchors.map((anchor: any) => ({ anchorId: anchor.id, parts: anchor.parts })) }
    } catch (err: any) { result = { ok: false, error: String(err?.message || err) } }
    p.tell('flux:header-schema-read', result)
  })
  p.on('syncFluxHeaderSchema', (request: any) => {
    let result: any
    try {
      if (!editor.isEditable) throw new Error('Документ открыт только для чтения')
      const schema = request?.schema
      const removed = request?.removedAnchorIds ?? []
      const displayLabels = request?.displayLabels && typeof request.displayLabels === 'object' ? request.displayLabels : {}
      if (!validateHeaderSchema(schema) || !Array.isArray(removed) || removed.length > 500 || removed.some((id: any) => !/^[0-9a-f-]{36}$/i.test(String(id)))) throw new Error('Схема заголовков имеет неверный формат')
      if (Object.values(displayLabels).some((label: any) => typeof label !== 'string' || label.length > 2000)) throw new Error('Подписи заголовков имеют неверный формат')
      const anchors = new Map<string, any>(schema.anchors.map((anchor: any) => [String(anchor.id), anchor]))
      if (new Set(removed.map(String)).size !== removed.length || removed.some((id: any) => anchors.has(String(id)))) throw new Error('Изменение схемы повторно удаляет или одновременно сохраняет якорь')
      const targets = new Map<string, { pos: number; paragraph: any }>()
      editor.state.doc.descendants((node: any, pos: number) => {
        if (!['docParagraph', 'paragraph'].includes(node.type.name)) return
        const id = [...(node.attrs?.bookmarks || []), ...(node.attrs?.hiddenBookmarks || [])].map(anchorIdFromBookmark).find(Boolean)
        if (id && !targets.has(id)) targets.set(id, { pos, paragraph: node })
      })
      for (const id of [...anchors.keys(), ...removed]) if (!targets.has(id)) throw new Error(`Ячейка заголовка ${id} больше не найдена в документе`)
      const tr = editor.state.tr
      const replacements: Array<{ pos: number; before: any; after: any }> = []
      for (const [id, anchor] of anchors) {
        const target = targets.get(id)!
        replacements.push({ pos: target.pos, before: target.paragraph, after: wordParagraphForSchema(editor, target.paragraph, anchor, displayLabels) })
      }
      for (const id of removed.map(String)) {
        const target = targets.get(id)!
        const attrs = { ...target.paragraph.attrs }
        attrs.bookmarks = (attrs.bookmarks || []).filter((name: unknown) => anchorIdFromBookmark(name) !== id)
        attrs.hiddenBookmarks = (attrs.hiddenBookmarks || []).filter((name: unknown) => anchorIdFromBookmark(name) !== id)
        const children: any[] = []
        target.paragraph.forEach((child: any) => { if (!child.isText || !(child.marks || []).some(isFluxField)) children.push(child) })
        replacements.push({ pos: target.pos, before: target.paragraph, after: target.paragraph.type.create(attrs, Fragment.fromArray(children)) })
      }
      for (const item of replacements.sort((a, b) => b.pos - a.pos)) tr.replaceWith(item.pos, item.pos + item.before.nodeSize, item.after)
      if (tr.docChanged) { tr.setMeta('fluxFieldCommand', true); editor.view.dispatch(tr) }
      const synced = schema.anchors.map((anchor: any) => ({ ...anchor, parts: readNativeHeader(editor, String(anchor.id), anchor) || [] }))
      liveHeaderSchema = { version: schema.version, anchors: synced }
      result = { ok: true, schema: { version: schema.version, anchors: synced }, headers: synced.map((anchor: any) => ({ anchorId: anchor.id, parts: anchor.parts })) }
    } catch (err: any) { result = { ok: false, error: String(err?.message || err) } }
    p.tell('flux:header-schema-synced', result)
  })
  p.on('mergeFluxHeaderColumns', (request: any) => {
    void (async () => {
      let result: any
      try { result = await headerActions.merge(request) }
      catch (err: any) { result = { ok: false, error: String(err?.message || err) } }
      if (result?.ok && !result.preview) liveHeaderSchema = result.schema
      p.tell('flux:header-columns-merged', result)
    })()
  })
  p.on('editFluxHeaderFormula', (request: any) => {
    let result: any
    try {
      result = { ok: headerActions.focusFormula(request) }
      liveHeaderSchema = request.schema
    } catch (err: any) { result = { ok: false, error: String(err?.message || err) } }
    p.tell('flux:header-formula-edit-started', result)
  })
  p.on('applyFluxPlan', (request: any) => {
    let result: any
    try {
      if (!editor.isEditable) throw new Error('Документ открыт только для чтения')
      result = applyDocOfficePlan(editor, request)
    } catch (err: any) { result = { ok: false, error: String(err?.message || err) } }
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
  const field = /^\s*DOCPROPERTY\s+"flux:([^"\r\n]+)"\s*$/i.exec(instruction)
  if (!field) return null
  let key = field[1]
  const composite = /^v1:([^:]+):(.+)$/.exec(key)
  if (composite) {
    try { key = decodeURIComponent(composite[2]) } catch { return null }
  }
  const match = /^tag\[([^\]\r\n]+)\]\.identifier$/i.exec(key)
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
    // Подключаем вместе: отдельная регистрация следующего плагина уничтожает
    // уже созданный view UndoManager и отключает сбор локальной истории.
    const plugins = editor.state.plugins.filter((plugin) => {
      const key = (plugin as unknown as { key: string }).key
      return !key.startsWith('history$') && !['y-sync$', 'y-undo$', 'yjs-cursor$'].includes(key)
    })
    editor.view.updateState(editor.state.reconfigure({ plugins: [
      ...plugins,
      ySyncPlugin(fragment),
      yUndoPlugin({ protectedNodes: new Set(['docParagraph']) }),
      yCursorPlugin(awareness),
    ] }))
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
