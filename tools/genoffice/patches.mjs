/**
 * Правки исходников GenOffice перед сборкой Flux Office.
 *
 * Правок мало, и каждая — ровно то, чего у редактора нет, а Flux нужно. Они
 * делаются заменой строки, а не файлом .patch: закреплённый коммит не
 * меняется, а при его смене заменяемая строка либо найдётся, либо сборка
 * остановится с понятной причиной — молча собрать редактор без правки
 * нельзя (у сотрудника тогда пропал бы режим просмотра).
 *
 * Повторный запуск безопасен: уже внесённая правка узнаётся и пропускается.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Прежняя одна кнопка Flux: кэш уже патченного исходника обновляется до вкладки (поле prior). */
const OPEN_PANEL_CLICK = "window.parent.postMessage({ flux: 'office', op: 'flux:open-panel' }, (window.location.origin === 'null' || window.location.origin === 'file://' ? '*' : window.location.origin))";
const FLUX_TAB_BUTTON_OLD_DOCS = `        <button type="button" className="ribbon-tab" aria-label="Flux" title="Flux" onClick={() => ${OPEN_PANEL_CLICK}}>Flux</button>\n        <span className="ribbon-tabs-spacer" />\n        {trailingActions}`;
const FLUX_TAB_BUTTON_OLD_SHEETS = `          <button type="button" className="ribbon-tab" aria-label="Flux" title="Flux" onClick={() => ${OPEN_PANEL_CLICK}}>Flux</button>\n          <span className="ribbon-tabs-spacer" />\n          <span className="workbook-status"`;

export const PATCHES = [
  {
    // В подсказке параметра показываем действие, а не внутреннюю инструкцию DOCX.
    id: 'flux-docs-parameter-hint',
    file: 'apps/docs/src/renderer/editor/marks.ts',
    find: "        title: t('editorFieldHint', { instr: instruction }),\n",
    replace: "        title: /^\\s*DOCPROPERTY\\s+\"flux:[^\"]+\"\\s*$/i.test(instruction) ? 'Параметр Flux. Действия доступны по правой кнопке мыши.' : t('editorFieldHint', { instr: instruction }),\n",
  },
  {
    // Метки параметров Flux выделены внутри ячейки; остальные поля Word сохраняют оформление.
    id: 'flux-docs-inline-parameter-chip',
    file: 'apps/docs/src/renderer/editor/marks.ts',
    find: "        'data-instr-field': instruction,\n        class: `doc-ref-field${zoteroClass}`,\n",
    replace: "        'data-instr-field': instruction,\n        'data-flux-parameter': /^\\s*DOCPROPERTY\\s+\"flux:[^\"]+\"\\s*$/i.test(instruction) ? 'true' : undefined,\n        contenteditable: /^\\s*DOCPROPERTY\\s+\"flux:[^\"]+\"\\s*$/i.test(instruction) ? 'false' : undefined,\n        class: `doc-ref-field${zoteroClass}${/^\\s*DOCPROPERTY\\s+\"flux:[^\"]+\"\\s*$/i.test(instruction) ? ' flux-parameter-chip' : ''}`,\n",
  },
  {
    // Цвет берётся из темы бумаги; рамка и отступ ограничены только токенами дополнения.
    id: 'flux-docs-inline-parameter-chip-style',
    file: 'apps/docs/src/renderer/styles.css',
    find: '.doc-ref-field:hover {\n  background: var(--docs-paper-field-bg);\n}',
    replace: '.doc-ref-field:hover {\n  background: var(--docs-paper-field-bg);\n}\n\n.flux-parameter-chip {\n  display: inline-flex;\n  align-items: baseline;\n  padding: 0 0.28em;\n  border: 1px solid color-mix(in srgb, currentColor 24%, transparent);\n  border-radius: 0.35em;\n  background: var(--docs-paper-field-bg);\n  color: inherit;\n  white-space: nowrap;\n  user-select: all;\n}',
  },
  {
    // DOCPROPERTY-поля Flux должны остаться защищённой меткой при чтении DOCX.
    // Остальные неизвестные поля сохраняют прежний режим отображения.
    id: 'flux-docx-docproperty-field',
    file: 'packages/docx-engine/src/parse-props.ts',
    find: '  /^\\s*(DATE|TIME|CREATEDATE|SAVEDATE|NUMPAGES|FILENAME|AUTHOR|PAGE)\\b/\n',
    prior: '  /^\\s*(?:(?:DATE|TIME|CREATEDATE|SAVEDATE|NUMPAGES|FILENAME|AUTHOR|PAGE)\\b|DOCPROPERTY\\s+"flux:[^"]+")/i\n',
    replace: '  /^\\s*(?:(?:DATE|TIME|CREATEDATE|SAVEDATE|NUMPAGES|FILENAME|AUTHOR|PAGE)\\b|DOCPROPERTY\\s+"flux:[^"]+")/\n',
  },
  {
    // Метки и номера строк Flux относятся к скрытым закладкам документа.
    id: 'flux-docx-hidden-bookmarks',
    file: 'packages/docx-engine/src/parse-props.ts',
    find: "    const list = name.startsWith('_') ? hidden : names\n",
    prior: "    const list = name.startsWith('_') || /^FLUX(?:_|$)/i.test(name) ? hidden : names\n",
    replace: "    const list = name.startsWith('_') || /^FLUX_[0-9a-f]{32}$/i.test(name) || /^FLUX(?:ROW|TABLE)_/i.test(name) ? hidden : names\n",
  },
  {
    // Табличная модель переносит только служебные закладки Flux.
    id: 'flux-docx-table-bookmark-parser-helper',
    file: 'packages/docx-engine/src/parse-props.ts',
    find: `  }\n}\n\n/**\n * Exact <w:pPr>...</w:pPr> slice of a paragraph (depth-aware: pPrChange nests`,
    replace: `  }\n}\n\n/** Возвращает только закладки Flux из абзаца таблицы. */\nexport function fluxTableBookmarkNamesOf(xml: string): string[] {\n  const { bookmarks, hiddenBookmarks } = bookmarkNamesOf(xml)\n  return [...(bookmarks ?? []), ...(hiddenBookmarks ?? [])].filter((name) => /^FLUX_[0-9a-f]{32}$/i.test(name) || /^FLUX(?:ROW|TABLE)_/i.test(name))\n}\n\n/**\n * Exact <w:pPr>...</w:pPr> slice of a paragraph (depth-aware: pPrChange nests`,
  },
  {
    // DOCX parser keeps Flux anchors with rich table paragraph metadata.
    id: 'flux-docx-table-bookmark-parse',
    file: 'packages/docx-engine/src/parse.ts',
    find: '  bookmarkNamesOf,\n',
    replace: '  bookmarkNamesOf,\n  fluxTableBookmarkNamesOf,\n',
  },
  {
    id: 'flux-docx-table-bookmark-model',
    file: 'packages/docx-engine/src/parse.ts',
    find: `    richParas.push({\n      ...format,\n      ...(cellStyleId ? { styleId: cellStyleId } : {}),\n      ...(emptySz ? { emptyRunSizeHalfPoints: emptySz } : {}),\n      ...(emptyFont ? { emptyRunFontFamily: emptyFont } : {}),\n      ...(list ? { list } : {}),\n      runs,\n    })`,
    replace: `    const fluxBookmarks = fluxTableBookmarkNamesOf(stripTextboxes(serializeXNode(p)))\n    richParas.push({\n      ...format,\n      ...(cellStyleId ? { styleId: cellStyleId } : {}),\n      ...(emptySz ? { emptyRunSizeHalfPoints: emptySz } : {}),\n      ...(emptyFont ? { emptyRunFontFamily: emptyFont } : {}),\n      ...(list ? { list } : {}),\n      ...(fluxBookmarks.length ? { hiddenBookmarks: fluxBookmarks } : {}),\n      runs,\n    })`,
  },
  {
    id: 'flux-docx-table-bookmark-type',
    file: 'packages/docx-engine/src/types.ts',
    find: '  runs: Run[]\n  /** w:pStyle of the cell paragraph (style CSS: fonts/spacing reach cell content) */',
    replace: '  runs: Run[]\n  /** Скрытые закладки Flux в абзаце таблицы. */\n  hiddenBookmarks?: string[]\n  /** w:pStyle of the cell paragraph (style CSS: fonts/spacing reach cell content) */',
  },
  {
    // Flux bookmarks travel through the Docs table display model only.
    id: 'flux-docs-table-bookmark-convert',
    file: 'apps/docs/src/renderer/editor/convert.ts',
    find: '/** cell paragraphs with nested tables (read-only atoms) spliced in at their anchors */\n',
    replace: 'const fluxTableBookmarks = (value: unknown): string[] => Array.isArray(value) ? value.filter((name): name is string => typeof name === \'string\' && (/^FLUX_[0-9a-f]{32}$/i.test(name) || /^FLUX(?:ROW|TABLE)_/i.test(name))) : []\n\n/** cell paragraphs with nested tables (read-only atoms) spliced in at their anchors */\n',
  },
  {
    id: 'flux-docs-table-bookmark-pm-model',
    file: 'apps/docs/src/renderer/editor/convert.ts',
    find: '            runs: inlineToRuns(paragraph.content ?? []),\n',
    replace: '            ...(fluxTableBookmarks(paragraph.attrs?.hiddenBookmarks).length ? { hiddenBookmarks: fluxTableBookmarks(paragraph.attrs?.hiddenBookmarks) } : {}),\n            runs: inlineToRuns(paragraph.content ?? []),\n',
  },
  {
    id: 'flux-docs-table-bookmark-native-model',
    file: 'apps/docs/src/renderer/editor/convert.ts',
    find: '            styleId,\n            kind: list.kind,',
    prior: '            styleId,\n            ...(fluxTableBookmarks(paragraph.hiddenBookmarks).length ? { hiddenBookmarks: fluxTableBookmarks(paragraph.hiddenBookmarks) } : {}),\n            kind: list.kind,',
    replace: '            styleId,\n            ...(fluxHiddenBookmarks.length ? { hiddenBookmarks: fluxHiddenBookmarks } : {}),\n            kind: list.kind,',
  },
  {
    id: 'flux-docs-table-bookmark-native-model-paragraph',
    file: 'apps/docs/src/renderer/editor/convert.ts',
    find: '  ).map((paragraph) => {\n    const list = \'list\' in paragraph ? paragraph.list : undefined\n    const styleId = (\'styleId\' in paragraph ? paragraph.styleId : undefined) ?? null\n',
    replace: '  ).map((paragraph) => {\n    const list = \'list\' in paragraph ? paragraph.list : undefined\n    const styleId = (\'styleId\' in paragraph ? paragraph.styleId : undefined) ?? null\n    const fluxHiddenBookmarks = fluxTableBookmarks(\'hiddenBookmarks\' in paragraph ? paragraph.hiddenBookmarks : undefined)\n',
  },
  {
    id: 'flux-docs-table-bookmark-native-model-paragraph-attrs',
    file: 'apps/docs/src/renderer/editor/convert.ts',
    find: '          attrs: { ...formatAttrs(paragraph, paragraph.runs), styleId },\n',
    prior: '          attrs: { ...formatAttrs(paragraph, paragraph.runs), styleId, ...(fluxTableBookmarks(paragraph.hiddenBookmarks).length ? { hiddenBookmarks: fluxTableBookmarks(paragraph.hiddenBookmarks) } : {}) },\n',
    replace: '          attrs: { ...formatAttrs(paragraph, paragraph.runs), styleId, ...(fluxHiddenBookmarks.length ? { hiddenBookmarks: fluxHiddenBookmarks } : {}) },\n',
  },
  {
    // Табличный генератор пишет только Flux-системные метки через тот же OOXML helper.
    id: 'flux-docx-table-bookmark-generate',
    file: 'packages/docx-engine/src/generate.ts',
    find: '    const pPr = mergePPrFormat(`<w:pPr>${numPr}</w:pPr>`, paragraph)\n',
    replace: '    const pPr = mergePPrFormat(`<w:pPr>${numPr}</w:pPr>`, paragraph)\n    const hiddenBookmarks = \'hiddenBookmarks\' in paragraph ? paragraph.hiddenBookmarks : undefined\n',
  },
  {
    id: 'flux-docx-table-bookmark-generate-p',
    file: 'packages/docx-engine/src/generate.ts',
    find: '    return `<w:p>${pPr}${runsXml(paragraph.runs, null)}</w:p>`',
    prior: '    return `<w:p>${pPr}${bookmarksXml(paragraph.hiddenBookmarks)}${runsXml(paragraph.runs, null)}</w:p>`',
    replace: '    return `<w:p>${pPr}${bookmarksXml(hiddenBookmarks)}${runsXml(paragraph.runs, null)}</w:p>`',
  },
  {
    // В подписи таблицы учитываются закладки абзацев, иначе оптимизатор
    // повторно использует исходный XML и теряет только что добавленный якорь.
    id: 'flux-docx-table-bookmark-signature',
    file: 'apps/docs/src/renderer/editor/convert.ts',
    find: `        cell.attrs?.cellRevision ?? null,\n      ]),`,
    prior: `        cell.attrs?.cellRevision ?? null,\n        (cell.content ?? []).map((paragraph) => [\n          paragraph.attrs?.bookmarks ?? null,\n          paragraph.attrs?.hiddenBookmarks ?? null,\n        ]),\n      ]),`,
    replace: `        cell.attrs?.cellRevision ?? null,\n        (cell.content ?? []).map((paragraph: PmNode) => {\n          const fluxBookmarks = (names: string[] | null | undefined) => (names ?? []).filter((name: string) => /^FLUX_[0-9a-f]{32}$/i.test(name) || /^FLUX(?:ROW|TABLE)_/i.test(name))\n          return [fluxBookmarks(paragraph.attrs?.bookmarks as string[] | undefined), fluxBookmarks(paragraph.attrs?.hiddenBookmarks as string[] | undefined)]\n        }),\n      ]),`,
  },
  {
    id: 'flux-sheet-copy-session-import',
    file: 'apps/sheets/src/main/sheets-main.ts',
    find: "import { createHash, randomUUID } from 'node:crypto'",
    replace: "import { createHash, randomUUID } from 'node:crypto'\nimport { isFluxCopySave, commitFluxSave } from 'electron'",
  },
  {
    // Копия оставляет исходную сессию и журнал правок: иначе следующий Ctrl+S ссылается на закрытый сеанс.
    id: 'flux-sheet-copy-keeps-session',
    file: 'apps/sheets/src/main/sheets-main.ts',
    find: '    // The sidecar session still streams the pre-save bytes; swap it for a',
    replace: '    await commitFluxSave()\n    if (isFluxCopySave()) return { canceled: true, fluxCopySaved: true }\n\n    // The sidecar session still streams the pre-save bytes; swap it for a',
  },
  {
    id: 'flux-sheets-disabled-settings',
    file: 'apps/sheets/src/renderer/App.tsx',
    find: '    void window.desktopApi.getAiSettings().then(setAiSettingsState)',
    prior: '    void window.desktopApi.getAiSettings().then(setAiSettingsState).catch(() => {}) // Flux: скрытые внешние сервисы отключены',
    replace: '    if (!(window as any).__fluxNoGenOfficeAI) void window.desktopApi.getAiSettings().then(setAiSettingsState).catch(() => {}) // Flux: GenOffice AI providers disabled',
  },
  { id: 'flux-markdown-insert-data', file: 'apps/markdown/src/renderer/App.tsx', find: "  const editorRef = useRef<Editor | null>(null)\n", replace: "  const editorRef = useRef<Editor | null>(null)\n  // Flux: \u0432\u0441\u0442\u0430\u0432\u043a\u0430 \u0434\u0430\u043d\u043d\u044b\u0445 \u0432 \u0437\u0430\u043c\u0435\u0442\u043a\u0443 \u0442\u043e\u043b\u044c\u043a\u043e \u043f\u043e \u044f\u0432\u043d\u043e\u043c\u0443 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044e \u0432 \u043f\u0430\u043d\u0435\u043b\u0438.\n  useEffect(() => {\n    const receive = (event: MessageEvent) => {\n      if (event.source !== window.parent || !['null', 'file://', window.location.origin].includes(event.origin)) return\n      const m = event.data\n      if (m?.flux !== 'office' || !['fluxInsertText', 'fluxInsertTable'].includes(m.event)) return\n      try {\n        const ed = editorRef.current\n        if (!ed || !ed.isEditable) throw new Error('\u0417\u0430\u043c\u0435\u0442\u043a\u0430 \u0437\u0430\u043a\u0440\u044b\u0442\u0430 \u0434\u043b\u044f \u043f\u0440\u0430\u0432\u043a\u0438')\n        const rows = m.payload?.rows\n        const content = m.event === 'fluxInsertText' ? { type: 'text', text: String(m.payload || '') } : {\n          type: 'table', content: rows.map((row: any[], at: number) => ({ type: 'tableRow', content: row.map(value => ({ type: at === 0 ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph', content: String(value ?? '') ? [{ type: 'text', text: String(value) }] : [] }] })) }))\n        }\n        const ok = ed.chain().focus().insertContent(content).run()\n        window.parent.postMessage({ flux: 'office', op: 'flux:table-inserted', payload: { ok } }, window.location.origin === 'null' || window.location.origin === 'file://' ? '*' : window.location.origin)\n      } catch (err: any) {\n        window.parent.postMessage({ flux: 'office', op: 'flux:table-inserted', payload: { ok: false, error: err.message } }, window.location.origin === 'null' || window.location.origin === 'file://' ? '*' : window.location.origin)\n      }\n    }\n    window.addEventListener('message', receive)\n    return () => window.removeEventListener('message', receive)\n  }, [])\n" },
  {
    // Файл правит другой сотрудник — у остальных только просмотр. Редактор
    // уже умеет «документ защищён»: этот флаг просто становится ещё одной
    // причиной защиты, и лента, колонтитулы и тело закрываются теми же
    // путями, что при защите паролем
    id: 'flux-read-only-state',
    file: 'apps/docs/src/renderer/App.tsx',
    find: "  const [readMode, setReadMode] = useState(false)\n",
    replace: "  const [readMode, setReadMode] = useState(false)\n" +
      "  // Flux Office: файл правит другой — только просмотр (tools/genoffice/patches.mjs)\n" +
      "  const [fluxReadOnly, setFluxReadOnly] = useState(false)\n" +
      "  useEffect(() => (window as any).desktop?.onFluxReadOnly?.((v: boolean) => setFluxReadOnly(v === true)), [])\n",
  },
  {
    id: 'flux-read-only-protect',
    file: 'apps/docs/src/renderer/App.tsx',
    find: "  const isProtected =\n    writeLocked ||\n",
    replace: "  const isProtected =\n    fluxReadOnly ||\n    writeLocked ||\n",
  },
  // ── Одновременная правка (tools/genoffice/inject/docs-collab.ts) ──
  {
    // Модулю совместной правки нужен контекст файла: значения и сеттеры
    // состояния вне тела документа
    id: 'flux-ctx-expose',
    file: 'apps/docs/src/renderer/App.tsx',
    find: "  const fileCtxRef = useRef<FileActionContext>(null as unknown as FileActionContext)\n",
    replace: "  const fileCtxRef = useRef<FileActionContext>(null as unknown as FileActionContext)\n" +
      "  ;(window as any).__fluxCtxRef = fileCtxRef\n",
  },
  {
    id: 'flux-undo-import',
    file: 'apps/docs/src/renderer/editor/extensions.ts',
    find: "import { Gapcursor, UndoRedo } from '@tiptap/extensions'\n",
    replace: "import { Gapcursor, UndoRedo } from '@tiptap/extensions'\n" +
      "import { FluxUndoRedo } from '../flux/docs-collab'\n",
  },
  {
    // Отмена в сеансе — своя у каждого (Yjs), а не общая история документа
    id: 'flux-undo-main',
    file: 'apps/docs/src/renderer/editor/extensions.ts',
    find: "  UndoRedo,\n  SearchHighlightExtension,",
    replace: "  FluxUndoRedo,\n  SearchHighlightExtension,",
  },
  {
    // В сеансе файл после записи не перечитывается: перечитывание заменило
    // бы документ у всех участников и сменило исходник сеанса
    id: 'flux-no-reparse',
    file: 'apps/docs/src/renderer/file-actions.ts',
    find: "    // parse before the identity check: a document opened during this await must not be rewritten\n",
    replace: "    // Flux Office: в сеансе совместной правки файл не перечитывается (tools/genoffice/patches.mjs)\n" +
      "    if ((globalThis as any).__fluxCollab?.active) {\n" +
      "      ctx.setStatus(auto ? t('appAutoSavedAt', { time: new Date().toLocaleTimeString() }) : t('appSaved'))\n" +
      "      return true\n" +
      "    }\n" +
      "    // parse before the identity check: a document opened during this await must not be rewritten\n",
  },
  // Правка соавтора — не своя: не записывается исправлением и не вызывает
  // у каждого участника одну и ту же доправку (иначе абзац после таблицы
  // появился бы столько раз, сколько людей в файле)
  {
    id: 'flux-remote-no-track',
    file: 'apps/docs/src/renderer/editor/revisions.ts',
    find: "            (t) => t.docChanged && !t.getMeta(TRACK_IGNORE) && !t.getMeta('history$'),\n",
    replace: "            (t) => t.docChanged && !t.getMeta(TRACK_IGNORE) && !t.getMeta('history$') && !(t.getMeta('y-sync$') as any)?.isChangeOrigin,\n",
  },
  {
    id: 'flux-remote-table-trailing',
    file: 'apps/docs/src/renderer/editor/extensions.ts',
    find: "          if (!transactions.some((tr) => tr.docChanged)) return null\n          // undo/redo restore what the user had; appending would also wipe the redo stack\n",
    replace: "          if (!transactions.some((tr) => tr.docChanged)) return null\n" +
      "          if (transactions.some((tr) => (tr.getMeta('y-sync$') as any)?.isChangeOrigin)) return null\n" +
      "          // undo/redo restore what the user had; appending would also wipe the redo stack\n",
  },
  {
    id: 'flux-remote-direction',
    file: 'apps/docs/src/renderer/editor/direction.ts',
    find: "          if (!transactions.some((tr) => tr.docChanged)) return null\n          // rewriting the paragraph DOM mid-composition would break the IME\n",
    replace: "          if (!transactions.some((tr) => tr.docChanged)) return null\n" +
      "          if (transactions.some((tr) => (tr.getMeta('y-sync$') as any)?.isChangeOrigin)) return null\n" +
      "          // rewriting the paragraph DOM mid-composition would break the IME\n",
  },
  {
    id: 'flux-remote-caret-marks',
    file: 'apps/docs/src/renderer/editor/caret-marks.ts',
    find: "        appendTransaction: (transactions, oldState, newState) => {\n          const { selection, storedMarks, schema } = newState\n",
    replace: "        appendTransaction: (transactions, oldState, newState) => {\n" +
      "          if (transactions.some((tr) => (tr.getMeta('y-sync$') as any)?.isChangeOrigin)) return null\n" +
      "          const { selection, storedMarks, schema } = newState\n",
  },
  {
    id: 'flux-remote-format-off',
    file: 'apps/docs/src/renderer/editor/marks.ts',
    find: "        appendTransaction: (trs, oldState, state) => {\n          if (!trs.some((tr) => tr.docChanged || tr.storedMarksSet)) return null\n",
    replace: "        appendTransaction: (trs, oldState, state) => {\n" +
      "          if (!trs.some((tr) => tr.docChanged || tr.storedMarksSet)) return null\n" +
      "          if (trs.some((tr) => (tr.getMeta('y-sync$') as any)?.isChangeOrigin)) return null\n",
  },
  // ── Таблица: одновременная правка (tools/genoffice/inject/sheets-collab.ts) ──
  {
    id: 'flux-sheets-collab-import',
    file: 'apps/sheets/src/renderer/App.tsx',
    find: "import { focusWorksheet } from './sheet-focus'\n",
    replace: "import { focusWorksheet } from './sheet-focus'\n" +
      "import './flux/sheets-collab'\n",
  },
  {
    // Модулю совместной правки нужны Univer (мутации) и состояние книги
    // (загружена ли целиком, перестраивается ли после записи)
    id: 'flux-sheets-expose',
    file: 'apps/sheets/src/renderer/App.tsx',
    find: "    univerRef.current = runtime\n    // a throwing construction",
    replace: "    univerRef.current = runtime\n" +
      "    ;(window as any).__fluxSheets = { univerRef, lazyWorkbookRef }\n" +
      "    // a throwing construction",
  },
  // ── Вкладка Flux в ленте Word и Таблицы (inject/flux-ribbon.tsx) ──
  // Раньше здесь была одна кнопка; теперь настоящая вкладка с группами
  // «Переводчик», «Данные», «Шаблоны», «Документ». Каждая кнопка шлёт окну Flux
  // одно сообщение flux:open-panel с полем command.
  {
    id: 'flux-ribbon-docs-import',
    file: 'apps/docs/src/renderer/components/Ribbon.tsx',
    find: "} from './ribbon-tabs'\n",
    replace: "} from './ribbon-tabs'\nimport { FluxRibbonTab } from '../flux/flux-ribbon'\n",
  },
  {
    id: 'flux-ribbon-docs',
    file: 'apps/docs/src/renderer/components/Ribbon.tsx',
    find: '        <span className="ribbon-tabs-spacer" />\n        {trailingActions}',
    prior: FLUX_TAB_BUTTON_OLD_DOCS,
    replace: '        <button type="button" className={`ribbon-tab ${(tab as string) === \'flux\' ? \'active\' : \'\'}`} aria-label="Flux" title="Flux" onClick={() => { collapse.onTabPress((tab as string) === \'flux\'); setTab(\'flux\' as never); setDropdown(null) }}>Flux</button>\n' +
      '        <span className="ribbon-tabs-spacer" />\n        {trailingActions}',
  },
  {
    id: 'flux-ribbon-docs-body',
    file: 'apps/docs/src/renderer/components/Ribbon.tsx',
    find: "        {tab === 'shapeFormat' && inShape ? (",
    replace: "        {(tab as string) === 'flux' ? (\n          <FluxRibbonTab variant=\"docs\" />\n        ) : tab === 'shapeFormat' && inShape ? (",
  },
  {
    id: 'flux-ribbon-sheets-import',
    file: 'apps/sheets/src/renderer/ExcelShell.tsx',
    find: "import { isGridKeyTarget, shouldInterceptClearSelection } from './clear-selection-keyboard'\n",
    replace: "import { isGridKeyTarget, shouldInterceptClearSelection } from './clear-selection-keyboard'\nimport { FluxRibbonTab } from './flux/flux-ribbon'\n",
  },
  {
    id: 'flux-ribbon-sheets',
    file: 'apps/sheets/src/renderer/ExcelShell.tsx',
    find: '          <span className="ribbon-tabs-spacer" />\n          <span className="workbook-status"',
    prior: FLUX_TAB_BUTTON_OLD_SHEETS,
    replace: '          <button type="button" className={`ribbon-tab ${(activeTab as string) === \'Flux\' ? \'active\' : \'\'}`} aria-label="Flux" title="Flux" onClick={() => { collapse.onTabPress((activeTab as string) === \'Flux\'); setActiveTab(\'Flux\' as never) }}>Flux</button>\n' +
      '          <span className="ribbon-tabs-spacer" />\n          <span className="workbook-status"',
  },
  {
    id: 'flux-ribbon-sheets-body',
    file: 'apps/sheets/src/renderer/ExcelShell.tsx',
    find: "  if (activeTab === 'Chart Design') {\n    const canConvert",
    replace: "  if ((activeTab as string) === 'Flux') return <FluxRibbonTab variant=\"sheets\" />\n  if (activeTab === 'Chart Design') {\n    const canConvert",
  },
  {
    id: 'flux-ribbon-pdf',
    file: 'apps/pdf/src/renderer/App.tsx',
    find: '          <span className="ribbon-tabs-spacer" />\n          {readOnly && <span className="tb-readonly">',
    replace: '          <button type="button" className="ribbon-tab" aria-label="Flux" title="Flux" onClick={() => window.parent.postMessage({ flux: \'office\', op: \'flux:open-panel\' }, (window.location.origin === \'null\' || window.location.origin === \'file://\' ? \'*\' : window.location.origin))}>Flux</button>\n' +
      '          <span className="ribbon-tabs-spacer" />\n          {readOnly && <span className="tb-readonly">',
  },
  {
    id: 'flux-ribbon-markdown',
    file: 'apps/markdown/src/renderer/components/Ribbon.tsx',
    find: '        <RibbonExpandButton state={collapse} label={t(\'ribbonExpand\')} />',
    replace: '        <button type="button" className="qa-btn qa-save-as" aria-label="Flux" title="Flux" onMouseDown={(e) => e.preventDefault()} onClick={() => window.parent.postMessage({ flux: \'office\', op: \'flux:open-panel\' }, (window.location.origin === \'null\' || window.location.origin === \'file://\' ? \'*\' : window.location.origin))}>Flux</button>\n' +
      '        <RibbonExpandButton state={collapse} label={t(\'ribbonExpand\')} />',
  },
  {
    id: 'flux-disable-docs-ai-settings-read',
    file: 'apps/docs/src/renderer/App.tsx',
    find: '    void window.desktop.getAiSettings().then(setSettings)',
    replace: '    if (!(window as any).__fluxNoGenOfficeAI) void window.desktop.getAiSettings().then(setSettings)',
  },
  {
    // Flux Office does not expose GenOffice's external-agent editor bridge.
    // FluxAssistant is provided by the Flux shell and remains separate.
    id: 'flux-disable-docs-mcp-ai-bridge',
    file: 'apps/docs/src/renderer/App.tsx',
    find: '    if (tornDown || !editor) return\n    return installMcpBridge({ getCtx: () => fileCtxRef.current })',
    replace: '    if ((window as any).__fluxNoGenOfficeAI || tornDown || !editor) return\n    return installMcpBridge({ getCtx: () => fileCtxRef.current })',
  },
  {
    id: 'flux-disable-sheets-mcp-ai-bridge',
    file: 'apps/sheets/src/renderer/App.tsx',
    find: '  useEffect(() => {\n    const handlers = mcpSheetHandlersRef\n    return installSheetsMcpBridge({',
    replace: '  useEffect(() => {\n    if ((window as any).__fluxNoGenOfficeAI) return\n    const handlers = mcpSheetHandlersRef\n    return installSheetsMcpBridge({',
  },
  {
    // Flux скрывает панель Copilot в electron-renderer.js. Лист должен занять
    // всё окно: без этой колонки он попадает в пустую ячейку шириной 34/360 px.
    id: 'flux-sheets-fill-hidden-copilot-layout',
    file: 'apps/sheets/src/renderer/styles.css',
    find: '.app-shell.copilot-collapsed .sheet-body {\n  grid-template-columns: 34px minmax(0, 1fr);\n}',
    replace: '.app-shell.copilot-collapsed .sheet-body {\n  grid-template-columns: 34px minmax(0, 1fr);\n}\n\n/* Copilot скрыт в оболочке Flux, поэтому лист занимает всё окно. */\n.sheet-body,\n.app-shell.copilot-collapsed .sheet-body {\n  grid-template-columns: minmax(0, 1fr);\n}',
  },
  {
    // Univer при вставке и удалении строк и столбцов сам переписывает имена
    // Excel (UpdateDefinedNameController), и журнал помечает их изменёнными.
    // Во Flux метки полей и есть имена Excel, поэтому сохранение падало при
    // любом удалении столбца и слиянии. Снимок имён применяется последним, уже
    // после сдвигов, и отражает итоговую модель; номера листов меняет только
    // sheetPlan, поэтому ошибка остаётся лишь для него.
    id: 'flux-gateway-defined-names-with-row-col',
    file: 'packages/xlsx-gateway/src/gateway/xlsx-gateway.ts',
    find: '    definedNamesState !== null &&\n    (structuralOps.some((sheet) => sheet.ops.length > 0) || sheetPlan !== undefined)\n  ) {',
    replace: '    definedNamesState !== null &&\n    sheetPlan !== undefined\n  ) {',
  },
  {
    // Когда есть снимок имён, applyDefinedNamesState всё равно выбросит все
    // обычные имена (метки полей), оставив встроенные, скрытые и перечисленные
    // в preserveNames. Сдвигать выбрасываемое бессмысленно, а метка удалённого
    // столбца падала с «A formula references the deleted range». Поэтому тот же
    // фильтр вынесен в общую функцию и применяется до сдвига.
    id: 'flux-gateway-drop-modeled-names-before-shift-fn',
    file: 'packages/xlsx-gateway/src/gateway/xlsx-defined-names.ts',
    find: "  // Drop every modeled entry from the existing section, keeping built-ins,\n  // hidden names, and preserve-listed ones in place.\n  const xml = workbookXml.replace(\n    /<definedName\\b[^>]*>[\\s\\S]*?<\\/definedName>|<definedName\\b[^>]*\\/>/g,\n    (element) => {\n      const name = /\\bname=\"([^\"]*)\"/.exec(element)?.[1] ?? ''\n      const unescaped = unescapeXml(name)\n      const keep =\n        unescaped.startsWith('_xlnm') ||\n        /\\bhidden=\"(?:1|true)\"/.test(element) ||\n        preserved.has(unescaped)\n      return keep ? element : ''\n    },\n  )\n",
    replace: "  // Drop every modeled entry from the existing section, keeping built-ins,\n  // hidden names, and preserve-listed ones in place.\n  const xml = dropModeledDefinedNames(workbookXml, preserved)\n",
  },
  {
    id: 'flux-gateway-drop-modeled-names-before-shift-decl',
    file: 'packages/xlsx-gateway/src/gateway/xlsx-defined-names.ts',
    find: 'export function applyDefinedNamesState(',
    replace: "/** Убрать из workbook.xml имена, которые заменит снимок: все обычные, кроме\n *  встроенных `_xlnm*`, скрытых и сохраняемых (preserve). */\nexport function dropModeledDefinedNames(workbookXml: string, preserved: ReadonlySet<string>): string {\n  return workbookXml.replace(\n    /<definedName\\b[^>]*>[\\s\\S]*?<\\/definedName>|<definedName\\b[^>]*\\/>/g,\n    (element) => {\n      const name = /\\bname=\"([^\"]*)\"/.exec(element)?.[1] ?? ''\n      const unescaped = unescapeXml(name)\n      const keep =\n        unescaped.startsWith('_xlnm') ||\n        /\\bhidden=\"(?:1|true)\"/.test(element) ||\n        preserved.has(unescaped)\n      return keep ? element : ''\n    },\n  )\n}\n\nexport function applyDefinedNamesState(",
  },
  {
    id: 'flux-gateway-drop-modeled-names-before-shift-import',
    file: 'packages/xlsx-gateway/src/gateway/xlsx-gateway.ts',
    find: '  applyDefinedNamesState,\n  DefinedNameError,',
    replace: '  applyDefinedNamesState,\n  dropModeledDefinedNames,\n  DefinedNameError,',
  },
  {
    id: 'flux-gateway-drop-modeled-names-before-shift-call',
    file: 'packages/xlsx-gateway/src/gateway/xlsx-gateway.ts',
    find: '    const shiftedWorkbook = shiftDefinedNames(workbookXml, sheetName, ops)\n',
    replace: '    // Имена, которые потом заменит снимок, не сдвигаем: метка удалённого\n    // столбца иначе роняет сдвиг (StructuralShiftError).\n    if (definedNamesState !== null) {\n      const kept = dropModeledDefinedNames(workbookXml, new Set(definedNamesState.preserveNames))\n      if (kept !== workbookXml) {\n        workbookXml = kept\n        pkg.write(workbookPath, workbookXml)\n        touchedEntries.add(workbookPath)\n      }\n    }\n    const shiftedWorkbook = shiftDefinedNames(workbookXml, sheetName, ops)\n',
  },
  {
    // Шлюз теперь принимает снимок имён вместе со сдвигом строк и столбцов
    // (он отбрасывает обычные имена до сдвига), поэтому откладывать имена на
    // вторую фазу нужно только при операциях над листами, где шлюз по-прежнему
    // отказывает. Иначе первая фаза сдвигала метки удалённого столбца и падала.
    id: 'flux-save-defined-names-with-row-col',
    file: 'apps/sheets/src/renderer/save-actions.ts',
    find: '  const heldNames = hasShifts ? definedNamesState : null\n',
    replace: '  const heldNames = sheetOps.length > 0 ? definedNamesState : null\n',
  },
  {
    id: 'flux-save-defined-names-first-phase',
    file: 'apps/sheets/src/renderer/save-actions.ts',
    find: '      definedNamesState: splitSave ? null : definedNamesState,\n',
    replace: '      definedNamesState: heldNames !== null ? null : definedNamesState,\n',
  },
];

/** Внести правки; вернуть, что сделано. Не нашлось места — ошибка */
export function applyPatches(src) {
  const done = [];
  for (const p of PATCHES) {
    const path = join(src, p.file);
    let text = readFileSync(path, 'utf8');
    if (text.includes(p.replace)) { done.push(`${p.id}: уже есть`); continue; }
    // Upgrade the earlier Flux-only safe fallback if the cached source was
    // already patched by a previous build of this integration.
    const target = p.prior && text.includes(p.prior) ? p.prior : p.find;
    const at = text.indexOf(target);
    if (at < 0) throw new Error(`правка «${p.id}»: в ${p.file} не нашлось места — сменился исходник GenOffice?`);
    if (text.indexOf(target, at + 1) >= 0) throw new Error(`правка «${p.id}»: место в ${p.file} не единственное`);
    writeFileSync(path, text.slice(0, at) + p.replace + text.slice(at + target.length));
    done.push(`${p.id}: внесена`);
  }
  return done;
}
