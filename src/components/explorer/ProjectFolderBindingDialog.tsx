import React from 'react';
import { Btn, Dialog } from '../ui';
import { dataService, type Project } from '../../services/dataService';
import { windowsFilesRequest, type WindowsFileRef } from '../../lib/windowsFiles';
import type { ProjectFolderBinding, ProjectFolderBindingLedger } from '../../lib/projectFolderBindings';

const deviceId = () => {
  const key = 'flux.explorer.device.v1';
  let id = localStorage.getItem(key);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
  return id;
};

export default function ProjectFolderBindingDialog({ folder, title, onClose, onChanged }: { folder: WindowsFileRef; title: string; onClose: () => void; onChanged: () => void }) {
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [bindings, setBindings] = React.useState<ProjectFolderBinding[]>([]);
  const [revision, setRevision] = React.useState(0);
  const [selected, setSelected] = React.useState('');
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState('');
  const [warning, setWarning] = React.useState('');
  const current = bindings.find(binding => binding.relativePath.toLocaleLowerCase('en-US') === folder.relativePath.toLocaleLowerCase('en-US'));
  const scopeDevice = React.useMemo(() => deviceId(), []);

  const load = React.useCallback(async () => {
    setBusy(true); setError('');
    try {
      const [ledgerResponse, availableProjects] = await Promise.all([
        fetch(`/api/explorer/project-bindings?${new URLSearchParams({ deviceId: scopeDevice, rootId: folder.rootId })}`),
        dataService.getProjects(),
      ]);
      const ledger = await ledgerResponse.json().catch(() => ({}));
      if (!ledgerResponse.ok) throw new Error(ledger.error || 'Не удалось прочитать привязки папок.');
      setBindings(ledger.bindings || []); setRevision(Number(ledger.revision) || 0); setProjects(availableProjects);
      const row = (ledger.bindings || []).find((binding: ProjectFolderBinding) => binding.relativePath.toLocaleLowerCase('en-US') === folder.relativePath.toLocaleLowerCase('en-US'));
      setSelected(row?.projectId || '');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось загрузить проекты.'); }
    finally { setBusy(false); }
  }, [folder.rootId, folder.relativePath, scopeDevice]);
  React.useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (busy || !selected) return;
    setBusy(true); setError(''); setWarning('');
    try {
      const checked = await windowsFilesRequest<{ fileId: string; kind: string; relativePath: string }>({ action: 'stat', ref: folder });
      if (checked.ok === false) throw new Error(checked.error.message);
      if (checked.data.kind !== 'directory' || checked.data.relativePath.replace(/\\/gu, '/') !== folder.relativePath.replace(/\\/gu, '/')) throw new Error('Папка изменилась после открытия. Обновите её и повторите выбор.');
      const occupied = bindings.find(binding => binding.relativePath.toLocaleLowerCase('en-US') === folder.relativePath.toLocaleLowerCase('en-US') && binding.canonicalFolderId !== checked.data.fileId);
      if (occupied) {
        setWarning('По этому пути уже сохранена привязка другого объекта. Она не будет автоматически перенесена. Сначала снимите старую привязку и повторите подтверждение.');
        return;
      }
      const response = await fetch('/api/explorer/project-bindings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: scopeDevice, rootId: folder.rootId, expectedRevision: revision, operation: { kind: 'upsert', binding: { id: current?.id, canonicalFolderId: checked.data.fileId, relativePath: folder.relativePath, projectId: selected } } }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Привязку не удалось сохранить.');
      setBindings(body.bindings || []); setRevision(body.revision); onChanged(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Привязку не удалось сохранить.'); }
    finally { setBusy(false); }
  };
  const remove = async (binding: ProjectFolderBinding) => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/explorer/project-bindings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: scopeDevice, rootId: folder.rootId, expectedRevision: revision, operation: { kind: 'remove', bindingId: binding.id } }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Привязку не удалось снять.');
      setBindings(body.bindings || []); setRevision(body.revision); setSelected(''); onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Привязку не удалось снять.'); }
    finally { setBusy(false); }
  };

  return <Dialog title="Привязать папку к проекту" label="Привязать папку к проекту" onClose={() => !busy && onClose()} busy={busy} footer={<><Btn disabled={busy} onClick={onClose}>Отмена</Btn><Btn tone="primary" disabled={busy || !selected} onClick={() => void save()}>Подтвердить привязку</Btn></>}>
    <div className="space-y-3 text-xs">
      <p className="text-slate-600 dark:text-slate-300">Папка: <strong className="break-all">{title}{folder.relativePath ? ` · ${folder.relativePath}` : ''}</strong></p>
      <p className="text-slate-500 dark:text-slate-400">Будут связаны только эта граница и её вложенные папки. Файлы не перемещаются, права проекта не меняются. Перед сохранением Flux повторно проверит идентификатор папки.</p>
      <label className="block">Проект<select aria-label="Проект папки" className="fx-input mt-1 w-full" value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}><option value="">Выберите проект</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {current && <div className="flex items-center justify-between gap-2 rounded border border-slate-200 p-2 dark:border-slate-700"><span>Текущая привязка: {projects.find(project => project.id === current.projectId)?.name || 'проект'}</span><button type="button" className="fx-btn fx-btn-sm" disabled={busy} onClick={() => void remove(current)}>Снять границу</button></div>}
      {warning && <p role="alert" className="text-amber-700 dark:text-amber-300">{warning}</p>}{error && <p role="alert" className="text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  </Dialog>;
}
