import React, { useRef, useState } from 'react';
import { AlertTriangle, FolderOpen, Loader2 } from 'lucide-react';
import ImportFileChooser, { type ImportFileChooserHandle } from '../ImportFileChooser';
import type { EquipmentDocumentBinding, EquipmentDocumentBindingsView } from '../../../equipment/documentBindings';
import { equipmentBindingLabel, getLocalEquipmentDocumentRef, saveLocalEquipmentDocumentRef, upsertEquipmentDocumentBinding } from '../../lib/equipmentDocumentBindings';
import { listEquipmentSourceBindings, saveEquipmentSourceBinding } from '../../lib/equipmentSourcesLocal';
import { windowsFilesRequest, type SelectionProvenance, type WindowsFileRef } from '../../lib/windowsFiles';

/**
 * Пути установок: где на этом компьютере лежат файлы каждой привязанной
 * установки. Путь запоминается при первой загрузке; здесь его перевыбирают
 * через Проводник Flux, если папку перенесли или выбрали не ту (например,
 * 001A, 001B и 001C лежат в одной папке, а нужна отдельная).
 */
export default function SourcePathsPanel({ projectId, bindings, revision, canManage, onChanged }: {
  projectId: string;
  bindings: EquipmentDocumentBinding[];
  revision: number;
  canManage: boolean;
  onChanged: (view?: EquipmentDocumentBindingsView) => void | Promise<void>;
}) {
  const picker = useRef<ImportFileChooserHandle>(null);
  const [target, setTarget] = useState<EquipmentDocumentBinding | null>(null);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [, setTick] = useState(0);

  const choose = (binding: EquipmentDocumentBinding) => { setError(''); setTarget(binding); picker.current?.open(); };

  const apply = async (folder: WindowsFileRef) => {
    const binding = target;
    setTarget(null);
    if (!binding) return;
    setBusyId(binding.id); setError('');
    try {
      // Общий адрес папки нужен коллегам: их Flux найдёт её у себя по тем же якорям.
      const provenance = await windowsFilesRequest<SelectionProvenance>({ action: 'selectionProvenance', ref: folder });
      const locator = provenance.ok === true ? provenance.data.portableLocator : undefined;
      let view: EquipmentDocumentBindingsView | undefined;
      if (canManage && locator) {
        view = await upsertEquipmentDocumentBinding(projectId, revision, {
          id: binding.id, kind: binding.kind, equipmentIds: binding.equipmentIds, fileName: binding.fileName, locator,
          ...(binding.xmlSourceId ? { xmlSourceId: binding.xmlSourceId } : {}), ...(binding.systemId ? { systemId: binding.systemId } : {}),
          ...(binding.tag ? { tag: binding.tag } : {}), ...(binding.rule ? { rule: binding.rule } : {}),
          ...(binding.latestRevision ? { latestRevision: binding.latestRevision } : {}),
        });
      }
      saveLocalEquipmentDocumentRef({ projectId, bindingId: binding.id, sourceFolder: folder });
      if (binding.kind === 'cad-xml') {
        const sourceId = binding.xmlSourceId || binding.id;
        // Старая ссылка на файл указывала в прежнюю папку: новая ревизия найдётся сканом по правилу имени.
        for (const local of listEquipmentSourceBindings(projectId).filter(item => item.sourceId === sourceId)) {
          const { selectedFileRef: _old, ...rest } = local;
          saveEquipmentSourceBinding({ ...rest, rootId: folder.rootId, relativePath: folder.relativePath });
        }
      }
      setTick(value => value + 1);
      await onChanged(view);
      if (canManage && !locator) setError('Путь сохранён только на этом компьютере: для папки не удалось получить общий адрес.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось сменить папку установки.');
    } finally { setBusyId(''); }
  };

  return (
    <section aria-label="Пути установок" className="space-y-2">
      <ImportFileChooser ref={picker} selectFolder label="Выбрать папку установки" trigger={() => null} onFiles={() => {}} onWindowsFolder={ref => { void apply(ref); }} />
      <div>
        <h3 className="text-sm font-semibold text-slate-800 dark:text-white">Пути установок</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">Папка запоминается при первой загрузке файла. Здесь её можно перевыбрать — новые ревизии будут искаться в ней.</p>
      </div>
      {error && <div role="alert" className="flex gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div>}
      {!bindings.length && <p className="rounded border border-dashed border-slate-300 p-3 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">Привязанных установок пока нет — они появятся после первой загрузки.</p>}
      <ul className="divide-y divide-slate-100 rounded border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {bindings.map(binding => {
          const local = getLocalEquipmentDocumentRef(projectId, binding.id);
          const path = local ? local.sourceFolder.relativePath || 'корень расположения' : binding.locator ? 'найдётся по общему адресу' : 'не задан на этом компьютере';
          return (
            <li key={binding.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
              <div className="min-w-0">
                <div className="font-semibold text-slate-800 dark:text-slate-100">{equipmentBindingLabel(binding)}</div>
                <div className="break-all text-slate-500 dark:text-slate-400">{binding.fileName}{binding.latestRevision ? ` · ревизия ${binding.latestRevision.revision}` : ''}</div>
                <div className={`break-all ${local || binding.locator ? 'text-slate-600 dark:text-slate-300' : 'text-amber-700 dark:text-amber-300'}`}>Папка: {path}</div>
              </div>
              <button type="button" onClick={() => choose(binding)} disabled={!!busyId} className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-300 px-2 py-1 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900">
                {busyId === binding.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}Сменить папку
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
