import React from 'react';
import { useLocation } from 'react-router-dom';
import { bundledModules } from '../../modules/bundled';
import type { LaunchContext } from '../../modules/contract';
import { useStore } from '../store/store';
import { createModuleReadCycle } from '../services/moduleDataService';
import ModuleFrame from '../components/modules/ModuleFrame';

export default function ModuleHost() {
  const location = useLocation();
  const project = useStore(state => state.activeProject);
  const user = useStore(state => state.user);
  const theme = useStore(state => state.theme);
  const manifest = bundledModules.find(item => location.pathname === `/module/${item.id}`);
  if (!manifest) return <div className="fx-empty"><div className="fx-empty-title">Модуль недоступен</div></div>;
  if (manifest.contractVersion !== 1) return <div className="fx-empty"><div className="fx-empty-title">Обновите Flux для этого модуля</div></div>;
  const params = new URLSearchParams(location.search);
  const entry = params.get('entry');
  const matchesProject = params.get('projectId') === project?.id;
  const context: LaunchContext = { projectId: project?.id || null,
    entry: matchesProject && (entry === 'equipment' || entry === 'tag') && manifest.entries.includes(entry) ? entry : 'start',
    entityId: matchesProject ? params.get('entityId') : null };
  return <div className="flex h-full min-h-0 flex-col text-[var(--flux-text)] bg-[var(--flux-surface)]">
    <div className="fx-head shrink-0"><h1 className="fx-head-title">{manifest.name}</h1><span className="fx-head-count">{manifest.version}</span></div>
    <ModuleFrame key={`${manifest.id}:${user?.id || ''}`} manifest={manifest} context={context} theme={theme}
      createReadCycle={() => createModuleReadCycle(context)} />
  </div>;
}
