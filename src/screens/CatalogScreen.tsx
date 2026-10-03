/** Общий просмотрщик и отдельная рабочая область редакторов. Публикации не загрязняются черновиками. */
import React, { useCallback, useEffect, useState } from 'react';
import { useCatalogStore } from '../store/catalogStore';
import { useStore } from '../store/store';
import { useCatalogLive } from '../components/catalog/useCatalogLive';
import SectionErrorBoundary from '../components/SectionErrorBoundary';
import CatalogReader from '../components/catalog/CatalogReader';
import CatalogManagement from '../components/catalog/CatalogManagement';
import CatalogPublications from '../components/catalog/CatalogPublications';
import CatalogAccess from '../components/catalog/CatalogAccess';
import DataIssueDialog from '../components/catalog/DataIssueDialog';
import { catalogWorkspaceService } from '../services/catalogWorkspaceService';
import type { CatalogWorkspace } from '../../catalog/publication';
import type { CatalogDataIssueContext } from '../../feedback/catalogDataIssue';
import { Btn } from '../components/catalog/ui';
export default function CatalogScreen() {
  const catalog = useCatalogStore(s => s.catalog); const meta = useCatalogStore(s => s.meta); const load = useCatalogStore(s => s.load);
  const loaded = useCatalogStore(s => s.loaded); const error = useCatalogStore(s => s.error); const user = useStore(s => s.user);
  const [workspace, setWorkspace] = useState<CatalogWorkspace | null>(null); const [manage, setManage] = useState(false);
  const [tab, setTab] = useState<'editor' | 'publication' | 'access'>('editor'); const [issue, setIssue] = useState<CatalogDataIssueContext | null>(null);
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
  useEffect(() => { if (workspace && !canManage) setManage(false); if (workspace && !canUseEditor && tab === 'editor') setTab('publication'); }, [workspace, canManage, canUseEditor, tab]);
  const afterPublication = async () => { await refresh(); await load(true); };
  return <SectionErrorBoundary title="Каталог"><div className="h-full min-h-0 flex flex-col gap-2">
    {(manage || canManage) && <div className="flex items-center gap-2 flex-wrap min-h-9">
      <Btn onClick={() => setManage(!manage)}>{manage ? '← К просмотру каталога' : 'Управление данными'}</Btn>
      {manage && <>{canUseEditor && <Btn onClick={() => setTab('editor')}>Редактор</Btn>}<Btn onClick={() => setTab('publication')}>Публикации · {workspace?.drafts.length || 0}</Btn>{['OWNER', 'ADMIN'].includes(user?.role || '') && <Btn onClick={() => setTab('access')}>Доступ сотрудников</Btn>}</>}
    </div>}
    {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    {manage && workError && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{workError}</p>}
    <div className="flex-1 min-h-0">{!loaded ? <p className="text-sm p-3">Загружаю каталог…</p> : manage && workspace ? tab === 'publication' ? <CatalogPublications workspace={workspace} onChanged={afterPublication} /> : tab === 'access' ? <CatalogAccess catalog={workspace.catalog} onSaved={() => void refresh()} /> : <CatalogManagement catalog={workspace.catalog} meta={meta} rights={workspace.rights} onChanged={refresh} /> : <CatalogReader catalog={catalog} onManage={canManage ? () => setManage(true) : undefined} onReport={(family, field, detail) => setIssue({ program: 'catalog', entityId: family.id, entityTitle: family.code, field, currentValue: detail?.currentValue, revision: meta[family.id]?.updatedAt, source: detail?.source || family.catalog })} />}</div>
    {issue && <DataIssueDialog context={issue} onClose={() => setIssue(null)} />}
  </div></SectionErrorBoundary>;
}
