/** Contract checks for the native Word/Excel header bridge. */
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const docs = readFileSync('tools/genoffice/inject/docs-collab.ts', 'utf8');
const wordMerge = readFileSync('tools/genoffice/inject/docs-header-merge.ts', 'utf8');
const sheets = readFileSync('tools/genoffice/inject/sheets-collab.ts', 'utf8');
let failures = 0;
const check = (name: string, condition: boolean) => {
  if (condition) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
};

const between = (source: string, start: string, end: string): string => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  return from < 0 || to < 0 ? '' : source.slice(from, to);
};

const wordRead = between(docs, "p.on('getFluxHeaderSchema'", "p.on('syncFluxHeaderSchema'");
const wordSync = between(docs, "p.on('syncFluxHeaderSchema'", "p.on('applyFluxPlan'");
const wordBuilder = between(docs, 'function wordParagraphForSchema(', 'function validateHeaderSchema(');
const sheetRead = between(sheets, "link.on('flux:get-header-schema'", "link.on('flux:sync-header-schema'");
const sheetSync = between(sheets, "link.on('flux:sync-header-schema'", "link.on('flux:insert-table'");
const readOnlyGuard = between(sheets, 'commandService.beforeCommandExecuted((command: any) => {', '// Загрузка из файла');
const gate = /if \((fluxReadOnly && !trusted && command\.type === MUTATION)\)/.exec(readOnlyGuard)?.[1];

function loadNativeTextSplitter(): (text: string, followsField: boolean) => Array<{ kind: string; text?: string; operator?: string }> {
  const start = docs.indexOf('function splitNativeText(');
  const end = docs.indexOf('/** Считывает живую последовательность', start);
  if (start < 0 || end < 0) throw new Error('Native Word text splitter was not found');
  const source = `${docs.slice(start, end)}\nmodule.exports = splitNativeText;`;
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module: { exports: unknown } = { exports: {} };
  new Function('module', 'exports', js)(module, module.exports);
  return module.exports as (text: string, followsField: boolean) => Array<{ kind: string; text?: string; operator?: string }>;
}

function loadMergeConflictCheck(): (targetText: string, sourceText: string) => boolean {
  const start = wordMerge.indexOf('function headerMergeConflictText(');
  const end = wordMerge.indexOf('\nfunction isEmptyRowValue(', start);
  if (start < 0 || end < 0) throw new Error('Native Word merge conflict check was not found');
  const source = `${wordMerge.slice(start, end)}\nmodule.exports = headerMergeConflictText;`;
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module: { exports: unknown } = { exports: {} };
  new Function('module', 'exports', js)(module, module.exports);
  return module.exports as (targetText: string, sourceText: string) => boolean;
}

function loadUnselectedColumnAnchors(): (anchorIds: string[][], sourceId: string) => string[] {
  const start = wordMerge.indexOf('function unselectedColumnAnchors(');
  const end = wordMerge.indexOf('\nfunction isEmptyRowValue(', start);
  if (start < 0 || end < 0) throw new Error('Native Word source-column anchor guard was not found');
  const source = `${wordMerge.slice(start, end)}\nmodule.exports = unselectedColumnAnchors;`;
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module: { exports: unknown } = { exports: {} };
  new Function('module', 'exports', js)(module, module.exports);
  return module.exports as (anchorIds: string[][], sourceId: string) => string[];
}

function loadRowMergeHelper(): (rows: any[], targetId: string, sourceId: string, actual: Map<string, { text: string; targetBookmark: boolean }>) => any[] {
  const start = wordMerge.indexOf('function isEmptyRowValue(');
  const end = wordMerge.indexOf('\nfunction actualMergedColumnValues(', start);
  if (start < 0 || end < 0) throw new Error('Native Word row metadata merge helper was not found');
  const source = `${wordMerge.slice(start, end)}\nmodule.exports = mergeOfficeRowsAfterHeaderMerge;`;
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module: { exports: unknown } = { exports: {} };
  new Function('module', 'exports', js)(module, module.exports);
  return module.exports as (rows: any[], targetId: string, sourceId: string, actual: Map<string, { text: string; targetBookmark: boolean }>) => any[];
}

function loadTagInstructionDecoder(): (instruction: string) => { tagId: string; identifier: string } | null {
  const start = docs.indexOf('export function tagTargetFromFieldInstruction(');
  const end = docs.indexOf('\nfunction fieldTagAtTarget(', start);
  if (start < 0 || end < 0) throw new Error('Word tag field decoder was not found');
  const source = `${docs.slice(start, end).replace('export function', 'function')}\nmodule.exports = tagTargetFromFieldInstruction;`;
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module: { exports: unknown } = { exports: {} };
  new Function('module', 'exports', js)(module, module.exports);
  return module.exports as (instruction: string) => { tagId: string; identifier: string } | null;
}

console.log('1. Word keeps schema parts native and in order');
check('read returns real OfficePart schema from current document order',
  wordRead.includes('readNativeHeader(editor') && wordRead.includes("'flux:header-schema-read'") && wordRead.includes('parts }'));
check('sync writes submitted text/operators and genuine instrField tokens',
  wordBuilder.includes('for (const part of anchor.parts)') && wordBuilder.includes('part.operator') && wordBuilder.includes('existingMarks.filter((mark: any) => !isFluxField(mark))') && wordBuilder.includes('fieldMarkType.create({ instr: fluxInstruction(anchor, binding) })') && docs.includes('marks.instrField') && wordBuilder.includes('Fragment.fromArray(parts)'));
check('sync replaces only anchored paragraphs, retaining paragraph attrs and inline marks',
  wordSync.includes('target.paragraph.type.create(attrs, Fragment.fromArray(children))') && wordSync.includes('tr.replaceWith(item.pos, item.pos + item.before.nodeSize, item.after)') && !/innerHTML|setContent\(/i.test(wordSync));
check('omitting a field from an explicit schema delta removes its field token',
  wordSync.includes('for (const id of removed.map(String))') && wordSync.includes("!(child.marks || []).some(isFluxField)"));
const splitText = loadNativeTextSplitter();
const arithmeticSuffix = splitText('*2 ед.', true);
check('merged Word text `*2 ед.` remains operator, numeric operand, and unit suffix',
  arithmeticSuffix.length === 3 && arithmeticSuffix[0].kind === 'operator' && arithmeticSuffix[0].operator === '*' && arithmeticSuffix[1].text === '2' && arithmeticSuffix[2].text === ' ед.');
check('five-part prefix/field/operator/operand/suffix order survives ProseMirror text merging',
  ['text', 'field', ...arithmeticSuffix.map((part) => part.kind)].join(',') === 'text,field,operator,text,text');
check('legacy insert can omit an anchor while explicit anchors require a table cell',
  docs.includes('if (explicitAnchor && !persistDocAnchor(ed, anchorId))'));
check('right click emits actions only for the actual selected bound Word header cells',
  docs.includes("p.tell('flux:cell-actions'") && docs.includes("editorKind: 'docs'") && wordMerge.includes('selection instanceof CellSelection') && wordMerge.includes("!['docTableHeader', 'docTableCell'].includes(node.type.name)") && docs.includes('anchors?.some((anchor) => anchor.anchorId === clickedAnchorId)'));
check('merge preview hashes table, schema, rows and ids, then requires exact-token confirmation',
  wordMerge.includes("crypto.subtle.digest('SHA-256'") && wordMerge.includes('rows: request.rows ?? null') && wordMerge.includes('pendingHeaderMerges.get(token) !== fingerprint') && wordMerge.includes("request?.confirm !== true"));
const unselectedAnchors = loadUnselectedColumnAnchors();
check('source-column removal rejects every other Flux anchor while allowing the selected source anchor',
  JSON.stringify(unselectedAnchors([['source-b'], ['other-c', 'source-b'], ['other-c']], 'source-b')) === JSON.stringify(['other-c']) && wordMerge.includes('unselectedColumnAnchors(otherSourceAnchors, sourceIds[0])') && wordMerge.indexOf('unselectedColumnAnchors(otherSourceAnchors') < wordMerge.indexOf('const conflicts:'));
check('merge preserves target cell formatting/widths and does not dispatch until all checks pass',
  wordMerge.includes('Number(leftWidths[0]) + Number(rightWidths[0])') && wordMerge.includes('table.type.create(table.attrs, Fragment.fromArray(rowsOut))') && wordMerge.indexOf("if (request?.confirm !== true") < wordMerge.indexOf('if (conflicts.length) return') && wordMerge.indexOf('if (conflicts.length) return') < wordMerge.indexOf('const rowsOut: any[] = []'));
check('formula edit focuses the anchored Word paragraph and inserts a plain leading equals marker',
  docs.includes("p.on('editFluxHeaderFormula'") && wordMerge.includes("editor.schema.text('=', marks)") && wordMerge.includes('tr.setSelection(selection).scrollIntoView()'));
check('new catalog insertions carry an encoded source identity for ambiguous field keys',
  docs.includes('const sourceId = typeof binding?.sourceId') && docs.includes('encodeURIComponent(sourceId)'));
check('inserting a field into a cell selection moves to the bound paragraph end instead of replacing selected cells',
  docs.includes("headerActions.isCellSelection()") && docs.includes("caret: 'end', preserveText: true") && wordMerge.includes('const nextPos = preserveText ? pos + 1 + paragraph.content.size : pos + 2'));
const conflicts = loadMergeConflictCheck();
check('merge transfers one populated side and deduplicates identical values but rejects differing values',
  !conflicts('', 'source only') && !conflicts('same', 'same') && conflicts('target value', 'source value'));
const mergeRows = loadRowMergeHelper();
const mergedMetadata = mergeRows([{
  entityId: 'entity-1', entityType: 'element', sourceId: 'equipment', sourceRevision: 'rev-7',
  anchorIds: ['target-a', 'source-b', 'unrelated-c'],
  cells: { 'source-b': 'FLUXROW_abc', 'unrelated-c': 'FLUXROW_else' },
  values: { 'target-a': null, 'source-b': 0, 'unrelated-c': 'keep' },
}], 'target-a', 'source-b', new Map([['FLUXROW_abc', { text: '0', targetBookmark: true }]]))[0];
check('source-only row values and bookmark move to target; zero, revision, and unrelated metadata survive',
  mergedMetadata.values['target-a'] === '0' && !('source-b' in mergedMetadata.values) && mergedMetadata.cells['target-a'] === 'FLUXROW_abc' && !('source-b' in mergedMetadata.cells) && mergedMetadata.anchorIds.includes('target-a') && !mergedMetadata.anchorIds.includes('source-b') && mergedMetadata.anchorIds.includes('unrelated-c') && mergedMetadata.values['unrelated-c'] === 'keep' && mergedMetadata.sourceRevision === 'rev-7');
const decodeTag = loadTagInstructionDecoder();
check('source-qualified Flux Word tags still resolve to their tag target',
  JSON.stringify(decodeTag(' DOCPROPERTY "flux:tag[AHU-1].identifier" ')) === JSON.stringify({ tagId: '', identifier: 'AHU-1' }) && JSON.stringify(decodeTag('DOCPROPERTY "flux:v1:tags:tag%5BAHU-1%5D.identifier"')) === JSON.stringify({ tagId: '', identifier: 'AHU-1' }));

console.log('\n2. Excel read is read-only and sync validates before writes');
check('Excel read merges live display text with the supplied schema without mutation',
  !!sheetRead && sheetRead.includes("'flux:header-schema-read'") && sheetRead.includes('getValues()') && !sheetRead.includes('setValues(') && !sheetRead.includes('insertDefinedName('));
check('all Excel anchors and parts are validated before mutation starts',
  sheetSync.indexOf('for (const anchor of schema.anchors)') >= 0 && sheetSync.indexOf('applyingFlux = true') > sheetSync.indexOf('const oldCells = targets.map'));
check('failed Excel sync restores prior cell values and defined names',
  sheetSync.includes('for (const old of oldCells.reverse())') && sheetSync.includes('for (const [name, ref] of oldNames)') && sheetSync.includes('throw error'));

console.log('\n3. Sheets issued-file read-only mode');
check('read-only IPC is subscribed before Flux is told the editor is ready',
  sheets.indexOf("link.on('flux:set-read-only'") >= 0 && sheets.indexOf("link.on('flux:set-read-only'") < sheets.indexOf("link.send('flux:editor-ready'"));
check('the guard blocks only workbook mutations and trusts controlled loading/collaboration',
  !!gate && readOnlyGuard.includes('journalSuppression.active || applying || applyingFlux') && readOnlyGuard.includes('new CustomCommandExecutionError'));
if (gate) {
  const shouldBlock = new Function('fluxReadOnly', 'trusted', 'command', 'MUTATION', `return ${gate}`) as (readOnly: boolean, trusted: boolean, command: { type: number }, mutation: number) => boolean;
  check('mutation is blocked in read-only mode', shouldBlock(true, false, { type: 2 }, 2));
  check('navigation and copy commands remain available', !shouldBlock(true, false, { type: 0 }, 2) && !shouldBlock(true, false, { type: 1 }, 2));
  check('trusted loading and shared application remain available', !shouldBlock(true, true, { type: 2 }, 2));
}

if (failures) process.exitCode = 1;
else console.log('\nNative header bridge contract checks passed.');
