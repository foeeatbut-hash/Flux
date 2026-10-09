import React from 'react';
import { dataService, type Project } from '../../services/dataService';
import { useStore } from '../../store/store';
import { useToastStore } from '../../store/toastStore';
import { windowsFilesRequest, type WindowsFileEntry, type WindowsFileMetadata } from '../../lib/windowsFiles';
import { entryRef } from '../files/fileOps';
import PropertiesDialog from './WindowsPropertiesDialog';

export default function PropertiesWindow({ entry, rootId, onClose }: { entry: WindowsFileEntry; rootId: string; onClose: () => void }) {
  const activeProject = useStore((s) => s.activeProject);
  const toast = useToastStore((s) => s.addToast);
  const [metadata, setMetadata] = React.useState<WindowsFileMetadata | null>(null);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [tags, setTags] = React.useState<{ id: string; identifier: string; name?: string }[]>([]);
  const [draftTags, setDraftTags] = React.useState<string[]>([]);
  const [draftProjects, setDraftProjects] = React.useState<string[]>([]);
  const [revision, setRevision] = React.useState('');
  const [responsible, setResponsible] = React.useState('');
  const [tagQuery, setTagQuery] = React.useState('');
  const [busy, setBusy] = React.useState(true);
  const [systemProperties, setSystemProperties] = React.useState<{ author?: string; createdAt?: string }>({});
  React.useEffect(() => {
    let alive = true;
    setBusy(true); setMetadata(null);
    setSystemProperties({});
    if (!entry.draftId) void windowsFilesRequest<{ author: string; createdAt: string }>({ action: 'systemProperties', ref: entryRef(entry, rootId) }).then((answer) => {
      if (alive && answer.ok) setSystemProperties({ ...(typeof answer.data?.author === 'string' ? { author: answer.data.author } : {}), ...(typeof answer.data?.createdAt === 'string' ? { createdAt: answer.data.createdAt } : {}) });
    }).catch(() => undefined);
    void windowsFilesRequest<WindowsFileMetadata>({ action: 'metadata', ref: entryRef(entry, rootId) }).then((answer) => {
      if (!alive) return;
      if (answer.ok) { const m = answer.data; setMetadata(m); setDraftTags(m.tags); setDraftProjects(m.projectIds); setRevision(m.revision); setResponsible(m.responsible); }
      else if ('error' in answer) toast(answer.error.message, 'error');
      setBusy(false);
    });
    void dataService.getProjects().then((items) => { if (alive) setProjects(items); }).catch(() => undefined);
    if (activeProject?.id) void dataService.getTags(activeProject.id).then((data) => { if (alive) setTags(data.tags || []); }).catch(() => undefined);
    return () => { alive = false; };
  }, [entry.fileId, rootId, activeProject?.id, toast]);
  const save = async () => {
    if (!metadata || busy) return;
    setBusy(true);
    const answer = await windowsFilesRequest({ action: 'setMetadata', ref: entryRef(entry, rootId), metadata: { tags: draftTags, projectIds: draftProjects, revision, responsible } });
    setBusy(false);
    if (answer.ok) { toast('Свойства сохранены', 'success'); onClose(); } else if ('error' in answer) toast(answer.error.message, 'error');
  };
  return <PropertiesDialog {...{ rootId, metadata, projects, tags, draftTags, setDraftTags, draftProjects, setDraftProjects, revision, setRevision, responsible, setResponsible, tagQuery, setTagQuery, onClose }} entry={{ ...entry, ...systemProperties }} busy={busy || !metadata} activeProjectId={activeProject?.id || ''} onSave={() => void save()} />;
}
