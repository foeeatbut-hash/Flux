import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import FluxSaveHost from '../../src/components/explorer/FluxSaveDialog';
import ToastProvider from '../../src/components/ToastProvider';
import { reportSaveError, saveBytes, saveText } from '../../src/lib/saveToWindows';
import { useFluxSaveStore } from '../../src/store/fluxSaveStore';
import '../../src/index.css';

/** Страница для проверки окна «Сохранить в Проводнике Flux»: кнопки вызывают те же функции, что и экраны программы. */
function Fixture() {
  const [out, setOut] = useState('');
  return <main className="p-6 flex flex-col gap-3 items-start">
    <button className="fx-btn" onClick={async () => setOut(JSON.stringify(await saveBytes('Смета.xlsx', new Uint8Array([1, 2, 3]), { dir: (window as any).__originDir || '' })))}>Сохранить смету</button>
    <button className="fx-btn" onClick={async () => { const r = await saveText('Пароли.csv', 'a;b'); reportSaveError(r); setOut(JSON.stringify(r)); }}>Сохранить пароли</button>
    <button className="fx-btn" onClick={async () => setOut(JSON.stringify(await useFluxSaveStore.getState().pickFolder({ title: 'Куда сохранить папку', confirmLabel: 'Сохранить сюда' })))}>Выбрать папку</button>
    <output aria-label="Результат">{out}</output>
    <FluxSaveHost />
    <ToastProvider />
  </main>;
}

createRoot(document.getElementById('mount')!).render(<Fixture />);
