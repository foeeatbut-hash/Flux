import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function replaceOnce(source, before, after, id) {
  if (source.includes(after)) return source
  const first = source.indexOf(before)
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`renderer save patch ${id}: expected one source anchor`)
  }
  return source.slice(0, first) + after + source.slice(first + before.length)
}

function replaceAll(source, before, after, expected, id) {
  if (source.includes(after)) return source
  const count = source.split(before).length - 1
  if (count !== expected) {
    throw new Error(`renderer save patch ${id}: expected ${expected} anchors, found ${count}`)
  }
  return source.split(before).join(after)
}

export function patchSheetsApp(source) {
  let result = source
  result = replaceOnce(
    result,
    "import { handleSave as handleSaveImpl, type SaveContext, type SaveOutcome } from './save-actions'\n",
    "import { handleSave as handleSaveImpl, type SaveContext, type SaveOutcome } from './save-actions'\n" +
    "import { initializeSheetsSaveCheckpoint, markSheetsJournalChanged, pendingSheetsJournalSize, serializeSheetsSave, subscribeSheetsJournalChanges } from './flux/sheets-save-checkpoint'\n",
    'app-helper-import',
  )
  result = replaceOnce(
    result,
    '  const [pendingEdits, setPendingEdits] = useState(0)\n',
    '  const [pendingEdits, setPendingEditsRaw] = useState(0)\n' +
      '  const setPendingEdits = useCallback((count: number) => {\n' +
      '    const journal = lazyWorkbookRef.current?.editJournal\n' +
      '    if (!journal) { window.desktopApi?.notifyPendingEdits?.(count); setPendingEditsRaw(count); return }\n' +
      '    markSheetsJournalChanged(journal)\n' +
      '    const pending = pendingSheetsJournalSize(journal, count)\n' +
      '    window.desktopApi?.notifyPendingEdits?.(pending)\n' +
      '    setPendingEditsRaw(pending)\n' +
      '  }, [])\n',
    'app-pending-setter',
  )
  result = replaceOnce(
    result,
    '    }\n    // Column outline levels arrive with the sheet metadata; seed them now.\n',
    '    }\n' +
      '    initializeSheetsSaveCheckpoint(state.editJournal)\n' +
      '    // Column outline levels arrive with the sheet metadata; seed them now.\n',
    'app-checkpoint-init',
  )
  result = replaceAll(result, '    setPendingEdits(0)\n', '    setPendingEditsRaw(0)\n', 1, 'app-raw-reset')

  result = replaceOnce(
    result,
    '      if (saving || !state || journalSize(state.editJournal) === 0) return\n',
    '      if (saving || !state || pendingSheetsJournalSize(state.editJournal, journalSize(state.editJournal)) === 0) return\n',
    'app-autosave-gate',
  )
  result = replaceOnce(
    result,
    '      if (writing || !state || journalSize(state.editJournal) === 0) return\n',
    '      if (writing || !state || pendingSheetsJournalSize(state.editJournal, journalSize(state.editJournal)) === 0) return\n',
    'app-recovery-gate',
  )
  result = replaceOnce(
    result,
    '    if (!state || journalSize(state.editJournal) === 0) return\n    // AutoSave off = the user decides when the file is written:',
    '    if (!state || pendingSheetsJournalSize(state.editJournal, journalSize(state.editJournal)) === 0) return\n    // AutoSave off = the user decides when the file is written:',
    'app-ai-save-gate',
  )
  result = replaceOnce(
    result,
    '    if (after && journalSize(after.editJournal) === 0) {\n      // Saving reopens the sidecar session and resets Univer\'s undo stack.\n',
    '    if (after && pendingSheetsJournalSize(after.editJournal, journalSize(after.editJournal)) === 0) {\n      // The save acknowledged the AI run\'s captured journal revision.\n',
    'app-ai-save-ack-check',
  )
  result = replaceOnce(
    result,
    '  async function handleSave(\n    mode: \'save\' | \'save-as\' | \'recovery\',\n    quiet = false,\n    explicitTarget?: { path: string; overwrite: boolean },\n  ): Promise<SaveOutcome> {\n    return handleSaveImpl(saveContext(), mode, quiet, explicitTarget)\n  }\n',
    '  async function handleSave(\n    mode: \'save\' | \'save-as\' | \'recovery\',\n    quiet = false,\n    explicitTarget?: { path: string; overwrite: boolean },\n  ): Promise<SaveOutcome> {\n' +
      '    const expectedState = lazyWorkbookRef.current\n' +
      '    const journal = expectedState?.editJournal\n' +
      '    const run = async (): Promise<SaveOutcome> => {\n' +
      '      if (lazyWorkbookRef.current !== expectedState) return { ok: false }\n' +
      '      const outcome = await handleSaveImpl(saveContext(), mode, quiet, explicitTarget)\n' +
      '      const current = lazyWorkbookRef.current\n' +
      '      const pending = current ? pendingSheetsJournalSize(current.editJournal, journalSize(current.editJournal)) : 0\n' +
      '      window.desktopApi?.notifyPendingEdits?.(pending)\n' +
      '      setPendingEditsRaw(pending)\n' +
      '      return outcome\n' +
      '    }\n' +
      '    return journal ? serializeSheetsSave(journal, run) : run()\n' +
      '  }\n',
    'app-serialized-handle-save',
  )
  result = replaceOnce(
    result,
    '    if (!state || journalSize(state.editJournal) === 0) {\n      window.desktopApi?.reportCloseSaveResult?.(true)\n',
    '    if (!state || pendingSheetsJournalSize(state.editJournal, journalSize(state.editJournal)) === 0) {\n      window.desktopApi?.reportCloseSaveResult?.(true)\n',
    'app-close-save-precheck',
  )
  result = replaceOnce(
    result,
    '      after === null || journalSize(after.editJournal) === 0,\n',
    '      after === null || pendingSheetsJournalSize(after.editJournal, journalSize(after.editJournal)) === 0,\n',
    'app-close-save-postcheck',
  )
  result = replaceOnce(
    result,
    '    // handleSave swallows errors into the status bar; a drained journal\n    // (fresh state after openLazyWorkbook) is the success signal.\n',
    '    // handleSave swallows errors into the status bar; the acknowledged\n    // checkpoint is the success signal while the cumulative journal stays live.\n',
    'app-close-save-checkpoint-comment',
  )
  result = replaceOnce(
    result,
    '      const candidate = after.file.sheets\n        .map((sheet) => sheet.name.trim())\n',
    '      const liveSheets = univerRef.current?.univerAPI.getActiveWorkbook()?.getSheets()\n' +
      '      const candidate = (liveSheets?.map((sheet) => String(sheet.getSheetName()).trim()) ?? after.file.sheets.map((sheet) => sheet.name.trim()))\n',
    'app-ai-rename-live-sheet-names',
  )

  result = replaceOnce(
    result,
    '  }, [pendingEdits])\n',
    '  }, [pendingEdits])\n' +
      '  useEffect(() => {\n' +
      '    const state = lazyWorkbookRef.current\n' +
      '    if (!state) return\n' +
      '    return subscribeSheetsJournalChanges(state.editJournal, () => {\n' +
      '      if (lazyWorkbookRef.current !== state) return\n' +
      '      const pending = pendingSheetsJournalSize(state.editJournal, journalSize(state.editJournal))\n' +
      '      window.desktopApi?.notifyPendingEdits?.(pending)\n' +
      '      setPendingEditsRaw(pending)\n' +
      '    })\n' +
      '  }, [workbookFile])\n',
    'app-journal-change-subscription',
  )
  result = replaceOnce(
    result,
    '        const rowColumn = ROW_COLUMN_MUTATIONS[event.id]\n',
    '        // Visual undo/redo belongs to this runtime but has no unitId.\n' +
      '        if (event.id === \'sheets.mutation.visual-edit-step\') {\n' +
      '          const visualState = lazyWorkbookRef.current\n' +
      '          if (visualState) setPendingEdits(journalSize(visualState.editJournal))\n' +
      '          return\n' +
      '        }\n' +
      '        const rowColumn = ROW_COLUMN_MUTATIONS[event.id]\n',
    'app-visual-history-before-unit-filter',
  )
  return result
}

export function patchSheetsSaveActions(source) {
  let result = source
  result = replaceOnce(
    result,
    "import type { LazyWorkbookState, UniverRuntime } from './univer-state'\n",
    "import type { LazyWorkbookState, UniverRuntime } from './univer-state'\n" +
      "import { acknowledgeSheetsSaveCheckpoint, captureSheetsSaveCheckpoint, isSheetsJournalTracked, pendingSheetsJournalSize } from './flux/sheets-save-checkpoint'\n",
    'save-helper-import',
  )
  result = replaceOnce(
    result,
    '  const state = ctx.lazyWorkbookRef.current\n  // Captured at save start (the Ctrl+S moment): the post-save session swap\n',
    '  const state = ctx.lazyWorkbookRef.current\n' +
      '  const saveCheckpoint = state ? captureSheetsSaveCheckpoint(state.editJournal) : undefined\n' +
      '  const checkpointTracked = state ? isSheetsJournalTracked(state.editJournal) : false\n' +
      '  const checkpointDirty = state !== null && checkpointTracked &&\n' +
      '    pendingSheetsJournalSize(state.editJournal, 0) > 0\n' +
      '  // Captured at save start (the Ctrl+S moment): the post-save session swap\n',
    'save-checkpoint-capture',
  )
  result = replaceOnce(
    result,
    '  if (total === 0 && mode !== \'save-as\' && !restoreWriteBack) {\n',
    '  if (checkpointTracked && !checkpointDirty && mode !== \'save-as\' && !restoreWriteBack) {\n' +
      '    return { ok: true, ...(state.file.path !== undefined ? { path: state.file.path } : {}) }\n' +
      '  }\n' +
      '  if (total === 0 && !checkpointDirty && mode !== \'save-as\' && !restoreWriteBack) {\n',
    'save-checkpoint-clean-short-circuit',
  )
  result = replaceOnce(
    result,
    '  const payload = {\n    sessionId: state.file.sessionId,\n',
    '  const retainSession =\n' +
      "    mode === 'save' && checkpointTracked && !explicitTarget &&\n" +
      '    state.file.csvPath === undefined && state.file.needsSaveAs !== true &&\n' +
      '    state.file.restoredFromRecovery !== true && state.file.readOnly !== true\n' +
      '  const payload = {\n    sessionId: state.file.sessionId,\n' +
      '    ...(retainSession ? { retainSession: true, ...(splitSave ? { saveContinuation: true } : {}) } : {}),\n',
    'save-retain-session-payload',
  )
  result = replaceOnce(
    result,
    '    const result = await window.desktopApi.saveWorkbookEdits({\n      sessionId: state.file.sessionId,\n      mode,\n',
    '    const result = await window.desktopApi.saveWorkbookEdits({\n' +
      '      sessionId: state.file.sessionId,\n' +
      '      ...(retainSession ? { retainSession: true, ...(splitSave ? { saveContinuation: true } : {}) } : {}),\n' +
      '      mode,\n',
    'save-retain-session-request',
  )
  result = replaceOnce(
    result,
    '    })\n    if (ctx.lazyWorkbookRef.current !== state) return { ok: false }\n    if (result.canceled) {\n',
    '    })\n' +
      '    if (ctx.lazyWorkbookRef.current !== state) {\n' +
      '      if (splitSave && retainSession && !result.canceled && (result as typeof result & { sessionRetained?: boolean }).sessionRetained === true) {\n' +
      '        await window.desktopApi.closeWorkbook(result.file.sessionId).catch(() => undefined)\n' +
      '      }\n' +
      '      return { ok: false }\n' +
      '    }\n' +
      '    if (result.canceled) {\n',
    'save-retained-split-stale-check',
  )
  result = replaceOnce(
    result,
    '    if (!splitSave) {\n      // Cross-save undo: carry the Univer undo stack over the session swap.\n',
    '    if (!splitSave && retainSession && (result as typeof result & { sessionRetained?: boolean }).sessionRetained === true) {\n' +
      '      if (ctx.lazyWorkbookRef.current !== state) return { ok: false }\n' +
      '      if (saveCheckpoint !== undefined) acknowledgeSheetsSaveCheckpoint(state.editJournal, saveCheckpoint)\n' +
      '      const saved = t(\'appSaved\')\n' +
      '      ctx.setMessage(saved)\n' +
      '      if (!quiet) showToast(saved)\n' +
      '      return { ok: true, ...(result.file.path !== undefined ? { path: result.file.path } : {}) }\n' +
      '    }\n' +
      '    if (!splitSave) {\n      // Cross-save undo: carry the Univer undo stack over the session swap.\n',
    'save-retain-session-success',
  )
  result = replaceOnce(
    result,
    '    // Two-phase saves reopen twice with structural entanglement; v1 does not\n    // carry undo history across them (and clears any stale stash).\n    stashUndoCarry(null)\n',
    '    // A retained first phase is a continuation over a temporary sidecar session;\n' +
      '    // keep the original baseline session and Univer undo stack alive.\n' +
      '    const retainedContinuation = retainSession &&\n' +
      '      (result as typeof result & { sessionRetained?: boolean }).sessionRetained === true\n' +
      '    if (!retainedContinuation) stashUndoCarry(null)\n',
    'save-split-retained-continuation',
  )
  result = replaceOnce(
    result,
    '        sessionId: result.file.sessionId,\n        mode: \'save\',\n',
    '        sessionId: result.file.sessionId,\n' +
      '        ...(retainedContinuation ? { retainSession: true, retainedSessionId: state.file.sessionId } : {}),\n' +
      '        mode: \'save\',\n',
    'save-split-continuation-request',
  )
  result = replaceOnce(
    result,
    '      if (second.canceled) {\n        ctx.stashViewRestore(viewAtSave)\n        ctx.openLazyWorkbook(result.file, { continueChat: true })\n',
    '      if (second.canceled) {\n' +
      '        if (retainedContinuation) {\n' +
      '          await window.desktopApi.closeWorkbook(result.file.sessionId).catch(() => undefined)\n' +
      '          ctx.setMessage(t(\'appSaveSecondCanceled\'))\n' +
      '          return { ok: false }\n' +
      '        }\n' +
      '        ctx.stashViewRestore(viewAtSave)\n        ctx.openLazyWorkbook(result.file, { continueChat: true })\n',
    'save-split-continuation-cancel',
  )
  result = replaceOnce(
    result,
    '      ctx.stashViewRestore(viewAtSave)\n      ctx.openLazyWorkbook(second.file, { continueChat: true })\n',
    '      if (retainedContinuation && (second as typeof second & { sessionRetained?: boolean }).sessionRetained === true) {\n' +
      '        if (saveCheckpoint !== undefined) acknowledgeSheetsSaveCheckpoint(state.editJournal, saveCheckpoint)\n' +
      '        const saved = t(\'appSavedTwoPhase\')\n' +
      '        ctx.setMessage(saved)\n' +
      '        if (!quiet) showToast(saved)\n' +
      '        return { ok: true, ...(second.file.path !== undefined ? { path: second.file.path } : {}) }\n' +
      '      }\n' +
      '      ctx.stashViewRestore(viewAtSave)\n      ctx.openLazyWorkbook(second.file, { continueChat: true })\n',
    'save-split-continuation-success',
  )
  result = replaceOnce(
    result,
    '    } catch (error: unknown) {\n      if (ctx.lazyWorkbookRef.current !== state) return { ok: false }\n      ctx.stashViewRestore(viewAtSave)\n      ctx.openLazyWorkbook(result.file, { continueChat: true })\n',
    '    } catch (error: unknown) {\n' +
      '      if (retainedContinuation) await window.desktopApi.closeWorkbook(result.file.sessionId).catch(() => undefined)\n' +
      '      if (ctx.lazyWorkbookRef.current !== state) return { ok: false }\n' +
      '      if (retainedContinuation) {\n' +
      '        const failed = t(\'appSaveSecondFailed\', { reason: error instanceof Error ? error.message : String(error) })\n' +
      '        ctx.setMessage(failed)\n' +
      '        if (!quiet) showToast(failed, \'error\')\n' +
      '        return { ok: false }\n' +
      '      }\n' +
      '      ctx.stashViewRestore(viewAtSave)\n      ctx.openLazyWorkbook(result.file, { continueChat: true })\n',
    'save-split-continuation-error',
  )
  return result
}

/** Apply renderer-only edits after every source transform has validated. */
export function applyRendererSavePatches(genofficeRoot) {
  const appPath = join(genofficeRoot, 'apps/sheets/src/renderer/App.tsx')
  const actionsPath = join(genofficeRoot, 'apps/sheets/src/renderer/save-actions.ts')
  const app = patchSheetsApp(readFileSync(appPath, 'utf8'))
  const actions = patchSheetsSaveActions(readFileSync(actionsPath, 'utf8'))
  writeFileSync(appPath, app)
  writeFileSync(actionsPath, actions)
  return ['App.tsx: save checkpoint and serialization', 'save-actions.ts: cumulative in-place save']
}
