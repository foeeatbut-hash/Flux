import React, { useEffect, useRef, useState } from 'react';
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
import { Chip } from '../components/ui';
import { DevConsentDialog } from '../components/store/StoreDialogs';
import { acceptDevRun, clearDevStorage, DEV_BADGE, removeDevRun } from '../services/moduleDevRunActions';
import { isStandalone } from '../../modules/storage/model';

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
  // Была ли здесь программа из разработки: если она остановилась (Studio закрыта, «Убрать»), говорим об этом, а не «модуль недоступен»
  const wasDev = useRef(false);
  if (selected?.dev) wasDev.current = true;
  return <ModuleHostSession key={`${location.pathname}:${user?.id || ''}`} current={current} wasDev={wasDev.current} location={location} project={project} theme={theme} />;
}

function ModuleHostSession({ current, wasDev, location, project, theme }: {
  wasDev: boolean;
  current: Pick<InstalledModule, 'manifest' | 'channel' | 'author' | 'dev'> | { manifest: typeof bundledModules[number]; channel: undefined } | undefined; location: ReturnType<typeof useLocation>;
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
    // Пакет разработки идёт не через каналы Store: его допуск решает главный процесс (согласие, аренда, отзыв ключа)
    if ('dev' in item && item.dev) return !!(author && trust?.revoked?.keys.includes(author));
    const cap = item.channel ? trust?.channelCaps?.[`${id}:${item.channel}`] : undefined;
    return !!(trust?.revoked?.releases.includes(`${id}@${version}`)
      || (author && trust?.revoked?.keys.includes(author)) || (cap && compareVersions(version, cap) > 0)
      || (item.channel && trust && !trust.channels.includes(item.channel)));
  };
  const blocked = denied(running);
  const selected = current && !denied(current) ? current : undefined;
  // Отзыв и подписанный откат — исключения: недействующий код нельзя
  // удерживать ради незавершённого расчёта, даже если уже выбрано обновление.
  // Пакет разработки приходит и уходит по решению главного процесса (согласие, срок аренды, «Убрать»): его не удерживают
  // ради незавершённого расчёта, как и отозванный выпуск, и не оставляют на месте, когда он сменился выпуском
  const devNow = !!current && 'dev' in current && !!current.dev, devWas = !!running && 'dev' in running && !!running.dev;
  const follow = devNow || devWas;
  const active = current ? (blocked || follow ? selected : running || selected) : undefined;
  useEffect(() => {
    if (!current || blocked || follow) setRunning(selected);
    else if (!running && selected) setRunning(selected);
  }, [current, running, blocked, selected, follow]);
  const manifest = active?.manifest;
  const dev = active && 'dev' in active ? active.dev : undefined;
  if (!manifest && wasDev) return <div className="fx-empty" data-testid="dev-stopped"><div className="fx-empty-title">Программа из разработки остановлена</div>
    <div className="fx-empty-text">Studio закрыта или пакет убран. Запустите программу из Studio снова.</div></div>;
  if (!manifest) return <div className="fx-empty"><div className="fx-empty-title">Модуль недоступен</div></div>;
  // Первый запуск сборки из разработки: пока человек не согласился с разрешениями, программа не открывается
  if (dev && !dev.accepted) return <DevConsent manifestId={manifest.id} />;
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
      {dev && <Chip tone="amber" title="Эту сборку не проверял и не подписывал владелец; она работает только у вас, пока открыта Studio">{DEV_BADGE}</Chip>}
      {dev && <div className="fx-head-acts">
        {isStandalone(manifest) && <button className="fx-btn" data-testid="dev-clear-storage" title="Данные сборки из разработки переживают перезапуск Flux и «Убрать»; стираются только так и из Studio. Данные выпущенной программы не затрагиваются"
          onClick={() => void clearDevStorage(manifest.id).then(() => setGeneration(value => value + 1)).catch(() => {})}>Очистить хранилище</button>}
        <button className="fx-btn" data-testid="dev-remove" onClick={() => void removeDevRun(manifest.id).catch(() => {})}>Убрать</button></div>}
      {selected && selected.manifest.version !== manifest.version && <div className="fx-head-acts"><button className="fx-btn" onClick={() => {
        setRunning(selected); setGeneration(value => value + 1);
      }}>Вышла версия {selected.manifest.version} — Перезапустить</button></div>}
    </div>
    <ModuleFrame key={`${manifest.id}:${manifest.version}:${dev?.sha256 || ''}:${generation}:${page}`} page={page} windowParams={windowParams} windowTitle={manifest.ui === 'page' ? (params.get('title') || '').slice(0, 80) : ''} manifest={manifest} channel={active?.channel} context={context} theme={theme}
      createReadCycle={() => createModuleReadCycle(context)} />
  </div>;
}

/** Согласие на разрешения сборки из разработки: пустое состояние с одной кнопкой и сам диалог */
function DevConsent({ manifestId }: { manifestId: string }) {
  const item = useModuleStore(state => state.local?.dev?.find(d => d.moduleId === manifestId));
  const [open, setOpen] = useState(true);
  if (!item?.manifest) return <div className="fx-empty"><div className="fx-empty-title">Модуль недоступен</div></div>;
  return <div className="fx-empty" data-testid="dev-consent-wait"><div className="fx-empty-title">{item.name} — {DEV_BADGE}</div>
    <div className="fx-empty-text">Перед первым запуском этой сборки нужно согласиться с разрешениями.</div>
    <div className="flex gap-2"><button className="fx-btn" onClick={() => setOpen(true)}>Показать разрешения</button>
      <button className="fx-btn" onClick={() => void removeDevRun(item.moduleId).catch(() => {})}>Убрать</button></div>
    {open && <DevConsentDialog item={item} onClose={() => setOpen(false)} onAccept={() => acceptDevRun(item)} />}
  </div>;
}
