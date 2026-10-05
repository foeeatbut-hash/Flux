import React, { useEffect, useRef, useState } from 'react';
import type { CatalogSection } from '../../../catalog/model';
import { loadCatalogAsset } from '../../services/catalogAssetService';
import { loadPdfJs } from '../../import/pdfShared';

/** Только содержание: физическая страница нужна рендереру, а не читателю. */
function Illustration({ section }: { section: CatalogSection }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false; let task: any; let render: any; let url = '';
    setError('');
    setBusy(false);
    canvas.current?.getContext('2d')?.clearRect(0, 0, canvas.current.width, canvas.current.height);
    if (!section.source.assetId || !section.source.physicalPage) return;
    setBusy(true);
    void (async () => {
      try {
        url = await loadCatalogAsset(section.source.assetId!);
        if (stopped) { URL.revokeObjectURL(url); return; }
        const pdfjs = await loadPdfJs();
        if (stopped) return;
        task = pdfjs.getDocument({ url });
        const document = await task.promise;
        const page = await document.getPage(section.source.physicalPage!);
        if (stopped || !canvas.current) return;
        const viewport = page.getViewport({ scale: 1.8 * zoom });
        const target = canvas.current;
        target.width = viewport.width; target.height = viewport.height;
        render = page.render({ canvasContext: target.getContext('2d'), viewport });
        await render.promise;
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : 'Не удалось открыть иллюстрацию'); }
      finally { if (!stopped) setBusy(false); }
    })();
    return () => { stopped = true; render?.cancel(); void task?.destroy(); if (url) URL.revokeObjectURL(url); };
  }, [section.id, section.source.assetId, section.source.physicalPage, zoom]);
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-xs font-medium">Схемы, таблицы и иллюстрации</h3><button type="button" className="fx-btn fx-btn-sm" onClick={() => setZoom(z => z === 1 ? 2 : 1)}>{zoom === 1 ? 'Увеличить' : 'По ширине'}</button></div>
    {busy && <p role="status" className="text-xs text-slate-500 dark:text-slate-400">Открываем иллюстрацию…</p>}
    {error && <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}
    {!section.source.assetId && <p className="text-xs text-slate-500 dark:text-slate-400">Иллюстрация ещё не добавлена в справочник.</p>}
    <div className="max-h-[70vh] overflow-auto border border-slate-200 dark:border-slate-700"><canvas ref={canvas} aria-label={section.title} className={zoom === 1 ? 'block h-auto w-full bg-white' : 'block h-auto max-w-none bg-white'} /></div>
  </div>;
}

export default function CatalogContents({ sections, kind }: { sections: CatalogSection[]; kind?: 'marking' | 'specs' }) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const filtered = sections.filter(section => (!kind || (kind === 'marking' ? section.kind === 'marking' : ['dimensions','selection'].includes(section.kind)))
    && (!query.trim() || `${section.title} ${section.text}`.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))));
  const selected = filtered.find(s => s.id === selectedId) || filtered[0];
  if (!sections.length) return null;
  return <section className="space-y-3" aria-label="Содержание справочника">
    <h3 className="text-sm font-medium">{kind === 'marking' ? 'Обозначения и исполнение' : kind === 'specs' ? 'Размеры и подбор' : 'Устройство, применение и инструкции'}</h3>
    <input className="fx-input w-full" aria-label="Поиск в содержании модели" placeholder="Например, подключение, масса, 230 В" value={query} onChange={e => setQuery(e.target.value)} />
    <div className="flex flex-wrap gap-1">{filtered.map((section, index) => <button key={section.id} type="button" className="fx-btn fx-btn-sm max-w-full" aria-pressed={section.id === selected?.id} onClick={() => setSelectedId(section.id)}><span className="truncate">{section.title}{filtered.some((s, i) => i !== index && s.title === section.title) ? ` · ${index + 1}` : ''}</span></button>)}</div>
    {selected ? <div className="space-y-3"><h4 className="text-sm font-medium">{selected.title}</h4><Illustration section={selected} />
      <details><summary className="cursor-pointer text-xs text-slate-600 dark:text-slate-300">Текст и значения для поиска и копирования</summary><pre className="mt-2 max-h-[50vh] overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-5 text-slate-700 dark:text-slate-300">{selected.text}</pre></details>
    </div> : <p className="text-xs text-slate-500 dark:text-slate-400">Разделы не найдены.</p>}
  </section>;
}
