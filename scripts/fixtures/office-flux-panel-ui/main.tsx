import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import FluxPanel from '../../../src/components/office/FluxPanel';
import './fixture.css';

function Fixture() {
  return <div style={{ height: '100vh', width: '100vw', background: 'var(--flux-bg)' }}>
    <div style={{ height: '100%', width: '100%', display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ height: '100%', width: '100%', maxWidth: 460 }}>
        <FluxPanel fileId="fixture-file" projectId="p1" editorKind="docs" readOnly={false} onClose={() => {}} onInsertTable={async () => true} />
      </div>
    </div>
  </div>;
}

createRoot(document.getElementById('root')!).render(<BrowserRouter><Fixture /></BrowserRouter>);
