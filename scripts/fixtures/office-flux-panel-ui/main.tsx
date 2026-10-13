import React from 'react';
import { createRoot } from 'react-dom/client';
import FluxOfficePanel, { type FluxOfficeAnchorSelection } from '../../../src/components/office/FluxOfficePanel';
import type { OfficeBinding, OfficeHeaderSchema } from '../../../src/lib/officeModel';
import type { OfficeFillPlan, OfficeState } from '../../../src/components/office/fluxData';
import './fixture.css';

declare global { interface Window { __fluxFixture: { ops: any[]; setTheme: (theme: string) => void } } }
const editorKind: 'docs' | 'sheets' = new URLSearchParams(location.search).get('kind') === 'docs' ? 'docs' : 'sheets';

const state: OfficeState = {
  baseHash: 'fixture-hash-1', sourceRevision: 'fixture-rev-1', rows: [{ entityId: 'e-old', entityType: 'element', sourceId: 'equipment', sourceRevision: 'fixture-rev-1', anchorIds: ['anchor-a1'], cells: { 'anchor-a1': editorKind === 'docs' ? 'FLUXROW_0123456789abcdef' : 'A2' }, values: { 'anchor-a1': 'P-100' } }], schema: { version: 1, anchors: [{ kind: editorKind === 'docs' ? 'word-row' : 'excel-range', id: 'anchor-a1', ...(editorKind === 'docs' ? { documentPart: 'word/document.xml' } : { sheetName: 'Лист1', address: 'A1' }), parts: [{ kind: 'text', text: 'Позиция ' }, { kind: 'field', binding: { fieldKey: 'identifier', sourceId: 'equipment', entityType: 'element', entityId: null, sourceRevision: 'fixture-rev-1', anchorId: 'anchor-a1' } }] }] },
};
const ops: any[] = [];
window.__fluxFixture = { ops, setTheme: (theme) => document.getElementById('root')?.classList.toggle('dark', theme === 'dark') };

async function persistMetadata(schema: OfficeHeaderSchema, rows = state.rows || []) {
  const response = await fetch('/api/project-data/files/fixture-file/office-state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseHash: state.baseHash, sourceRevision: state.sourceRevision, schema, rows }) });
  if (!response.ok) throw new Error('office-state fixture PUT failed');
  state.schema = schema; state.rows = rows; state.baseHash = (await response.json()).baseHash;
}

function Fixture() {
  const anchor: FluxOfficeAnchorSelection = { kind: editorKind === 'docs' ? 'word-row' : 'excel-range', anchorId: 'anchor-a1', ...(editorKind === 'docs' ? { documentPart: 'word/document.xml' } : { sheetName: 'Лист1', address: 'A1' }) };
  return <div className="fixture-shell"><main className="fixture-editor"><h1>GenOffice workbook fixture</h1><p>Штатный холст остаётся видимым за Flux add-on.</p></main>
    <FluxOfficePanel fileId="fixture-file" projectId="fixture-project" fileName={editorKind === 'docs' ? 'Пробный документ.docx' : 'Пробная книга.xlsx'} editorKind={editorKind} readOnly={false} schemaWriteAvailable activeAnchor={anchor}
      requestState={async () => structuredClone(state)}
      insertBinding={async (selected, binding: OfficeBinding, displayText) => { ops.push({ type: 'insert-field', selected, binding, displayText }); return true; }}
      applyWrites={async (plan: OfficeFillPlan, schema: OfficeHeaderSchema, rows) => {
        ops.push({ type: 'apply-plan', plan, schema, rows });
        const nextRows = [...rows.filter((row) => row.entityId !== plan.writes[0]?.entityId), { entityId: plan.writes[0]?.entityId || '', entityType: 'element', sourceId: 'equipment', sourceRevision: plan.sourceRevision, anchorIds: plan.writes.map((write) => write.anchorId), cells: { 'anchor-a1': editorKind === 'docs' ? 'FLUXROW_fedcba9876543210' : 'A3' }, values: Object.fromEntries(plan.writes.map((write) => [write.anchorId, String(write.value)])) }];
        await persistMetadata(schema, nextRows);
        return { appliedCount: plan.writes.length, manualRows: ['e-old'] };
      }}
      updateSchema={async (schema: OfficeHeaderSchema) => { ops.push({ type: 'save-schema', schema }); await persistMetadata(schema); return structuredClone(state); }}
      onClose={() => ops.push({ type: 'close' })} />
  </div>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
