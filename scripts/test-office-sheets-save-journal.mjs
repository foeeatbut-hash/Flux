import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import ts from 'typescript'
import * as checkpointExports from '../tools/genoffice/inject/sheets-save-checkpoint.ts'
import { patchSheetsEditJournal, patchSheetsUniverSync } from '../tools/genoffice/sheets-save-journal-patch.mjs'

const checkpointApi = checkpointExports.default ?? checkpointExports
const {
  acknowledgeSheetsSaveCheckpoint,
  captureSheetsSaveCheckpoint,
  initializeSheetsSaveCheckpoint,
  isSheetsJournalTracked,
  pendingSheetsJournalSize,
} = checkpointApi
assert.equal(typeof captureSheetsSaveCheckpoint, 'function')

const configuredRoot = process.env.GENOFFICE_SRC || resolve('.cache/genoffice')
const genofficeRoot = existsSync(resolve(configuredRoot, 'apps/sheets/src/renderer/edit-journal.ts'))
  ? configuredRoot
  : resolve(configuredRoot, 'repo')
const renderer = join(genofficeRoot, 'apps/sheets/src/renderer')

function declarations(source, names, path) {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found = new Map()
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) {
      found.set(node.name.text, node.getText(ast).replace(/^export\s+/, ''))
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.deepEqual([...found.keys()].sort(), [...names].sort(), `expected real declarations in ${path}`)
  return [...found.values()].join('\n')
}

function extract(source, names, path, dependencies = {}) {
  const js = ts.transpile(declarations(source, names, path), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  })
  return new Function('deps', `with (deps) { ${js}\nreturn { ${names.join(', ')} } }`)({ ...checkpointApi, ...dependencies })
}

function markClean(journal) {
  const revision = captureSheetsSaveCheckpoint(journal)
  assert.notEqual(revision, undefined)
  acknowledgeSheetsSaveCheckpoint(journal, revision)
}
function assertDirty(journal, label) {
  assert.ok(pendingSheetsJournalSize(journal, 0) > 0, `${label} must remain pending at unchanged journal size`)
}

const editPath = join(renderer, 'edit-journal.ts')
const syncPath = join(renderer, 'univer-sync.ts')
const editSource = patchSheetsEditJournal(readFileSync(editPath, 'utf8'))
const syncSource = patchSheetsUniverSync(readFileSync(syncPath, 'utf8'))
assert.equal(patchSheetsEditJournal(editSource), editSource, 'edit journal transform is idempotent')
assert.equal(patchSheetsUniverSync(syncSource), syncSource, 'visual restore transform is idempotent')
assert.throws(
  () => patchSheetsEditJournal(editSource.replace('export function recordPageSetup', 'export function removedPageSetup')),
  /missing functions|partial checkpoint instrumentation/,
  'a moved or renamed upstream anchor fails closed',
)

const edit = extract(editSource, [
  'recordPageSetup', 'recordSheetProtection', 'recordWorkbookProtection',
  'recordStructuralOp', 'recordSparklineAdd', 'removeSparklineAdd',
  'recordBulkConstantFill', 'removeBulkConstantFill', 'restoreJournalCells',
  'recordChartEdit',
], editPath)
const journal = {
  pageSetup: new Map(),
  sheetProtection: new Map(),
  workbookProtection: { desired: null },
  structuralOps: new Map(),
  sparklineAdds: [],
  bulkConstantFills: new Map(),
  cells: new Map(),
  chartEdits: new Map(),
  visualAdds: [],
  visualEdits: new Map(),
  hyperlinks: new Map(),
}
initializeSheetsSaveCheckpoint(journal)

// Same-size changes must survive a save acknowledgement and become dirty again.
edit.recordPageSetup(journal, 'sheet-1', { orientation: 'landscape' })
markClean(journal)
edit.recordPageSetup(journal, 'sheet-1', { orientation: 'landscape' })
assertDirty(journal, 'same-count page setup edit')

markClean(journal)
edit.recordSheetProtection(journal, 'sheet-1', true, false)
assertDirty(journal, 'sheet protection')
markClean(journal)
edit.recordWorkbookProtection(journal, true, false)
assertDirty(journal, 'workbook protection')

// The actual column-style journal operation is a structural op with set-col-style.
markClean(journal)
edit.recordStructuralOp(journal, 'sheet-1', {
  kind: 'set-col-style', start: 0, end: 16383, style: { bold: true },
})
assertDirty(journal, 'column style')
assert.equal(journal.structuralOps.get('sheet-1').length, 1)

markClean(journal)
edit.recordSparklineAdd(journal, { id: 'sparkline-1', sheetId: 'sheet-1', type: 'line', cells: [] })
assertDirty(journal, 'sparkline add')
markClean(journal)
edit.removeSparklineAdd(journal, 'sparkline-1')
assertDirty(journal, 'sparkline undo')

markClean(journal)
const fill = { sheetId: 'sheet-1', startRow: 0, endRow: 1, startColumn: 0, endColumn: 0, value: 'x', journalId: 17 }
edit.recordBulkConstantFill(journal, fill)
markClean(journal)
edit.removeBulkConstantFill(journal, fill)
edit.restoreJournalCells(journal, 'sheet-1', [{ row: 0, column: 0, hasValue: true, value: 'old' }])
assertDirty(journal, 'bulk-fill undo and cell restore')

markClean(journal)
edit.recordChartEdit(journal, 'xl/charts/chart1.xml', { title: 'changed' })
assertDirty(journal, 'chart edit')

const visual = extract(syncSource, ['restoreVisualJournal'], join(renderer, 'univer-sync.ts'))
markClean(journal)
const state = { editJournal: journal }
visual.restoreVisualJournal(state, 'visual-1', 'xl/charts/chart1.xml', {
  chartEdit: { title: 'before' },
})
assertDirty(journal, 'chart/visual undo')
markClean(journal)
visual.restoreVisualJournal(state, 'visual-1', 'xl/charts/chart1.xml', {})
assertDirty(journal, 'chart/visual redo')

// Workbook initialization mutates before the journal is tracked; it must stay untracked.
const untracked = { pageSetup: new Map() }
edit.recordPageSetup(untracked, 'sheet-1', { orientation: 'portrait' })
assert.equal(isSheetsJournalTracked(untracked), false)

console.log('Office sheets save journal checkpoints: passed')
