import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Btn, Empty } from '../ui';
import { windowsFilesRequest, type WindowsFileRef, type WindowsRecycleBin, type WindowsRecycleItem } from '../../lib/windowsFiles';
import { restoreTrashedDraft } from './fileOps';
import type { BridgeRequest } from './createEntry';

type TrashedDraft = { ref: WindowsFileRef; name: string; fileId: string };

/** Две корзины имеют отдельные команды возврата: Windows и черновики Flux. */
export default function RecyclePane({ onChanged, request = windowsFilesRequest }: { onChanged: () => void; request?: BridgeRequest }) {
  const alive = useRef(false);
  const running = useRef(false);
  const [bin, setBin] = useState<WindowsRecycleBin>({ supported: true, items: [] });
  const [drafts, setDrafts] = useState<TrashedDraft[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (running.current) return;
    running.current = true; setLoading(true); setError('');
    try {
      const [windows, flux] = await Promise.all([
        request<WindowsRecycleBin>({ action: 'recycleBin' }),
        request<TrashedDraft[]>({ action: 'draftTrash' }),
      ]);
      if (!alive.current) return;
      if ('error' in windows) throw new Error(windows.error.message);
      if ('error' in flux) throw new Error(flux.error.message);
      setBin(windows.data); setDrafts(flux.data); setSelected((ids) => ids.filter((id) => windows.data.items.some((item) => item.id === id)));
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить корзины.'); }
    finally { running.current = false; if (alive.current) setLoading(false); }
  }, [request]);

  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]);

  const perform = useCallback(async (action: 'recycleBinRestore' | 'recycleBinPurge' | 'recycleBinEmpty', ids?: string[]) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await request(action === 'recycleBinEmpty' ? { action } : { action, ids: ids || [] });
      if ('error' in result) throw new Error(result.error.message);
      if (alive.current) { setSelected([]); await load(); onChanged(); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Операция с корзиной не выполнена.'); }
    finally { if (alive.current) setBusy(false); }
  }, [busy, load, onChanged, request]);

  const restoreDraft = useCallback(async (draft: TrashedDraft) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await restoreTrashedDraft(request, draft.ref); if (alive.current) { await load(); onChanged(); } }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Черновик не восстановлен.'); }
    finally { if (alive.current) setBusy(false); }
  }, [busy, load, onChanged, request]);

  const purgeDrafts = useCallback(async (items: TrashedDraft[]) => {
    if (busy || !items.length) return;
    setBusy(true); setError('');
    try {
      const failures: string[] = [];
      for (const draft of items) {
        const result = await request({ action: 'purgeDraft', ref: draft.ref });
        if ('error' in result) failures.push(`${draft.name}: ${result.error.message}`);
      }
      if (alive.current) {
        await load();
        if (failures.length) setError(`Не удалось удалить некоторые черновики: ${failures.join('; ')}`);
        else onChanged();
      }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Черновики не удалены.'); }
    finally { if (alive.current) setBusy(false); }
  }, [busy, load, onChanged, request]);

  // A trashed directory may have trashed descendants; purgeDraft removes the
  // entire subtree, so the bulk action sends only the outermost roots.
  const draftRoots = drafts.filter((draft) => !drafts.some((other) => other !== draft && other.ref.rootId === draft.ref.rootId && draft.ref.relativePath.startsWith(`${other.ref.relativePath}/`)));

  const toggle = (item: WindowsRecycleItem) => setSelected((ids) => ids.includes(item.id) ? ids.filter((id) => id !== item.id) : [...ids, item.id]);
  const openWindowsBin = async () => {
    const result = await request({ action: 'openRecycleBin' });
    if ('error' in result) setError(result.error.message);
  };

  return <section aria-label="Корзины файлов" className="space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">Корзина</h2><div className="flex gap-2"><Btn onClick={() => void load()} disabled={loading || busy}>Обновить</Btn>{bin.supported && <Btn tone="danger" onClick={() => { if (window.confirm('Безвозвратно очистить корзину Windows?')) void perform('recycleBinEmpty'); }} disabled={busy || !bin.items.length}>Очистить корзину Windows</Btn>}</div></header>
    {error && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
    <section aria-labelledby="windows-recycle-title" className="space-y-2">
      <div className="flex items-center justify-between gap-2"><h3 id="windows-recycle-title" className="font-medium">Корзина Windows</h3><div className="flex gap-2"><Btn onClick={() => void perform('recycleBinRestore', selected)} disabled={busy || !selected.length}>Восстановить выбранное</Btn><Btn tone="danger" onClick={() => { if (window.confirm(`Безвозвратно удалить выбранные объекты (${selected.length})?`)) void perform('recycleBinPurge', selected); }} disabled={busy || !selected.length}>Удалить безвозвратно</Btn></div></div>
      {!bin.supported ? <div className="rounded border p-3"><p>{bin.message || 'Список корзины Windows недоступен.'}</p>{bin.fallback === 'openRecycleBin' && <Btn className="mt-2" onClick={() => void openWindowsBin()}>Открыть корзину Windows</Btn>}</div>
        : bin.items.length === 0 ? <Empty title="Корзина Windows пуста" /> : <ul className="divide-y rounded border">{bin.items.map((item) => <li key={item.id} className="flex items-center gap-3 p-2">
          <input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggle(item)} aria-label={`Выбрать ${item.name}`} />
          <span className="min-w-0 flex-1"><span className="block truncate">{item.name}</span><small className="text-slate-500">{item.location}{item.deletedAt ? ` · ${new Date(item.deletedAt).toLocaleString()}` : ''}</small></span>
          <Btn onClick={() => void perform('recycleBinRestore', [item.id])} disabled={busy}>Восстановить</Btn><Btn tone="danger" onClick={() => { if (window.confirm(`Безвозвратно удалить «${item.name}»?`)) void perform('recycleBinPurge', [item.id]); }} disabled={busy}>Удалить</Btn>
        </li>)}</ul>}
    </section>
    <section aria-labelledby="flux-trash-title" className="space-y-2">
      <div className="flex items-center justify-between gap-2"><h3 id="flux-trash-title" className="font-medium">Корзина черновиков Flux</h3><Btn tone="danger" onClick={() => { if (window.confirm(`Безвозвратно удалить ${draftRoots.length} ${draftRoots.length === 1 ? 'черновик' : 'черновика'} Flux и их содержимое?`)) void purgeDrafts(draftRoots); }} disabled={busy || !drafts.length}>Очистить черновики Flux</Btn></div>
      {drafts.length === 0 ? <Empty title="Удалённых черновиков нет" /> : <ul className="divide-y rounded border">{drafts.map((draft) => <li key={draft.ref.draftId || draft.fileId} className="flex items-center gap-3 p-2"><span className="min-w-0 flex-1 truncate">{draft.name}</span><Btn onClick={() => void restoreDraft(draft)} disabled={busy}>Восстановить в Flux</Btn><Btn tone="danger" onClick={() => { if (window.confirm(`Безвозвратно удалить черновик «${draft.name}» и его содержимое?`)) void purgeDrafts([draft]); }} disabled={busy}>Удалить из Flux</Btn></li>)}</ul>}
    </section>
  </section>;
}
