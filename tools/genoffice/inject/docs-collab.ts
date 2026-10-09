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
  prosemirrorToYXmlFragment, redoCommand, undoCommand, yCursorPlugin, ySyncPlugin, yUndoPlugin,
} from 'y-prosemirror'
import { UndoRedo } from '@tiptap/extensions'
import type { Editor } from '@tiptap/core'
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
