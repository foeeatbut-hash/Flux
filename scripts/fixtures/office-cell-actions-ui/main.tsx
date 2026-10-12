import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import FluxCellActionsDialog, { type FluxCellActionAnchor } from '../../../src/components/office/FluxCellActionsDialog';
import type { OfficeField } from '../../../src/components/office/fluxData';
import type { OfficeBinding } from '../../../src/lib/officeModel';
import './style.css';

declare global { interface Window { __cellActionsFixture: { setTheme: (theme: string) => void; ops: any[] } } }
const fields: OfficeField[] = [
  { sourceId: 'equipment', entityType: 'element', fieldKey: 'param:@DrivePower', displayName: 'DrivePower', unit: 'kW', kind: 'number' },
  { sourceId: 'equipment', entityType: 'element', fieldKey: 'param:@MotorPower', displayName: 'MotorPower', unit: 'kW', kind: 'number' },
];
const binding = (field: OfficeField, anchorId: string): OfficeBinding => ({ ...field, entityId: null, sourceRevision: 'fixture-revision', anchorId });
const selected: FluxCellActionAnchor[] = [
  { anchorId: 'anchor-a1', kind: 'excel-range', sheetName: 'Перечень', address: 'A1', displayText: 'Drive Power', parts: [{ kind: 'field', binding: binding(fields[0], 'anchor-a1') }] },
  { anchorId: 'anchor-b1', kind: 'excel-range', sheetName: 'Перечень', address: 'B1', displayText: 'Motor Power', parts: [{ kind: 'field', binding: binding(fields[1], 'anchor-b1') }] },
];
const ops: any[] = [];
window.__cellActionsFixture = { ops, setTheme: (theme) => document.documentElement.classList.toggle('dark', theme === 'dark') };

function Fixture() {
  const [open, setOpen] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  return <main className="fixture-shell">
    <section className="fixture-sheet" aria-label="Native sheet fixture"><h1>Перечень</h1><div className="grid"><span></span><span>A</span><span>B</span><span>1</span><span>Drive Power</span><span>Motor Power</span><span>2</span><span>120</span><span>95</span></div></section>
    <aside className="fixture-controls"><button onClick={() => { setReadOnly(false); setOpen(true); }}>Открыть действия с двумя ячейками</button><button onClick={() => { setReadOnly(true); setOpen(true); }}>Открыть только для просмотра</button><output aria-live="polite">{open ? 'Действия открыты' : 'Действия закрыты'}</output></aside>
    <FluxCellActionsDialog open={open} selectedAnchors={selected} fields={fields} readOnly={readOnly}
      onCancel={() => { ops.push({ type: 'cancel' }); setOpen(false); }}
      onPreviewMerge={async (request) => { ops.push({ type: 'preview', request }); return { ok: true, previewToken: 'fixture-token', conflicts: [] }; }}
      onConfirmMerge={async (request) => { ops.push({ type: 'confirm', request }); return { ok: true }; }} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
