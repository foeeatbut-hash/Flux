import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Search, X } from 'lucide-react';
import { Btn, Empty, IconBtn, Input } from '../ui';
import ProjectDataPanel from './ProjectDataPanel';
import TextTranslationPanel from './TextTranslationPanel';
import FileEnglishVersion from '../translate/FileEnglishVersion';
import { editorHref, saveNewFile } from '../../lib/officeFiles';
import { fileName as exportFileName, toCsv, toXlsx } from '../../lib/exchange';
import { loadProcurementStages, loadStageTemplates, resolveTemplate } from '../../lib/procurementStages';
import { rowsOfProject } from '../../lib/equipmentRows';
import { normalizeSpecs } from '../../lib/specs';
import { buildEquipmentExchange, equipmentColumns } from '../../lib/equipmentExchange';
import { classifyAll } from '../../../equipment/classes';

export interface ProjectField {
  key: string;
  title: string;
  value: string;
}

export type FluxEditorKind = 'docs' | 'sheets' | 'note' | 'pdf';
export type FluxTableRow = (string | number)[];

export interface FluxPanelProps {
  fileId: string;
  projectId: string;
  editorKind: FluxEditorKind;
  readOnly: boolean;
  onClose: () => void;
  /** Вставка поля в документ, таблицу или заметку средствами редактора хоста. */
  onInsertField?: (field: ProjectField) => void;
  onInsertTable?: (rows: FluxTableRow[], title: string, query?: unknown) => Promise<boolean>;
  onReadText?: () => Promise<string>;
  onInsertText?: (text: string) => Promise<void> | void;
  onUpdateFields?: () => Promise<void>;
  beforeTranslate?: () => Promise<void>;
  fileName?: string;
}

type SourceTab = 'tags' | 'equipment' | 'procurement' | 'docs' | 'catalog';
type PanelTab = SourceTab | 'data' | 'translation';
type DataRow = { id: string; cells: (string | number)[]; haystack: string };
type Column = { key: string; title: string };
type ColumnChoiceState = Partial<Record<SourceTab, { selected: string[]; known: string[] }>>;

const TABS: { key: SourceTab; title: string }[] = [
  { key: 'tags', title: 'Теги' }, { key: 'equipment', title: 'Оборудование' },
  { key: 'procurement', title: 'Менеджмент: закупки' }, { key: 'docs', title: 'Документация' },
  { key: 'catalog', title: 'Каталог' },
];

const failResponse = async (response: Response) => {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `сервер ответил ${response.status}`);
  return data;
};

function downloadBlob(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(href);
}

function rowsOfTags(tags: any[]): { columns: Column[]; rows: DataRow[] } {
  const metadataOf = (tag: any) => {
    try { return typeof tag.metadata === 'string' ? JSON.parse(tag.metadata || '{}') : (tag.metadata || {}); } catch { return {}; }
  };
  const metaKeys = [...new Set(tags.flatMap((tag) => Object.keys(metadataOf(tag).dynamicFields || {})))].sort((a, b) => a.localeCompare(b, 'ru'));
  const columns = [
    { key: 'identifier', title: 'Тег' }, { key: 'metadata.mainName', title: 'Наименование' },
    { key: 'department', title: 'Отдел' }, { key: 'wbs', title: 'Раздел' },
    { key: 'fluid', title: 'Среда' }, { key: 'brand', title: 'Марка' },
    { key: 'metadata.descriptions', title: 'Описания' }, { key: 'metadata.createdAt', title: 'Создан' },
    { key: 'metadata.updatedAt', title: 'Изменён' },
    ...metaKeys.map((key) => ({ key: `metadata.dynamicFields.${key}`, title: key })),
  ];
  const rows = tags.map((tag) => {
    const metadata = metadataOf(tag);
    const descriptions = Array.isArray(metadata.descriptions) ? metadata.descriptions.map((item: any) => item.text || item.comment).filter(Boolean).join('; ') : '';
    const cells = [tag.identifier, metadata.mainName, tag.department, tag.wbs, tag.fluid, tag.brand, descriptions, metadata.createdAt, metadata.updatedAt,
      ...metaKeys.map((key) => metadata.dynamicFields?.[key])].map((v) => String(v ?? ''));
    return { id: String(tag.id), cells, haystack: cells.join(' ').toLowerCase() };
  });
  return { columns, rows };
}

function rowsOfEquipment(systems: any[]): { columns: Column[]; rows: DataRow[] } {
  const items = rowsOfProject(systems, normalizeSpecs);
  const classificationById = new Map<string, any>();
  for (const system of systems) {
    const components = (system.monoblocks || []).flatMap((mono: any) => mono.components || []);
    const classified = classifyAll(components);
    for (const [id, type] of classified) classificationById.set(id, type);
  }
  for (const item of items) {
    const type = classificationById.get(item.id);
    if (type) { item.cls = type.cls; item.kind = type.kind; }
  }
  const columns = equipmentColumns(items);
  const exchange = buildEquipmentExchange(items, columns, { keepOrder: true });
  const resultColumns = columns.map((column) => ({ key: column.key, title: column.label }));
  const rows = items.map((item, index) => {
    const cells = exchange.rows[index] || [];
    return { id: item.id, cells, haystack: cells.join(' ').toLowerCase() };
  });
  return { columns: resultColumns, rows };
}

function rowsOfProcurement(tags: any[], stages: any[], templates: any[]): { columns: Column[]; rows: DataRow[] } {
  const metadataFor = (tag: any) => {
    try { return typeof tag.metadata === 'string' ? JSON.parse(tag.metadata || '{}') : (tag.metadata || {}); } catch { return {}; }
  };
  const dynamicKeys = [...new Set(tags.flatMap((tag) => Object.keys(metadataFor(tag).dynamicFields || {})))].sort((a, b) => a.localeCompare(b, 'ru'));
  const columns = [
    { key: 'tag', title: 'Тег' }, { key: 'name', title: 'Наименование' }, { key: 'brand', title: 'Марка' },
    { key: 'qty', title: 'Количество' }, { key: 'supplier', title: 'Поставщик' }, { key: 'stage', title: 'Этап' },
    { key: 'note', title: 'Примечание' }, { key: 'dates', title: 'Даты этапов' },
    ...dynamicKeys.map((key) => ({ key: `metadata.dynamicFields.${key}`, title: key })),
  ];
  const rows = tags.map((tag) => {
    const metadata = metadataFor(tag);
    const procurement = metadata.procurement || {};
    const links = Array.isArray(tag.componentElements) ? tag.componentElements : [];
    const template = resolveTemplate({
      identifier: tag.identifier || '', department: tag.department || '',
      equipTypes: links.map((item: any) => String(item.equipType || '')).filter(Boolean),
      categories: links.map((item: any) => String(item?.monoblock?.system?.category || '')).filter(Boolean),
      explicitTemplateId: procurement.templateId,
    }, templates);
    const rowStages = template?.stages || stages;
    const stage = rowStages.find((item) => item.id === procurement.stage) || rowStages[0];
    const history = { ...(procurement.stageLog && typeof procurement.stageLog === 'object' ? procurement.stageLog : {}) };
    for (const [id, atKey, byKey] of [['ordered', 'orderedAt', 'orderedBy'], ['approved', 'approvedAt', 'approvedBy'], ['purchased', 'purchasedAt', 'purchasedBy']]) {
      if (procurement[atKey] && !history[id]) history[id] = { at: procurement[atKey], by: procurement[byKey] || '' };
    }
    const dates = Object.entries(history).map(([id, record]: [string, any]) => {
      const label = rowStages.find((item) => item.id === id)?.label || id;
      const at = record?.at ? new Date(record.at) : null;
      const date = at && !Number.isNaN(at.getTime()) ? at.toLocaleDateString('ru-RU') : '';
      return date ? `${label}: ${date}` : '';
    }).filter(Boolean).join('; ');
    const cells = [tag.identifier, metadata.mainName, tag.brand, procurement.qty, procurement.supplier, stage?.label, procurement.note, dates,
      ...dynamicKeys.map((key) => metadata.dynamicFields?.[key])]
      .map((value) => String(value ?? ''));
    return { id: String(tag.id), cells, haystack: cells.join(' ').toLowerCase() };
  });
  return { columns, rows };
}

function rowsOfDocuments(registers: any[], itemsByRegister: any[][]): { columns: Column[]; rows: DataRow[] } {
  const baseColumns = [
    { key: 'register', title: 'Реестр' }, { key: 'number', title: 'Номер подрядчика' },
    { key: 'vdr', title: 'Код ВДР' }, { key: 'title', title: 'Наименование' },
    { key: 'revision', title: 'Ревизия' }, { key: 'status', title: 'Статус' },
  ];
  const serviceColumns = registers.flatMap((register) => (Array.isArray(register.columnsConfig) ? register.columnsConfig : [])
    .filter((column: any) => !column.field && column.key)
    .map((column: any) => ({ key: `extra:${register.id}:${column.key}`, title: column.title || column.label || column.key, registerId: register.id, fieldKey: column.key })));
  const columns: Column[] = [...baseColumns, ...serviceColumns];
  const rows: DataRow[] = [];
  registers.forEach((register, index) => (itemsByRegister[index] || []).forEach((item) => {
    const cells = [register.name, item.contractorNo, item.vdrCode, item.titleRu || item.titleEn, item.revision, item.status]
      .concat(serviceColumns.map((column: any) => column.registerId === register.id ? item.extra?.[column.fieldKey] : ''))
      .map((v) => String(v ?? ''));
    rows.push({ id: String(item.id), cells, haystack: cells.join(' ').toLowerCase() });
  }));
  return { columns, rows };
}

function rowsOfCatalog(data: any): { columns: Column[]; rows: DataRow[] } {
  const classes = new Map((data.classes || []).map((item: any) => [item.id, item.title?.ru || item.name || item.code]));
  const manufacturers = new Map((data.manufacturers || []).map((item: any) => [item.id, item.name || item.shortName]));
  const paramDefs = new Map<string, string>();
  for (const family of data.families || []) for (const param of family.specs || []) {
    const key = String(param.key || param.label?.ru || param.label?.en || '').trim();
    if (key) paramDefs.set(key, String(param.label?.ru || param.label?.en || key));
  }
  for (const component of data.components || []) for (const spec of component.specs || []) {
    const key = String(spec.key || spec.label?.ru || spec.label?.en || spec.label || '').trim();
    if (key) paramDefs.set(key, String(spec.label?.ru || spec.label?.en || spec.label || key));
  }
  const parameterKeys = [...paramDefs.keys()].sort((a, b) => a.localeCompare(b, 'ru'));
  const columns: Column[] = [
    { key: 'class', title: 'Класс' }, { key: 'manufacturer', title: 'Производитель' },
    { key: 'code', title: 'Модель / код' }, { key: 'title', title: 'Наименование' },
    { key: 'description', title: 'Описание' }, { key: 'kind', title: 'Вид' }, { key: 'status', title: 'Полнота' },
    ...parameterKeys.map((key) => ({ key: `spec:${key}`, title: paramDefs.get(key) || key })),
  ];
  const textValue = (value: any) => typeof value === 'object' ? (value?.ru || value?.en || '') : String(value ?? '');
  const models = (data.families || []).map((item: any) => ({
    id: `family:${item.id}`, className: classes.get(item.classId) || '', manufacturer: manufacturers.get(item.manufacturerId) || '',
    code: item.code, title: item.title?.ru || item.title?.en || '', description: item.description?.ru || item.description?.en || '',
    kind: item.kind, status: item.status,
    specs: Object.fromEntries((item.specs || []).map((spec: any) => [String(spec.key || spec.label?.ru || spec.label?.en || '').trim(), textValue(spec.value)])),
  }));
  const components = (data.components || []).map((item: any) => ({
    id: `component:${item.id}`, className: classes.get(item.classId) || '',
    manufacturer: item.manufacturer || manufacturers.get(item.manufacturerId) || '', code: item.code,
    title: item.title?.ru || item.title?.en || '', description: item.equipmentType || '', kind: item.kind, status: item.status || '',
    specs: Object.fromEntries((item.specs || []).map((spec: any) => [String(spec.key || spec.label?.ru || spec.label?.en || spec.label || '').trim(), textValue(spec.value)])),
  }));
  const rows = [...models, ...components].map((item: any) => {
    const cells = [item.className, item.manufacturer, item.code, item.title, item.description, item.kind, item.status,
      ...parameterKeys.map((key) => item.specs[key])].map((v) => String(v ?? ''));
    return { id: item.id, cells, haystack: cells.join(' ').toLowerCase() };
  });
  return { columns, rows };
}

function useSource(tab: SourceTab, projectId: string) {
  const [result, setResult] = useState<{ columns: Column[]; rows: DataRow[] } | null>(null);
  const [loadedSource, setLoadedSource] = useState<SourceTab | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setResult(null); setLoadedSource(null); setError(''); setLoading(false);
    if (!projectId && tab !== 'catalog') {
      setError('Выберите проект, чтобы загрузить его данные.'); setLoadedSource(tab);
      return () => { live = false; };
    }
    setLoading(true);
    const load = async () => {
      try {
        let next: { columns: Column[]; rows: DataRow[] };
        if (tab === 'tags') {
          const data = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tags`).then(failResponse);
          next = rowsOfTags(data.tags || []);
        } else if (tab === 'equipment') {
          const data = await fetch(`/api/projects/${encodeURIComponent(projectId)}/systems`).then(failResponse);
          next = rowsOfEquipment(data.systems || []);
        } else if (tab === 'procurement') {
          const [data, stages, templates] = await Promise.all([
            fetch(`/api/projects/${encodeURIComponent(projectId)}/tags`).then(failResponse),
            loadProcurementStages(), loadStageTemplates(),
          ]);
          next = rowsOfProcurement(data.tags || [], stages, templates);
        } else if (tab === 'docs') {
          const data = await fetch(`/api/vdr/registers?projectId=${encodeURIComponent(projectId)}`).then(failResponse);
          const registers = data.registers || [];
          const itemsByRegister = await Promise.all(registers.map(async (register: any) => {
            const result = await fetch(`/api/vdr/items?registerId=${encodeURIComponent(register.id)}`).then(failResponse);
            return result.items || [];
          }));
          next = rowsOfDocuments(registers, itemsByRegister);
        } else {
          const data = await fetch('/api/catalog').then(failResponse);
          next = rowsOfCatalog(data);
        }
        if (live) { setResult(next); setLoadedSource(tab); }
      } catch (e: any) {
        if (live) { setError(String(e?.message || e)); setLoadedSource(tab); }
      } finally {
        if (live) setLoading(false);
      }
    };
    void load();
    return () => { live = false; };
  }, [tab, projectId]);

  return { result, loadedSource, error, loading };
}

export default function FluxPanel(props: FluxPanelProps) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<PanelTab>('tags');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [columnsBySource, setColumnsBySource] = useState<ColumnChoiceState>({});
  const [busy, setBusy] = useState(false);
  const [insertMessage, setInsertMessage] = useState('');
  const [panelError, setPanelError] = useState('');
  const [resolvedFileName, setResolvedFileName] = useState(props.fileName || '');
  const sourceTab: SourceTab = tab === 'data' || tab === 'translation' ? 'tags' : tab;
  const { result, loadedSource, error, loading } = useSource(sourceTab, props.projectId);
  const currentResult = loadedSource === sourceTab ? result : null;
  const filtered = useMemo(() => (currentResult?.rows || []).filter((row) => row.haystack.includes(query.trim().toLowerCase())), [currentResult, query]);
  const chosenColumns = columnsBySource[sourceTab]?.selected || currentResult?.columns.map((column) => column.key) || [];
  const activeColumns = useMemo(() => currentResult?.columns.filter((column) => chosenColumns.includes(column.key)) || [], [currentResult, chosenColumns]);
  const activeCellIndexes = useMemo(() => activeColumns.map((column) => currentResult?.columns.findIndex((item) => item.key === column.key) ?? -1), [activeColumns, currentResult]);

  useEffect(() => { setSelected([]); setQuery(''); setInsertMessage(''); setPanelError(''); }, [tab]);
  useEffect(() => {
    if (!currentResult) return;
    setColumnsBySource((previous) => {
      const keys = currentResult.columns.map((column) => column.key);
      const existing = previous[sourceTab];
      if (!existing) return { ...previous, [sourceTab]: { selected: keys, known: keys } };
      const added = keys.filter((key) => !existing.known.includes(key));
      return { ...previous, [sourceTab]: {
        selected: [...existing.selected.filter((key) => keys.includes(key)), ...added], known: keys,
      } };
    });
  }, [currentResult, sourceTab]);
  useEffect(() => {
    if (props.fileName) { setResolvedFileName(props.fileName); return; }
    if (!props.fileId) return;
    let live = true;
    fetch(`/api/office/files/${encodeURIComponent(props.fileId)}/meta`)
      .then(failResponse)
      .then((meta) => { if (live) setResolvedFileName(String(meta.name || 'Документ')); })
      .catch(() => { if (live) setResolvedFileName('Документ'); });
    return () => { live = false; };
  }, [props.fileId, props.fileName]);

  const insert = async (rows: DataRow[]) => {
    if (!currentResult || props.readOnly || !rows.length) return;
    const capped = rows.slice(0, 500);
    const headers = activeColumns.map((column) => column.title);
    const table = [headers, ...capped.map((row) => activeCellIndexes.map((index) => row.cells[index] ?? ''))] as FluxTableRow[];
    if (props.onInsertTable) {
      setBusy(true); setInsertMessage('');
      try {
        const inserted = await props.onInsertTable(table, TABS.find((item) => item.key === sourceTab)?.title || 'Данные', query ? { q: query } : undefined);
        setInsertMessage(inserted ? (rows.length > 500 ? 'Вставлены первые 500 строк из выбранного набора.' : 'Таблица вставлена.') : 'Редактор не смог вставить таблицу.');
      } catch (e: any) { setInsertMessage(String(e?.message || 'Не удалось вставить таблицу.')); }
      finally { setBusy(false); }
      return;
    }
  };

  const exportRows = async (rows: DataRow[], format: 'csv' | 'xlsx' | 'office') => {
    if (!currentResult || !rows.length) return;
    const headers = activeColumns.map((column) => column.title);
    const body = rows.map((row) => activeCellIndexes.map((index) => row.cells[index] ?? ''));
    const title = TABS.find((item) => item.key === sourceTab)?.title || 'Данные';
    const name = exportFileName(title, format === 'csv' ? 'csv' : 'xlsx');
    setBusy(true); setInsertMessage('');
    try {
      if (format === 'csv') {
        downloadBlob(new Blob([toCsv(headers, body)], { type: 'text/csv;charset=utf-8;' }), name);
      } else {
        const bytes = await toXlsx(headers, body, title);
        if (format === 'office') {
          const made = await saveNewFile(bytes, name, 'exports');
          navigate(editorHref(made));
        } else downloadBlob(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
      }
      setInsertMessage(`${format === 'csv' ? 'CSV скачан.' : format === 'office' ? 'Книга сохранена в Flux Office.' : 'XLSX скачан.'} · ${rows.length} строк`);
    } catch (e: any) { setInsertMessage(String(e?.message || 'Не удалось подготовить файл.')); }
    finally { setBusy(false); }
  };

  const sourcePanel = () => {
    if (loading) return <p className="p-4 text-sm text-slate-500 dark:text-slate-400">Загрузка…</p>;
    if (error) return <Empty title="Данные недоступны" text={error} />;
    if (!currentResult) return <p className="p-4 text-sm text-slate-500 dark:text-slate-400">Загрузка…</p>;
    if (!currentResult.rows.length) return <Empty title="Пока нет данных" text="В этом разделе проекта пока нет строк для выгрузки." />;
    const selectedRows = filtered.filter((row) => selected.includes(row.id));
    return (
      <>
        <label className="relative block px-3 py-2">
          <Search className="pointer-events-none absolute left-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по строкам" aria-label="Отобрать строки" className="w-full pl-7" />
        </label>
        <details className="mx-3 mb-2 rounded-lg border border-slate-200 px-2 py-1.5 dark:border-slate-800">
          <summary className="cursor-pointer text-xs text-slate-600 dark:text-slate-300">Столбцы: {activeColumns.length} из {currentResult.columns.length}</summary>
          <div className="mt-2 flex gap-2 text-xs">
            <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" onClick={() => setColumnsBySource((current) => ({ ...current, [sourceTab]: { selected: currentResult.columns.map((column) => column.key), known: currentResult.columns.map((column) => column.key) } }))}>Выбрать все</button>
            <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" onClick={() => setColumnsBySource((current) => ({ ...current, [sourceTab]: { selected: [], known: currentResult.columns.map((column) => column.key) } }))}>Снять выбор</button>
          </div>
          <div className="mt-2 flex max-h-28 flex-wrap gap-x-3 gap-y-1 overflow-auto">
            {currentResult.columns.map((column) => <label key={column.key} className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={chosenColumns.includes(column.key)} onChange={(event) => setColumnsBySource((previous) => ({ ...previous, [sourceTab]: { selected: event.target.checked ? [...chosenColumns, column.key] : chosenColumns.filter((key) => key !== column.key), known: currentResult.columns.map((item) => item.key) } }))} />
              {column.title}
            </label>)}
          </div>
        </details>
        {!filtered.length ? <div className="min-h-0 flex-1"><Empty title="Ничего не найдено" text="Измените поисковый запрос или снимите фильтр." /></div> : <div className="min-h-0 flex-1 overflow-auto px-3">
          <p className="pb-2 text-xs text-slate-500 dark:text-slate-400">Предпросмотр: {filtered.length} строк{filtered.length > 500 ? ', максимум 500 за вставку' : ''}.</p>
          <div className="overflow-x-auto">
            <table className="fx-table text-xs" style={{ minWidth: 32 + activeColumns.length * 120 }}>
              <thead><tr><th className="w-7"><input type="checkbox" aria-label="Выбрать все видимые строки" checked={filtered.length > 0 && selectedRows.length === filtered.length} onChange={(event) => setSelected(event.target.checked ? filtered.map((row) => row.id) : [])} /></th>{activeColumns.map((column) => <th key={column.key} className="min-w-[120px] whitespace-nowrap">{column.title}</th>)}</tr></thead>
              <tbody>{filtered.slice(0, 100).map((row) => <tr key={row.id}>
                <td><input type="checkbox" aria-label={`Выбрать строку ${String(row.cells[0] || '')}`} checked={selected.includes(row.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id))} /></td>
                {activeCellIndexes.map((index) => <td className="whitespace-nowrap overflow-hidden text-ellipsis max-w-[280px]" key={`${row.id}:${index}`} title={String(row.cells[index] ?? '')}>{row.cells[index] ?? ''}</td>)}
              </tr>)}</tbody>
            </table>
          </div>
          {filtered.length > 100 && <p className="py-2 text-xs text-slate-500 dark:text-slate-400">В таблице показаны первые 100 строк; действие охватывает все отобранные.</p>}
        </div>}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 p-3 dark:border-slate-800">
          {props.onInsertTable && <Btn tone="primary" disabled={props.readOnly || busy || !filtered.length || !activeColumns.length} onClick={() => void insert(selectedRows.length ? selectedRows : filtered)}>
            <Check />{selectedRows.length ? `Вставить выбранные (${selectedRows.length})` : 'Вставить все'}
          </Btn>}
            <Btn size="sm" disabled={busy || !filtered.length || !activeColumns.length} onClick={() => void exportRows(selectedRows.length ? selectedRows : filtered, 'xlsx')}>XLSX</Btn>
            <Btn size="sm" disabled={busy || !filtered.length || !activeColumns.length} onClick={() => void exportRows(selectedRows.length ? selectedRows : filtered, 'csv')}>CSV</Btn>
            <Btn size="sm" tone="primary" disabled={busy || !filtered.length || !activeColumns.length} onClick={() => void exportRows(selectedRows.length ? selectedRows : filtered, 'office')}>Книга Flux</Btn>
          {insertMessage && <span role="status" className="text-xs text-slate-500 dark:text-slate-400">{insertMessage}</span>}
        </div>
      </>
    );
  };

  return (
    <aside aria-label="Flux" className="flex h-full w-[min(420px,45vw)] min-w-0 shrink-0 max-[1024px]:absolute max-[1024px]:right-0 max-[1024px]:top-0 max-[1024px]:z-50 max-[1024px]:w-[min(420px,90vw)] max-[1024px]:shadow-sm flex-col border-l border-slate-200 bg-[var(--flux-surface)] text-slate-800 dark:border-slate-800 dark:text-slate-100">
      <header className="fx-head">
        <h2 className="fx-head-title">Flux</h2>
        <div className="fx-head-acts"><IconBtn label="Закрыть панель Flux" onClick={props.onClose}><X /></IconBtn></div>
      </header>
      <nav aria-label="Разделы Flux" className="fx-tabs shrink-0 overflow-x-auto">
        {TABS.map((item) => <button key={item.key} type="button" className="fx-tab whitespace-nowrap" aria-selected={tab === item.key} onClick={() => setTab(item.key)}>{item.title}</button>)}
        <button type="button" className="fx-tab whitespace-nowrap" aria-selected={tab === 'data'} onClick={() => setTab('data')}>Данные проекта</button>
        <button type="button" className="fx-tab whitespace-nowrap" aria-selected={tab === 'translation'} onClick={() => setTab('translation')}>Перевод</button>
      </nav>
      {panelError && <p role="alert" className="mx-3 mt-2 text-xs text-rose-600 dark:text-rose-400">{panelError}</p>}
      {tab === 'data' && <div className="min-h-0 flex-1 overflow-auto">
        <ProjectDataPanel fileId={props.fileId} projectId={props.projectId} kind={props.editorKind === 'sheets' ? 'sheet' : 'doc'} onInsert={props.onInsertField || (() => {})} onUpdate={async () => {
          setPanelError('');
          try {
            if (props.onUpdateFields) { await props.onUpdateFields(); return; }
            const response = await fetch(`/api/project-data/files/${encodeURIComponent(props.fileId)}/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data?.error || `сервер ответил ${response.status}`);
          } catch (error: any) {
            setPanelError(String(error?.message || 'Не удалось обновить поля.'));
          }
        }} onClose={() => setTab('tags')} readOnly={props.readOnly || !props.onInsertField || props.editorKind === 'pdf'} />
        {props.editorKind === 'note' && props.onInsertField && <p className="mx-3 my-2 text-xs text-slate-500 dark:text-slate-400">Вставка полей в заметку поддерживается.</p>}
      </div>}
      {tab === 'translation' && (['docs', 'sheets'].includes(props.editorKind) ? <FileEnglishVersion fileId={props.fileId} name={resolvedFileName || 'Документ'} onClose={() => setTab('tags')} beforeIssue={props.beforeTranslate} /> : <TextTranslationPanel onReadText={props.onReadText} onInsertText={props.readOnly ? undefined : props.onInsertText} />)}
      {tab !== 'data' && tab !== 'translation' && <section className="flex min-h-0 flex-1 flex-col">
        {sourcePanel()}
      </section>}
    </aside>
  );
}
