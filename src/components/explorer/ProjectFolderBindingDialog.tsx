import React from 'react';
import { Btn, Dialog } from '../ui';
import { dataService, type Project } from '../../services/dataService';
import { windowsFilesRequest, type WindowsFileRef } from '../../lib/windowsFiles';
import type { ProjectFolderBinding } from '../../lib/projectFolderBindings';
import { useStore } from '../../store/store';

const deviceId = () => {
  const key = 'flux.explorer.device.v1';
  let id = localStorage.getItem(key);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
  return id;
};

export default function ProjectFolderBindingDialog({ folder, title, onClose, onChanged }: { folder: WindowsFileRef; title: string; onClose: () => void; onChanged: (undo?: { undoId: string; afterRevision: number; deviceId: string; rootId: string }) => void }) {
  const actorId = useStore(state => state.user?.id || '');
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [bindings, setBindings] = React.useState<ProjectFolderBinding[]>([]);
  const [revision, setRevision] = React.useState(0);
  const [canonicalId, setCanonicalId] = React.useState('');
  const [selected, setSelected] = React.useState('');
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState('');
  const [warning, setWarning] = React.useState('');
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [undoId, setUndoId] = React.useState('');
  const [loadedScope, setLoadedScope] = React.useState('');
  const requestEpoch = React.useRef(0);
  const scopeRef = React.useRef('');
  const scopeDevice = React.useMemo(() => deviceId(), []);
  const scope = `${actorId}\0${scopeDevice}\0${folder.rootId}\0${folder.relativePath}`;
  scopeRef.current = scope;
  const scopedBindings = loadedScope === scope ? bindings : [];
  const scopedProjects = loadedScope === scope ? projects : [];
  const current = scopedBindings.find(binding => binding.canonicalFolderId === canonicalId && !!canonicalId)
    || scopedBindings.find(binding => binding.relativePath.toLocaleLowerCase('en-US') === folder.relativePath.toLocaleLowerCase('en-US'));
  const moved = !!current && current.relativePath.replaceAll('\\', '/').toLocaleLowerCase('en-US') !== folder.relativePath.replaceAll('\\', '/').toLocaleLowerCase('en-US');

  const load = React.useCallback(async () => {
    const epoch = ++requestEpoch.current;
    const requestScope = scope;
    setBusy(true); setError('');
    try {
      const [ledgerResponse, availableProjects] = await Promise.all([
        fetch(`/api/explorer/project-bindings?${new URLSearchParams({ deviceId: scopeDevice, rootId: folder.rootId })}`),
        dataService.getProjects(),
      ]);
      const ledger = await ledgerResponse.json().catch(() => ({}));
      if (!ledgerResponse.ok) throw new Error(ledger.error || 'Не удалось прочитать привязки папок.');
      if (epoch !== requestEpoch.current || scopeRef.current !== requestScope) return;
      setBindings(ledger.bindings || []); setRevision(Number(ledger.revision) || 0); setProjects(availableProjects);
      setUndoId(Array.isArray(ledger.undo) ? ledger.undo.at(-1)?.id || '' : '');
      const row = (ledger.bindings || []).find((binding: ProjectFolderBinding) => binding.relativePath.toLocaleLowerCase('en-US') === folder.relativePath.toLocaleLowerCase('en-US'));
      setSelected(row?.projectId || '');
      const stat = await windowsFilesRequest<{ fileId: string; kind: string }>({ action: 'stat', ref: folder });
      if (epoch !== requestEpoch.current || scopeRef.current !== requestScope) return;
      setCanonicalId(stat.ok && stat.data.kind === 'directory' ? stat.data.fileId : '');
      const identityBinding = stat.ok ? (ledger.bindings || []).find((binding: ProjectFolderBinding) => binding.canonicalFolderId === stat.data.fileId) : null;
      if (!row && identityBinding) setSelected(identityBinding.projectId);
      setLoadedScope(requestScope);
    } catch (reason) { if (epoch === requestEpoch.current && scopeRef.current === requestScope) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить проекты.'); }
    finally { if (epoch === requestEpoch.current && scopeRef.current === requestScope) setBusy(false); }
  }, [folder.rootId, folder.relativePath, scopeDevice, scope]);
  React.useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (busy || !selected || loadedScope !== scope) return;
    const operationScope = scope;
    setBusy(true); setError(''); setWarning('');
    try {
      const checked = await windowsFilesRequest<{ fileId: string; kind: string; relativePath: string }>({ action: 'stat', ref: folder });
      if (scopeRef.current !== operationScope) return;
      if (checked.ok === false) throw new Error(checked.error.message);
      if (checked.data.kind !== 'directory' || checked.data.relativePath.replace(/\\/gu, '/') !== folder.relativePath.replace(/\\/gu, '/')) throw new Error('Папка изменилась после открытия. Обновите её и повторите выбор.');
      const occupied = bindings.find(binding => binding.relativePath.toLocaleLowerCase('en-US') === folder.relativePath.toLocaleLowerCase('en-US') && binding.canonicalFolderId !== checked.data.fileId);
      if (occupied) {
        setWarning('По этому пути уже сохранена привязка другого объекта. Она не будет автоматически перенесена. Сначала снимите старую привязку и повторите подтверждение.');
        return;
      }
      if (scopeRef.current !== operationScope) return;
      const response = await fetch('/api/explorer/project-bindings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: scopeDevice, rootId: folder.rootId, expectedRevision: revision, operation: { kind: 'upsert', binding: { id: current?.id, canonicalFolderId: checked.data.fileId, relativePath: folder.relativePath, projectId: selected } } }) });
      const body = await response.json().catch(() => ({}));
      if (scopeRef.current !== operationScope) return;
      if (!response.ok) throw new Error(body.error || 'Привязку не удалось сохранить.');
      setBindings(body.bindings || []); setRevision(body.revision); setUndoId(body.undo?.at(-1)?.id || ''); onChanged(body.undo?.at(-1) ? { undoId: body.undo.at(-1).id, afterRevision: body.revision, deviceId: scopeDevice, rootId: folder.rootId } : undefined);
    } catch (reason) { if (scopeRef.current === operationScope) setError(reason instanceof Error ? reason.message : 'Привязку не удалось сохранить.'); }
    finally { if (scopeRef.current === operationScope) setBusy(false); }
  };
  const remove = async (binding: ProjectFolderBinding) => {
    if (loadedScope !== scope) return;
    const operationScope = scope;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/explorer/project-bindings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: scopeDevice, rootId: folder.rootId, expectedRevision: revision, operation: { kind: 'remove', bindingId: binding.id } }) });
      const body = await response.json().catch(() => ({}));
      if (scopeRef.current !== operationScope) return;
      if (!response.ok) throw new Error(body.error || 'Привязку не удалось снять.');
      setBindings(body.bindings || []); setRevision(body.revision); setSelected(''); setUndoId(body.undo?.at(-1)?.id || ''); setConfirmRemove(false); onChanged(body.undo?.at(-1) ? { undoId: body.undo.at(-1).id, afterRevision: body.revision, deviceId: scopeDevice, rootId: folder.rootId } : undefined);
    } catch (reason) { if (scopeRef.current === operationScope) setError(reason instanceof Error ? reason.message : 'Привязку не удалось снять.'); }
    finally { if (scopeRef.current === operationScope) setBusy(false); }
  };

  const undo = async () => {
    if (!undoId || busy || loadedScope !== scope) return;
    const operationScope = scope;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/explorer/project-bindings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: scopeDevice, rootId: folder.rootId, expectedRevision: revision, operation: { kind: 'undo', undoId } }) });
      const body = await response.json().catch(() => ({}));
      if (scopeRef.current !== operationScope) return;
      if (!response.ok) throw new Error(body.error || 'Отмена не выполнена: привязки уже изменились. Обновите их и повторите.');
      setBindings(body.bindings || []); setRevision(body.revision); setUndoId(body.undo?.at(-1)?.id || ''); onChanged(body.undo?.at(-1) ? { undoId: body.undo.at(-1).id, afterRevision: body.revision, deviceId: scopeDevice, rootId: folder.rootId } : undefined);
    } catch (reason) { if (scopeRef.current === operationScope) setError(reason instanceof Error ? reason.message : 'Не удалось отменить привязку.'); }
    finally { if (scopeRef.current === operationScope) setBusy(false); }
  };

  return <Dialog title="Привязать папку к проекту" label="Привязать папку к проекту" onClose={() => !busy && onClose()} busy={busy} footer={<><Btn disabled={busy} onClick={onClose}>Закрыть</Btn><Btn tone="primary" disabled={busy || !selected} onClick={() => void save()}>{moved ? 'Подтвердить перенос привязки' : 'Подтвердить привязку'}</Btn></>}>
    <div className="space-y-3 text-xs">
      <p className="text-slate-600 dark:text-slate-300">Папка: <strong className="break-all font-medium">{title}{folder.relativePath ? ` · ${folder.relativePath}` : ''}</strong></p>
      <p className="text-slate-500 dark:text-slate-400">Новые файлы и подпапки унаследуют этот проект до ближайшей вложенной границы. Файлы с собственным проектом и вложенные папки с отдельной привязкой сохранят его. Файлы и права доступа не изменятся.</p>
      <p className="text-slate-500 dark:text-slate-400">В этом корне сохранено дочерних границ: {scopedBindings.filter(binding => binding.relativePath.toLocaleLowerCase('en-US').startsWith(`${folder.relativePath.toLocaleLowerCase('en-US').replace(/[\\/]+$/u, '')}/`)).length}. Их проекты продолжают действовать внутри своих подпапок.</p>
      {moved && <p role="status" className="text-sky-700 dark:text-sky-300">Папка перемещена. Подтвердите привязку по новому пути. Это действие можно отменить.</p>}
      <label className="block">Проект<select aria-label="Проект папки" className="fx-input mt-1 w-full" value={loadedScope === scope ? selected : ''} disabled={busy || loadedScope !== scope} onChange={event => setSelected(event.target.value)}><option value="">Выберите проект</option>{scopedProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {current && <div className="flex items-center justify-between gap-2 rounded border border-slate-200 p-2 dark:border-slate-700"><span>Текущая привязка: {scopedProjects.find(project => project.id === current.projectId)?.name || 'проект'}</span><button type="button" className="fx-btn fx-btn-sm" disabled={busy} onClick={() => setConfirmRemove(true)}>Снять границу…</button></div>}
      {confirmRemove && <div role="alertdialog" aria-label="Подтвердить снятие привязки" className="space-y-2 rounded border border-amber-400 p-2 dark:border-amber-700"><p>Вложенные файлы перестанут наследовать проект этой границы, если у них нет собственной привязки. Файлы и права не изменятся.</p><div className="flex gap-2"><Btn disabled={busy} onClick={() => setConfirmRemove(false)}>Оставить</Btn><Btn tone="primary" disabled={busy || !current} onClick={() => current && void remove(current)}>Подтвердить снятие</Btn></div></div>}
      {undoId && loadedScope === scope && <button type="button" className="fx-btn fx-btn-sm" disabled={busy} onClick={() => void undo()}>Отменить последнее изменение</button>}
      {warning && <p role="alert" className="text-amber-700 dark:text-amber-300">{warning}</p>}{error && <p role="alert" className="text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  </Dialog>;
}
