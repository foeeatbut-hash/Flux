import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Btn, Dialog, Empty, Select } from '../ui';
import { takeWindowsDrop, windowsFilesRequest, type WindowsFileChoice, type WindowsFileEntry, type WindowsFileRef, type WindowsImportResult, type WindowsPublishPlan, type WindowsUndoState } from '../../lib/windowsFiles';
import { useToastStore } from '../../store/toastStore';
import { copyName, entryRef, getClip, makeClip, setClip, subscribeClip, trashQuestion, type ClipItem } from './fileOps';
import { clipboardAction, choicesForPlan, planSummary, publishRequestFor } from './explorerOperationLogic';
import type { BridgeRequest } from './createEntry';

type Progress = { done: number; total: number; label: string };
type PublishDialogState = { plan: WindowsPublishPlan; choices: Record<string, WindowsFileChoice>; applyChoice: WindowsFileChoice };
type ImportDialogState = { ticket: string; parent: WindowsFileRef; result: WindowsImportResult; names: string[]; choices: Record<string, WindowsFileChoice>; applyChoice: WindowsFileChoice; group: string; imported: number; skipped: number; failed: number };
type ClipConflict = { item: ClipItem; action: 'copy' | 'move'; existing: WindowsFileEntry };
type ClipDialogState = { items: ClipItem[]; parent: WindowsFileRef; conflicts: ClipConflict[]; choices: Record<string, WindowsFileChoice>; applyChoice: WindowsFileChoice; copyModifier: boolean; cut?: boolean; sourceClip: boolean; carryMeta: boolean };
type Listing = { entries: WindowsFileEntry[]; nextOffset: number | null; truncated: boolean };
const EMPTY_UNDO: WindowsUndoState = { undo: null, redo: null };
const CHOICES = [
  { value: 'replace', label: 'Заменить' },
  { value: 'skip', label: 'Пропустить' },
  { value: 'keepBoth', label: 'Оставить оба' },
];
const groupId = () => `explorer-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const clipKey = (item: ClipItem) => `${item.ref.rootId}\u0000${item.ref.relativePath}\u0000${item.ref.draftId || ''}`;
const sameFolder = (ref: WindowsFileRef, parent: WindowsFileRef) => ref.rootId === parent.rootId && ref.relativePath.split('/').slice(0, -1).join('/') === parent.relativePath;

async function listDestination(parent: WindowsFileRef, request: BridgeRequest): Promise<WindowsFileEntry[]> {
  const entries: WindowsFileEntry[] = [];
  let offset = 0;
  while (true) {
    const answer = await request<Listing>({ action: 'list', ref: parent, offset, limit: 500 });
    if ('error' in answer) throw new Error(answer.error.message);
    entries.push(...answer.data.entries);
    if (answer.data.truncated) throw new Error('Список папки назначения обрезан. Не удалось проверить все совпадения; обновите список и повторите.');
    if (answer.data.nextOffset === null) return entries;
    offset = answer.data.nextOffset;
  }
}

/** Общие файловые операции Проводника. Мост передан внутрь для проверки поведения без Electron. */
export function useExplorerOperations({ folder, reload, selected: _selected, rootId, request = windowsFilesRequest }: {
  folder: WindowsFileRef | null; reload: () => Promise<void>; selected: WindowsFileEntry[]; rootId: string; request?: BridgeRequest;
}) {
  const addToast = useToastStore((state) => state.addToast);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const cancelRef = useRef(false);
  const clip = useSyncExternalStore(subscribeClip, getClip, getClip);
  const [busy, setBusy] = useState(false);
  const [canCancel, setCanCancel] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [carryMetaState, setCarryMetaState] = useState(false);
  const [carryMeta, setCarryMeta] = useState(false);
  const [undo, setUndo] = useState<WindowsUndoState>(EMPTY_UNDO);
  const [progress, setProgress] = useState<Progress>();
  const [error, setError] = useState('');
  const [publishDialog, setPublishDialog] = useState<PublishDialogState | null>(null);
  const [importDialog, setImportDialog] = useState<ImportDialogState | null>(null);
  const [clipDialog, setClipDialog] = useState<ClipDialogState | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const response = useCallback(async <T,>(payload: Parameters<BridgeRequest>[0]) => {
    const answer = await request<T>(payload);
    if ('error' in answer) throw new Error(answer.error.message);
    return answer.data;
  }, [request]);

  const refreshUndo = useCallback(async () => {
    try { const value = await response<WindowsUndoState>({ action: 'undoState' }); if (mounted.current) setUndo(value); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Не удалось проверить состояние отмены.'); }
  }, [response]);
  useEffect(() => { void refreshUndo(); }, [refreshUndo]);

  const run = useCallback(async (label: string, total: number, job: (group: string, isCanceled: () => boolean) => Promise<void>, sharedGroup = groupId(), cancellable = false) => {
    if (busyRef.current || !mounted.current) return;
    busyRef.current = true; cancelRef.current = false; setCancelRequested(false); setBusy(true); setCanCancel(cancellable); setError(''); setProgress({ done: 0, total, label });
    try { await job(sharedGroup, () => cancelRef.current); if (mounted.current) await reload(); }
    catch (cause) {
      if (mounted.current) { const message = cause instanceof Error ? cause.message : 'Операция не выполнена.'; setError(message); addToast(message, 'error'); }
    } finally {
      busyRef.current = false;
      if (mounted.current) { setBusy(false); setCanCancel(false); setCancelRequested(false); setProgress(undefined); await refreshUndo(); }
    }
  }, [addToast, refreshUndo, reload]);

  const undoAction = useCallback(async (action: 'undo' | 'redo') => run(action === 'undo' ? 'Отмена действия' : 'Повтор действия', 1, async () => {
    const result = await response<{ label: string; state: WindowsUndoState }>({ action });
    if (mounted.current) { setUndo(result.state); addToast(action === 'undo' ? `Отменено: ${result.label}` : `Повторено: ${result.label}`, 'success'); }
  }), [addToast, response, run]);

  const publish = useCallback(async (entry: WindowsFileEntry) => {
    if (!rootId || !entry.draftId || busyRef.current) return;
    try {
      const plan = await response<WindowsPublishPlan>({ action: 'publishPlan', ref: { rootId, relativePath: entry.relativePath, draftId: entry.draftId } });
      if (mounted.current) setPublishDialog({ plan, choices: Object.fromEntries(plan.items.filter((item) => item.status === 'collision').map((item) => [item.draftId, 'keepBoth'])), applyChoice: 'keepBoth' });
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Не удалось проверить план публикации.'); }
  }, [response, rootId]);

  const executePublish = useCallback(async () => {
    if (!publishDialog) return;
    const { plan, choices } = publishDialog;
    const counts = planSummary(plan.items);
    if (!counts.free && !counts.collisions) return;
    setPublishDialog(null);
    await run('Публикация черновиков', counts.free + counts.collisions, async (group) => {
      const result = await response<any>({ action: publishRequestFor(plan), ref: plan.ref, choices: choicesForPlan(plan, choices), group });
      const done = typeof result.published === 'number' ? result.published : result.file ? 1 : 0;
      if (mounted.current) setProgress({ done, total: counts.free + counts.collisions, label: 'Публикация черновиков' });
      if (result.failed?.length || result.complete === false) {
        const details = Array.isArray(result.failed) ? result.failed.join('; ') : '';
        const message = `Опубликовано: ${done}. Остальные черновики сохранены в Flux${details ? `: ${details}` : '.'}`;
        if (mounted.current) { setError(message); addToast(message, 'error'); }
      } else if (mounted.current) addToast(`Опубликовано черновиков: ${done}.`, 'success');
    });
  }, [addToast, publishDialog, response, run]);

  const finishImport = useCallback(async (state: ImportDialogState) => {
    await run('Импорт перетаскиваемых объектов', state.names.length, async () => {
      const result = await response<WindowsImportResult>({ action: 'importPaths', ticket: state.ticket, parent: state.parent, resolutions: state.choices, group: state.group });
      const imported = state.imported + result.imported.length;
      const skipped = state.skipped + result.skipped.length;
      const failed = state.failed + result.failed.length;
      const done = imported + skipped + failed;
      if (result.collisions.length && mounted.current) {
        setImportDialog({ ...state, result, imported, skipped, failed, choices: Object.fromEntries(result.collisions.map((item) => [String(item.index), state.choices[String(item.index)] || 'keepBoth'])) });
        setProgress({ done, total: state.names.length, label: 'Импорт перетаскиваемых объектов' });
        return;
      }
      if (failed || !result.complete) {
        const details = result.failed.slice(0, 4).map((item) => `${item.name}: ${item.message}`).join('; ');
        const message = `Импортировано: ${imported}; пропущено: ${skipped}. Не удалось: ${details || `${failed} объект(а/ов) не обработано`}. Исходники и оставшиеся черновики сохранены.`;
        if (mounted.current) { setError(message); addToast(message, 'error'); }
      } else if (mounted.current) addToast(`Импортировано объектов: ${imported}; пропущено: ${skipped}.`, 'success');
      if (mounted.current) setProgress({ done, total: state.names.length, label: 'Импорт перетаскиваемых объектов' });
    }, state.group);
  }, [addToast, response, run]);

  const executeClip = useCallback(async (items: ClipItem[], parent: WindowsFileRef, choices: Record<string, WindowsFileChoice>, copyModifier: boolean, listed?: WindowsFileEntry[], clipOptions?: { cut: boolean; sourceClip: boolean; carryMeta: boolean }) => {
    const entries = listed || await listDestination(parent, request);
    const existing = new Map(entries.map((entry) => [entry.name.toLocaleLowerCase(), entry]));
    const successful: string[] = [];
    await run('Копирование и перемещение', items.length, async (group, isCanceled) => {
      let done = 0; const failed: string[] = [];
      for (const item of items) {
        if (isCanceled()) break;
        const action = clipOptions?.sourceClip ? (clipOptions.cut ? 'move' : 'copy') : clipboardAction(item.ref, parent, copyModifier);
        const copyInPlace = action === 'copy' && sameFolder(item.ref, parent);
        if (action === 'move' && sameFolder(item.ref, parent)) { successful.push(clipKey(item)); done++; continue; }
        const conflict = existing.get(item.name.toLocaleLowerCase());
        const choice = conflict ? (choices[clipKey(item)] || (copyInPlace ? 'keepBoth' : undefined)) : undefined;
        if (choice === 'skip') { done++; continue; }
        const name = (conflict || copyInPlace) && choice === 'keepBoth' ? copyName(item.name, new Set([...existing.values()].map((entry) => entry.name))) : item.name;
        try {
          if (conflict && choice === 'replace' && (action === 'copy' || action === 'move') && item.kind === 'file' && conflict.kind === 'file') {
            const [source, target] = await Promise.all([
              response<{ sha256: string; size: number }>({ action: 'fileHash', ref: item.ref }),
              response<{ sha256: string; size: number }>({ action: 'fileHash', ref: { rootId: parent.rootId, relativePath: conflict.relativePath, ...(conflict.draftId ? { draftId: conflict.draftId } : {}) } }),
            ]);
            await response({ action: 'replaceCopy', ref: item.ref, parent, name, targetSha256: target.sha256, baseSha256: item.sha256 || source.sha256, ...(action === 'move' ? { move: true } : {}), ...(clipOptions?.carryMeta ? { carryMeta: true } : {}), group });
          } else {
            await response({ action, ref: item.ref, parent, name, ...(action === 'move' && item.sha256 ? { baseSha256: item.sha256 } : {}), ...(action === 'copy' && clipOptions?.carryMeta ? { carryMeta: true } : {}), group });
          }
          existing.set(name.toLocaleLowerCase(), { name, relativePath: parent.relativePath ? `${parent.relativePath}/${name}` : name, storage: 'windows', kind: item.kind, fileId: item.ref.draftId || clipKey(item), size: 0, modifiedAt: '', linked: false });
          successful.push(clipKey(item));
        } catch (cause) { failed.push(`${item.name}: ${cause instanceof Error ? cause.message : 'ошибка'}`); }
        done++;
        if (mounted.current) setProgress({ done, total: items.length, label: 'Копирование и перемещение' });
      }
      if (failed.length && mounted.current) { const message = `Не удалось выполнить: ${failed.slice(0, 5).join('; ')}. Источники сохранены.`; setError(message); addToast(message, 'error'); }
      if (isCanceled() && mounted.current) setError(`Операция остановлена после ${successful.length + failed.length} из ${items.length}. Остальные файлы не изменены.`);
    }, groupId(), true);
    if (clipOptions?.sourceClip && clipOptions.cut) {
      const current = getClip();
      if (current) setClip({ ...current, items: current.items.filter((item) => !successful.includes(clipKey(item))) });
    }
  }, [addToast, request, response, run]);

  const take = useCallback(async (entries: WindowsFileEntry[], cut: boolean) => {
    if (!entries.length || busyRef.current) return;
    try { setClip(await makeClip(request, entries, rootId, cut)); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Не удалось подготовить буфер обмена.'); }
  }, [request, rootId]);

  const paste = useCallback(async (copyMetadata?: boolean) => {
    const current = getClip();
    if (!current?.items.length || !folder || busyRef.current) return;
    const carry = copyMetadata ?? carryMetaState;
    try {
      const entries = await listDestination(folder, request);
      const present = new Map(entries.map((entry) => [entry.name.toLocaleLowerCase(), entry]));
      const conflicts: ClipConflict[] = [];
      for (const item of current.items) {
        if (current.cut && sameFolder(item.ref, folder)) continue;
        const action = current.cut ? 'move' : 'copy';
        const inPlaceCopy = !current.cut && sameFolder(item.ref, folder);
        const existing = present.get(item.name.toLocaleLowerCase());
        if (existing && !inPlaceCopy) conflicts.push({ item, action, existing });
        else if (!existing && !inPlaceCopy) present.set(item.name.toLocaleLowerCase(), { name: item.name, relativePath: folder.relativePath ? `${folder.relativePath}/${item.name}` : item.name, storage: 'windows', kind: item.kind, fileId: clipKey(item), size: 0, modifiedAt: '', linked: false });
      }
      if (!mounted.current) return;
      if (conflicts.length) setClipDialog({ items: current.items, parent: folder, conflicts, choices: Object.fromEntries(conflicts.map(({ item }) => [clipKey(item), 'keepBoth'])), applyChoice: 'keepBoth', copyModifier: false, cut: current.cut, sourceClip: true, carryMeta: carry });
      else await executeClip(current.items, folder, {}, false, entries, { cut: current.cut, sourceClip: true, carryMeta: carry });
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Не удалось проверить папку назначения.'); }
  }, [carryMetaState, executeClip, folder, request]);

  const trash = useCallback(async (entries: WindowsFileEntry[], permanent = false) => {
    if (!entries.length || busyRef.current) return;
    const question = permanent
      ? `Безвозвратно удалить выбранные объекты (${entries.length})? Это действие нельзя отменить.`
      : trashQuestion(entries);
    if (typeof window !== 'undefined' && !window.confirm(question)) return;
    await run(permanent ? 'Удаление безвозвратно' : 'Перемещение в корзину', entries.length, async (group, isCanceled) => {
      let done = 0; const failed: string[] = [];
      for (const entry of entries) {
        if (isCanceled()) break;
        const ref = entryRef(entry, rootId);
        try {
          const hash = entry.kind === 'file' ? await response<{ sha256: string; size: number }>({ action: 'fileHash', ref }).then((content) => content.sha256) : undefined;
          await response({ action: permanent ? 'permanentDelete' : 'trash', ref, ...(hash ? { baseSha256: hash } : {}), ...(!permanent ? { group } : {}) });
          done++;
        } catch (cause) { failed.push(`${entry.name}: ${cause instanceof Error ? cause.message : 'ошибка'}`); }
        if (mounted.current) setProgress({ done: done + failed.length, total: entries.length, label: permanent ? 'Удаление безвозвратно' : 'Перемещение в корзину' });
      }
      if (failed.length && mounted.current) {
        const message = `${done ? `Выполнено: ${done}. ` : ''}Не удалось: ${failed.slice(0, 5).join('; ')}. Остальные объекты не удалены.`;
        setError(message); addToast(message, 'error');
      }
      if (isCanceled() && mounted.current) setError(`Операция остановлена после ${done + failed.length} из ${entries.length}. Остальные объекты не изменены.`);
      if (done && !failed.length && mounted.current) addToast(permanent ? `Удалено безвозвратно: ${done}.` : `Перемещено в корзину: ${done}.`, 'success');
    }, groupId(), true);
  }, [addToast, response, rootId, run]);

  const drop = useCallback((event: React.DragEvent, parent = folder || undefined) => {
    event.preventDefault();
    if (!parent || busyRef.current) return;
    const encoded = event.dataTransfer.getData('application/x-flux-entries');
    if (encoded) {
      try {
        const payload = JSON.parse(encoded) as { items?: ClipItem[] } | ClipItem[];
        const items = Array.isArray(payload) ? payload : payload.items;
        if (!Array.isArray(items) || !items.every((item) => item?.ref && typeof item.name === 'string')) throw new Error('Буфер Проводника повреждён.');
        const copyModifier = event.ctrlKey || event.metaKey;
        void (async () => {
          const entries = await listDestination(parent, request);
          const present = new Map(entries.map((entry) => [entry.name.toLocaleLowerCase(), entry]));
          const conflicts: ClipConflict[] = [];
          for (const item of items) {
            const action = clipboardAction(item.ref, parent, copyModifier);
            if (action === 'move' && sameFolder(item.ref, parent)) continue;
            const current = present.get(item.name.toLocaleLowerCase());
            if (current) conflicts.push({ item, action, existing: current });
            else present.set(item.name.toLocaleLowerCase(), { name: item.name, relativePath: parent.relativePath ? `${parent.relativePath}/${item.name}` : item.name, storage: 'windows', kind: item.kind, fileId: clipKey(item), size: 0, modifiedAt: '', linked: false });
          }
          if (!mounted.current) return;
          if (entries.length && conflicts.length) setClipDialog({ items, parent, conflicts, choices: Object.fromEntries(conflicts.map(({ item }) => [clipKey(item), 'keepBoth'])), applyChoice: 'keepBoth', copyModifier, sourceClip: false, carryMeta: false });
          else if (conflicts.length) throw new Error('Не удалось подтвердить свободное имя в папке назначения.');
          else await executeClip(items, parent, {}, copyModifier, entries);
        })().catch((cause) => { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Не удалось проверить папку назначения.'); });
      } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Не удалось прочитать буфер Проводника.'); }
      return;
    }
    const ticket = takeWindowsDrop();
    if (!ticket) { setError('Windows не передала билет импорта. Повторите перетаскивание.'); return; }
    const group = groupId();
    void run('Импорт перетаскиваемых объектов', ticket.names.length, async (operationGroup) => {
      try {
        const result = await response<WindowsImportResult>({ action: 'importPaths', ticket: ticket.ticket, parent, group: operationGroup });
        if (result.collisions.length && mounted.current) {
          setImportDialog({ ticket: ticket.ticket, parent, result, names: ticket.names, choices: Object.fromEntries(result.collisions.map((item) => [String(item.index), 'keepBoth'])), applyChoice: 'keepBoth', group: operationGroup, imported: result.imported.length, skipped: result.skipped.length, failed: result.failed.length });
          return;
        }
        if (result.failed.length || !result.complete) {
          const details = result.failed.slice(0, 4).map((item) => `${item.name}: ${item.message}`).join('; ');
          const message = `Импортировано: ${result.imported.length}. Не удалось: ${details || 'часть объектов не обработана'}. Источники сохранены.`;
          if (mounted.current) { setError(message); addToast(message, 'error'); }
        } else if (mounted.current) addToast(`Импортировано объектов: ${result.imported.length}; пропущено: ${result.skipped.length}.`, 'success');
        if (mounted.current) setProgress({ done: result.imported.length + result.skipped.length + result.failed.length, total: ticket.names.length, label: 'Импорт перетаскиваемых объектов' });
      } catch (cause) { if (mounted.current) { const message = cause instanceof Error ? cause.message : 'Импорт не выполнен; источники сохранены.'; setError(message); addToast(message, 'error'); } }
    });
  }, [addToast, executeClip, folder, request, response, run]);

  const resolveImport = useCallback(async () => { if (!importDialog) return; const state = importDialog; setImportDialog(null); await finishImport(state); }, [finishImport, importDialog]);
  const resolveClip = useCallback(async () => { if (!clipDialog) return; const state = clipDialog; setClipDialog(null); await executeClip(state.items, state.parent, state.choices, state.copyModifier, undefined, { cut: !!state.cut, sourceClip: state.sourceClip, carryMeta: state.carryMeta }); }, [clipDialog, executeClip]);

  const cancel = useCallback(() => { if (canCancel) { cancelRef.current = true; setCancelRequested(true); } }, [canCancel]);

  const element = <>
    {error && <p className="mb-2 text-sm text-rose-600 dark:text-rose-400" role="alert" aria-live="polite">{error}</p>}
    {canCancel && <Btn onClick={cancel} disabled={cancelRequested}>Остановить после текущего файла</Btn>}
    {publishDialog && <PublishReview state={publishDialog} busy={busy} onChange={setPublishDialog} onClose={() => setPublishDialog(null)} onSubmit={() => void executePublish()} />}
    {importDialog && <ImportReview state={importDialog} busy={busy} onChange={setImportDialog} onClose={() => { setImportDialog(null); void reload(); }} onSubmit={() => void resolveImport()} />}
    {clipDialog && <ClipReview state={clipDialog} busy={busy} onChange={setClipDialog} onClose={() => setClipDialog(null)} onSubmit={() => void resolveClip()} />}
  </>;
  return { busy, undo, progress, clip, carryMeta: carryMetaState, setCarryMeta: setCarryMetaState, refreshUndo,
    copy: (entries: WindowsFileEntry[]) => void take(entries, false), cut: (entries: WindowsFileEntry[]) => void take(entries, true),
    paste, trash, clearClip: () => setClip(null), cancel, undoLast: () => void undoAction('undo'), redoLast: () => void undoAction('redo'), publish, drop, element };
}

function PublishReview({ state, busy, onChange, onClose, onSubmit }: { state: PublishDialogState; busy: boolean; onChange: (next: PublishDialogState) => void; onClose: () => void; onSubmit: () => void }) {
  const counts = planSummary(state.plan.items);
  const blocked = state.plan.items.filter((item) => item.status === 'blocked');
  const conflicts = state.plan.items.filter((item) => item.status === 'collision');
  const applyAll = () => onChange({ ...state, choices: Object.fromEntries(conflicts.map((item) => [item.draftId, item.replaceable === false && state.applyChoice === 'replace' ? 'keepBoth' : state.applyChoice])) });
  return <Dialog title="Публикация черновика" onClose={onClose} busy={busy} width="max-w-2xl" scrollBody footer={<><Btn onClick={onClose} disabled={busy}>Отмена</Btn><Btn tone="primary" onClick={onSubmit} disabled={busy || state.plan.truncated || (!counts.free && !counts.collisions)}>Опубликовать доступные</Btn></>}>
    <p>Свободно: {counts.free}; совпадений: {counts.collisions}; заблокировано: {counts.blocked}.</p>
    {conflicts.length > 0 && <>
      <div className="mt-3 flex items-end gap-2"><label className="min-w-0 flex-1 text-sm font-medium">Решение для всех совпадений<Select value={state.applyChoice} onChange={(value) => onChange({ ...state, applyChoice: value as WindowsFileChoice })} options={CHOICES} /></label><Btn onClick={applyAll}>Применить ко всем</Btn></div>
      <ul className="mt-3 space-y-2">{conflicts.map((item) => <li key={item.draftId} className="grid grid-cols-[minmax(0,1fr)_12rem] items-center gap-2"><span className="truncate" title={item.targetPath}>{item.name} · {item.targetPath}</span><Select aria-label={`Решение для ${item.name}`} value={state.choices[item.draftId] || 'keepBoth'} onChange={(value) => onChange({ ...state, choices: { ...state.choices, [item.draftId]: value as WindowsFileChoice } })} options={item.replaceable === false ? CHOICES.filter((choice) => choice.value !== 'replace') : CHOICES} /></li>)}</ul>
    </>}
    {blocked.length > 0 && <div className="mt-3" role="alert"><strong>Некоторые объекты недоступны:</strong><ul className="list-disc pl-5">{blocked.slice(0, 8).map((item) => <li key={item.draftId}>{item.name}: {item.reason || 'публикация заблокирована'}</li>)}</ul></div>}
    {state.plan.truncated && <p className="mt-3 text-amber-700 dark:text-amber-300" role="alert">План ограничен по числу объектов и неполон. Публикация отключена, чтобы не принимать решение по непоказанным объектам.</p>}
    {!counts.free && !counts.collisions && <Empty title="Нет доступных объектов" text="Исправьте причины блокировки и повторите публикацию." />}
  </Dialog>;
}

function ImportReview({ state, busy, onChange, onClose, onSubmit }: { state: ImportDialogState; busy: boolean; onChange: (next: ImportDialogState) => void; onClose: () => void; onSubmit: () => void }) {
  const applyAll = () => onChange({ ...state, choices: Object.fromEntries(state.result.collisions.map((item) => [String(item.index), item.kind === 'file' && item.existing.kind === 'file' && state.applyChoice === 'replace' ? 'replace' : state.applyChoice === 'replace' ? 'keepBoth' : state.applyChoice])) });
  return <Dialog title="Совпадающие имена" onClose={onClose} busy={busy} scrollBody footer={<><Btn onClick={onClose} disabled={busy}>Оставить без решения</Btn><Btn tone="primary" onClick={onSubmit} disabled={busy}>Продолжить импорт</Btn></>}>
    <p>Файлы без совпадений уже скопированы. Для совпадений выберите решение; исходные файлы остаются на месте.</p>
    <div className="mt-3 flex items-end gap-2"><label className="min-w-0 flex-1 text-sm font-medium">Решение для всех совпадений<Select value={state.applyChoice} onChange={(value) => onChange({ ...state, applyChoice: value as WindowsFileChoice })} options={CHOICES} /></label><Btn onClick={applyAll}>Применить ко всем</Btn></div>
    <ul className="my-3 space-y-2">{state.result.collisions.map((item) => <li key={item.index} className="grid grid-cols-[minmax(0,1fr)_12rem] items-center gap-2"><span className="truncate">{item.name} · {item.kind}</span><Select aria-label={`Решение для ${item.name}`} value={state.choices[String(item.index)] || 'keepBoth'} onChange={(value) => onChange({ ...state, choices: { ...state.choices, [String(item.index)]: value as WindowsFileChoice } })} options={item.kind === 'file' && item.existing.kind === 'file' ? CHOICES : CHOICES.filter((choice) => choice.value !== 'replace')} /></li>)}</ul>
    {state.result.failed.length > 0 && <p role="alert">Ошибки: {state.result.failed.map((item) => `${item.name}: ${item.message}`).join('; ')}</p>}
  </Dialog>;
}

function ClipReview({ state, busy, onChange, onClose, onSubmit }: { state: ClipDialogState; busy: boolean; onChange: (next: ClipDialogState) => void; onClose: () => void; onSubmit: () => void }) {
  const applyAll = () => onChange({ ...state, choices: Object.fromEntries(state.conflicts.map(({ item, existing }) => [clipKey(item), state.applyChoice === 'replace' && !(item.kind === 'file' && existing.kind === 'file') ? 'keepBoth' : state.applyChoice])) });
  return <Dialog title="Совпадающие имена" onClose={onClose} busy={busy} scrollBody footer={<><Btn onClick={onClose} disabled={busy}>Отмена</Btn><Btn tone="primary" onClick={onSubmit} disabled={busy}>Продолжить</Btn></>}>
    <p>Папка назначения проверена полностью. Выберите решение для каждого совпадения; файл можно заменить копированием или переносом.</p>
    {state.conflicts.some((conflict) => conflict.action === 'copy') && <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={state.carryMeta} onChange={(event) => onChange({ ...state, carryMeta: event.target.checked })} />Перенести теги, проекты, ревизию и ответственного</label>}
    <div className="mt-3 flex items-end gap-2"><label className="min-w-0 flex-1 text-sm font-medium">Решение для всех совпадений<Select value={state.applyChoice} onChange={(value) => onChange({ ...state, applyChoice: value as WindowsFileChoice })} options={CHOICES} /></label><Btn onClick={applyAll}>Применить ко всем</Btn></div>
    <ul className="my-3 space-y-2">{state.conflicts.map(({ item, action, existing }) => {
      const canReplace = item.kind === 'file' && existing.kind === 'file';
      return <li key={clipKey(item)} className="grid grid-cols-[minmax(0,1fr)_12rem] items-center gap-2"><span className="truncate">{item.name} · {action === 'move' ? 'перенос' : 'копирование'}</span><Select aria-label={`Решение для ${item.name}`} value={state.choices[clipKey(item)] || 'keepBoth'} onChange={(value) => onChange({ ...state, choices: { ...state.choices, [clipKey(item)]: value as WindowsFileChoice } })} options={canReplace ? CHOICES : CHOICES.filter((choice) => choice.value !== 'replace')} /></li>;
    })}</ul>
  </Dialog>;
}
