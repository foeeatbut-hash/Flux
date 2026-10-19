import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import * as checkpointExports from '../tools/genoffice/inject/sheets-save-checkpoint.ts'

// tsx loads .ts as CommonJS in this repository; native ESM has no default wrapper.
const checkpointApi = checkpointExports.default ?? checkpointExports
assert.equal(typeof checkpointApi.acknowledgeSheetsSaveCheckpoint, 'function', 'checkpoint exports are available through the active module loader')
const {
  acknowledgeSheetsSaveCheckpoint,
  captureSheetsSaveCheckpoint,
  initializeSheetsSaveCheckpoint,
  isSheetsJournalTracked,
  markSheetsJournalChanged,
  pendingSheetsJournalSize,
  serializeSheetsSave,
} = checkpointApi
import { patchSheetsApp, patchSheetsSaveActions } from '../tools/genoffice/sheets-save-renderer-patch.mjs'

const configuredRoot = process.env.GENOFFICE_SRC || resolve('.cache/genoffice')
const genofficeRoot = existsSync(resolve(configuredRoot, 'apps/sheets/src/renderer/save-actions.ts'))
  ? configuredRoot
  : resolve(configuredRoot, 'repo')
const upstream = resolve(genofficeRoot, 'apps/sheets/src/renderer/save-actions.ts')
const source = patchSheetsSaveActions(readFileSync(upstream, 'utf8'))
const ast = ts.createSourceFile('save-actions.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
let declaration
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleSave') declaration = node
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(declaration, 'patcher output exports the real handleSave implementation')
const declarationText = declaration.getText(ast).replace(/^export\s+/, '')
const js = ts.transpile(declarationText, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })
const makeSave = new Function('deps', `with (deps) { ${js}\n return handleSave }`)

function makeState({ edits = [{ row: 0, column: 0, value: 'one' }], structuralOps = [], tableAdds = [], definedNamesDirty = false } = {}) {
  const editJournal = {
    cells: new Map(),
    edits,
    bulkConstantFills: [],
    structuralOps,
    chartEdits: [],
    visualEdits: [],
    visualAdds: [],
    tableAdds,
    pivotAdds: [],
    sparklineAdds: [],
    sheets: { added: new Map(), removed: new Set(), renamed: new Map(), hidden: new Map(), orderDirty: false },
    filterDirty: new Set(),
    cfDirty: new Set(),
    dvDirty: new Set(),
    sheetProtection: new Map(),
    workbookProtection: { desired: null },
    protectedRangesDirty: new Set(),
    theme: {},
    definedNames: { dirty: definedNamesDirty },
    hyperlinks: [],
    pageSetup: [],
    noteDirty: new Set(),
    pivotCacheRefresh: new Set(),
    pivotRefreshUpdates: new Map(),
  }
  const state = {
    file: { sessionId: 'session-original', path: '/files/book.xlsx', sha256: 'original-sha', readOnly: false, needsSaveAs: false },
    editJournal,
    flags: { preloadComplete: true },
    sheetProtectedRanges: new Map(),
    recalc: { overlay: new Map() },
  }
  initializeSheetsSaveCheckpoint(editJournal)
  if (edits.length || structuralOps.length || tableAdds.length || definedNamesDirty) markSheetsJournalChanged(editJournal)
  return state
}

function harness({ state = makeState(), responses = [], onSave, failSecond = false, stage = async (_api, _id, edits) => ({ edits, editsTransferId: undefined }) } = {}) {
  const calls = { requests: [], opened: [], undo: [], view: [], closed: [], messages: [], toasts: [] }
  let responseIndex = 0
  const desktopApi = {
    saveWorkbookEdits: async (request) => {
      calls.requests.push(request)
      const index = responseIndex++
      await onSave?.(request, index, state)
      if (failSecond && index === 1) throw new Error('phase two failed')
      const response = responses[index] ?? { canceled: false, sessionRetained: true, file: { ...state.file } }
      return response
    },
    closeWorkbook: async (id) => { calls.closed.push(id) },
  }
  const deps = {
    window: { desktopApi },
    isSheetRemoved: () => false,
    toSaveChartEdits: (j) => j.chartEdits,
    toSaveBulkConstantFills: (j) => j.bulkConstantFills,
    toSaveEdits: (j) => j.edits.map((edit) => ({ ...edit })),
    toSaveHyperlinkEdits: (j) => j.hyperlinks,
    toSavePageSetupStates: (j) => j.pageSetup,
    toSavePivotAdds: (j) => j.pivotAdds,
    toSaveSheetOps: () => [],
    toSaveSparklineAdds: (j) => j.sparklineAdds,
    toSaveStructuralOps: (j) => j.structuralOps,
    toSaveTableAdds: (j) => j.tableAdds,
    toSaveVisualAdds: (j) => j.visualAdds,
    toSaveVisualEdits: (j) => j.visualEdits,
    activeCsvSheet: () => null,
    handleExportCsv: async () => {},
    serializeActiveSheetCsv: () => null,
    verifiedFormulaValues: () => [],
    t: (key) => key,
    abortStagedEditsTransfer: async () => {},
    stageEditsForSave: stage,
    showToast: (...args) => calls.toasts.push(args),
    captureUndoCarry: () => 'undo-stash',
    hasPendingUndoCarry: () => false,
    stashUndoCarry: (value) => calls.undo.push(value),
    collectCfStates: () => [],
    getScrollAnchor: () => null,
    collectDefinedNamesState: (_runtime, s) => s.editJournal.definedNames.dirty ? { dirty: true } : null,
    collectDvStates: () => [],
    collectFilterStates: () => [],
    collectNoteStates: () => [],
    acknowledgeSheetsSaveCheckpoint,
    captureSheetsSaveCheckpoint,
    isSheetsJournalTracked,
    pendingSheetsJournalSize,
    ctx: undefined,
    stripIpcErrorWrapper: (message) => message,
    localizeSaveError: () => null,
  }
  const ctx = {
    univerRef: { current: null },
    lazyWorkbookRef: { current: state },
    setMessage: (message) => calls.messages.push(message),
    openLazyWorkbook: (file) => calls.opened.push(file),
    stashViewRestore: (view) => calls.view.push(view),
  }
  calls.invoke = (mode = 'save', quiet = true) => makeSave(deps)(ctx, mode, quiet)
  return { calls, state, desktopApi, deps, ctx }
}

function retained(file = { sessionId: 'session-original', path: '/files/book.xlsx', sha256: 'saved-sha' }) {
  return { canceled: false, sessionRetained: true, file }
}

// Normal Save keeps the live renderer state and acknowledges only the revision
// captured before IPC; a same-count edit made during IPC remains pending.
{
  let finish
  const gate = new Promise((resolve) => { finish = resolve })
  const h = harness({ responses: [retained()], onSave: async (_request, _index, state) => {
    markSheetsJournalChanged(state.editJournal)
    state.editJournal.edits[0].value = 'two'
    await gate
  } })
  const pending = h.calls.invoke()
  await Promise.resolve()
  finish()
  assert.deepEqual(await pending, { ok: true, path: '/files/book.xlsx' })
  assert.equal(h.calls.opened.length, 0)
  assert.equal(h.calls.undo.length, 0)
  assert.equal(h.calls.view.length, 0)
  assert.equal(pendingSheetsJournalSize(h.state.editJournal, 1), 1)
}

// Undo-to-empty is still dirty by revision, so the real save action writes it.
{
  const h = harness({ state: makeState({ edits: [] }) })
  markSheetsJournalChanged(h.state.editJournal)
  const result = await h.calls.invoke()
  assert.equal(result.ok, true)
  assert.equal(h.calls.requests.length, 1)
  assert.equal(h.calls.requests[0].edits.length, 0)
}

// Cancellation and first-phase writer errors never acknowledge the revision.
{
  const canceled = harness({ responses: [{ canceled: true }] })
  assert.equal((await canceled.calls.invoke()).ok, false)
  assert.equal(pendingSheetsJournalSize(canceled.state.editJournal, 1), 1)
  const failed = harness({ stage: async () => { throw new Error('stage failure') } })
  assert.equal((await failed.calls.invoke()).ok, false)
  assert.equal(pendingSheetsJournalSize(failed.state.editJournal, 1), 1)
  const writerFailure = harness({ onSave: async () => { throw new Error('writer failure') } })
  assert.equal((await writerFailure.calls.invoke()).ok, false)
  assert.equal(pendingSheetsJournalSize(writerFailure.state.editJournal, 1), 1)
}

// A later Save sends the cumulative journal against the original session.
{
  const h = harness({ responses: [retained(), retained()] })
  await h.calls.invoke()
  h.state.editJournal.edits[0].value = 'two'
  markSheetsJournalChanged(h.state.editJournal)
  await h.calls.invoke()
  assert.equal(h.calls.requests.length, 2)
  assert.deepEqual(h.calls.requests.map((request) => request.sessionId), ['session-original', 'session-original'])
  assert.deepEqual(h.calls.requests.map((request) => request.edits[0].value), ['one', 'two'])
  assert.equal(pendingSheetsJournalSize(h.state.editJournal, 1), 0)
}

// Retained split saves keep the original session without view/undo handoff;
// a phase-two failure closes the temporary reader and leaves the revision dirty.
{
  const tempFile = { sessionId: 'continuation-temp', path: '/files/book.xlsx', sha256: 'phase-one' }
  const h = harness({
    state: makeState({ structuralOps: [{ kind: 'insert-rows', index: 0, count: 1 }], tableAdds: [{ id: 'table1' }] }),
    responses: [retained(tempFile)],
    failSecond: true,
  })
  const result = await h.calls.invoke()
  assert.equal(result.ok, false)
  assert.deepEqual(h.calls.closed, ['continuation-temp'])
  assert.equal(h.calls.opened.length, 0)
  assert.equal(h.calls.undo.length, 0)
  assert.equal(h.calls.view.length, 0)
  assert.equal(h.calls.requests[1].sessionId, 'continuation-temp')
  assert.equal(h.calls.requests[1].retainedSessionId, 'session-original')
  assert.equal(pendingSheetsJournalSize(h.state.editJournal, 1), 1)
}

// A successful retained split phase two returns to the retained session in
// place, with no view restore and a clean captured revision.
{
  const tempFile = { sessionId: 'continuation-temp', path: '/files/book.xlsx', sha256: 'phase-one' }
  const h = harness({
    state: makeState({ structuralOps: [{ kind: 'insert-rows', index: 0, count: 1 }], tableAdds: [{ id: 'table1' }] }),
    responses: [retained(tempFile), retained()],
  })
  assert.equal((await h.calls.invoke()).ok, true)
  assert.equal(h.calls.requests.length, 2)
  assert.equal(h.calls.opened.length, 0)
  assert.equal(h.calls.undo.length, 0)
  assert.equal(h.calls.view.length, 0)
  assert.deepEqual(h.calls.closed, [])
  assert.equal(pendingSheetsJournalSize(h.state.editJournal, 1), 0)
}

// Save As follows the legacy session replacement path even for a tracked journal.
{
  const replacement = { sessionId: 'save-as-session', path: '/files/copy.xlsx', sha256: 'copy-sha' }
  const h = harness({ responses: [{ canceled: false, file: replacement }] })
  const result = await h.calls.invoke('save-as')
  assert.equal(result.ok, true)
  assert.deepEqual(h.calls.opened, [replacement])
  assert.equal(h.calls.undo.length, 1)
  assert.equal(h.calls.view.length, 1)
}

// If a split Save completes after its source renderer changes, close the
// retained temporary reader instead of leaking it behind the stale-state guard.
{
  const tempFile = { sessionId: 'stale-continuation-temp', path: '/files/book.xlsx', sha256: 'phase-one' }
  let firstPhase
  firstPhase = harness({ state: makeState({ structuralOps: [{ kind: 'insert-rows', index: 0, count: 1 }], tableAdds: [{ id: 'table1' }] }), responses: [retained(tempFile)], onSave: async (_request, index) => {
    if (index === 0) firstPhase.ctx.lazyWorkbookRef.current = null
  } })
  assert.equal((await firstPhase.calls.invoke()).ok, false)
  assert.deepEqual(firstPhase.calls.closed, ['stale-continuation-temp'])
  assert.equal(firstPhase.calls.requests.length, 1)

  let secondPhase
  secondPhase = harness({ state: makeState({ structuralOps: [{ kind: 'insert-rows', index: 0, count: 1 }], tableAdds: [{ id: 'table1' }] }), responses: [retained(tempFile)], failSecond: true, onSave: async (_request, index) => {
    if (index === 1) secondPhase.ctx.lazyWorkbookRef.current = null
  } })
  assert.equal((await secondPhase.calls.invoke()).ok, false)
  assert.deepEqual(secondPhase.calls.closed, ['stale-continuation-temp'])
  assert.equal(secondPhase.calls.opened.length, 0)
}

// The patched App setter and save wrapper notify the close guard even when its
// numeric pending count stays at one across same-target edits.
{
  const appPath = resolve(genofficeRoot, 'apps/sheets/src/renderer/App.tsx')
  const patchedApp = patchSheetsApp(readFileSync(appPath, 'utf8'))
  const appAst = ts.createSourceFile('App.tsx', patchedApp, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let setterArrow
  let saveDeclaration
  function findAppHooks(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(appAst) === 'setPendingEdits' && node.initializer && ts.isCallExpression(node.initializer)) {
      const first = node.initializer.arguments[0]
      if (first && ts.isArrowFunction(first)) setterArrow = first
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleSave') saveDeclaration = node
    ts.forEachChild(node, findAppHooks)
  }
  findAppHooks(appAst)
  assert.ok(setterArrow, 'patched App contains the actual pending-edit callback')
  assert.ok(saveDeclaration, 'patched App contains the actual serialized save wrapper')
  const setterJs = ts.transpile(`const setter = ${setterArrow.getText(appAst)}; return setter`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })
  const setterFactory = new Function('deps', `with (deps) { ${setterJs} }`)
  const saveText = saveDeclaration.getText(appAst).replace(/^export\s+/, '')
  const saveJs = ts.transpile(`${saveText}\nreturn handleSave`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })

  const journal = { edits: [{ row: 0, column: 1, value: 'one' }] }
  initializeSheetsSaveCheckpoint(journal)
  markSheetsJournalChanged(journal)
  const notifications = []
  const rawCounts = []
  const setter = setterFactory({
    lazyWorkbookRef: { current: { editJournal: journal } },
    setPendingEditsRaw: (count) => rawCounts.push(count),
    markSheetsJournalChanged,
    pendingSheetsJournalSize,
    window: { desktopApi: { notifyPendingEdits: (count) => notifications.push(count) } },
  })
  setter(1)
  journal.edits[0].value = 'two'
  setter(1)
  assert.deepEqual(notifications, [1, 1], 'each edit notifies close guard despite an unchanged pending count')
  assert.deepEqual(rawCounts, [1, 1])

  const saveNotifications = []
  const saveRawCounts = []
  const activeState = { editJournal: journal }
  const saveFactory = new Function('deps', `with (deps) { ${saveJs} }`)
  const save = saveFactory({
    lazyWorkbookRef: { current: activeState },
    saveContext: () => ({}),
    handleSaveImpl: async () => {
      journal.edits[0].value = 'three'
      markSheetsJournalChanged(journal)
      return { ok: true }
    },
    journalSize: () => 1,
    pendingSheetsJournalSize,
    serializeSheetsSave,
    setPendingEditsRaw: (count) => saveRawCounts.push(count),
    window: { desktopApi: { notifyPendingEdits: (count) => saveNotifications.push(count) } },
  })
  assert.equal((await save('save')).ok, true)
  assert.deepEqual(saveNotifications, [1], 'save completion re-notifies a same-count concurrent edit')
  assert.deepEqual(saveRawCounts, [1])
}

// Exercise the actual collab save-event callback: retained success and errors
// release immediately, while legacy reopen success keeps the 15-second pause.
{
  const collabPath = resolve('tools/genoffice/inject/sheets-collab.ts')
  const collabSource = readFileSync(collabPath, 'utf8')
  const collabAst = ts.createSourceFile('sheets-collab.ts', collabSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let listenerArrow
  function findSaveListener(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'addEventListener' && node.arguments[0]?.getText(collabAst) === "'flux-sheets-save'" && ts.isArrowFunction(node.arguments[1])) listenerArrow = node.arguments[1]
    ts.forEachChild(node, findSaveListener)
  }
  findSaveListener(collabAst)
  assert.ok(listenerArrow, 'collab module has the actual flux-sheets-save listener')
  const listenerJs = ts.transpile(`let saving = null; const listener = ${listenerArrow.getText(collabAst)}; return { listener, getSaving: () => saving }`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })
  const createListener = new Function('hooks', 'Date', listenerJs)
  const fakeDate = { now: () => 1000 }
  const hooks = () => ({ lazyWorkbookRef: { current: { marker: 'live' } } })
  const retained = createListener(hooks, fakeDate)
  retained.listener({ detail: { phase: 'start' } })
  retained.listener({ detail: { phase: 'end', ok: true, sessionRetained: true } })
  assert.equal(retained.getSaving(), null, 'retained save resumes collaboration immediately')
  const legacy = createListener(hooks, fakeDate)
  legacy.listener({ detail: { phase: 'start' } })
  legacy.listener({ detail: { phase: 'end', ok: true, sessionRetained: false } })
  assert.equal(legacy.getSaving().until, 16000, 'legacy successful reopen retains its existing wait')
  const failed = createListener(hooks, fakeDate)
  failed.listener({ detail: { phase: 'start' } })
  failed.listener({ detail: { phase: 'end', ok: false, sessionRetained: false } })
  assert.equal(failed.getSaving(), null, 'failed save releases collaboration immediately')
  assert.match(readFileSync(resolve('tools/genoffice/shims/electron-renderer.js'), 'utf8'), /sessionRetained:\s*r\?\.sessionRetained\s*===\s*true/)
}

console.log('Office sheets save renderer tests passed')
