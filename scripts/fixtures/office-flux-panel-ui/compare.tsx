import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import FluxPanel from '../../../src/components/office/FluxPanel';
import FluxOfficePanel from '../../../src/components/office/FluxOfficePanel';
import type { RibbonCommand } from '../../../src/components/office/useFluxRibbon';
import './fixture.css';

/**
 * Старая и новая панель на одних и тех же данных: «Вставить все», XLSX, CSV.
 * ?panel=old — прежняя FluxPanel (источник «Теги»), ?panel=new — FluxOfficePanel
 * (команда ленты «Выгрузить»). Страница только запоминает, что получил хост
 * (вставленные таблицы) и что скачал пользователь (имена и содержимое файлов);
 * сравнивает их scripts/fixtures/office-flux-panel-ui/compare.mjs.
 */
declare global { interface Window { __inserted: unknown[][][]; __downloads: Array<{ name: string; base64: string }>; __command: (name: RibbonCommand['name']) => void } }
window.__inserted = [];
window.__downloads = [];

// Скачивание: ссылка на blob. Запоминаем имя и байты до того, как ссылка будет отозвана
const blobs = new Map<string, Blob>();
const createObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (object: Blob | MediaSource) => { const href = createObjectURL(object); if (object instanceof Blob) blobs.set(href, object); return href; };
const click = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  const blob = blobs.get(this.href);
  if (blob && this.download) {
    void blob.arrayBuffer().then((buffer) => {
      let binary = ''; const bytes = new Uint8Array(buffer);
      for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
      window.__downloads.push({ name: this.download, base64: btoa(binary) });
    });
  }
  // Сам файл не скачиваем: стенду нужны только имя и содержимое
};

const panel = new URLSearchParams(location.search).get('panel') === 'old' ? 'old' : 'new';
const onInsertTable = async (rows: (string | number)[][]) => { window.__inserted.push(rows as any); return true; };
const state = { baseHash: 'h', sourceRevision: 'r', schema: { version: 1 as const, anchors: [] }, rows: [] };

function Compare() {
  const [command, setCommand] = React.useState<RibbonCommand | null>(null);
  window.__command = (name) => setCommand((current) => ({ seq: (current?.seq || 0) + 1, name }));
  return <div style={{ display: 'flex', height: '100%' }}><main style={{ flex: 1 }} />
    {panel === 'old'
      ? <FluxPanel fileId="file" projectId="project" editorKind="docs" fileName="Документ.docx" readOnly={false} onClose={() => undefined} onInsertTable={onInsertTable} />
      : <FluxOfficePanel fileId="file" projectId="project" fileName="Документ.docx" editorKind="docs" readOnly={false} schemaWriteAvailable activeAnchor={null}
        requestState={async () => structuredClone(state)} insertBinding={async () => true} applyWrites={async () => false} updateSchema={async () => structuredClone(state)}
        command={command} onInsertTable={onInsertTable} onClose={() => undefined} />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<MemoryRouter><Compare /></MemoryRouter>);
