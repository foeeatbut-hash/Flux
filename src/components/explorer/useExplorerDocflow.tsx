import React from 'react';
import { useNavigate } from 'react-router-dom';
import type { MenuItem } from '../ContextMenu';
import type { WindowsFileEntry, WindowsFileRef } from '../../lib/windowsFiles';
import { windowsFilesRequest } from '../../lib/windowsFiles';
import { nearestBinding, type ProjectFolderBinding } from '../../lib/projectFolderBindings';
import { can } from '../../lib/permissions';
import { trackLinks, unlinkLink, type TrackUpdate } from '../../lib/docflowApi';
import { dirOf, linkLookupKey, relativeInBinding } from '../../../shared/docflow/links';
import { useStore } from '../../store/store';
import { useToastStore } from '../../store/toastStore';
import { useProjectDocs } from '../docflow/useProjectDocs';
import AssignFileDialog from '../docflow/AssignFileDialog';
import AddToRegistryDialog from '../docflow/AddToRegistryDialog';
import DocDetails from '../files/DocDetails';
import { docInfoOf, matchesDocFilter, type DocEntryInfo, type DocFilter } from '../files/docEntryInfo';
import { OffMaskBadge, docCell } from '../files/DocColumns';
import { entryKey } from '../files/useSelection';
import { entryRef } from '../files/fileOps';
import type { FolderColumn } from '../files/viewModel';

type Dialog = { kind: 'link' | 'remarks' | 'add'; entry: WindowsFileEntry; info: DocEntryInfo } | null;

/**
 * Документооборот в Проводнике (docs/docflow-program.md, 3.2–3.5): сведения о
 * файле как о документе проекта, фильтры, меню «Документооборот ▸» и слежение
 * за переименованием и пропажей связанных файлов. Только для папок, привязанных
 * к проекту; вне них Проводник ведёт себя как раньше.
 */
export function useExplorerDocflow(input: {
  entries: WindowsFileEntry[]; rootId: string; bindings: ProjectFolderBinding[];
  chainOf: (ref: WindowsFileRef) => string[] | null; chainVersion: number;
  /** Список папки прочитан целиком и это не поиск: только тогда «нет файла» значит «файла нет». */
  complete: boolean; reload: () => void;
}) {
  const { entries, rootId, bindings, chainOf, chainVersion, complete, reload } = input;
  const user = useStore((s) => s.user);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const toast = useToastStore((s) => s.addToast);
  const navigate = useNavigate();
  const mayView = can(user, 'docflow.view');
  const mayFiles = can(user, 'docflow.files');
  const mayEdit = can(user, 'docflow.edit');
  const [filter, setFilter] = React.useState<DocFilter>('all');
  const [dialog, setDialog] = React.useState<Dialog>(null);

  // Где в проекте лежит каждая запись: ближайшая привязанная папка и путь внутри неё
  const placed = React.useMemo(() => {
    const map = new Map<string, { projectId: string; folderKey: string; purpose?: ProjectFolderBinding['purpose']; relativePath: string }>();
    if (!mayView || !bindings.length) return map;
    for (const entry of entries) {
      if (entry.kind !== 'file') continue;
      const found = nearestBinding(bindings, chainOf(entryRef(entry, rootId)));
      if (!found || found.depth < 1) continue;
      const relativePath = relativeInBinding(entry.relativePath, found.depth);
      if (relativePath) map.set(entryKey(entry), { projectId: found.binding.projectId, folderKey: found.binding.locationKey, purpose: found.binding.purpose, relativePath });
    }
    return map;
  }, [entries, bindings, chainOf, chainVersion, rootId, mayView]);
  const projectIds = React.useMemo(() => [...new Set([...placed.values()].map((p) => p.projectId))], [placed]);
  const { docs, reload: reloadDocs } = useProjectDocs(projectIds, mayView);

  const infos = React.useMemo(() => {
    const map = new Map<string, DocEntryInfo | null>();
    for (const entry of entries) {
      const where = placed.get(entryKey(entry));
      map.set(entryKey(entry), where ? docInfoOf(entry, where, docs[where.projectId]) : null);
    }
    return map;
  }, [entries, placed, docs]);
  const infoOf = React.useCallback((entry: WindowsFileEntry) => infos.get(entryKey(entry)) || null, [infos]);
  const active = projectIds.length > 0;

  const visible = React.useMemo(() => filter === 'all' ? entries : entries.filter((e) => e.kind === 'directory' || matchesDocFilter(infoOf(e), filter)), [entries, filter, infoOf]);

  // ── Слежение (3.5): переименовали/перенесли — по отпечатку находим файл; не нашли — помечаем ──
  const tracking = React.useRef(false);
  React.useEffect(() => {
    if (!mayFiles || !complete || tracking.current) return;
    const present = new Set<string>();
    const groups = new Map<string, { projectId: string; folderKey: string; dir: string; entries: WindowsFileEntry[] }>();
    for (const entry of entries) {
      const where = placed.get(entryKey(entry)); const info = infoOf(entry);
      if (!where || !info || info.role !== 'file' || info.ignored) continue;
      present.add(linkLookupKey(where.folderKey, where.relativePath));
      const dir = dirOf(where.relativePath); const key = `${where.folderKey}\n${dir.toLowerCase()}`;
      const group = groups.get(key) || { projectId: where.projectId, folderKey: where.folderKey, dir, entries: [] };
      group.entries.push(entry); groups.set(key, group);
    }
    const work = async () => {
      const updates: TrackUpdate[] = [];
      for (const group of groups.values()) {
        const ctx = docs[group.projectId];
        if (!ctx) continue;
        const free = group.entries.filter((e) => !infoOf(e)?.link);
        for (const link of ctx.links) {
          if (link.unlinkedAt || link.role !== 'file' || link.folderKey !== group.folderKey || dirOf(link.relativePath).toLowerCase() !== group.dir.toLowerCase()) continue;
          const key = linkLookupKey(link.folderKey, link.relativePath);
          if (present.has(key)) {
            const here = group.entries.find((e) => linkLookupKey(group.folderKey, [group.dir, e.name].filter(Boolean).join('/')) === key);
            // Файл на месте: пометка «не найден» снимается; изменился размер — отпечаток обновляется
            if (here && (link.lostAt || (link.size && here.size !== link.size))) {
              const hash = await windowsFilesRequest<{ sha256: string; size: number }>({ action: 'fileHash', ref: entryRef(here, rootId) });
              if (hash.ok) updates.push({ itemId: link.itemId, linkId: link.id, sha256: hash.data.sha256, size: hash.data.size });
            }
            continue;
          }
          // Файла по пути нет: ищем переименованный — тот же размер и тот же отпечаток
          let moved: { entry: WindowsFileEntry; sha256: string } | null = null;
          if (link.sha256) {
            for (const candidate of free.filter((e) => e.size === link.size).slice(0, 12)) {
              const hash = await windowsFilesRequest<{ sha256: string; size: number }>({ action: 'fileHash', ref: entryRef(candidate, rootId) });
              if (hash.ok && hash.data.sha256 === link.sha256) { moved = { entry: candidate, sha256: hash.data.sha256 }; break; }
            }
          }
          if (moved) updates.push({ itemId: link.itemId, linkId: link.id, relativePath: [group.dir, moved.entry.name].filter(Boolean).join('/'), fileName: moved.entry.name, sha256: moved.sha256, size: moved.entry.size });
          else if (!link.lostAt) updates.push({ itemId: link.itemId, linkId: link.id, lost: true });
        }
      }
      if (updates.length) await trackLinks(updates.slice(0, 200));
    };
    tracking.current = true;
    void work().catch(() => undefined).finally(() => { tracking.current = false; });
  }, [entries, placed, infoOf, docs, complete, mayFiles, rootId]);

  // ── Меню «Документооборот ▸» (3.3) ──
  const openInDocflow = (info: DocEntryInfo) => {
    const item = info.item;
    const active = useStore.getState().activeProject;
    const open = () => navigate(`/docflow?tab=registry${item ? `&vdr=${encodeURIComponent(item.registerId)}&item=${encodeURIComponent(item.id)}` : ''}`);
    if (active?.id === info.projectId) { open(); return; }
    void import('../../services/dataService').then(async ({ dataService }) => {
      const project = (await dataService.getProjects()).find((p) => p.id === info.projectId);
      if (project) setActiveProject(project);
      open();
    });
  };
  const unlink = async (info: DocEntryInfo) => {
    if (!info.link) return;
    const answer = await unlinkLink(info.link.itemId, info.link.id, 'отвязан в Проводнике');
    if (answer.ok) { toast('Файл отвязан от строки; связь осталась в истории', 'success'); void reloadDocs(info.projectId); reload(); } else toast(answer.data.error || 'Не удалось отвязать', 'error');
  };
  const menuItems = (picked: WindowsFileEntry[], target?: WindowsFileEntry): MenuItem[] => {
    const entry = picked.length === 1 ? picked[0] : target;
    const info = entry ? infoOf(entry) : null;
    if (!entry || picked.length !== 1 || !info || info.ignored) return [];
    const sub: MenuItem[] = [];
    if (info.role === 'file') {
      if (!info.link) {
        sub.push({ label: 'Связать со строкой ВДР…', disabled: !mayFiles, onClick: () => setDialog({ kind: 'link', entry, info }) });
        sub.push({ label: 'Добавить в реестр…', disabled: !mayEdit || !mayFiles, onClick: () => setDialog({ kind: 'add', entry, info }) });
      }
      sub.push({ label: 'Назначить возвратом к…', disabled: !mayFiles, onClick: () => setDialog({ kind: 'remarks', entry, info }) });
    }
    if (info.link) sub.push({ label: 'Открыть в ДО', onClick: () => openInDocflow(info) });
    if (info.link) sub.push({ label: 'Отвязать', danger: true, disabled: !mayFiles, onClick: () => void unlink(info) });
    if (!info.link && info.role === 'remarks') sub.push({ label: 'Назначить возвратом к…', disabled: !mayFiles, onClick: () => setDialog({ kind: 'remarks', entry, info }) });
    return sub.length ? [{ label: 'Документооборот', separated: true, items: sub }] : [];
  };
  /** Для папки проекта: «Сверить с реестром» открывает вкладку сверки ДО. */
  const folderMenuItems = (folder: WindowsFileRef | null): MenuItem[] => {
    if (!folder || !active) return [];
    return [{ label: 'Документооборот', separated: true, items: [{ label: 'Сверить с реестром', onClick: () => { const first = projectIds[0]; const current = useStore.getState().activeProject; if (current?.id === first) navigate('/docflow?tab=reconcile'); else openInDocflow({ projectId: first } as DocEntryInfo); } }] }];
  };

  const doc = React.useMemo(() => ({
    cell: (entry: WindowsFileEntry, column: FolderColumn) => { const info = infoOf(entry); return docCell(info, column, info ? docs[info.projectId]?.config : undefined); },
    badge: (entry: WindowsFileEntry) => { const info = infoOf(entry); return info && !info.ignored ? <OffMaskBadge problems={info.offMask} /> : null; },
  }), [infoOf, docs]);

  /** Блок «Документооборот» для правой панели «Сведения». */
  const details = (entry: WindowsFileEntry): React.ReactNode => {
    const info = infoOf(entry);
    const ctx = info ? docs[info.projectId] : undefined;
    if (!info || !ctx || info.ignored) return null;
    return <DocDetails info={info} docs={ctx} fileRef={entryRef(entry, rootId)} canFiles={mayFiles} onOpen={() => openInDocflow(info)} onUnlink={() => void unlink(info)} onChanged={() => { void reloadDocs(info.projectId); reload(); }} />;
  };

  const done = () => { void Promise.all(projectIds.map((id) => reloadDocs(id))); reload(); };
  const element = dialog ? (() => {
    const ctx = docs[dialog.info.projectId];
    if (!ctx) return null;
    const file = entryRef(dialog.entry, rootId);
    if (dialog.kind === 'add') return <AddToRegistryDialog projectId={dialog.info.projectId} docs={ctx} file={file} info={dialog.info} onClose={() => setDialog(null)} onDone={done} />;
    return <AssignFileDialog role={dialog.kind === 'link' ? 'file' : 'remarks'} projectId={dialog.info.projectId} docs={ctx} bindings={bindings} file={file} renameOffer={false} onClose={() => setDialog(null)} onDone={done} />;
  })() : null;

  return { active, infoOf, details, doc, filter, setFilter, visible, menuItems, folderMenuItems, element, docs };
}
