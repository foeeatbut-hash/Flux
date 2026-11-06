import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { bundledModules } from '../../modules/bundled';
import { useInstalledModules, type InstalledModule } from '../workspace/installedSections';
import type { LaunchContext } from '../../modules/contract';
import { useStore } from '../store/store';
import { createModuleReadCycle } from '../services/moduleDataService';
import { useModuleStore } from '../store/moduleStoreState';
import { compareVersions } from '../../shared/versionCompare';
import ModuleFrame from '../components/modules/ModuleFrame';

export default function ModuleHost() {
  const location = useLocation();
  const project = useStore(state => state.activeProject);
  const user = useStore(state => state.user);
  const theme = useStore(state => state.theme);
  const installed = useInstalledModules();
  // Встроенный пример — из сборки; подпрограмма из Store — проверенный манифест главного процесса
  const bundled = bundledModules.find(item => location.pathname === `/module/${item.id}`);
  const selected = installed.find(item => location.pathname === `/module/${item.manifest.id}`);
  const current = bundled ? { manifest: bundled, channel: undefined } : selected;
  return <ModuleHostSession key={`${location.pathname}:${user?.id || ''}`} current={current} location={location} project={project} theme={theme} />;
}

function ModuleHostSession({ current, location, project, theme }: {
  current: Pick<InstalledModule, 'manifest' | 'channel' | 'author'> | { manifest: typeof bundledModules[number]; channel: undefined } | undefined; location: ReturnType<typeof useLocation>;
  project: ReturnType<typeof useStore.getState>['activeProject']; theme: string;
}) {
  // Манифест и мост остаются прежними, пока человек не решит прервать расчёт.
  const [running, setRunning] = useState(current);
  const [generation, setGeneration] = useState(0);
  useEffect(() => { if (!current) setRunning(undefined); else if (!running) setRunning(current); }, [running, current]);
  const trust = useModuleStore(state => state.local);
  const denied = (item: typeof current) => {
    if (!item) return false;
    const id = item.manifest.id, version = item.manifest.version;
    const author = 'author' in item ? item.author : undefined;
    const cap = item.channel ? trust?.channelCaps?.[`${id}:${item.channel}`] : undefined;
    return !!(trust?.revoked?.releases.includes(`${id}@${version}`)
      || (author && trust?.revoked?.keys.includes(author)) || (cap && compareVersions(version, cap) > 0)
      || (item.channel && trust && !trust.channels.includes(item.channel)));
  };
  const blocked = denied(running);
  const selected = current && !denied(current) ? current : undefined;
  // Отзыв и подписанный откат — исключения: недействующий код нельзя
  // удерживать ради незавершённого расчёта, даже если уже выбрано обновление.
  const active = current ? (blocked ? selected : running || selected) : undefined;
  useEffect(() => { if (blocked) setRunning(selected); }, [blocked, selected]);
  const manifest = active?.manifest;
  if (!manifest) return <div className="fx-empty"><div className="fx-empty-title">Модуль недоступен</div></div>;
  if (manifest.contractVersion !== 1) return <div className="fx-empty"><div className="fx-empty-title">Обновите Flux для этого модуля</div></div>;
  const params = new URLSearchParams(location.search);
  const entry = params.get('entry');
  const matchesProject = params.get('projectId') === project?.id;
  const context: LaunchContext = { projectId: project?.id || null,
    entry: matchesProject && (entry === 'equipment' || entry === 'tag') && manifest.entries.includes(entry) ? entry : 'start',
    entityId: matchesProject ? params.get('entityId') : null };
  return <div data-running-module={manifest.id} data-running-version={manifest.version} data-running-channel={active?.channel}
    data-running-api={String(manifest.contractVersion)} data-running-developer={manifest.author} data-running-name={manifest.name}
    className="flex h-full min-h-0 flex-col text-[var(--flux-text)] bg-[var(--flux-surface)]">
    <div className="fx-head shrink-0"><h1 className="fx-head-title">{manifest.name}</h1><span className="fx-head-count">{manifest.version}</span>
      {current && current.manifest.version !== manifest.version && <div className="fx-head-acts"><button className="fx-btn" onClick={() => {
        setRunning(current); setGeneration(value => value + 1);
      }}>Вышла версия {current.manifest.version} — Перезапустить</button></div>}
    </div>
    <ModuleFrame key={`${manifest.id}:${manifest.version}:${generation}`} manifest={manifest} channel={active?.channel} context={context} theme={theme}
      createReadCycle={() => createModuleReadCycle(context)} />
  </div>;
}
