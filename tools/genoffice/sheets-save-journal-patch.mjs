import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const JOURNAL_MUTATORS = [
  'recordNoteChange', 'recordPivotCacheRefresh', 'recordPivotRefreshUpdate',
  'recordPageSetup', 'recordDefinedNamesChange', 'recordWorkbookProtection',
  'recordProtectedRangesChange', 'recordThemeColors', 'recordThemeFonts',
  'recordSheetProtection', 'recordCfChange', 'recordDvChange',
  'recordHyperlinkEdit', 'recordFilterChange', 'recordSheetInsert',
  'recordSheetRemove', 'recordSheetDuplicate', 'recordSheetRename',
  'recordSheetOrderChange', 'recordSheetHidden', 'recordChartEdit',
  'recordTableAdd', 'updateTableAdd', 'recordPivotAdd', 'recordSparklineAdd',
  'removeSparklineAdd', 'recordVisualAdd', 'recordVisualEdit',
  'removeVisualAdd', 'updateVisualAdd', 'removeStructuralOp',
  'recordStructuralOp', 'recordBulkConstantFill', 'restoreJournalCells',
  'removeBulkConstantFill', 'recordSetNumfmt', 'recordSetRangeValues', 'recordNeutralStyleEdit',
]

function parse(source, path) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function transform(source, path, names, importPath, journalExpression) {
  const file = parse(source, path)
  const declarations = new Map()
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue
    if (names.includes(statement.name.text)) declarations.set(statement.name.text, statement)
  }
  const missing = names.filter((name) => !declarations.has(name))
  if (missing.length) throw new Error(`journal save patch ${path}: missing functions: ${missing.join(', ')}`)

  const importLine = `import { isSheetsJournalTracked, markSheetsJournalChanged } from '${importPath}'\n`
  const hasImport = source.includes(importLine.trim())
  const allMarked = names.every((name) => {
    const node = declarations.get(name)
    return node.body.statements.some((statement) => statement.getText(file).includes('markSheetsJournalChanged'))
  })
  if (hasImport && allMarked) return source
  if (hasImport || source.includes('markSheetsJournalChanged')) {
    throw new Error(`journal save patch ${path}: partial checkpoint instrumentation`)
  }

  const edits = []
  for (const name of names) {
    const node = declarations.get(name)
    if (!node.body || !node.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'journal') && journalExpression === 'journal') {
      throw new Error(`journal save patch ${path}: ${name} has no journal parameter`)
    }
    const expression = journalExpression === 'journal' ? 'journal' : journalExpression(node, file)
    if (!expression) throw new Error(`journal save patch ${path}: cannot resolve journal for ${name}`)
    edits.push({
      pos: node.body.getStart(file) + 1,
      text: `\n  if (isSheetsJournalTracked(${expression})) markSheetsJournalChanged(${expression})`,
    })
  }
  const imports = file.statements.filter(ts.isImportDeclaration)
  const importPos = imports.length ? imports[imports.length - 1].end : 0
  edits.push({ pos: importPos, text: `\n${importLine.trimEnd()}` })
  edits.sort((a, b) => b.pos - a.pos)
  let result = source
  for (const edit of edits) result = result.slice(0, edit.pos) + edit.text + result.slice(edit.pos)
  return result
}

export function patchSheetsEditJournal(source) {
  return transform(
    source,
    'edit-journal.ts',
    JOURNAL_MUTATORS,
    './flux/sheets-save-checkpoint',
    'journal',
  )
}

export function patchSheetsUniverSync(source) {
  const names = ['restoreVisualJournal']
  return transform(
    source,
    'univer-sync.ts',
    names,
    './flux/sheets-save-checkpoint',
    (node) => {
      const state = node.parameters.find((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'state')
      return state ? 'state.editJournal' : null
    },
  )
}

export function applyJournalSavePatches(genofficeRoot) {
  const editPath = join(genofficeRoot, 'apps/sheets/src/renderer/edit-journal.ts')
  const syncPath = join(genofficeRoot, 'apps/sheets/src/renderer/univer-sync.ts')
  const edit = patchSheetsEditJournal(readFileSync(editPath, 'utf8'))
  const sync = patchSheetsUniverSync(readFileSync(syncPath, 'utf8'))
  writeFileSync(editPath, edit)
  writeFileSync(syncPath, sync)
  return ['edit-journal.ts: tracked mutations advance save checkpoint', 'univer-sync.ts: visual undo/redo advances save checkpoint']
}
