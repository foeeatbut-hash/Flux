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
