import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ImportFileChooser from '../../src/components/ImportFileChooser';
import type { SelectionProvenance } from '../../filesystem/contracts';
import '../../src/index.css';

function Fixture() {
  const [picked, setPicked] = useState('');
  const onFiles = async (files: File[], provenance?: SelectionProvenance[]) => {
    (window as any).__receivedProvenance = provenance;
    const values = await Promise.all(files.map(async file => `${file.name}|${file.type}|${file.lastModified}|${[...new Uint8Array(await file.arrayBuffer())].join(',')}`));
    setPicked(values.join(';'));
  };
  return <main className="p-6"><ImportFileChooser accept="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple onFiles={(files, provenance) => void onFiles(files, provenance)} /><output aria-label="Полученные файлы">{picked}</output></main>;
}

createRoot(document.getElementById('mount')!).render(<Fixture />);
