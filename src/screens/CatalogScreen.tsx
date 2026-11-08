/** Каталог: просмотр для всех и панель разработчика для тех, у кого есть права. Публикации не загрязняются черновиками. */
import React, { useCallback, useEffect, useState } from 'react';
import { useCatalogStore } from '../store/catalogStore';
import { useStore } from '../store/store';
import { useCatalogLive } from '../components/catalog/useCatalogLive';
import SectionErrorBoundary from '../components/SectionErrorBoundary';
import CatalogReader from '../components/catalog/CatalogReader';
import ProjectCatalog from '../components/catalog/ProjectCatalog';
import CatalogStudio from '../components/catalog/CatalogStudio';
import DataIssueDialog from '../components/catalog/DataIssueDialog';
import { catalogWorkspaceService } from '../services/catalogWorkspaceService';
import type { CatalogWorkspace } from '../../catalog/publication';
import type { CatalogDataIssueContext } from '../../feedback/catalogDataIssue';

export default function CatalogScreen() {
  const catalog = useCatalogStore(s => s.catalog); const meta = useCatalogStore(s => s.meta); const load = useCatalogStore(s => s.load);
  const loaded = useCatalogStore(s => s.loaded); const error = useCatalogStore(s => s.error); const user = useStore(s => s.user);
  const projectId = useStore(s => s.activeProject?.id);
  const [scope, setScope] = useState<'common' | 'project'>('common');
  const [workspace, setWorkspace] = useState<CatalogWorkspace | null>(null); const [manage, setManage] = useState(false);
  const [issue, setIssue] = useState<CatalogDataIssueContext | null>(null);
  const [workError, setWorkError] = useState('');
  const refresh = useCallback(async () => { try { const next = await catalogWorkspaceService.load(); setWorkspace(current => JSON.stringify(current) === JSON.stringify(next) ? current : next); setWorkError(''); } catch (e: any) { setWorkError(e.message); } }, []);
  useEffect(() => { void load(); void refresh(); }, [load, refresh]); useCatalogLive();
  useEffect(() => { const listener = () => void refresh(); window.addEventListener('catalog:workspace-changed', listener); return () => window.removeEventListener('catalog:workspace-changed', listener); }, [refresh]);
  useEffect(() => {
    if (!manage) return;
    const tick = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', tick); const timer = setInterval(tick, 20000);
    return () => { window.removeEventListener('focus', tick); clearInterval(timer); };
  }, [manage, refresh]);
  const canManage = !!workspace && Object.values(workspace.rights).some(Boolean);
  const canUseEditor = !!workspace && (workspace.rights.edit || workspace.rights.import);
  useEffect(() => { if (workspace && !canManage) setManage(false); }, [workspace, canManage]);
  const afterPublication = async () => { await refresh(); await load(true); };
  return <SectionErrorBoundary title="Каталог"><div className="flex h-full min-h-0 flex-col">
    <div className="fx-tools py-1"><div className="fx-segctl" aria-label="Источник каталога"><button aria-pressed={scope === 'common'} onClick={() => setScope('common')}>Общий</button><button aria-pressed={scope === 'project'} onClick={() => { setManage(false); setScope('project'); }}>Каталог проекта</button></div></div>
    {scope === 'project' ? <div className="min-h-0 flex-1">{projectId ? <ProjectCatalog key={projectId} projectId={projectId} canProposeCommon={!!workspace?.rights.edit}/> : <div className="fx-empty"><div className="fx-empty-title">Проект не выбран</div><div className="fx-empty-text">Выберите проект, чтобы открыть его каталог.</div></div>}</div> : <>
    {error && <p role="alert" className="m-0 px-4 py-2 text-xs text-[var(--flux-bad-text)]">{error}</p>}
    <div className="min-h-0 flex-1">{!loaded ? <p className="p-4 text-[13px] text-[var(--flux-text-muted)]">Загружаю каталог…</p>
      : manage && workspace ? <CatalogStudio workspace={workspace} meta={meta} isAdmin={['OWNER', 'ADMIN'].includes(user?.role || '')} canUseEditor={canUseEditor} workError={workError} onBack={() => setManage(false)} onChanged={refresh} onPublished={afterPublication} />
      : <CatalogReader catalog={catalog} onManage={canManage ? () => setManage(true) : undefined} onReport={(family, field, detail) => setIssue({ program: 'catalog', entityId: family.id, entityTitle: family.code, field, currentValue: detail?.currentValue, revision: meta[family.id]?.updatedAt, source: detail?.source || family.catalog })} />}</div>
    </>}
    {issue && <DataIssueDialog context={issue} onClose={() => setIssue(null)} />}
  </div></SectionErrorBoundary>;
}
