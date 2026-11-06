import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { SectionHead, Tabs } from '../components/ui';
import VdrPanel from '../components/vdr/VdrPanel';
import ReconcileTab from '../components/docflow/ReconcileTab';
import DocflowSettings from '../components/docflow/DocflowSettings';
import { can, hasAdminRole } from '../lib/permissions';
import { useAppContext } from '../store/policyStore';
import NoProject from '../components/NoProject';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';

type Tab = 'registry' | 'tags' | 'issues' | 'reconcile' | 'settings';
const tabs: { value: Tab; label: string }[] = [
  { value: 'registry', label: 'Реестр' },
  { value: 'tags', label: 'По тегам' },
  { value: 'issues', label: 'Выпуски' },
  { value: 'reconcile', label: 'Сверка с папкой' },
  { value: 'settings', label: 'Настройки' },
];

export default function DocflowScreen() {
  const { user } = useAppContext();
  const project = useStore(s => s.activeProject);
  const { addToast } = useToastStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const tab: Tab = tabs.find(t => t.value === requested)?.value || 'registry';
  const setTab = (value: Tab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', value);
    setSearchParams(next, { replace: true });
  };
  if (!project) return <NoProject what="Документооборот" />;
  return (
    <div className="fx-page @container">
      <SectionHead title="Документооборот">
        <Tabs label="Вкладки документооборота" value={tab} onChange={setTab} tabs={tabs} />
      </SectionHead>
      {tab === 'registry' ? <div className="flex-1 min-h-0 overflow-y-auto"><VdrPanel /></div>
        : tab === 'settings' ? <div className="flex-1 min-h-0 overflow-hidden"><DocflowSettings projectId={project.id} canEdit={can(user, 'docflow.settings')} isAdmin={hasAdminRole(user)} addToast={addToast} /></div>
          : tab === 'reconcile' ? <div className="flex-1 min-h-0 overflow-hidden"><ReconcileTab projectId={project.id} /></div>
          : <div className="p-4 text-sm text-slate-500 dark:text-dark-text-muted">Этот раздел находится в разработке.</div>}
    </div>
  );
}
