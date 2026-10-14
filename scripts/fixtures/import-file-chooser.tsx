import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ImportFileChooser from '../../src/components/ImportFileChooser';
import '../../src/index.css';

function Fixture() {
  const [picked, setPicked] = useState('');
  const onFiles = async (files: File[]) => {
    const values = await Promise.all(files.map(async file => `${file.name}|${file.type}|${file.lastModified}|${[...new Uint8Array(await file.arrayBuffer())].join(',')}`));
    setPicked(values.join(';'));
  };
  return <main className="p-6"><ImportFileChooser accept="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple onFiles={files => void onFiles(files)} /><output aria-label="Полученные файлы">{picked}</output></main>;
}

createRoot(document.getElementById('mount')!).render(<Fixture />);
