import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LoaderCircle, Pin, Save, X } from 'lucide-react';
import { useStore } from '../../store/store';
import { Btn, Input } from '../ui';
import FluxFieldsPanel from './FluxFieldsPanel';
import FluxSelectionPanel from './FluxSelectionPanel';
import { fieldsFromCatalog, officeDataApi, toProjectQuery, type OfficeField, type OfficeFillPlan, type OfficeQuery, type OfficeQueryResult, type OfficeState, type OfficeTemplate } from './fluxData';
import type { OfficeBinding } from '../../lib/officeModel';

type Tab = 'selection' | 'fields' | 'update';
export interface FluxOfficeAnchorSelection {
  anchorId: string;
  kind: 'word-row' | 'excel-range';
  sheetName?: string;
  address?: string;
}
interface Props {
  fileId: string;
  projectId: string;
  fileName: string;
  editorKind: 'docs' | 'sheets';
  readOnly: boolean;
  activeAnchor: FluxOfficeAnchorSelection | null;
  requestState: () => Promise<OfficeState | null>;
  insertBinding: (anchor: FluxOfficeAnchorSelection, binding: OfficeBinding) => Promise<boolean>;
  applyWrites: (plan: OfficeFillPlan, schema: OfficeState['schema']) => Promise<boolean>;
  updateSchema: (schema: OfficeState['schema']) => Promise<OfficeState | null>;
  onOpenLegacy: () => void;
  onClose: () => void;
}

const initialQuery = (projectId: string): OfficeQuery => ({ projectId, sources: ['equipment'], types: [], filters: [], sort: [], excludedEntityIds: [], limit: 1000 });

/** Flux addon panel; the GenOffice canvas, ribbon, and save lifecycle remain owned by the editor. */
export default function FluxOfficePanel(props: Props) {
  const activeProject = useStore((state) => state.activeProject);
  const [tab, setTab] = useState<Tab>('selection');
  const [fields, setFields] = useState<OfficeField[]>([]);
  const [officeState, setOfficeState] = useState<OfficeState | null>(null);
  const [templateSchema, setTemplateSchema] = useState<OfficeState['schema'] | null>(null);
  const [query, setQuery] = useState<OfficeQuery>(() => initialQuery(props.projectId));
  const [result, setResult] = useState<OfficeQueryResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedField, setSelectedField] = useState<OfficeField | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [plan, setPlan] = useState<OfficeFillPlan | null>(null);
  const [planSchema, setPlanSchema] = useState<OfficeState['schema'] | null>(null);
  const [planQuery, setPlanQuery] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [panelWidth, setPanelWidth] = useState(580);
  const [templates, setTemplates] = useState<OfficeTemplate[]>([]);
  const [pinnedTemplates, setPinnedTemplates] = useState<string[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [templateError, setTemplateError] = useState('');
  const sourceId = query.sources[0] || '';
  const activeAnchor = props.activeAnchor;
  const fillEnabled = props.editorKind === 'sheets';

  useEffect(() => {
    const saved = Number(localStorage.getItem('flux-office-panel-width'));
    if (Number.isFinite(saved) && saved >= 320 && saved <= 850) setPanelWidth(saved);
  }, []);

  const resizePanel = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const move = (pointer: PointerEvent) => {
      const next = Math.max(320, Math.min(850, window.innerWidth - pointer.clientX));
      setPanelWidth(next);
      localStorage.setItem('flux-office-panel-width', String(next));
    };
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  };

  const refreshState = useCallback(async () => {
    const state = await props.requestState();
    if (state) { setOfficeState(state); setTemplateSchema(null); }
    return state;
  }, [props.requestState]);

  useEffect(() => {
    if (!props.projectId) { setFields([]); setError('К файлу не привязан проект.'); return; }
    let alive = true;
    setError('');
    Promise.all([officeDataApi.catalog(props.projectId), officeDataApi.templates(), props.requestState()])
      .then(([catalog, templateResult, state]) => {
        if (!alive) return;
        const available = fieldsFromCatalog(catalog);
        setFields(available);
        setTemplates(templateResult.templates || []);
        setPinnedTemplates(templateResult.pinned || []);
        if (state) setOfficeState(state);
        const firstSource = available.some((field) => field.sourceId === 'equipment') ? 'equipment' : available[0]?.sourceId || '';
        setQuery((current) => ({ ...current, projectId: props.projectId, sources: firstSource ? [firstSource] : [] }));
      })
      .catch((reason) => { if (alive) setError(String(reason?.message || reason)); });
    return () => { alive = false; };
  }, [props.projectId, props.requestState]);

  useEffect(() => { setQuery((current) => ({ ...current, projectId: props.projectId })); }, [props.projectId]);
  const sourceFields = useMemo(() => fields.filter((field) => field.sourceId === sourceId), [fields, sourceId]);
  const schema = templateSchema || officeState?.schema;

  const runQuery = useCallback(async () => {
    if (!sourceId) { setError('Выберите источник данных.'); return; }
    const entity = sourceId === 'tags' ? 'tag' : 'element';
    const columns = sourceFields.map((field) => field.fieldKey);
    if (!columns.length) { setError('Для источника сервер не вернул полей.'); return; }
    setLoading(true); setError('');
    try {
      const data = await officeDataApi.query({ ...query, columns });
      setResult(data);
      setSelectedIds((ids) => ids.filter((id) => data.rows.some((row) => row.entityId === id)));
      setQuery((current) => ({ ...current, sourceRevision: data.revision }));
      setPlan(null);
    } catch (reason: any) { setError(String(reason?.message || reason)); }
    finally { setLoading(false); }
  }, [sourceId, sourceFields, query]);

  const bindSelectedField = useCallback(async () => {
    if (!selectedField || !activeAnchor || !officeState) return;
    setBusy(true); setError('');
    try {
      const binding: OfficeBinding = {
        fieldKey: selectedField.fieldKey, sourceId: selectedField.sourceId, entityType: selectedField.entityType,
        entityId: null, sourceRevision: result?.revision || officeState.sourceRevision, ...(selectedField.unit ? { unit: selectedField.unit } : {}), anchorId: activeAnchor.anchorId,
      };
      if (!(await props.insertBinding(activeAnchor, binding))) throw new Error('Редактор не принял привязку.');
      await refreshState();
    } catch (reason: any) { setError(String(reason?.message || reason)); }
    finally { setBusy(false); }
  }, [selectedField, activeAnchor, officeState, result?.revision, props.projectId, props.insertBinding, refreshState]);

  const buildPlan = useCallback(async () => {
    if (!fillEnabled) { setError('Заполнение Word пока недоступно: привязки строк в DOCX ещё не имеют устойчивого ID при сохранении и повторном открытии.'); return; }
    if (!officeState || !schema || !result || !selectedIds.length) { setError('Выберите строки и дождитесь загрузки состояния документа.'); return; }
    setBusy(true); setError('');
    try {
      const queryBody = toProjectQuery({ ...query, columns: sourceFields.map((field) => field.fieldKey) });
      const next = await officeDataApi.preview(props.fileId, {
        projectId: props.projectId, baseHash: officeState.baseHash, sourceRevision: result.revision,
        selectedEntityIds: selectedIds, query: queryBody, schema,
      });
      setPlan(next); setPlanSchema(schema!); setPlanQuery(queryBody); setTab('update');
    } catch (reason: any) { setError(String(reason?.message || reason)); }
    finally { setBusy(false); }
  }, [fillEnabled, officeState, schema, result, selectedIds, props.fileId, props.projectId, query, sourceFields]);

  const applyPlan = useCallback(async () => {
    if (!plan || !planSchema || !planQuery || props.readOnly) return;
    setBusy(true); setError('');
    try {
      const confirmed = await officeDataApi.confirm(props.fileId, {
        projectId: props.projectId, planId: plan.planId, baseHash: plan.baseHash,
        sourceRevision: plan.sourceRevision, selectedEntityIds: plan.selectedEntityIds, query: planQuery, schema: planSchema,
      });
      if (!(await props.applyWrites({ ...plan, writes: confirmed.writes }, planSchema))) throw new Error('Редактор не применил заполнение.');
      setPlan(null); setPlanSchema(null); setPlanQuery(null);
      await refreshState();
    } catch (reason: any) { setError(String(reason?.message || reason)); }
    finally { setBusy(false); }
  }, [plan, planSchema, planQuery, props.readOnly, props.projectId, props.fileId, props.applyWrites, refreshState]);

  const saveTemplate = async () => {
    if (!schema || !templateName.trim()) return;
    setTemplateError('');
    try {
      const { template } = await officeDataApi.saveTemplate({ name: templateName.trim(), scope: 'PERSONAL', schema, query: toProjectQuery({ ...query, columns: sourceFields.map((field) => field.fieldKey) }) });
      setTemplates((items) => [template, ...items.filter((item) => item.id !== template.id)]);
      setTemplateName('');
    } catch (reason: any) { setTemplateError(String(reason?.message || reason)); }
  };
  const saveSchema = async (nextSchema: OfficeState['schema']) => {
    const updated = await props.updateSchema(nextSchema);
    if (updated) { setOfficeState(updated); setTemplateSchema(null); }
    return !!updated;
  };
  const openTemplate = async (template: OfficeTemplate) => {
    setTemplateError('');
    try {
      setQuery(templateQuery(template, props.projectId));
      setTemplateSchema(template.schema as OfficeState['schema']);
      setPlan(null); setPlanSchema(null); setPlanQuery(null);
    } catch (reason: any) { setTemplateError(String(reason?.message || reason)); }
  };
  const pinTemplate = async (template: OfficeTemplate) => {
    try {
      const pinned = !pinnedTemplates.includes(template.id);
      const response = await officeDataApi.pinTemplate(template.id, pinned);
      setPinnedTemplates(response.pinned || []);
    } catch (reason: any) { setTemplateError(String(reason?.message || reason)); }
  };

  return (
    <aside aria-label="Flux Office" style={{ width: panelWidth, maxWidth: '100vw' }} className="relative z-20 flex h-full shrink-0 flex-col border-l border-slate-200 bg-white max-[760px]:absolute max-[760px]:inset-y-0 max-[760px]:right-0 max-[760px]:z-50 max-[760px]:w-full dark:border-dark-border dark:bg-dark-surface">
      <div role="separator" aria-orientation="vertical" aria-label="Изменить ширину панели Flux" tabIndex={0} onPointerDown={resizePanel}
        onKeyDown={(event) => { if (event.key === 'ArrowLeft') setPanelWidth((width) => Math.min(850, width + 24)); if (event.key === 'ArrowRight') setPanelWidth((width) => Math.max(320, width - 24)); }}
        className="absolute -left-1 top-0 z-10 hidden h-full w-2 cursor-col-resize focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 md:block" />
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-dark-border">
        <div className="min-w-0"><h2 className="text-sm font-semibold text-slate-900 dark:text-dark-text-main">Flux · {props.fileName || 'Office'}</h2><p className="truncate text-xs text-slate-500 dark:text-slate-400">{activeProject?.name || 'Выборка, поля и обновление'}</p></div>
        <button type="button" onClick={props.onOpenLegacy} className="shrink-0 rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800" title="Все источники, переводчик и экспорт">Источники и перевод</button>
        <button type="button" onClick={props.onClose} aria-label="Закрыть Flux" className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4" /></button>
      </header>

      <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-slate-200 px-3 py-2 dark:border-dark-border" aria-label="Шаблоны Flux">
        <span className="shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">Шаблоны</span>
        {templates.map((template) => <div key={template.id} className="flex shrink-0 items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs dark:border-dark-border">
          <button type="button" onClick={() => void openTemplate(template)}>{template.name}</button>
          <button type="button" onClick={() => void pinTemplate(template)} aria-pressed={pinnedTemplates.includes(template.id)} aria-label={`${pinnedTemplates.includes(template.id) ? 'Открепить' : 'Закрепить'} ${template.name}`} title={pinnedTemplates.includes(template.id) ? 'Открепить' : 'Закрепить'}><Pin className={`h-3 w-3 ${pinnedTemplates.includes(template.id) ? 'fill-current text-emerald-700 dark:text-emerald-300' : ''}`} /></button>
        </div>)}
        <Input aria-label="Название шаблона" value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="Новый шаблон" className="h-7 min-w-28 max-w-36 text-xs" />
        <button type="button" onClick={() => void saveTemplate()} disabled={!schema || !templateName.trim() || props.readOnly} title="Сохранить шаблон" className="rounded p-1 text-slate-500 disabled:opacity-40"><Save className="h-3.5 w-3.5" /></button>
      </div>
      {templateError && <p role="alert" className="border-b border-rose-200 px-3 py-1 text-xs text-rose-700 dark:border-rose-900 dark:text-rose-300">{templateError}</p>}

      <nav className="flex shrink-0 border-b border-slate-200 dark:border-dark-border" aria-label="Этап Flux">
        {([['selection', 'Выборка'], ['fields', 'Поля и шапка'], ['update', 'Обновление']] as const).map(([key, label], index) => <button key={key} type="button" onClick={() => setTab(key)} aria-current={tab === key ? 'step' : undefined}
          className={`flex-1 border-b-2 px-2 py-2 text-xs font-semibold ${tab === key ? 'border-emerald-600 text-emerald-700 dark:text-emerald-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}>
          {index + 1}. {label}
        </button>)}
      </nav>

      {error && <p role="alert" className="shrink-0 border-b border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">{error}</p>}
      {!props.projectId && <p className="shrink-0 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">Сначала привяжите документ к проекту.</p>}
      {tab === 'selection' && <FluxSelectionPanel query={query} fields={fields} result={result} loading={loading} error="" selectedIds={selectedIds} onQueryChange={setQuery} onRun={() => void runQuery()} onSelectionChange={setSelectedIds} />}
      {tab === 'fields' && <FluxFieldsPanel fields={fields} state={officeState ? { ...officeState, schema: schema || officeState.schema } : null} selectedField={selectedField} activeAnchorId={activeAnchor?.anchorId || ''} projectId={props.projectId} readOnly={props.readOnly} canEditSchema={!props.readOnly} onSelectField={setSelectedField} onSaveSchema={saveSchema} />}
      {tab === 'update' && <UpdatePanel state={officeState} result={result} plan={plan} selectedCount={selectedIds.length} busy={busy} readOnly={props.readOnly} fillEnabled={fillEnabled} onRefresh={() => void refreshState()} />}

      {tab === 'fields' && <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-200 px-3 py-2 dark:border-dark-border">
        <span className="min-w-0 truncate text-xs text-slate-500 dark:text-slate-400">{activeAnchor ? `${activeAnchor.sheetName ? `${activeAnchor.sheetName}!` : ''}${activeAnchor.address || activeAnchor.anchorId}` : 'Выберите ячейку шапки в документе'}</span>
        <Btn tone="primary" disabled={busy || props.readOnly || !selectedField || !activeAnchor} onClick={() => void bindSelectedField()}>{busy ? <LoaderCircle className="animate-spin" /> : null}Привязать поле</Btn>
      </div>}
      {tab === 'update' && <div className="flex shrink-0 items-center justify-between border-t border-slate-200 px-3 py-2 dark:border-dark-border">
        <span className="text-xs text-slate-500 dark:text-slate-400">Выбрано строк: {selectedIds.length}</span>
        {plan ? <Btn tone="primary" disabled={busy || props.readOnly || plan.errors.length > 0 || plan.conflicts.length > 0} onClick={() => void applyPlan()}>{busy ? 'Проверка…' : 'Подтвердить и заполнить'}</Btn>
          : <Btn tone="primary" disabled={busy || props.readOnly || !fillEnabled || !selectedIds.length || !officeState} onClick={() => void buildPlan()}>{busy ? 'Строим план…' : 'Предпросмотр заполнения'}</Btn>}
      </div>}
    </aside>
  );
}

function UpdatePanel({ state, result, plan, selectedCount, busy, readOnly, fillEnabled, onRefresh }: {
  state: OfficeState | null; result: OfficeQueryResult | null; plan: OfficeFillPlan | null; selectedCount: number;
  busy: boolean; readOnly: boolean; fillEnabled: boolean; onRefresh: () => void;
}) {
  return <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
    <div className="mb-4 flex items-center justify-between"><h3 className="font-semibold">Состояние документа и источника</h3><button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" onClick={onRefresh} disabled={busy}><LoaderCircle className={busy ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />Проверить</button></div>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs"><dt className="text-slate-500 dark:text-slate-400">Источник</dt><dd className="truncate">{result?.revision || 'Не запрошен'}</dd><dt className="text-slate-500 dark:text-slate-400">Документ</dt><dd className="truncate">{state?.baseHash || 'Состояние не прочитано'}</dd><dt className="text-slate-500 dark:text-slate-400">Якорей шапки</dt><dd>{state?.schema.anchors.length ?? '—'}</dd><dt className="text-slate-500 dark:text-slate-400">Выбрано строк</dt><dd>{selectedCount}</dd></dl>
    {!fillEnabled && <p className="mt-4 border-l-2 border-amber-500 pl-3 text-xs text-amber-800 dark:text-amber-300">Заполнение Word пока отключено: ID ячейки DOCX не сохраняется устойчиво между открытием файла и повторным запуском. Привязки полей вставлять можно; заполнение станет доступно после сохранения устойчивых якорей.</p>}
    {plan && <section className="mt-5 space-y-3 border-t border-slate-200 pt-4 dark:border-dark-border"><h3 className="font-semibold">План заполнения</h3><PlanCount label="Будет добавлено" count={plan.adds.length} /><PlanCount label="Будет обновлено" count={plan.replaces.length} /><PlanCount label="Ручные строки сохранены" count={plan.manualRows.length} /><PlanCount label="Пропущено" count={plan.skips.length} /><PlanCount label="Ошибки" count={plan.errors.length} /><PlanCount label="Конфликты" count={plan.conflicts.length} />
      {plan.errors.map((item, index) => <p key={`error-${index}`} className="text-xs text-rose-700 dark:text-rose-300">{item.message}</p>)}
      {plan.conflicts.map((item, index) => <p key={`conflict-${index}`} className="text-xs text-amber-700 dark:text-amber-300">Конфликт в {item.anchorId}: {item.candidates.join(', ')}</p>)}
      <p className="text-xs text-slate-500 dark:text-slate-400">План не сохраняет файл. После подтверждения изменения попадут в текущий редактор, затем используются обычные сохранение и история GenOffice.</p>
    </section>}
    {readOnly && <p className="mt-4 text-xs text-amber-700 dark:text-amber-300">Документ открыт только для просмотра.</p>}
    <div className="sr-only" aria-live="polite">{busy ? 'Flux выполняет запрос' : 'Flux готов'}</div>
  </div>;
}

function PlanCount({ label, count }: { label: string; count: number }) { return <div className="flex items-center justify-between text-xs"><span className="text-slate-600 dark:text-slate-300">{label}</span><strong className="tabular-nums">{count.toLocaleString('ru-RU')}</strong></div>; }

function templateQuery(template: OfficeTemplate, projectId: string): OfficeQuery {
  const saved: any = template.query || {};
  return {
    ...initialQuery(projectId),
    sources: [saved.entity === 'element' ? 'equipment' : 'tags'],
    columns: Array.isArray(saved.columns) ? saved.columns.map(String) : [],
    filters: Array.isArray(saved.filters) ? saved.filters.map((filter: any) => ({ fieldKey: String(filter.field), op: filter.op === 'eq' ? 'equals' : filter.op === 'neq' ? 'notEquals' : filter.op === 'nempty' ? 'notEmpty' : filter.op, value: String(filter.value ?? '') })) : [],
    sort: Array.isArray(saved.sort) ? saved.sort.map((item: any) => ({ fieldKey: String(item.field), direction: item.direction === 'desc' ? 'desc' : 'asc' })) : [],
  };
}
