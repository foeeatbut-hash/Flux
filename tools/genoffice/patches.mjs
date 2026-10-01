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

export const PATCHES = [
  {
    id: 'flux-sheets-disabled-settings',
    file: 'apps/sheets/src/renderer/App.tsx',
    find: '    void window.desktopApi.getAiSettings().then(setAiSettingsState)',
    replace: '    void window.desktopApi.getAiSettings().then(setAiSettingsState).catch(() => {}) // Flux: скрытые внешние сервисы отключены',
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
  // ── Кнопка Flux открывает панель оболочки из любой ленты редактора ──
  {
    id: 'flux-ribbon-docs',
    file: 'apps/docs/src/renderer/components/Ribbon.tsx',
    find: '        <span className="ribbon-tabs-spacer" />\n        {trailingActions}',
    replace: '        <button type="button" className="ribbon-tab" aria-label="Flux" title="Flux" onClick={() => window.parent.postMessage({ flux: \'office\', op: \'flux:open-panel\' }, (window.location.origin === \'null\' || window.location.origin === \'file://\' ? \'*\' : window.location.origin))}>Flux</button>\n' +
      '        <span className="ribbon-tabs-spacer" />\n        {trailingActions}',
  },
  {
    id: 'flux-ribbon-sheets',
    file: 'apps/sheets/src/renderer/ExcelShell.tsx',
    find: '          <span className="ribbon-tabs-spacer" />\n          <span className="workbook-status"',
    replace: '          <button type="button" className="ribbon-tab" aria-label="Flux" title="Flux" onClick={() => window.parent.postMessage({ flux: \'office\', op: \'flux:open-panel\' }, (window.location.origin === \'null\' || window.location.origin === \'file://\' ? \'*\' : window.location.origin))}>Flux</button>\n' +
      '          <span className="ribbon-tabs-spacer" />\n          <span className="workbook-status"',
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
];

/** Внести правки; вернуть, что сделано. Не нашлось места — ошибка */
export function applyPatches(src) {
  const done = [];
  for (const p of PATCHES) {
    const path = join(src, p.file);
    const text = readFileSync(path, 'utf8');
    if (text.includes(p.replace)) { done.push(`${p.id}: уже есть`); continue; }
    const at = text.indexOf(p.find);
    if (at < 0) throw new Error(`правка «${p.id}»: в ${p.file} не нашлось места — сменился исходник GenOffice?`);
    if (text.indexOf(p.find, at + 1) >= 0) throw new Error(`правка «${p.id}»: место в ${p.file} не единственное`);
    writeFileSync(path, text.slice(0, at) + p.replace + text.slice(at + p.find.length));
    done.push(`${p.id}: внесена`);
  }
  return done;
}
