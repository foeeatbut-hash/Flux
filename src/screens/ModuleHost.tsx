import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { bundledModules } from '../../modules/bundled';
import { useInstalledModules, type InstalledModule } from '../workspace/installedSections';
import type { LaunchContext } from '../../modules/contract';
import { useStore } from '../store/store';
import { createModuleReadCycle } from '../services/moduleDataService';
import { useModuleStore } from '../store/moduleStoreState';
import { compareVersions } from '../../shared/versionCompare';
import { CONTRACT_VERSION } from '../../modules/contract';
import ModuleFrame from '../components/modules/ModuleFrame';

export default function ModuleHost() {
  const location = useLocation();
  const project = useStore(state => state.activeProject);
  const user = useStore(state => state.user);
  const theme = useStore(state => state.theme);
  const installed = useInstalledModules();
  // Встроенный пример — из сборки; программа из Store — проверенный манифест главного процесса
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
  useEffect(() => {
    if (!current || blocked) setRunning(selected);
    else if (!running && selected) setRunning(selected);
  }, [current, running, blocked, selected]);
  const manifest = active?.manifest;
  if (!manifest) return <div className="fx-empty"><div className="fx-empty-title">Модуль недоступен</div></div>;
  if (manifest.contractVersion > CONTRACT_VERSION) return <div className="fx-empty"><div className="fx-empty-title">Обновите Flux для этого модуля</div></div>;
  const params = new URLSearchParams(location.search);
  const entry = params.get('entry');
  const matchesProject = params.get('projectId') === project?.id;
  // Окно программы-страницы: какая страница пакета и с какими параметрами (flux.windows.open); чужие имена отбрасываются
  const asked = params.get('page') || 'index.html';
  const page = manifest.ui === 'page' && (asked === 'index.html' || (manifest.pages || []).includes(asked)) ? asked : 'index.html';
  let windowParams: Record<string, unknown> = {};
  try { const raw = JSON.parse(params.get('params') || '{}'); if (raw && typeof raw === 'object' && !Array.isArray(raw)) windowParams = raw; } catch (_) { /* адрес правил вручную */ }
  const context: LaunchContext = { projectId: project?.id || null,
    entry: matchesProject && (entry === 'equipment' || entry === 'tag') && manifest.entries.includes(entry) ? entry : 'start',
    entityId: matchesProject ? params.get('entityId') : null };
  return <div data-running-module={manifest.id} data-running-version={manifest.version} data-running-channel={active?.channel}
    data-running-api={String(manifest.contractVersion)} data-running-developer={manifest.author} data-running-name={manifest.name}
    className="flex h-full min-h-0 flex-col text-[var(--flux-text)] bg-[var(--flux-surface)]">
    <div className="fx-head shrink-0"><h1 className="fx-head-title">{manifest.name}</h1><span className="fx-head-count">{manifest.version}</span>
      {selected && selected.manifest.version !== manifest.version && <div className="fx-head-acts"><button className="fx-btn" onClick={() => {
        setRunning(selected); setGeneration(value => value + 1);
      }}>Вышла версия {selected.manifest.version} — Перезапустить</button></div>}
    </div>
    <ModuleFrame key={`${manifest.id}:${manifest.version}:${generation}:${page}`} page={page} windowParams={windowParams} windowTitle={manifest.ui === 'page' ? (params.get('title') || '').slice(0, 80) : ''} manifest={manifest} channel={active?.channel} context={context} theme={theme}
      createReadCycle={() => createModuleReadCycle(context)} />
  </div>;
}
