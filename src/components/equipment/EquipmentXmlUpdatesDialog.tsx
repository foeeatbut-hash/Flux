import { useEffect, useRef, useState } from 'react';
import { captureEquipmentSourceBindings, getEquipmentSourceBinding, pickEquipmentSourceFolder, planEquipmentSourceFolderRebind, rebindEquipmentSourceFolders, restoreEquipmentSourceBindings } from '../../lib/equipmentSourcesLocal';
import type { LocalEquipmentSourceBinding } from '../../lib/equipmentSourcesLocal';
import type { WindowsFileRef } from '../../lib/windowsFiles';
import EquipmentXmlSourcePanel from './EquipmentXmlSourcePanel';

type Candidate = { id: string; revision: string; status: string; changes?: unknown[]; structuralCount?: number; updatedAt: string };
type Source = { sourceId: string; projectId?: string; tagId?: string; tagIdentifier?: string; xmlTargetIdentity?: LocalEquipmentSourceBinding['xmlTargetIdentity']; elementId: string; targetType: 'system' | 'component'; systemId?: string; revisionOrder?: string[]; selectedRule?: LocalEquipmentSourceBinding['selectedRule']; updatedAt: string; lastImportedRevision?: string | null; latestCandidate?: Candidate | null };
type UndoState = ReturnType<typeof rebindEquipmentSourceFolders>;
const api = (path: string) => `/api${path}`;
const isPending = (status?: string) => status === 'pending' || status === 'partial';

/** Общий список найденных XML-кандидатов и безопасная перепривязка локальных папок. */
export default function EquipmentXmlUpdatesDialog(props: { projectId: string; canManage: boolean; localStatuses: Record<string, { status: string; revision?: string }>; onClose: () => void; onChanged: () => void }) {
  const { projectId, canManage, localStatuses, onClose, onChanged } = props;
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [folder, setFolder] = useState<WindowsFileRef | null>(null);
  const [folderPlan, setFolderPlan] = useState<Array<{ sourceId: string; folder: WindowsFileRef; binding?: LocalEquipmentSourceBinding }>>([]);
  const [folderSnapshot, setFolderSnapshot] = useState<ReturnType<typeof captureEquipmentSourceBindings>>([]);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);
  const [reviewSourceIds, setReviewSourceIds] = useState<string[]>([]);
  const busyRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const activeProjectRef = useRef(projectId);
  activeProjectRef.current = projectId;
  const [loadedProjectId, setLoadedProjectId] = useState(projectId);
  const load = async () => {
    const requestedProjectId = projectId;
    const generation = ++loadGenerationRef.current;
    const response = await fetch(api(`/equipment/projects/${encodeURIComponent(requestedProjectId)}/sources`));
    const payload = await response.json().catch(() => ({}));
    if (generation !== loadGenerationRef.current || activeProjectRef.current !== requestedProjectId) return;
    if (!response.ok) throw new Error(payload.error || 'Не удалось загрузить источники XML.');
    const rows: Source[] = payload.sources || [];
    setLoadedProjectId(requestedProjectId);
    setSources(rows);
    setSelected(current => current.filter(id => rows.some(row => row.sourceId === id)));
  };
  useEffect(() => { loadGenerationRef.current += 1; setSources([]); setSelected([]); setFolder(null); setFolderPlan([]); setFolderSnapshot([]); setUndo(null); setReviewIndex(null); setReviewSourceIds([]); setMessage(''); void load().catch(error => setMessage(error.message)); return () => { loadGenerationRef.current += 1; }; }, [projectId]);

  const chooseFolder = async () => {
    if (busyRef.current || loadedProjectId !== projectId) return;
    const requestProjectId = projectId;
    const requestSourceIds = [...selected];
    busyRef.current = true; setBusy(true); setMessage('');
    try {
      const result = await pickEquipmentSourceFolder();
      if ('error' in result) throw new Error(result.error.message);
      if (!result.data || activeProjectRef.current !== requestProjectId || requestProjectId !== projectId) return;
      const selectedRows = sources.filter(row => requestSourceIds.includes(row.sourceId) && row.projectId === requestProjectId);
      if (!selectedRows.length || selectedRows.length !== requestSourceIds.length) throw new Error('Список источников изменился при выборе папки. Обновите список и повторите действие.');
      const plan = planEquipmentSourceFolderRebind(selectedRows, result.data).map(item => {
        const row = selectedRows.find(source => source.sourceId === item.sourceId)!;
        const binding = getEquipmentSourceBinding(projectId, row.sourceId, row.tagId, row.elementId) || { sourceId: row.sourceId, projectId, ...(row.tagId ? { tagId: row.tagId } : {}), ...(row.tagIdentifier ? { tagIdentifier: row.tagIdentifier } : {}), ...(row.xmlTargetIdentity ? { xmlTargetIdentity: row.xmlTargetIdentity } : {}), elementId: row.elementId, targetType: row.targetType, ...(row.systemId ? { systemId: row.systemId } : {}), rootId: item.folder.rootId, relativePath: item.folder.relativePath, revisionOrder: row.revisionOrder || ['A','B','C'], ...(row.selectedRule ? { selectedRule: row.selectedRule } : {}) };
        return { ...item, binding };
      });
      setFolderSnapshot(captureEquipmentSourceBindings(projectId, plan.map(item => ({ sourceId: item.sourceId, binding: item.binding! }))));
      setFolder(result.data);
      setFolderPlan(plan);
    } catch (error: any) { setMessage(error?.message || 'Не удалось выбрать папку XML.'); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const confirmRebind = async () => {
    if (!folder || !selected.length || busyRef.current || loadedProjectId !== projectId) return;
    const requestProjectId = projectId;
    busyRef.current = true; setBusy(true); setMessage('');
    try {
      const rows = folderPlan.map(item => sources.find(row => row.sourceId === item.sourceId)!).filter(Boolean);
      const response = await fetch(api(`/equipment/projects/${encodeURIComponent(projectId)}/sources/rebind-folder`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: rows.map(row => ({ sourceId: row.sourceId, updatedAt: row.updatedAt, latestCandidate: row.latestCandidate ? { id: row.latestCandidate.id, revision: row.latestCandidate.revision, updatedAt: row.latestCandidate.updatedAt } : null })) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Не удалось перепривязать папку XML.');
      if (activeProjectRef.current !== requestProjectId) return;
      try {
        const saved = rebindEquipmentSourceFolders(projectId, folderPlan, folderSnapshot);
        setUndo(saved); setMessage('Папка перепривязана. Кандидаты устарели и будут сравнены заново.');
        setFolder(null); setFolderPlan([]); setFolderSnapshot([]); await load(); onChanged();
      } catch (error: any) {
        setMessage(`Сервер пометил прежние кандидаты устаревшими, но локальную папку сохранить не удалось: ${error?.message || 'ошибка хранилища'}. Повторно выберите папку и выполните проверку XML.`);
        setFolder(null); setFolderPlan([]); setFolderSnapshot([]); await load(); onChanged();
      }
    } catch (error: any) { setMessage(error?.message || 'Не удалось перепривязать папку XML.'); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const undoRebind = () => {
    if (!undo || busyRef.current || loadedProjectId !== projectId) return;
    try { restoreEquipmentSourceBindings(undo.before, undo.after); setUndo(null); setMessage('Локальные папки восстановлены. Кандидаты остаются устаревшими; запустите проверку XML.'); onChanged(); }
    catch (error: any) { setMessage(error?.message || 'Не удалось безопасно отменить перепривязку.'); }
  };

  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  const pendingCount = sources.filter(row => isPending(row.latestCandidate?.status)).length;
  const reviewRows = sources.filter(row => reviewSourceIds.includes(row.sourceId) && isPending(row.latestCandidate?.status));
  const changeCount = (row: Source) => (row.latestCandidate?.changes?.length || 0) + (row.latestCandidate?.structuralCount || 0);
  const localStatus = (row: Source) => localStatuses[`${row.tagId || ''}:${row.elementId}`];
  const textFor = (row: Source) => row.latestCandidate?.status === 'stale' ? 'Требует повторной проверки' : row.latestCandidate?.status === 'partial' ? 'Ждёт проверки' : row.latestCandidate?.status === 'pending' ? 'Новая ревизия' : row.latestCandidate?.status === 'complete' || row.latestCandidate?.status === 'keepResolved' ? 'Проверено' : row.latestCandidate?.status === 'noChanges' ? 'Без изменений' : localStatus(row)?.status === 'source-unavailable' ? 'Источник недоступен' : localStatus(row)?.status === 'ambiguous' ? 'Неоднозначный XML' : localStatus(row)?.status === 'invalid' ? 'Ошибка XML' : localStatus(row)?.status === 'unstable' ? 'Файл меняется' : 'Нет кандидата';
  const colorFor = (row: Source) => row.latestCandidate?.status === 'partial' ? 'text-amber-700 dark:text-amber-300' : row.latestCandidate?.status === 'pending' ? (changeCount(row) ? 'text-amber-700 dark:text-amber-300' : 'text-sky-700 dark:text-sky-300') : row.latestCandidate?.status === 'stale' || ['source-unavailable', 'ambiguous', 'invalid', 'unstable'].includes(localStatus(row)?.status || '') ? 'text-rose-700 dark:text-rose-300' : 'text-slate-500 dark:text-slate-400';

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="equipment-xml-updates-title" className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-950">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800"><div><h2 id="equipment-xml-updates-title" className="text-sm font-semibold">Обновления XML · проект <span className="text-slate-500">{pendingCount}</span></h2><p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Показаны все источники проекта. Изменения требуют явного решения инженера.</p></div><button type="button" onClick={onClose} disabled={busy} className="rounded px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-900">Закрыть</button></header>
      <div className="min-h-0 flex-1 overflow-auto p-4"><div className="mb-3 flex flex-wrap items-center gap-2">{canManage && <><button type="button" className="rounded border border-slate-300 px-2.5 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900" onClick={() => setSelected(selected.length === sources.length ? [] : sources.map(row => row.sourceId))} disabled={!sources.length}>Выбрать все</button><button type="button" className="rounded border border-slate-300 px-2.5 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900" onClick={() => void chooseFolder()} disabled={busy || !selected.length}>Перепривязать папку XML{selected.length > 1 ? ` · ${selected.length}` : ''}</button><button type="button" className="rounded border border-slate-300 px-2.5 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900" onClick={() => { const candidates = sources.filter(row => isPending(row.latestCandidate?.status)); const ids = selected.length ? candidates.filter(row => selected.includes(row.sourceId)).map(row => row.sourceId) : candidates.map(row => row.sourceId); setReviewSourceIds(ids); setReviewIndex(ids.length ? 0 : null); }} disabled={!pendingCount}>Рассмотреть обновления</button>{undo && <button type="button" className="rounded border border-amber-400 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-300" onClick={undoRebind}>Отменить перепривязку</button>}</>}{busy && <span className="text-xs text-slate-500">Сохраняю…</span>}</div>
        {folder && <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"><p>{folderPlan.length === 1 ? 'Перепривязать источник к выбранной папке?' : `Перепривязать ${folderPlan.length} источника к общей папке и подпапкам по тегу?`} Прежние незавершённые сравнения станут устаревшими.</p><div className="mt-2 max-h-28 space-y-1 overflow-auto">{folderPlan.map(item => { const row = sources.find(source => source.sourceId === item.sourceId); return <div key={item.sourceId}>{row?.tagIdentifier || row?.elementId} → {item.folder.relativePath || 'выбранная папка'}</div>; })}</div><div className="mt-2 flex gap-2"><button type="button" disabled={busy} onClick={() => void confirmRebind()} className="rounded bg-amber-700 px-2.5 py-1.5 font-medium text-white disabled:opacity-50">Подтвердить</button><button type="button" disabled={busy} onClick={() => { setFolder(null); setFolderPlan([]); setFolderSnapshot([]); }} className="rounded border border-amber-500 px-2.5 py-1.5">Отмена</button></div></div>}
        {message && <p role="status" className="mb-3 rounded border border-slate-200 bg-slate-50 p-2 text-xs dark:border-slate-800 dark:bg-slate-900">{message}</p>}
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800"><table className="w-full min-w-[700px] border-collapse text-left text-xs"><thead className="bg-slate-50 text-slate-500 dark:bg-slate-900"><tr>{[...(canManage ? [''] : []), 'Тег / источник', 'Текущая', 'Новая', 'Изменений', 'Статус'].map(title => <th key={title} className="border-b border-slate-200 px-2.5 py-2 font-medium dark:border-slate-800">{title}</th>)}</tr></thead><tbody>{sources.map(row => <tr key={row.sourceId} className="border-b border-slate-100 last:border-0 dark:border-slate-900">{canManage && <td className="px-2.5 py-2"><input type="checkbox" aria-label={`Выбрать ${row.tagIdentifier || row.elementId}`} checked={selected.includes(row.sourceId)} onChange={() => toggle(row.sourceId)} disabled={!!folder} /></td>}<td className="px-2.5 py-2 font-medium">{row.tagIdentifier || row.tagId || row.elementId}</td><td className="px-2.5 py-2">{row.lastImportedRevision || '—'}</td><td className="px-2.5 py-2">{row.latestCandidate?.revision || '—'}</td><td className="px-2.5 py-2">{row.latestCandidate ? changeCount(row) : '—'}</td><td className={`px-2.5 py-2 ${colorFor(row)}`}>{textFor(row)}</td></tr>)}{!sources.length && <tr><td colSpan={canManage ? 6 : 5} className="px-3 py-8 text-center text-slate-500">У проекта пока нет привязанных XML-источников.</td></tr>}</tbody></table></div>
        {reviewIndex !== null && reviewRows[reviewIndex] && <div className="mt-4 space-y-2"><div className="flex items-center justify-between text-xs text-slate-500"><span>Проверка {reviewIndex + 1} / {reviewRows.length} · {reviewRows[reviewIndex].tagIdentifier || reviewRows[reviewIndex].elementId}</span><button type="button" onClick={() => setReviewIndex(index => index === null || index + 1 >= reviewRows.length ? null : index + 1)} className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700">{reviewIndex + 1 >= reviewRows.length ? 'Закрыть проверку' : 'Следующий источник'}</button></div><EquipmentXmlSourcePanel key={reviewRows[reviewIndex].sourceId} projectId={projectId} tag={reviewRows[reviewIndex].tagId ? { id: reviewRows[reviewIndex].tagId, identifier: reviewRows[reviewIndex].tagIdentifier || '' } : undefined} elementId={reviewRows[reviewIndex].elementId} targetType={reviewRows[reviewIndex].targetType} systemId={reviewRows[reviewIndex].systemId} canManage={canManage} onChanged={() => { void load(); onChanged(); }} /></div>}
      </div>
    </section>
  </div>;
}
