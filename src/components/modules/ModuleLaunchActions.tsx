import { useNavigate } from 'react-router-dom';
import { bundledModules } from '../../../modules/bundled';
import { useInstalledModules } from '../../workspace/installedSections';
import { moduleHref } from '../../../modules/launch';
import { useStore } from '../../store/store';

export default function ModuleLaunchActions({ entry, entityId, projectId }: {
  entry: 'equipment' | 'tag';
  entityId: string;
  projectId?: string;
}) {
  const navigate = useNavigate();
  const activeProject = useStore((state) => state.activeProject);
  const installed = useInstalledModules();
  if (!activeProject?.id || !entityId || (projectId && projectId !== activeProject.id)) return null;

  const modules = [...bundledModules, ...installed.map((item) => item.manifest).filter((m) => !bundledModules.some((b) => b.id === m.id))].filter((manifest) => manifest.entries.includes(entry));
  if (!modules.length) return null;
  return <div className="flex flex-wrap gap-2">
    {modules.map((manifest) => <button key={manifest.id} type="button" className="fx-btn"
      onClick={() => navigate(moduleHref(manifest.id, { entry, entityId, projectId: activeProject.id }))}>{manifest.name}</button>)}
  </div>;
}
