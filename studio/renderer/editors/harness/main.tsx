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
import { sampleDraft } from '../sample';
import type { ModuleDraft } from '../types';

declare global { interface Window { __draft: ModuleDraft; __changes: number } }

const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;

function Harness() {
  const [draft, setDraft] = useState<ModuleDraft>(() => sampleDraft());
  window.__draft = draft;
  return (
    <div style={{ height: '100vh' }}>
      <Editors moduleId="equipment-inspector" draft={draft} onChange={next => { window.__changes = (window.__changes ?? 0) + 1; setDraft(next); }} />
    </div>
  );
}

window.__changes = 0;
createRoot(document.getElementById('root')!).render(<Harness />);
