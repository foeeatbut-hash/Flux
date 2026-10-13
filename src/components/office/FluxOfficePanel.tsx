import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { useStore } from '../../store/store';
import { useModalStore } from '../../store/modalStore';
import { Btn } from '../ui';
import FluxFieldsPanel from './FluxFieldsPanel';
import FluxSelectionPanel from './FluxSelectionPanel';
import FluxTemplateControls, { canManageTemplate } from './FluxTemplateControls';
import FluxRevisionPanel from './FluxRevisionPanel';
import FluxExportDialog from './FluxExportDialog';
import TextTranslationPanel from './TextTranslationPanel';
import { useOfficeTemplates } from './useOfficeTemplates';
import { insertMessage, insertTable, tableColumns, tableRows, type TableCell } from './fluxTable';
import type { RibbonCommand } from './useFluxRibbon';
import { mapOfficeTemplateToTarget, officeTemplateFieldSelectionKey, type OfficeTemplatePending } from './officeTemplateMapping';
import type { HeaderSchemaSyncOptions } from './officeNativeSchema';
import { dataService } from '../../services/dataService';
import { fieldsFromCatalog, officeDataApi, toProjectQuery, type OfficeAppliedTemplate, type OfficeFileSource, type OfficeLocalSource, type OfficeAnchorRow, type OfficeField, type OfficeFillPlan, type OfficeQuery, type OfficeQueryResult, type OfficeState, type OfficeTemplate } from './fluxData';
import type { OfficeBinding, OfficeHeaderAnchor } from '../../lib/officeModel';

type Tab = 'selection' | 'fields' | 'update';
type View = 'data' | 'translator';
type Dialog = 'templates' | 'pinned' | 'save-template' | 'export' | null;
interface OfficeApplySummary { appliedCount: number; manualRows: string[]; state?: OfficeState }
export interface FluxOfficeAnchorSelection {
  anchorId: string;
  kind: 'word-row' | 'excel-range';
  documentPart?: string;
  sheetName?: string;
  address?: string;
}
interface Props {
  fileId: string;
  /** Файл Проводника: содержимое уходит на сервер только в запросе, «Выпустить» недоступно. */
  localSource?: OfficeLocalSource;
  /** Есть обработчик — в шапке выбор проекта (у файла Проводника проекта нет). */
  onProjectChange?: (projectId: string) => void;
  projectId: string;
  fileName: string;
  editorKind: 'docs' | 'sheets';
  readOnly: boolean;
  schemaWriteAvailable: boolean;
  activeAnchor: FluxOfficeAnchorSelection | null;
  requestState: () => Promise<OfficeState | null>;
  insertBinding: (anchor: FluxOfficeAnchorSelection, binding: OfficeBinding, displayText: string) => Promise<boolean>;
  applyWrites: (plan: OfficeFillPlan, schema: OfficeState['schema'], rows: OfficeAnchorRow[]) => Promise<OfficeApplySummary | false>;
  updateSchema: (schema: OfficeState['schema'], options?: HeaderSchemaSyncOptions) => Promise<OfficeState | null>;
  isInlineEditing?: () => boolean;
  onIssued?: (fileId: string, revisionId: string) => void;
  onDraftCreated?: (fileId: string) => void;
  /** Команда ленты «Flux»: что открыть или сделать (useFluxRibbon). */
  command?: RibbonCommand | null;
  /** Вставка таблицы в документ (Word — таблица, Таблица — диапазон); нет — кнопки «Вставить все» нет. */
  onInsertTable?: (rows: TableCell[][]) => Promise<boolean>;
  /** Переводчик: прочитать выделение редактора и вставить результат. */
  onReadText?: () => Promise<string>;
  onInsertText?: (text: string) => Promise<void> | void;
  /** Шаблон, применённый к файлу, изменился: лента включает или выключает «Исходную шапку». */
  onTemplateChange?: (template: OfficeAppliedTemplate | null) => void;
  onClose: () => void;
}

const initialQuery = (projectId: string): OfficeQuery => ({ projectId, sources: ['equipment'], types: [], filters: [], sort: [], excludedEntityIds: [], limit: 1000 });

/** Flux addon panel; the GenOffice canvas, ribbon, and save lifecycle remain owned by the editor. */
export default function FluxOfficePanel(props: Props) {
  const activeProject = useStore((state) => state.activeProject);
  const [tab, setTab] = useState<Tab>('selection');
  const [fields, setFields] = useState<OfficeField[]>([]);
  const [officeState, setOfficeState] = useState<OfficeState | null>(null);
  const [templateSourceSchema, setTemplateSourceSchema] = useState<OfficeState['schema'] | null>(null);
  const [templateTargetSchema, setTemplateTargetSchema] = useState<OfficeState['schema'] | null>(null);
  const [templateAnchorSelections, setTemplateAnchorSelections] = useState<Record<number, string>>({});
  const [templateFieldSelections, setTemplateFieldSelections] = useState<Record<string, OfficeField>>({});
  const [query, setQuery] = useState<OfficeQuery>(() => initialQuery(props.projectId));
  const [result, setResult] = useState<OfficeQueryResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedField, setSelectedField] = useState<OfficeField | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [plan, setPlan] = useState<OfficeFillPlan | null>(null);
  const [planSchema, setPlanSchema] = useState<OfficeState['schema'] | null>(null);
  const [planQuery, setPlanQuery] = useState<Record<string, unknown> | null>(null);
  const [appliedSummary, setAppliedSummary] = useState<OfficeApplySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [panelWidth, setPanelWidth] = useState(580);
  const tpl = useOfficeTemplates();
  const userId = useStore((state) => state.user?.id || '');
  const [view, setView] = useState<View>('data');
  const [dialog, setDialog] = useState<Dialog>(null);
  /** Шаблон, который открыли, но ещё не сохранили в файл: при сохранении схемы он становится применённым. */
  const [openedTemplate, setOpenedTemplate] = useState<OfficeTemplate | null>(null);
  const [actionMessage, setActionMessage] = useState('');
  const sourceId = query.sources[0] || '';
  const activeAnchor = props.activeAnchor;
  const fileSource: OfficeFileSource = props.localSource ?? props.fileId;
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!props.onProjectChange) return;
    let alive = true;
    dataService.getProjects()
      .then((list: any[]) => { if (alive) setProjects((list || []).map((project) => ({ id: String(project.id), name: String(project.name || 'Без названия') }))); })
      .catch(() => { /* без списка остаётся текущий проект */ });
    return () => { alive = false; };
  }, [!!props.onProjectChange]);
  // Другой проект — другая выборка: строки и план прежнего проекта к нему не относятся
  useEffect(() => { setResult(null); setSelectedIds([]); setPlan(null); setPlanSchema(null); setPlanQuery(null); setAppliedSummary(null); setSelectedField(null); }, [props.projectId]);

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
    if (state) { setOfficeState(state); setTemplateSourceSchema(null); setTemplateTargetSchema(null); }
    return state;
  }, [props.requestState]);

  useEffect(() => {
    if (!props.projectId) { setFields([]); setError(props.onProjectChange ? 'Выберите проект, чтобы загрузить его данные.' : 'К файлу не привязан проект.'); return; }
    let alive = true;
    setError('');
    Promise.all([officeDataApi.catalog(props.projectId), props.requestState()])
      .then(([catalog, state]) => {
        if (!alive) return;
        const available = fieldsFromCatalog(catalog);
        setFields(available);
        if (state) setOfficeState(state);
        const firstSource = available.some((field) => field.sourceId === 'equipment') ? 'equipment' : available[0]?.sourceId || '';
        setQuery((current) => ({ ...current, projectId: props.projectId, sources: firstSource ? [firstSource] : [] }));
      })
      .catch((reason) => { if (alive) setError(String(reason?.message || reason)); });
    return () => { alive = false; };
  }, [props.projectId, props.requestState]);

  useEffect(() => { setQuery((current) => ({ ...current, projectId: props.projectId })); }, [props.projectId]);
  const sourceFields = useMemo(() => fields.filter((field) => field.sourceId === sourceId), [fields, sourceId]);
  const templateMapping = useMemo(() => templateSourceSchema && templateTargetSchema
    ? mapOfficeTemplateToTarget(templateSourceSchema, templateTargetSchema, fields, templateAnchorSelections, templateFieldSelections)
    : null, [templateSourceSchema, templateTargetSchema, fields, templateAnchorSelections, templateFieldSelections]);
  const templateSchema = templateMapping?.schema || null;
  const templatePending: OfficeTemplatePending[] = templateMapping?.pending || [];
  const schema = templateSchema || officeState?.schema;
  const activeAnchorIndex = schema?.anchors.findIndex((anchor) => anchor.id === activeAnchor?.anchorId) ?? -1;

  const runQuery = useCallback(async () => {
    if (!sourceId) { setError('Выберите источник данных.'); return; }
    const available = new Set(sourceFields.map((field) => field.fieldKey));
    const columns = query.columns?.length ? query.columns.filter((key) => available.has(key)) : sourceFields.map((field) => field.fieldKey);
    if (!columns.length) { setError('Для источника сервер не вернул полей.'); return; }
    setLoading(true); setError('');
    try {
      const data = await officeDataApi.query({ ...query, columns });
      setResult(data);
      setSelectedIds((ids) => ids.filter((id) => !query.excludedEntityIds.includes(id) && data.rows.some((row) => row.entityId === id)));
      setQuery((current) => ({ ...current, columns, sourceRevision: data.revision }));
      setPlan(null);
      setAppliedSummary(null);
    } catch (reason: any) { setError(String(reason?.message || reason)); }
    finally { setLoading(false); }
  }, [sourceId, sourceFields, query]);

  const bindSelectedField = useCallback(async () => {
    if (!selectedField || !activeAnchor || !officeState) return;
    setBusy(true); setError('');
    try {
      const current = await props.requestState();
      if (!current) throw new Error('Состояние документа недоступно. Повторите проверку.');
      setOfficeState(current); setTemplateSourceSchema(null); setTemplateTargetSchema(null);
      const binding: OfficeBinding = {
        fieldKey: selectedField.fieldKey, sourceId: selectedField.sourceId, entityType: selectedField.entityType,
        entityId: null, sourceRevision: result?.revision || current.sourceRevision, ...(selectedField.unit ? { unit: selectedField.unit } : {}), anchorId: activeAnchor.anchorId,
      };
      if (!(await props.insertBinding(activeAnchor, binding, selectedField.displayName))) throw new Error('Редактор не принял привязку.');
      // При вводе формулы связь хранится в буфере ячейки до Enter.
      if (props.isInlineEditing?.()) return;
      const previous = current.schema.anchors.find((anchor) => anchor.id === activeAnchor.anchorId);
      const parts = previous?.parts || [];
      const hasBinding = parts.some((part) => part.kind === 'field' && part.binding.fieldKey === binding.fieldKey && part.binding.sourceId === binding.sourceId);
      const anchor: OfficeHeaderAnchor = {
        ...(previous || {}), kind: activeAnchor.kind, id: activeAnchor.anchorId,
        ...(activeAnchor.documentPart ? { documentPart: activeAnchor.documentPart } : {}),
        ...(activeAnchor.sheetName ? { sheetName: activeAnchor.sheetName } : {}),
        ...(activeAnchor.address ? { address: activeAnchor.address } : {}),
        parts: hasBinding ? parts : [...parts, { kind: 'field', binding }],
      };
      // Текстовые фрагменты задают место вставки; черновая схема помогает
      // редактору распознать новый токен в текущей позиции курсора.
      const labels = Object.fromEntries(fields.map((field) => [`${field.sourceId}:${field.fieldKey}`, field.displayName]));
      const saved = await props.updateSchema({ ...current.schema, anchors: [...current.schema.anchors.filter((item) => item.id !== anchor.id), anchor] }, { captureNative: true, displayLabels: labels });
      if (!saved) throw new Error('Поле вставлено, но его связь с источником не сохранена. Повторите сохранение схемы.');
      setOfficeState(saved); setTemplateSourceSchema(null); setTemplateTargetSchema(null);
    } catch (reason: any) { setError(String(reason?.message || reason)); }
    finally { setBusy(false); }
  }, [selectedField, activeAnchor, officeState, result?.revision, fields, props.insertBinding, props.requestState, props.updateSchema]);

  const buildPlan = useCallback(async () => {
    if (templatePending.length) { setError('Сначала уточните все связи выбранного шаблона.'); return; }
    if (templateSchema) { setError('Сохраните схему шаблона во вкладке «Поля и шапка», затем создайте предпросмотр.'); return; }
    if (!officeState || !schema || !result || !selectedIds.length) { setError('Выберите строки и дождитесь загрузки состояния документа.'); return; }
    setBusy(true); setError('');
    try {
      setAppliedSummary(null);
      // Обычная ручная правка меняет хеш файла вне панели. Для нового
      // предпросмотра сохраняем её и читаем актуальные связи; confirm
      // по-прежнему проверяет ровно эту версию и этот план.
      const current = await props.requestState();
      if (!current) throw new Error('Состояние документа недоступно. Повторите проверку.');
      setOfficeState(current);
      const previewSchema = templateSchema || current.schema;
      const queryBody = toProjectQuery({ ...query, columns: query.columns?.length ? query.columns : sourceFields.map((field) => field.fieldKey) });
      const next = await officeDataApi.preview(fileSource, {
        projectId: props.projectId, baseHash: current.baseHash, sourceRevision: result.revision,
        selectedEntityIds: selectedIds, query: queryBody, schema: previewSchema,
      });
      setPlan(next); setPlanSchema(previewSchema); setPlanQuery(queryBody); setTab('update');
    } catch (reason: any) { setError(String(reason?.message || reason)); }
    finally { setBusy(false); }
  }, [officeState, schema, templateSchema, templatePending.length, result, selectedIds, fileSource, props.projectId, props.requestState, query, sourceFields]);

  const applyPlan = useCallback(async () => {
    if (!plan || !planSchema || !planQuery || props.readOnly) return;
    setBusy(true); setError('');
    try {
      const confirmed = await officeDataApi.confirm(fileSource, {
        projectId: props.projectId, planId: plan.planId, baseHash: plan.baseHash,
        sourceRevision: plan.sourceRevision, selectedEntityIds: plan.selectedEntityIds, query: planQuery, schema: planSchema,
      });
      const applied = await props.applyWrites({ ...plan, writes: confirmed.writes }, planSchema, officeState?.rows || []);
      if (!applied) throw new Error('Редактор не применил заполнение.');
      setAppliedSummary(applied);
      setPlan(null); setPlanSchema(null); setPlanQuery(null);
      if (applied.state) setOfficeState(applied.state);
      else await refreshState();
    } catch (reason: any) { setError(String(reason?.message || reason)); }
    finally { setBusy(false); }
  }, [plan, planSchema, planQuery, officeState?.rows, props.readOnly, props.projectId, fileSource, props.applyWrites, refreshState]);

  const currentTemplateQuery = () => toProjectQuery({ ...query, columns: query.columns?.length ? query.columns : sourceFields.map((field) => field.fieldKey) });
  /** Шаблон файла: тот, что применён к нему (снимок в файле), либо только что открытый. */
  const fileTemplate = openedTemplate || tpl.templates.find((item) => item.id === officeState?.template?.templateId) || null;

  // Лента узнаёт, применён ли к файлу шаблон («Исходная шапка»)
  useEffect(() => { props.onTemplateChange?.(officeState ? officeState.template ?? null : null); }, [officeState?.template, !!officeState]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveTemplateAs = async (input: { name: string; description: string; scope: OfficeTemplate['scope']; pin: boolean }) => {
    if (!schema || templatePending.length) return false;
    const made = await tpl.create({ ...input, schema, query: currentTemplateQuery() });
    if (made) setActionMessage(`Шаблон «${made.name}» сохранён.`);
    return !!made;
  };
  /** «Обновить шаблон»: записать текущую шапку в шаблон файла, если его создал этот сотрудник. */
  const updateFileTemplate = async () => {
    if (!schema || templatePending.length) return;
    if (!fileTemplate) { setActionMessage('У файла нет шаблона: сохраните шапку кнопкой «Сохранить как».'); return; }
    if (!canManageTemplate(fileTemplate, userId)) { tpl.setError('Этот шаблон создал другой сотрудник: сохраните свою копию кнопкой «Сохранить как».'); setDialog('templates'); return; }
    const current = await props.requestState();
    if (!current) { tpl.setError('Состояние документа недоступно. Повторите действие.'); return; }
    const updated = await tpl.update(fileTemplate, { schema: current.schema, query: currentTemplateQuery() });
    if (updated) setActionMessage(`Шаблон «${updated.name}» обновлён.`);
    else setDialog('templates');
  };
  const saveSchema = async (nextSchema: OfficeState['schema'], options?: { displayLabels?: Record<string, string> }) => {
    if (templatePending.length) throw new Error('Сначала уточните все связи выбранного шаблона.');
    // Сохранение сопоставленного шаблона и есть его применение: в файл ложатся templateId и снимок схемы
    const link = templateSchema && openedTemplate ? { templateId: openedTemplate.id, name: openedTemplate.name } : undefined;
    const updated = await props.updateSchema(nextSchema, { ...options, ...(link ? { template: link } : {}) });
    if (updated) { setOfficeState(updated); setTemplateSourceSchema(null); setTemplateTargetSchema(null); if (link) setOpenedTemplate(null); }
    return !!updated;
  };
  /** «Исходная шапка»: та же запись схемы, что и у остальных действий, значения в строках не трогаются. */
  const resetHeader = async () => {
    setError(''); setActionMessage('');
    const snapshot = officeState?.template;
    if (!snapshot) { setError('У файла нет шаблона.'); return; }
    const ok = await useModalStore.getState().openConfirm('Вернуть исходную шапку?', `Шапка вернётся к шаблону${snapshot.name ? ` «${snapshot.name}»` : ''}, правки шапки после его применения будут отброшены. Данные в строках не изменятся.`, { confirmLabel: 'Вернуть' });
    if (!ok) return;
    setBusy(true);
    try {
      const current = await props.requestState();
      if (!current) throw new Error('Состояние документа недоступно. Повторите действие.');
      const keep = new Set(snapshot.schema.anchors.map((anchor) => anchor.id));
      const removedAnchorIds = current.schema.anchors.map((anchor) => anchor.id).filter((id) => !keep.has(id));
      const labels = Object.fromEntries(fields.map((field) => [`${field.sourceId}:${field.fieldKey}`, field.displayName]));
      const saved = await props.updateSchema(snapshot.schema, { displayLabels: labels, ...(removedAnchorIds.length ? { removedAnchorIds } : {}) });
      if (!saved) throw new Error('Редактор не подтвердил возврат шапки.');
      setOfficeState(saved); setTemplateSourceSchema(null); setTemplateTargetSchema(null); setOpenedTemplate(null);
      setActionMessage('Шапка возвращена к исходной.');
    } catch (reason: any) { setError(String(reason?.message || reason)); }
    finally { setBusy(false); }
  };
  const openTemplate = async (template: OfficeTemplate) => {
    tpl.setError('');
    try {
      const savedQuery = templateQuery(template, props.projectId);
      const valid = new Set(fields.filter((field) => field.sourceId === savedQuery.sources[0]).map((field) => field.fieldKey));
      setQuery({ ...savedQuery, columns: (savedQuery.columns || []).filter((key) => valid.has(key)), filters: savedQuery.filters.filter((filter) => valid.has(filter.fieldKey)), sort: savedQuery.sort.filter((item) => valid.has(item.fieldKey)) });
      const fresh = await props.requestState();
      const target = fresh?.schema;
      if (!target) throw new Error('Сначала прочитайте состояние открытого документа.');
      setOfficeState(fresh);
      setTemplateSourceSchema(template.schema as OfficeState['schema']);
      setTemplateTargetSchema(target);
      setTemplateAnchorSelections({}); setTemplateFieldSelections({});
      setPlan(null); setPlanSchema(null); setPlanQuery(null);
      setOpenedTemplate(template); setView('data'); setTab('fields');
    } catch (reason: any) { tpl.setError(String(reason?.message || reason)); setDialog('templates'); }
  };
  const copyTemplate = async (template: OfficeTemplate) => { const made = await tpl.copy(template); if (made) setActionMessage(`Копия «${made.name}» сохранена.`); };
  const deleteTemplate = async (template: OfficeTemplate) => {
    if (!(await useModalStore.getState().openConfirm('Удалить шаблон?', `Шаблон «${template.name}» исчезнет у всех, кто им пользуется. Документы с применённым шаблоном сохранят свой снимок.`, { confirmLabel: 'Удалить', tone: 'danger' }))) return;
    await tpl.remove(template);
  };

  // Таблица из выборки: выбранные строки, иначе все; столбцы — поля источника
  const exportSourceId = query.sources[0] || '';
  const allColumns = useMemo(() => tableColumns(fields, exportSourceId), [fields, exportSourceId]);
  const insertAll = async () => {
    if (!props.onInsertTable || !result || props.readOnly) return;
    const rows = tableRows(result, allColumns, selectedIds);
    if (!rows.length) return;
    setBusy(true); setActionMessage('');
    try {
      const { table, truncated } = insertTable(allColumns, rows);
      setActionMessage(insertMessage(await props.onInsertTable(table), truncated));
    } catch (reason: any) { setActionMessage(String(reason?.message || 'Не удалось вставить таблицу.')); }
    finally { setBusy(false); }
  };

  const insertButton = props.onInsertTable ? <Btn disabled={busy || props.readOnly || !result?.rows.length} onClick={() => void insertAll()} title="Вставить таблицу выбранных строк в документ">{selectedIds.length ? `Вставить выбранные (${selectedIds.length})` : 'Вставить все'}</Btn> : null;

  /** «Обновить данные»: выборка по строкам, уже стоящим в документе, → предпросмотр → подтверждение. */
  const refreshData = async () => {
    setView('data'); setTab('update'); setError(''); setActionMessage('');
    setBusy(true);
    try {
      const current = await props.requestState();
      if (!current) throw new Error('Состояние документа недоступно. Повторите действие.');
      setOfficeState(current);
      const placed = [...new Set((current.rows || []).map((row) => row.entityId))];
      if (!placed.length) { setActionMessage('В документе ещё нет заполненных строк: выберите строки во вкладке «Выборка» и нажмите «Предпросмотр заполнения».'); return; }
      const source = (current.rows || [])[0]?.sourceId;
      const useSource = source || sourceId;
      const columns = fields.filter((field) => field.sourceId === useSource).map((field) => field.fieldKey);
      const fresh: OfficeQuery = { ...query, sources: [useSource], columns, filters: [], sort: [], types: [], excludedEntityIds: [], limit: 50000, sourceRevision: undefined };
      const data = await officeDataApi.query(fresh);
      const known = new Set(data.rows.map((row) => row.entityId));
      const ids = placed.filter((id) => known.has(id));
      setResult(data); setSelectedIds(ids); setQuery({ ...fresh, limit: query.limit, sourceRevision: data.revision });
      if (!ids.length) { setActionMessage('Строки документа не найдены в источнике: возможно, они удалены.'); return; }
      const queryBody = toProjectQuery(fresh);
      const next = await officeDataApi.preview(fileSource, {
        projectId: props.projectId, baseHash: current.baseHash, sourceRevision: data.revision,
        selectedEntityIds: ids, query: queryBody, schema: current.schema,
      });
      setPlan(next); setPlanSchema(current.schema); setPlanQuery(queryBody); setAppliedSummary(null);
    } catch (reason: any) { setError(String(reason?.message || reason)); }
    finally { setBusy(false); }
  };

  // Команды ленты: каждая кнопка вкладки Flux приходит сюда ровно один раз
  const handledCommand = useRef(0);
  useEffect(() => {
    const command = props.command;
    if (!command || command.seq === handledCommand.current) return;
    // Команде, которой нужно состояние документа и поля источника, даём их дождаться: панель только открылась
    const needsState = command.name === 'refresh' || command.name === 'reset-header' || command.name === 'update-template';
    if (needsState && (!officeState || (!fields.length && props.projectId && !error))) return;
    handledCommand.current = command.seq;
    setActionMessage('');
    switch (command.name) {
      case 'translator': setView('translator'); break;
      case 'source-equipment': case 'source-tags': {
        const source = command.name === 'source-tags' ? 'tags' : 'equipment';
        setView('data'); setTab('selection');
        setQuery((current) => current.sources[0] === source ? current : { ...current, sources: [source], columns: undefined, filters: [], sort: [], types: [], excludedEntityIds: [] });
        setResult(null); setSelectedIds([]);
        break;
      }
      case 'templates': setDialog('templates'); break;
      case 'pinned': setDialog('pinned'); break;
      case 'save-template': setDialog('save-template'); break;
      case 'update-template': void updateFileTemplate(); break;
      case 'refresh': void refreshData(); break;
      case 'issue': setView('data'); setTab('update'); break;
      case 'reset-header': void resetHeader(); break;
      case 'export': setDialog('export'); break;
    }
  }, [props.command, officeState, fields.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside aria-label="Flux Office" style={{ '--flux-office-panel-width': `${panelWidth}px` } as React.CSSProperties} className="relative z-20 flex h-full w-[var(--flux-office-panel-width)] shrink-0 flex-col border-l border-slate-200 bg-white max-[760px]:absolute max-[760px]:inset-y-0 max-[760px]:right-0 max-[760px]:z-50 max-[760px]:w-full dark:border-dark-border dark:bg-dark-surface">
      <div role="separator" aria-orientation="vertical" aria-label="Изменить ширину панели Flux" tabIndex={0} onPointerDown={resizePanel}
        onKeyDown={(event) => { if (event.key === 'ArrowLeft') setPanelWidth((width) => Math.min(850, width + 24)); if (event.key === 'ArrowRight') setPanelWidth((width) => Math.max(320, width - 24)); }}
        className="absolute -left-1 top-0 z-10 hidden h-full w-2 cursor-col-resize focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 md:block" />
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-dark-border">
        <div className="min-w-0"><h2 className="text-sm font-semibold text-slate-900 dark:text-dark-text-main">{view === 'translator' ? 'Переводчик' : 'Данные для таблицы'} · {props.fileName || 'Office'}</h2>{view === 'translator' ? <p className="truncate text-xs text-slate-500 dark:text-slate-400">Перевод текста документа</p> : props.onProjectChange
          ? <select aria-label="Проект для данных Flux" value={props.projectId} onChange={(event) => props.onProjectChange?.(event.target.value)} className="fx-input mt-1 w-full max-w-[16rem] text-xs">
            <option value="">Выберите проект</option>
            {props.projectId && !projects.some((project) => project.id === props.projectId) && <option value={props.projectId}>{activeProject?.id === props.projectId ? activeProject.name : 'Текущий проект'}</option>}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          : <p className="truncate text-xs text-slate-500 dark:text-slate-400">{activeProject?.name || 'Выборка, поля и обновление'}</p>}</div>
        <button type="button" onClick={props.onClose} aria-label="Закрыть Flux" className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4" /></button>
      </header>

      {templatePending.length > 0 && <div role="status" className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
        <p>Шаблон ожидает уточнения: {templatePending.length}.</p>
        <div className="mt-2 space-y-2">
          {templatePending.map((pending) => pending.kind === 'anchor' ? <label key={`anchor:${pending.sourceAnchorIndex}`} className="flex flex-wrap items-center gap-2">
            <span>Ячейка шаблона {pending.sourceAnchorIndex + 1}: {pending.reason === 'ambiguous-target' ? 'выберите целевую ячейку' : pending.reason === 'target-already-used' ? 'выберите другую целевую ячейку' : 'выберите ячейку документа'}</span>
            <select aria-label={`Целевая ячейка для якоря шаблона ${pending.sourceAnchorIndex + 1}`} className="h-7 max-w-full rounded border border-amber-300 bg-white px-2 text-xs dark:border-amber-800 dark:bg-dark-surface" value={templateAnchorSelections[pending.sourceAnchorIndex] || ''} onChange={(event) => setTemplateAnchorSelections((current) => ({ ...current, [pending.sourceAnchorIndex]: event.target.value }))}>
              <option value="">Выберите ячейку</option>
              {(templateTargetSchema?.anchors || []).filter((anchor) => pending.candidateTargetIds.includes(anchor.id)).map((anchor) => {
                const index = templateTargetSchema!.anchors.findIndex((item) => item.id === anchor.id);
                return <option key={anchor.id} value={anchor.id}>{anchor.sheetName ? `${anchor.sheetName}!` : ''}{anchor.address || `Ячейка шапки ${index + 1}`}</option>;
              })}
            </select>
          </label> : <label key={`field:${pending.sourceAnchorIndex}:${pending.partIndex}:${pending.alternativeIndex ?? ''}`} className="flex flex-wrap items-center gap-2">
            <span>Поле «{pending.fieldKey}» из «{pending.sourceId}»: выберите поле каталога</span>
            <select aria-label={`Новое поле для ${pending.fieldKey}`} className="h-7 max-w-full rounded border border-amber-300 bg-white px-2 text-xs dark:border-amber-800 dark:bg-dark-surface" value={selectedFieldKey(templateFieldSelections[officeTemplateFieldSelectionKey(pending.sourceAnchorIndex, pending.partIndex, pending.alternativeIndex)])} onChange={(event) => {
              const field = fields.find((item) => selectedFieldKey(item) === event.target.value);
              const key = officeTemplateFieldSelectionKey(pending.sourceAnchorIndex, pending.partIndex, pending.alternativeIndex);
              setTemplateFieldSelections((current) => { const next = { ...current }; if (field) next[key] = field; else delete next[key]; return next; });
            }}>
              <option value="">Выберите поле</option>
              {fields.map((field) => <option key={`${field.sourceId}:${field.fieldKey}:${field.entityType}`} value={selectedFieldKey(field)}>{field.displayName} · {field.sourceId}</option>)}
            </select>
          </label>)}
        </div>
      </div>}

      {view === 'translator' && <div className="min-h-0 flex-1 overflow-auto"><TextTranslationPanel onReadText={props.onReadText} onInsertText={props.readOnly ? undefined : props.onInsertText} /></div>}
      {view === 'data' && <>
      <nav className="flex shrink-0 border-b border-slate-200 dark:border-dark-border" aria-label="Этап Flux">
        {([['selection', 'Выборка'], ['fields', 'Поля и шапка'], ['update', 'Обновление']] as const).map(([key, label], index) => <button key={key} type="button" onClick={() => setTab(key)} aria-current={tab === key ? 'step' : undefined}
          className={`flex-1 border-b-2 px-2 py-2 text-xs font-semibold ${tab === key ? 'border-emerald-600 text-emerald-700 dark:text-emerald-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}>
          {index + 1}. {label}
        </button>)}
      </nav>

      {error && <p role="alert" className="shrink-0 border-b border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">{error}</p>}
      {!props.projectId && <p className="shrink-0 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">Сначала привяжите документ к проекту.</p>}
      {tab === 'selection' && <FluxSelectionPanel query={query} fields={fields} result={result} loading={loading} error="" selectedIds={selectedIds} onQueryChange={setQuery} onRun={() => void runQuery()} onSelectionChange={setSelectedIds} />}
      {tab === 'fields' && <FluxFieldsPanel fields={fields} state={officeState ? { ...officeState, schema: schema || officeState.schema } : null} forceSave={!!templateSchema} saveBlocked={!!templatePending.length} selectedField={selectedField} activeAnchorId={activeAnchor?.anchorId || ''} readOnly={props.readOnly} canEditSchema={props.schemaWriteAvailable} onSelectField={setSelectedField} onSaveSchema={saveSchema} />}
      {tab === 'update' && <UpdatePanel state={officeState} result={result} plan={plan} applied={appliedSummary} selectedCount={selectedIds.length} busy={busy} readOnly={props.readOnly} fileId={props.localSource ? '' : props.fileId} fileName={props.fileName} onIssued={props.onIssued} onDraftCreated={props.onDraftCreated} beforeRevisionIssue={async () => {
        const current = await props.requestState();
        if (!current?.baseHash) return false;
        setOfficeState(current);
        return true;
      }} onRefresh={() => void refreshState()} />}

      {tab === 'fields' && <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-200 px-3 py-2 dark:border-dark-border">
        <span title={activeAnchor?.anchorId} className="min-w-0 truncate text-xs text-slate-500 dark:text-slate-400">{activeAnchor ? `${activeAnchor.sheetName ? `${activeAnchor.sheetName}!` : ''}${activeAnchor.address || (activeAnchorIndex >= 0 ? `Ячейка шапки ${activeAnchorIndex + 1}` : 'Выбрана ячейка таблицы')}` : 'Выберите ячейку шапки в документе'}</span>
        <Btn tone="primary" disabled={busy || props.readOnly || !selectedField || !activeAnchor} onClick={() => void bindSelectedField()}>{busy ? <LoaderCircle className="animate-spin" /> : null}Привязать поле</Btn>
      </div>}
      {tab === 'update' && <div className="flex shrink-0 items-center justify-between border-t border-slate-200 px-3 py-2 dark:border-dark-border">
        <span className="text-xs text-slate-500 dark:text-slate-400">Выбрано строк: {selectedIds.length}</span>
        {plan ? <Btn tone="primary" disabled={busy || props.readOnly || plan.errors.length > 0 || plan.conflicts.length > 0} onClick={() => void applyPlan()}>{busy ? 'Проверка…' : 'Подтвердить и заполнить'}</Btn>
          : <Btn tone="primary" disabled={busy || props.readOnly || !selectedIds.length || !officeState} onClick={() => void buildPlan()}>{busy ? 'Строим план…' : 'Предпросмотр заполнения'}</Btn>}
      </div>}
      {tab === 'selection' && <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-200 px-3 py-2 dark:border-dark-border">
        <span className="min-w-0 truncate text-xs text-slate-500 dark:text-slate-400">{result ? `В таблицу попадёт ${(selectedIds.length || result.rows.length).toLocaleString('ru-RU')} позиций` : 'Задайте источник и обновите выборку'}</span>
        <span className="flex shrink-0 items-center gap-2">
          {insertButton}
          <Btn tone="primary" disabled={busy || props.readOnly || !selectedIds.length || !officeState} onClick={() => void buildPlan()}>{busy ? 'Строим план…' : 'Предпросмотр заполнения'}</Btn>
        </span>
      </div>}
      {actionMessage && <p role="status" className="shrink-0 border-t border-slate-200 px-3 py-1.5 text-xs text-slate-600 dark:border-dark-border dark:text-slate-300">{actionMessage}</p>}
      </>}
      {dialog && dialog !== 'export' && <FluxTemplateControls mode={dialog === 'pinned' ? 'pinned' : dialog === 'save-template' ? 'save' : 'library'} templates={tpl.templates} pinnedIds={tpl.pinned} userId={userId}
        canSave={!!schema && !props.readOnly && !templatePending.length} busy={tpl.busy || busy} error={tpl.error || undefined} onSave={saveTemplateAs} onOpen={openTemplate} onPin={tpl.togglePin} onCopy={copyTemplate} onDelete={deleteTemplate} onClose={() => { setDialog(null); tpl.setError(''); }} />}
      {dialog === 'export' && <FluxExportDialog sourceId={exportSourceId} columns={allColumns} result={result} selectedIds={selectedIds} query={query} onClose={() => setDialog(null)} />}
    </aside>
  );
}

function UpdatePanel({ state, result, plan, applied, selectedCount, busy, readOnly, fileId, fileName, beforeRevisionIssue, onIssued, onDraftCreated, onRefresh }: {
  state: OfficeState | null; result: OfficeQueryResult | null; plan: OfficeFillPlan | null; applied: OfficeApplySummary | null; selectedCount: number;
  busy: boolean; readOnly: boolean; fileId: string; fileName: string; beforeRevisionIssue: () => Promise<boolean>;
  onIssued?: (fileId: string, revisionId: string) => void; onDraftCreated?: (fileId: string) => void; onRefresh: () => void;
}) {
  return <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
    <div className="mb-4 flex items-center justify-between"><h3 className="font-semibold">Состояние документа и источника</h3><button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" onClick={onRefresh} disabled={busy}><LoaderCircle className={busy ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />Проверить</button></div>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs"><dt className="text-slate-500 dark:text-slate-400">Источник</dt><dd>{result?.revision ? 'Выборка загружена' : 'Выборка не загружена'}</dd><dt className="text-slate-500 dark:text-slate-400">Документ</dt><dd>{state?.baseHash ? 'Состояние прочитано' : 'Не прочитано'}</dd><dt className="text-slate-500 dark:text-slate-400">Якорей шапки</dt><dd>{state?.schema.anchors.length ?? '—'}</dd><dt className="text-slate-500 dark:text-slate-400">Выбрано строк</dt><dd>{selectedCount}</dd></dl>
    {(result?.revision || state?.baseHash) && <details className="mt-3 text-xs text-slate-500 dark:text-slate-400"><summary className="cursor-pointer">Технические сведения</summary><dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2"><dt>Ревизия источника</dt><dd className="break-all font-mono">{result?.revision || '—'}</dd><dt>Хеш документа</dt><dd className="break-all font-mono">{state?.baseHash || '—'}</dd></dl></details>}
    {applied && <section role="status" className="mt-4 border-l-2 border-emerald-600 pl-3 text-xs text-slate-700 dark:text-slate-300"><p>Обновлено значений: {applied.appliedCount.toLocaleString('ru-RU')}</p>{applied.manualRows.length > 0 && <p className="mt-1">Без замены оставлены строки с ручными правками: {applied.manualRows.length}</p>}</section>}
    {plan && <section className="mt-5 space-y-3 border-t border-slate-200 pt-4 dark:border-dark-border"><h3 className="font-semibold">План заполнения</h3><PlanCount label="Будет добавлено" count={plan.adds.length} /><PlanCount label="Будет обновлено" count={plan.replaces.length} /><PlanCount label="Ручные строки сохранены" count={plan.manualRows.length} /><PlanCount label="Пропущено" count={plan.skips.length} /><PlanCount label="Ошибки" count={plan.errors.length} /><PlanCount label="Конфликты" count={plan.conflicts.length} />
      {plan.errors.map((item, index) => <p key={`error-${index}`} className="text-xs text-rose-700 dark:text-rose-300">{item.message}</p>)}
      {plan.conflicts.map((item, index) => <p key={`conflict-${index}`} className="text-xs text-amber-700 dark:text-amber-300">Конфликт в {item.anchorId}: {item.candidates.join(', ')}</p>)}
      <p className="text-xs text-slate-500 dark:text-slate-400">План не сохраняет файл. После подтверждения изменения попадут в текущий редактор, затем используются обычные сохранение и история GenOffice.</p>
    </section>}
    {readOnly && <p className="mt-4 text-xs text-amber-700 dark:text-amber-300">Документ открыт только для просмотра.</p>}
    <div className="sr-only" aria-live="polite">{busy ? 'Flux выполняет запрос' : 'Flux готов'}</div>
    {fileId && <div className="mt-5 border-t border-slate-200 pt-4 dark:border-dark-border">
      <FluxRevisionPanel fileId={fileId} fileName={fileName} beforeIssue={beforeRevisionIssue} onIssued={onIssued} onDraftCreated={onDraftCreated} readOnly={readOnly} />
    </div>}
  </div>;
}

function PlanCount({ label, count }: { label: string; count: number }) { return <div className="flex items-center justify-between text-xs"><span className="text-slate-600 dark:text-slate-300">{label}</span><strong className="tabular-nums">{count.toLocaleString('ru-RU')}</strong></div>; }

function selectedFieldKey(field?: OfficeField): string {
  return field ? `${field.sourceId}\u0000${field.entityType}\u0000${field.fieldKey}` : '';
}

function templateQuery(template: OfficeTemplate, projectId: string): OfficeQuery {
  const saved: any = template.query || {};
  const savedFilters: any[] = Array.isArray(saved.filters) ? saved.filters : [];
  const typeFilter = savedFilters.find((filter) => filter.field === 'equipType' && filter.op === 'in');
  return {
    ...initialQuery(projectId),
    sources: [saved.entity === 'element' ? 'equipment' : 'tags'],
    columns: Array.isArray(saved.columns) ? saved.columns.map(String) : [],
    excludedEntityIds: Array.isArray(saved.excludedEntityIds) ? saved.excludedEntityIds.map(String) : [],
    types: typeFilter ? String(typeFilter.value || '').split('|').filter(Boolean) : [],
    filters: savedFilters.filter((filter) => filter !== typeFilter).map((filter: any) => ({ fieldKey: String(filter.field), op: filter.op === 'eq' ? 'equals' : filter.op === 'neq' ? 'notEquals' : filter.op === 'nempty' ? 'notEmpty' : filter.op, value: String(filter.value ?? '') })),
    sort: Array.isArray(saved.sort) ? saved.sort.map((item: any) => ({ fieldKey: String(item.field), direction: (item.direction ?? item.dir) === 'desc' ? 'desc' : 'asc' })) : [],
  };
}
