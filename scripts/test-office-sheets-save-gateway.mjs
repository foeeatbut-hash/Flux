import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { applyGatewaySavePatches, transformDesktopApi, transformSheetsMain, transformSheetsPreload } from '../tools/genoffice/sheets-save-gateway-patch.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const genofficeRoot = process.env.GENOFFICE_SRC ?? [join(repoRoot, '.cache/genoffice'), join(repoRoot, '.cache/genoffice/repo')]
  .find((candidate) => existsSync(join(candidate, 'apps/sheets/src/main/sheets-main.ts')))
if (!genofficeRoot) throw new Error('Set GENOFFICE_SRC to the pinned GenOffice source checkout.')
const upstream = join(genofficeRoot, 'apps/sheets/src')
const main = transformSheetsMain(readFileSync(`${upstream}/main/sheets-main.ts`, 'utf8'))
const api = transformDesktopApi(readFileSync(`${upstream}/shared/desktop-api.ts`, 'utf8'))
const preload = transformSheetsPreload(readFileSync(`${upstream}/preload/index.ts`, 'utf8'))
assert.match(api, /retainSession: z\.boolean\(\)\.optional\(\)/)
assert.match(api, /saveContinuation: z\.boolean\(\)\.optional\(\)/)
assert.match(api, /retainedSessionId: z\.string\(\)\.uuid\(\)\.optional\(\)/)
assert.match(api, /sessionRetained: z\.boolean\(\)\.optional\(\)/)
assert.match(api, /Invalid split-save continuation request/)
assert.match(preload, /input\.sessionRetained === undefined/)
assert.match(preload, /input\.ok === false/)

// The patcher validates every transformed file before committing any change.
{
  const root = mkdtempSync(join(tmpdir(), 'sheets-gateway-patch-'))
  try {
    const mainPath = join(root, 'apps/sheets/src/main/sheets-main.ts')
    const apiPath = join(root, 'apps/sheets/src/shared/desktop-api.ts')
    const channelsPath = join(root, 'apps/sheets/src/shared/ipc-channels.ts')
    const preloadPath = join(root, 'apps/sheets/src/preload/index.ts')
    mkdirSync(join(root, 'apps/sheets/src/main'), { recursive: true })
    mkdirSync(join(root, 'apps/sheets/src/shared'), { recursive: true })
    mkdirSync(join(root, 'apps/sheets/src/preload'), { recursive: true })
    const originalMain = readFileSync(`${upstream}/main/sheets-main.ts`, 'utf8')
    writeFileSync(mainPath, originalMain)
    writeFileSync(apiPath, 'stale source')
    writeFileSync(channelsPath, "export const IPC_CHANNELS = { saveWorkbook: 'workbook:save' }")
    writeFileSync(preloadPath, readFileSync(`${upstream}/preload/index.ts`, 'utf8'))
    assert.throws(() => applyGatewaySavePatches(root), /expected one exact source anchor/)
    assert.equal(readFileSync(mainPath, 'utf8'), originalMain)
    writeFileSync(apiPath, readFileSync(`${upstream}/shared/desktop-api.ts`, 'utf8'))
    const logs = applyGatewaySavePatches(root)
    assert.equal(logs.length, 4)
    const patchedMain = readFileSync(mainPath, 'utf8')
    applyGatewaySavePatches(root)
    assert.equal(readFileSync(mainPath, 'utf8'), patchedMain)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function saveHandler(source) {
  const ast = ts.createSourceFile('sheets-main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let callback
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'handle' && node.arguments.length >= 2 &&
      node.arguments[0].getText(ast) === 'IPC_CHANNELS.saveWorkbook' && ts.isArrowFunction(node.arguments[1])) {
      callback = node.arguments[1]
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(callback, 'patched source has a native saveWorkbook IPC handler')
  const js = ts.transpile(callback.getText(ast), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })
  return new Function('deps', `with (deps) { return (${js.trim().replace(/;$/, '')}) }`)
}
const makeHandler = saveHandler(main)

function extractedFunction(source, name, deps) {
  const ast = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let declaration
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(declaration, `patched source has ${name}`)
  const js = ts.transpile(declaration.getText(ast), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }).trim().replace(/;$/, '')
  return new Function('deps', `with (deps) { return (${js}) }`)(deps)
}

const parseSaveResult = extractedFunction(preload, 'parseSaveResult', {
  isRecord: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  parseWorkbookFile: (value) => value,
})
const successfulSave = {
  canceled: false,
  file: { sessionId: 'native-session', path: '/files/book.xlsx' },
  touchedEntries: ['xl/worksheets/sheet1.xml'],
}
assert.equal(parseSaveResult({ ...successfulSave, sessionRetained: true }).sessionRetained, true)
assert.equal(parseSaveResult(successfulSave).sessionRetained, undefined)
assert.throws(() => parseSaveResult({ ...successfulSave, sessionRetained: 'yes' }), /Invalid workbook save response/)
assert.throws(() => parseSaveResult({ ok: false, error: 'disk changed' }), /disk changed/)
assert.deepEqual(parseSaveResult({ canceled: true }), { canceled: true })

function harness({ failWrite = false, failPostWriteSha = false, closeDuringWrite = false } = {}) {
  const originalId = 'original-session'
  const path = '/files/book.xlsx'
  const baselineFile = { sessionId: originalId, path, sha256: 'open-snapshot-sha', fileBytes: 20, readOnly: false, needsSaveAs: false }
  const original = { path, snapshotPath: '/snapshots/open.xlsx', sha256: 'open-snapshot-sha', baselineFile, sheetNames: new Map(), automaticRecoveryDisabled: false }
  const entry = { client: { close: async (id) => closed.push(id) }, sessions: new Map([[originalId, original]]) }
  const closed = []
  const writes = []
  const opened = []
  const hooks = []
  let diskSha = 'open-snapshot-sha'
  let nextSha = 0
  let tempId = 0
  const deps = {
    sessionFor: () => entry,
    resolveTransferredEdits: (_entry, request) => request,
    workbookSaveRequestSchema: { parse: (request) => request },
    writeWorkbookTo: async (_client, session, request, target) => {
      writes.push({ session, request, target })
      if (failWrite) throw new Error('simulated writer failure')
      diskSha = `saved-${++nextSha}`
      if (closeDuringWrite) entry.sessions.delete(request.sessionId)
      return { touchedEntries: ['xl/worksheets/sheet1.xml'] }
    },
    sha256File: async () => {
      if (failPostWriteSha && writes.length > 0) throw new Error('simulated digest failure')
      return diskSha
    },
    openWorkbookSession: async (_client, target, sessions) => {
      const id = `continuation-${++tempId}`
      const file = { sessionId: id, path: target, sha256: diskSha, fileBytes: 30, readOnly: false, needsSaveAs: false }
      sessions.set(id, { path: target, snapshotPath: `/snapshots/${id}.xlsx`, sha256: diskSha, baselineFile: file, sheetNames: new Map(), automaticRecoveryDisabled: false })
      opened.push(id)
      return file
    },
    cleanupSessionResources: async ({ snapshotPath, closeSidecar }) => { hooks.push(`cleanup:${snapshotPath}`); await closeSidecar?.() },
    workbookOpenedHook: (_sender, target) => hooks.push(`opened:${target}`),
    clearWorkbookRecovery: (target) => hooks.push(`clear:${target}`),
    saveFileDialog: async () => ({ canceled: false, filePath: '/files/other.xlsx' }),
    app: { getPath: () => '/tmp' },
    event: { sender: { id: 7 } },
    IPC_CHANNELS: { saveWorkbook: 'workbook:save' },
    tm: (key) => key,
    existsSync: () => false,
    canMcpSheetWrite: () => true,
    isAbsolute: () => true,
    writeFile: async () => {},
    Buffer,
  }
  return { invoke: makeHandler(deps), entry, original, baselineFile, closed, writes, opened, hooks, get diskSha() { return diskSha }, set diskSha(value) { diskSha = value } }
}
const request = (sessionId, extra = {}) => ({ sessionId, mode: 'save', edits: [], structuralOps: [], sheetOps: [], sheetOrder: [], chartEdits: [], visualEdits: [], visualAdditions: [], tableAdditions: [], pivotAdditions: [], filterStates: [], hyperlinkEdits: [], cfStates: [], dvStates: [], pageSetupStates: [], noteStates: [], formulaValues: [], pivotCacheRefreshPaths: [], pivotRefreshUpdates: [], sheetProtections: [], sparklineAdditions: [], definedNamesState: null, themeState: null, workbookProtectionState: null, protectedRangeStates: [], ...extra });

// Two sequential normal saves keep the original reader/snapshot and cumulatively
// pass that same immutable base to the real IPC handler's writer call.
{
  const h = harness()
  for (let i = 0; i < 2; i++) {
    const result = await h.invoke(h.deps?.event ?? { sender: { id: 7 } }, request('original-session', { retainSession: true }))
    assert.equal(result.sessionRetained, true)
    assert.strictEqual(result.file, h.baselineFile)
    assert.strictEqual(h.entry.sessions.get('original-session').snapshotPath, '/snapshots/open.xlsx')
  }
  assert.equal(h.writes.length, 2)
  assert.deepEqual(h.writes.map((write) => write.session.snapshotPath), ['/snapshots/open.xlsx', '/snapshots/open.xlsx'])
  assert.equal(h.closed.length, 0)
  assert.equal(h.opened.length, 0)
  assert.equal(h.entry.sessions.get('original-session').sha256, 'open-snapshot-sha')
  assert.equal(h.entry.sessions.get('original-session').lastSavedSha256, 'saved-2')
  h.diskSha = 'external-after-save'
  await assert.rejects(h.invoke({ sender: { id: 7 } }, request('original-session', { retainSession: true })), /errDiskChanged/)
  assert.equal(h.writes.length, 2)
}

// A failed continuation save leaves the phase-one guard advanced and keeps
// both sessions available so the renderer can close the temp one and retry.
{
  const h = harness()
  const first = await h.invoke({ sender: { id: 7 } }, request('original-session', { retainSession: true, saveContinuation: true }))
  const tempId = first.file.sessionId
  h.entry.sessions.set(tempId, { ...h.entry.sessions.get(tempId), sha256: 'saved-1' })
  h.diskSha = 'saved-1'
  const failing = harness({ failWrite: true })
  // Reuse the phase-one state and a writer that fails during phase two.
  failing.entry.sessions.clear()
  failing.entry.sessions.set('original-session', h.entry.sessions.get('original-session'))
  failing.entry.sessions.set(tempId, h.entry.sessions.get(tempId))
  failing.diskSha = 'saved-1'
  await assert.rejects(failing.invoke({ sender: { id: 7 } }, request(tempId, { retainSession: true, retainedSessionId: 'original-session' })), /simulated writer failure/)
  assert.equal(failing.entry.sessions.get('original-session').lastSavedSha256, 'saved-1')
  assert.equal(failing.entry.sessions.has(tempId), true)
  assert.deepEqual(failing.closed, [])
}

// Split save: phase one opens one continuation reader, phase two saves from its
// file but returns to the original session and cleans only the continuation.
{
  const h = harness()
  const first = await h.invoke({ sender: { id: 7 } }, request('original-session', { retainSession: true, saveContinuation: true }))
  assert.equal(first.sessionRetained, true)
  assert.equal(first.file.sessionId, 'continuation-1')
  assert.equal(h.entry.sessions.get('original-session').lastSavedSha256, 'saved-1')
  const temp = h.entry.sessions.get(first.file.sessionId)
  const second = await h.invoke({ sender: { id: 7 } }, request(first.file.sessionId, { retainSession: true, retainedSessionId: 'original-session' }))
  assert.equal(second.sessionRetained, true)
  assert.strictEqual(second.file, h.baselineFile)
  assert.equal(h.entry.sessions.has(first.file.sessionId), false)
  assert.ok(h.entry.sessions.has('original-session'))
  assert.equal(h.entry.sessions.get('original-session').lastSavedSha256, 'saved-2')
  assert.deepEqual(h.writes.map((write) => write.session.snapshotPath), ['/snapshots/open.xlsx', temp.snapshotPath])
  assert.deepEqual(h.closed, [first.file.sessionId])
  assert.equal(h.opened.length, 1)
}

// The guard follows the disk baseline, but external edits still block before
// the writer runs. A writer error leaves the original session and CAS intact.
{
  const h = harness()
  h.diskSha = 'external-change'
  await assert.rejects(h.invoke({ sender: { id: 7 } }, request('original-session', { retainSession: true })), /errDiskChanged/)
  assert.equal(h.writes.length, 0)
  const failed = harness({ failWrite: true })
  await assert.rejects(failed.invoke({ sender: { id: 7 } }, request('original-session', { retainSession: true })), /simulated writer failure/)
  assert.strictEqual(failed.entry.sessions.get('original-session'), failed.original)
  assert.equal(failed.closed.length, 0)
  const digestFailure = harness({ failPostWriteSha: true })
  await assert.rejects(digestFailure.invoke({ sender: { id: 7 } }, request('original-session', { retainSession: true })), /Could not verify saved workbook/)
  assert.strictEqual(digestFailure.entry.sessions.get('original-session'), digestFailure.original)
  assert.equal(digestFailure.opened.length, 0)
  assert.equal(digestFailure.closed.length, 0)
  const closedDuringSave = harness({ closeDuringWrite: true })
  await assert.rejects(closedDuringSave.invoke({ sender: { id: 7 } }, request('original-session', { retainSession: true })), /Workbook session closed during save/)
  assert.equal(closedDuringSave.entry.sessions.has('original-session'), false)
  assert.equal(closedDuringSave.opened.length, 0)
  assert.equal(closedDuringSave.closed.length, 0)
}

// Save As remains on the legacy replacement path and never acknowledges retention.
{
  const h = harness()
  const result = await h.invoke({ sender: { id: 7 } }, request('original-session', { mode: 'save-as' }))
  assert.equal(result.sessionRetained, undefined)
  assert.equal(h.closed[0], 'original-session')
}

console.log('Office sheets save gateway tests passed')
