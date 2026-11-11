/**
 * Автономная страница-стенд редакторов: монтирует раздел с образцом черновика без оболочки Studio.
 * Нужна проверкам в браузере (scripts/test-studio-editor-ui.ts) и тому, кто правит редакторы:
 * оболочка подключает тот же компонент через studio/renderer/editors/index.tsx.
 *
 * Тема Studio берётся из адреса (?theme=dark), чтобы снимки обеих тем не зависели от ОС.
 */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Editors from '../index';
import { sampleFiles } from '../sample';

declare global { interface Window { __files: Record<string, string>; __changes: number; __failSave: string } }

const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'dark' || theme === 'light') document.documentElement.classList.toggle('dark', theme === 'dark');

/** Оболочка в миниатюре: хранит файлы проекта, принимает изменённые и отдаёт обновлённый черновик */
function Harness() {
  const [files, setFiles] = useState<Record<string, string>>(() => sampleFiles());
  window.__files = files;
  return (
    <div style={{ height: '100vh' }}>
      <Editors moduleId="equipment-inspector" draft={{ files, binary: [] }} onChange={async changed => {
        window.__changes = (window.__changes ?? 0) + 1;
        if (window.__failSave) return window.__failSave;
        setFiles(previous => ({ ...previous, ...changed }));
        return '';
      }} />
    </div>
  );
}

window.__changes = 0;
window.__failSave = '';
createRoot(document.getElementById('root')!).render(<Harness />);
