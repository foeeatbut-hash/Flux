import React from 'react';
import { Toolbar, Input, Btn, Select, Status } from '../ui';
import { can } from '../../lib/permissions';
import { useAppContext } from '../../store/policyStore';
import { kitUndo } from '../../lib/docflowKitApi';
import { useKitDocuments } from './useKitDocuments';
import KitRowsDialog from './KitRowsDialog';
import TagKitDocuments from './TagKitDocuments';
import CreateFilesDialog from './CreateFilesDialog';
import IssueDialog from './IssueDialog';
import { useProjectDocs } from './useProjectDocs';
import { useStore } from '../../store/store';
import { useBindingLedger } from '../explorer/useProjectFolderBindings';

export default function DocflowTags({ projectId }: { projectId: string }) {
  const { user } = useAppContext();
  const canEdit = can(user, 'docflow.edit');
  const [stage, setStage] = React.useState('Р');
  const { view, error, reload } = useKitDocuments(projectId, undefined, stage);
  const [selected, setSelected] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [planTags, setPlanTags] = React.useState<string[] | null>(null);
  const [fileItems, setFileItems] = React.useState<string[] | null>(null);
  const [issueItems, setIssueItems] = React.useState<string[] | null>(null);
  const { docs: projectDocs, reload: reloadDocs } = useProjectDocs([projectId], can(user, 'docflow.view'));
  const { bindings: folderBindings } = useBindingLedger(useStore(s => s.user)?.id);
  const [notice, setNotice] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { setSelected(''); setNotice(''); setPlanTags(null); setFileItems(null); }, [projectId]);
  const tags = view?.tags.filter(tag => tag.identifier.toLocaleLowerCase().includes(search.toLocaleLowerCase())) || [];
  const current = tags.find(tag => tag.id === selected) || tags[0];
  const currentItemIds = [...new Set([...(current?.items || []).map(item => item.id), ...(current?.requirements || []).flatMap(r => r.item ? [r.item.id] : [])])];
  const undo = async () => {
    if (!view?.lastPlanId) return;
    setBusy(true); setNotice('');
    const answer = await kitUndo(projectId, view.lastPlanId);
    setBusy(false);
    if (answer.ok) reload(); else setNotice(answer.data.error || 'Не удалось отменить создание');
  };
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <Toolbar className="!py-[5px]">
      <Input aria-label="Найти тег для документов" placeholder="Найти тег…" value={search} onChange={e => setSearch(e.target.value)} className="!w-48 shrink-0" />
      <Select className="!w-28 shrink-0" aria-label="Стадия документов" value={stage} onChange={setStage} options={[{ value: 'П', label: 'Стадия П' }, { value: 'Р', label: 'Стадия Р' }]} />
      {canEdit && <Btn disabled={!view?.tags.some(t => !t.removed)} onClick={() => setPlanTags(view!.tags.filter(t => !t.removed).map(t => t.id))}>Строки для всех тегов…</Btn>}
      {canEdit && view?.lastPlanId && <Btn disabled={busy} onClick={() => void undo()}>Отменить последнее создание строк</Btn>}
    </Toolbar>
    {(error || notice) && <div className="p-3"><Status tone="rose">{error || notice}</Status></div>}
    {!view && !error && <p role="status" className="p-4 fx-note">Загрузка комплектов…</p>}
    {view && <><p className="px-4 py-2 fx-note">Нужно {view.totals.needed} · есть {view.totals.existing} · выдано {view.totals.issued} · просрочено {view.totals.overdue}</p>
      <div className="flex min-h-0 flex-1 border-t border-[var(--line)]">
        <aside className="fx-side w-52 shrink-0 overflow-y-auto" aria-label="Теги документов">{tags.map(tag => <button className="fx-li w-full text-left" aria-current={current?.id === tag.id ? 'true' : undefined} type="button" key={tag.id} onClick={() => setSelected(tag.id)}>
          <span className="font-mono truncate">{tag.identifier}</span><span className="fx-note ml-auto">{tag.removed ? 'снят' : `${tag.requirements.filter(r => r.item).length}/${tag.requirements.filter(r => r.needed).length}`}</span>
        </button>)}</aside>
        <div className="min-w-0 flex-1 overflow-auto p-4">{current ? <>
          <div className="flex items-center gap-2 mb-3"><h3 className="font-medium text-sm font-mono">{current.identifier}</h3>
            {can(user, 'docflow.files') && <Btn disabled={!currentItemIds.length} onClick={() => setFileItems(currentItemIds)}>Создать файлы по тегу…</Btn>}
            {can(user, 'docflow.issue') && <Btn data-issue-by-tag disabled={!currentItemIds.length || !projectDocs[projectId]} onClick={() => setIssueItems(currentItemIds)}>Выпустить документы тега…</Btn>}
            {canEdit && !current.removed && <Btn className="ml-auto" onClick={() => setPlanTags([current.id])}>Создать недостающие строки…</Btn>}</div>
          <TagKitDocuments key={current.id} tag={current} canEdit={canEdit} onCreate={() => setPlanTags([current.id])} />
        </> : <p className="fx-note">Тегов пока нет или они не подходят поиску.</p>}</div>
      </div>
    </>}
    {planTags && view && <KitRowsDialog projectId={projectId} tagIds={planTags} registers={view.registers} stage={stage} onClose={() => setPlanTags(null)} onApplied={reload} />}
    {issueItems && projectDocs[projectId] && <IssueDialog projectId={projectId} docs={projectDocs[projectId]} bindings={folderBindings} itemIds={issueItems} onClose={() => setIssueItems(null)} onDone={() => { reload(); void reloadDocs(projectId); }} />}
    {fileItems && <CreateFilesDialog projectId={projectId} itemIds={fileItems} onClose={() => setFileItems(null)} onDone={reload} />}
  </div>;
}
