import React from 'react';
import { Btn, Dialog } from '../ui';
import { dataService, type Project } from '../../services/dataService';
import type { WindowsFileRef } from '../../lib/windowsFiles';
import { nearestBinding, type ProjectFolderBinding, type ProjectFolderBindingView } from '../../lib/projectFolderBindings';
import { fetchLocationChains } from './useProjectFolderBindings';

type Undo = { undoId: string; afterRevision: number };

/**
 * Привязка папки к проекту. Привязка общая: её увидят все, кому виден проект, на любом компьютере,
 * где эта папка доступна по тому же сетевому пути. Окно открывают только администратор и
 * обладатель права «Управление проектами» (кнопки у остальных скрыты, сервер отвечает 403).
 */
export default function ProjectFolderBindingDialog({ folder, title, onClose, onChanged }: { folder: WindowsFileRef; title: string; onClose: () => void; onChanged: (undo?: Undo) => void }) {
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [bindings, setBindings] = React.useState<ProjectFolderBinding[]>([]);
  const [revision, setRevision] = React.useState(0);
  const [canManage, setCanManage] = React.useState(true);
  const [chain, setChain] = React.useState<string[] | null>(null);
  const [selected, setSelected] = React.useState('');
  const [busy, setBusy] = React.useState(true);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState('');
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [undoId, setUndoId] = React.useState('');
  const scope = `${folder.rootId}\0${folder.relativePath}`;
  const scopeRef = React.useRef(scope);
  scopeRef.current = scope;
  const requestEpoch = React.useRef(0);

  const current = chain ? bindings.find(binding => binding.locationKey === chain[0]) : undefined;
  const inherited = chain && !current ? nearestBinding(bindings, chain) : null;
  const projectName = (id: string) => projects.find(project => project.id === id)?.name || 'проект';
  const apply = (body: ProjectFolderBindingView) => {
    setBindings(body.bindings || []); setRevision(body.revision); setCanManage(!!body.canManage);
    const last = body.undo?.at(-1);
    setUndoId(last?.id || '');
    return last ? { undoId: last.id, afterRevision: body.revision } : undefined;
  };

  const load = React.useCallback(async () => {
    const epoch = ++requestEpoch.current;
    const requestScope = scope;
    setBusy(true); setError('');
    try {
      const [response, availableProjects, chains] = await Promise.all([fetch('/api/explorer/project-bindings'), dataService.getProjects(), fetchLocationChains([folder])]);
      const ledger = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(ledger.error || 'Не удалось прочитать привязки папок.');
      if (epoch !== requestEpoch.current || scopeRef.current !== requestScope) return;
      apply(ledger); setProjects(availableProjects);
      const keys = chains?.[0] || null;
      setChain(keys);
      setSelected((ledger.bindings || []).find((binding: ProjectFolderBinding) => binding.locationKey === keys?.[0])?.projectId || '');
      setLoaded(true);
    } catch (reason) { if (epoch === requestEpoch.current && scopeRef.current === requestScope) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить проекты.'); }
    finally { if (epoch === requestEpoch.current && scopeRef.current === requestScope) setBusy(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, folder.rootId, folder.relativePath]);
  React.useEffect(() => { void load(); }, [load]);

  const send = async (operation: unknown, failure: string): Promise<boolean> => {
    const operationScope = scope;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/explorer/project-bindings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, operation }) });
      const body = await response.json().catch(() => ({}));
      if (scopeRef.current !== operationScope) return false;
      if (!response.ok) throw new Error(body.error || failure);
      onChanged(apply(body));
      return true;
    } catch (reason) { if (scopeRef.current === operationScope) setError(reason instanceof Error ? reason.message : failure); return false; }
    finally { if (scopeRef.current === operationScope) setBusy(false); }
  };
  const save = async () => {
    if (busy || !selected || !loaded || !chain || !canManage) return;
    const label = title.trim() || 'Папка';
    await send({ kind: 'upsert', binding: { id: current?.id, locationKey: chain[0], projectId: selected, label } }, 'Привязку не удалось сохранить.');
  };
  const remove = async () => {
    if (!current || !loaded) return;
    if (await send({ kind: 'remove', bindingId: current.id }, 'Привязку не удалось снять.')) { setSelected(''); setConfirmRemove(false); }
  };
  const undo = async () => {
    if (!undoId || busy || !loaded) return;
    if (await send({ kind: 'undo', undoId }, 'Отмена не выполнена: привязки уже изменились. Обновите их и повторите.')) void load();
  };

  const notShared = loaded && !chain;
  const readOnly = loaded && !canManage;
  return <Dialog title="Привязать папку к проекту" label="Привязать папку к проекту" onClose={() => !busy && onClose()} busy={busy} footer={<><Btn disabled={busy} onClick={onClose}>Закрыть</Btn><Btn tone="primary" disabled={busy || !selected || !chain || !canManage || !loaded} onClick={() => void save()}>{current ? 'Сменить проект' : 'Подтвердить привязку'}</Btn></>}>
    <div className="space-y-3 text-xs">
      <p className="text-slate-600 dark:text-slate-300">Папка: <strong className="break-all font-medium">{title}</strong></p>
      <p className="text-slate-500 dark:text-slate-400">Привязка общая: её увидят все, кто видит проект, на любом компьютере, где эта папка открыта по тому же сетевому пути. Новые файлы и подпапки унаследуют проект до ближайшей вложенной привязки. Файлы с собственным проектом сохранят его. Файлы и права доступа не изменятся.</p>
      {notShared && <p role="status" className="text-amber-700 dark:text-amber-300">Эта папка не сетевая, поэтому к проекту её привязать нельзя: на других компьютерах её нет. Выберите папку на сетевом ресурсе.</p>}
      {readOnly && <p role="status" className="text-amber-700 dark:text-amber-300">Менять привязки могут администраторы и сотрудники с правом «Управление проектами».</p>}
      {inherited && <p role="status" className="text-slate-500 dark:text-slate-400">Сейчас папка наследует проект «{projectName(inherited.binding.projectId)}» от папки «{inherited.binding.label}».</p>}
      <label className="block">Проект<select aria-label="Проект папки" className="fx-input mt-1 w-full" value={loaded ? selected : ''} disabled={busy || !loaded || notShared || readOnly} onChange={event => setSelected(event.target.value)}><option value="">Выберите проект</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {current && <div className="flex items-center justify-between gap-2 rounded border border-slate-200 p-2 dark:border-slate-700"><span>Текущая привязка: {projectName(current.projectId)}</span>{canManage && <button type="button" className="fx-btn fx-btn-sm" disabled={busy} onClick={() => setConfirmRemove(true)}>Снять привязку…</button>}</div>}
      {confirmRemove && <div role="alertdialog" aria-label="Подтвердить снятие привязки" className="space-y-2 rounded border border-amber-400 p-2 dark:border-amber-700"><p>Вложенные файлы перестанут наследовать проект этой папки у всех сотрудников, если у них нет собственной привязки. Файлы и права не изменятся.</p><div className="flex gap-2"><Btn disabled={busy} onClick={() => setConfirmRemove(false)}>Оставить</Btn><Btn tone="primary" disabled={busy || !current} onClick={() => void remove()}>Подтвердить снятие</Btn></div></div>}
      {undoId && loaded && canManage && <button type="button" className="fx-btn fx-btn-sm" disabled={busy} onClick={() => void undo()}>Отменить последнее изменение</button>}
      {error && <p role="alert" className="text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  </Dialog>;
}
