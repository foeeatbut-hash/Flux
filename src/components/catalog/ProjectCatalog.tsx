import React, { useCallback, useEffect, useState } from 'react';
import { textOf, type Family } from '../../../catalog/model';
import type { CatalogDraft } from '../../../catalog/publication';
import { catalogService } from '../../services/catalogService';
import { catalogWorkspaceService } from '../../services/catalogWorkspaceService';
import type { CatalogDifference } from '../../../shared/catalogProject';
import { projectCatalogService, type ProjectCatalogOperation, type ProjectCatalogPlan, type ProjectCatalogSource, type ProjectCatalogView } from '../../services/projectCatalogService';
import { ProjectFamilyEditor } from './ProjectFamilyEditor';
import { countOf } from '../../lib/plural';

const labels: Record<string, string> = { code: 'Код', title: 'Название', ru: 'на русском', en: 'на английском', classId: 'Класс', manufacturerId: 'Изготовитель', params: 'Параметры', specs: 'Характеристики', description: 'Описание', value: 'Значение', label: 'Название', unit: 'Единица', kind: 'Тип', positions: 'Обозначение', rules: 'Правила', facts: 'Признаки', status: 'Состояние', values: 'Варианты' };
function valueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.map(valueText).join('; ') : 'Нет';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.ru === 'string') return record.ru;
    return Object.entries(record).map(([key, val]) => `${labels[key] || key}: ${valueText(val)}`).join(', ') || '—';
  }
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return String(value);
}
function Differences({ changes, preview = true }: { changes: CatalogDifference[]; preview?: boolean }) {
  if (!changes.length) return <p className="text-sm text-[var(--flux-text-muted)]">Отличий нет</p>;
  return <div className="overflow-auto"><table className="fx-table w-full"><thead><tr><th>Поле</th><th>{preview ? 'Было' : 'Общая основа'}</th><th>{preview ? 'Станет' : 'В проекте'}</th></tr></thead><tbody>{changes.map((change, index) => <tr key={index}><td>{change.path.map(part => labels[part] || part).join(' · ') || 'Позиция'}</td><td>{valueText(change.before)}</td><td>{change.remove ? '—' : valueText(change.after)}</td></tr>)}</tbody></table></div>;
}
const emptyFamily = (): Family => ({ id: crypto.randomUUID(), code: '', title: { ru: '' }, classId: '', manufacturerId: '', kind: '', typeLabel: { ru: '' }, shapes: [], designationMode: 'free', positions: [], params: [], rules: [], specs: [], match: { kinds: [] }, status: 'draft' });

export default function ProjectCatalog({ projectId, canProposeCommon = false }: { projectId: string; canProposeCommon?: boolean }) {
  const [source, setSource] = useState<ProjectCatalogSource>('project');
  const [view, setView] = useState<ProjectCatalogView | null>(null);
  const [selected, setSelected] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{ family: Family; operation: 'create' | 'edit'; revision?: string } | null>(null);
  const [plan, setPlan] = useState<ProjectCatalogPlan | null>(null);
  const [proposal, setProposal] = useState<{ sourceId: string; document: Family; revision?: string } | null>(null);
  const [proposalOpen, setProposalOpen] = useState(false);
  const prepareProposal = (item: Family) => {
    setError('');
    if (proposal?.sourceId !== item.id) {
      const copy = structuredClone(item) as Family & Record<string, unknown>;
      for (const key of Object.keys(copy)) if (key.startsWith('_') || key.startsWith('basedOn') || ['projectId', 'baseDataJson', 'overridesJson'].includes(key)) delete copy[key];
      copy.id = `global-${crypto.randomUUID()}`;
      setProposal({ sourceId: item.id, document: copy });
    }
    setProposalOpen(true);
  };
  const saveProposal = async () => {
    if (!proposal || proposal.revision) return;
    setBusy(true); setError('');
    try { const result = await catalogService.save('family', proposal.document); setProposal({ ...proposal, revision: result.revision }); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const discardProposal = async () => {
    if (!proposal?.revision) return;
    setBusy(true); setError('');
    try {
      await catalogWorkspaceService.discard({ entity: 'family', id: proposal.document.id, revision: proposal.revision } as CatalogDraft);
      window.dispatchEvent(new Event('catalog:workspace-changed'));
      setProposal(null); setProposalOpen(false);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const reload = useCallback(async () => { setBusy(true); setError(''); try { const next = await projectCatalogService.load(projectId, source); setView(next); setSelected(current => next.families.some(f => f.id === current) ? current : next.families[0]?.id || ''); } catch (e: any) { setError(e.message); setView(null); } finally { setBusy(false); } }, [projectId, source]);
  useEffect(() => { setPlan(null); setEditor(null); void reload(); }, [reload]);
  const family = view?.families.find(item => item.id === selected); const row = view?.rows.find(item => item.id === selected);
  const run = async (operation: ProjectCatalogOperation, document?: Family, revision?: string) => {
    setBusy(true); setError(''); try { const result = await projectCatalogService.plan({ projectId, operation, ...(operation === 'create' ? {} : { familyId: selected }), ...(revision ? { expectedRevision: revision } : {}), ...(document ? { document } : {}) }); setEditor(null); setPlan(result); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const apply = async () => { if (!plan) return; setBusy(true); setError(''); try { const next = await projectCatalogService.apply(projectId, plan.id); setPlan(null); setSource('project'); if (source === 'project') { setView(next); setSelected(next.families.find(item => item.id === plan.rows[0]?.id)?.id || next.families[0]?.id || ''); } } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const undo = async () => { if (!view?.lastPlanId) return; setBusy(true); setError(''); try { const next = await projectCatalogService.undo(projectId, view.lastPlanId); setView(next); setSelected(next.families[0]?.id || ''); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  if (proposalOpen && proposal && view) return <div className="flex h-full min-h-0 flex-col text-[13px] leading-5">
    <div className="fx-head"><span className="fx-head-title">Черновик для общего каталога</span></div>
    {error && <p role="alert" className="m-0 px-4 py-2 text-sm text-[var(--flux-bad-text)]">{error}</p>}
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <h3 className="m-0 text-[15px] font-semibold">{proposal.document.code}</h3>
      <p>{textOf(proposal.document.title)}</p>
      <p className="text-sm text-[var(--flux-text-muted)]">{textOf(view.classes.find(item => item.id === proposal.document.classId)?.title) || '—'} · {view.manufacturers.find(item => item.id === proposal.document.manufacturerId)?.name || '—'}</p>
      <p>Черновик увидят редакторы общего каталога. Публикация выполняется отдельно в Панели разработчика.</p>
      {proposal.revision && <p role="status">Черновик подготовлен; откройте Панель разработчика для обычной публикации.</p>}
    </div>
    <div className="flex justify-end gap-2 border-t border-[var(--flux-line)] p-3">
      <button className="fx-btn" disabled={busy} onClick={() => setProposalOpen(false)}>Назад</button>
      {proposal.revision ? <button className="fx-btn" disabled={busy} onClick={() => void discardProposal()}>Отменить черновик</button> : <button className="fx-btn fx-btn-primary" disabled={busy} onClick={() => void saveProposal()}>Создать черновик</button>}
    </div>
  </div>;
  if (editor && view) return <div className="flex h-full min-h-0 flex-col text-[13px] leading-5">{error && <p role="alert" className="m-0 px-4 py-2 text-sm text-[var(--flux-bad-text)]">{error}</p>}<div className="min-h-0 flex-1"><ProjectFamilyEditor catalog={view} initial={editor.family} onCancel={() => setEditor(null)} onSave={document => void run(editor.operation, document, editor.revision)} /></div></div>;
  return <div className="flex h-full min-h-0 flex-col text-[13px] leading-5">
    <div className="fx-head"><span className="fx-head-title">Каталог проекта</span><span className="fx-head-count">{countOf(view?.families.length ?? 0, 'позиция')}</span><span className="flex-1"/>{view?.canEdit && !plan && view.lastPlanId && source === 'project' && <button className="fx-btn" disabled={busy} onClick={() => void undo()}>Отменить последнее изменение</button>}{view?.canEdit && !plan && <button className="fx-btn fx-btn-primary" disabled={busy} onClick={() => setEditor({ family: emptyFamily(), operation: 'create' })}>Своя позиция</button>}</div>
    <div className="fx-tools py-1"><div className="fx-segctl"><button aria-pressed={source === 'project'} onClick={() => setSource('project')}>Проектные позиции</button><button aria-pressed={source === 'common'} onClick={() => setSource('common')}>Общий каталог</button><button aria-pressed={source === 'effective'} onClick={() => setSource('effective')}>Все доступные</button></div></div>
    {error && <p role="alert" className="m-0 px-4 py-2 text-sm text-[var(--flux-bad-text)]">{error}</p>}
    {plan ? <div className="min-h-0 flex-1 overflow-auto p-4"><h3 className="m-0 text-[15px] font-semibold">Предпросмотр изменений</h3><p className="fx-hint">Изменения будут видны участникам выбранного проекта.</p>{plan.operation === 'update' && <p>Общий каталог изменил эти поля; проектные значения будут сохранены.</p>}{plan.rows.map((item, index) => <section key={item.id || index} className="mt-4"><h4 className="font-medium">{item.code}</h4><Differences changes={item.differences}/>{item.conflicts.length > 0 && <><p>Общий каталог изменил эти поля; проектные значения будут сохранены.</p><Differences changes={item.conflicts as CatalogDifference[]}/></>}</section>)}<div className="mt-4 flex justify-end gap-2"><button className="fx-btn" onClick={() => setPlan(null)}>Назад</button><button className="fx-btn fx-btn-primary" disabled={busy} onClick={() => void apply()}>Применить</button></div></div>
      : !view ? <div className="fx-empty">{busy ? 'Загружаю каталог…' : 'Каталог недоступен'}</div> : <div className="flex min-h-0 flex-1"><div className="fx-side w-64 shrink-0 overflow-auto" aria-label="Позиции каталога">{view.families.map(item => <button key={item.id} className="fx-li w-full text-left" aria-current={item.id === selected ? 'true' : undefined} onClick={() => setSelected(item.id)}><span className="truncate">{item.code}</span>{view.rows.find(r => r.id === item.id)?.updateAvailable && <span className="fx-n">Обновление</span>}</button>)}{!view.families.length && <div className="fx-empty">Позиций пока нет</div>}</div>
      <div className="min-w-0 flex-1 overflow-auto p-4">{family ? <><div className="flex flex-wrap items-center gap-2"><h3 className="m-0 text-[15px] font-semibold">{family.code}</h3><span className="text-sm text-[var(--flux-text-muted)]">{textOf(family.title)}</span><span className="flex-1"/>{view.canEdit && (row ? <><button className="fx-btn" onClick={() => setEditor({ family, operation: 'edit', revision: row.revision })}>Изменить</button>{row.basedOnFamilyId && <button className="fx-btn" onClick={() => void run('reset', undefined, row.revision)}>Сбросить к общему</button>}{row.updateAvailable && <button className="fx-btn" onClick={() => void run('update', undefined, row.revision)}>Обновить до новой ревизии общего</button>}</> : <button className="fx-btn" onClick={() => void run('take')}>Взять из общего</button>)}</div>
        {row && canProposeCommon && <div className="mt-3"><button className="fx-btn" disabled={busy} onClick={() => prepareProposal(family)}>Подготовить черновик для общего каталога…</button></div>}
        <p className="text-sm text-[var(--flux-text-muted)]">{view.classes.find(item => item.id === family.classId) ? textOf(view.classes.find(item => item.id === family.classId)?.title) : '—'} · {view.manufacturers.find(item => item.id === family.manufacturerId)?.name || '—'}</p>
        <h4 className="fx-group-title">Проектные отличия</h4>{row ? <Differences changes={row.overrides} preview={false}/> : <p className="text-sm text-[var(--flux-text-muted)]">Общая позиция</p>}
        <h4 className="fx-group-title">Параметры</h4>{family.params.length ? family.params.map(p => <p key={p.key} className="text-sm">{textOf(p.label)}{p.unit ? `, ${p.unit}` : ''}</p>) : <p className="text-sm text-[var(--flux-text-muted)]">Нет параметров</p>}
        <h4 className="fx-group-title">Характеристики</h4>{family.specs.length ? family.specs.map(s => <p key={s.key} className="text-sm">{textOf(s.label)}: {textOf(s.value)} {s.unit || ''}</p>) : <p className="text-sm text-[var(--flux-text-muted)]">Нет характеристик</p>}</> : <div className="fx-empty"><div className="fx-empty-title">Выберите позицию</div><div className="fx-empty-text">Или добавьте позицию в каталог проекта.</div></div>}</div></div>}
  </div>;
}
