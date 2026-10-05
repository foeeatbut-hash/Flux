import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, BookOpen, Check, ChevronRight, FileText, GitCompareArrows, Search, X } from 'lucide-react';
import type { Catalog, Family, Component, CatalogRef, CatalogDocument, CatalogTable, Facts, FactDef, ParamDef } from '../../../catalog/model';
import { textOf } from '../../../catalog/model';
import { parseWithFamily } from '../../../catalog/designation';
import { sourcePhysicalPage } from '../../../catalog/sources';
import { loadCatalogAsset } from '../../services/catalogAssetService';
import CatalogContents from './CatalogContents';

type Tab = 'overview' | 'specs' | 'marking' | 'documents';
const TABS: Array<{ id: Tab; title: string }> = [
  { id: 'overview', title: 'Обзор' }, { id: 'specs', title: 'Характеристики' },
  { id: 'marking', title: 'Маркировка' }, { id: 'documents', title: 'Устройство и применение' },
];

const muted = 'text-slate-500 dark:text-slate-400';
const line = 'border-slate-200 dark:border-slate-700';

function valueText(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function manufacturerName(catalog: Catalog, family: Family, component?: Component): string {
  const source = component || (family.id.startsWith('component:') ? catalog.components.find((item) => `component:${item.id}` === family.id) : undefined);
  const maker = catalog.manufacturers.find((item) => item.id === family.manufacturerId);
  return maker?.shortName || maker?.name || source?.manufacturer || '';
}

function familyOfComponent(component: Component, catalog: Catalog): Family {
  const maker = catalog.manufacturers.find((item) => item.id === component.manufacturerId)
    || catalog.manufacturers.find((item) => item.name === component.manufacturer || item.shortName === component.manufacturer);
  return {
    id: `component:${component.id}`, classId: component.classId, manufacturerId: maker?.id || '', code: component.code,
    title: component.title, typeLabel: { ru: component.equipmentType || component.kind }, kind: component.kind,
    shapes: [], positions: [], designationMode: 'article', article: component.code, rules: [], match: { kinds: [] },
    params: (component.specs || []).map((spec, index) => ({
      key: `spec_${index}`, label: spec.label, kind: 'text' as const, unit: spec.unit,
      values: [{ code: spec.value, label: { ru: spec.value } }],
    })),
    specs: [], facts: component.facts,
    catalog: component.catalog || (component.sourcePdfPage ? { file: '', pages: String(component.sourcePdfPage) } : undefined),
    documents: component.documents, sections: component.sections, tables: component.tables,
    status: component.status || 'partial', todo: component.todo,
  };
}

function displayParam(param: ParamDef) {
  const labels = param.values?.map((item) => textOf(item.label)).filter(Boolean) || [];
  return { label: textOf(param.label) || param.key, unit: param.unit || '', description: param.hint || '', options: labels };
}

function FactRows({ facts, definitions }: { facts?: Facts; definitions: FactDef[] }) {
  const rows = Object.entries(facts || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!rows.length) return <p className={`text-xs ${muted}`}>Характеристики пока не указаны.</p>;
  return <dl className="divide-y divide-slate-100 dark:divide-slate-800">
    {rows.map(([key, value]) => { const def = definitions.find(d => d.key === key); const choice = def?.values?.find(v => v.code === String(value));
      return <div key={key} className="grid grid-cols-[minmax(130px,0.7fr)_minmax(0,1fr)] gap-3 py-2 text-xs">
        <dt className={muted}>{def ? textOf(def.label) : key}</dt><dd className="min-w-0 break-words text-slate-800 dark:text-slate-100">{choice ? textOf(choice.label) : valueText(value)}{def?.unit ? ` ${def.unit}` : ''}</dd>
      </div>;
    })}
  </dl>;
}

type ReportDetails = { currentValue?: string; source?: CatalogRef };
function ValueRows({ family, onReport }: { family: Family; onReport?: (field: string, details?: ReportDetails) => void }) {
  const params = family.params || [];
  if (!params.length) return <p className={`text-xs ${muted}`}>Для этой модели характеристики ещё не добавлены.</p>;
  return <div className={`overflow-auto border-y ${line}`}>
    <table className="w-full min-w-[480px] border-collapse text-left text-xs">
      <thead className="sticky top-0 bg-slate-50 text-slate-500 dark:bg-slate-800 dark:text-slate-300"><tr className="h-7">
        <th className="px-2 font-medium">Характеристика</th><th className="px-2 font-medium">{family.designationMode === 'article' ? 'Значение' : 'Варианты в обозначении'}</th><th className="px-2 font-medium">Единица</th>
      </tr></thead>
      <tbody>{params.map((param) => {
        const info = displayParam(param);
        return <tr key={param.key} className={`h-9 border-t ${line}`}>
          <td className="px-2 text-slate-800 dark:text-slate-100">{info.label}{onReport && <button type="button" className="ml-2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" onClick={() => onReport(param.key, { currentValue: info.options.join(', ') || undefined, source: family.catalog })}>Сообщить</button>}</td>
          <td className={`px-2 ${info.options.length ? 'text-slate-600 dark:text-slate-300' : muted}`}>{info.options.length ? info.options.join(', ') : 'Не указано'}</td>
          <td className={`px-2 ${muted}`}>{info.unit || '—'}</td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

function SourceBlock({ family, onOpen }: { family: Family; onOpen: (doc: CatalogDocument) => void }) {
  const docs = family.documents || [];
  return <div className="flex flex-col divide-y divide-slate-100 dark:divide-slate-800">
    {docs.map(doc => <div key={doc.id} className="flex min-w-0 items-start gap-2 py-2 text-xs"><FileText className={`mt-0.5 h-4 w-4 shrink-0 ${muted}`} /><div className="min-w-0"><p>{doc.label.replace(/: PDF стр\. .*$/, '')}</p>{doc.assetId && <button type="button" className="mt-1 text-emerald-700 hover:underline dark:text-emerald-400" onClick={() => onOpen(doc)}>Открыть</button>}</div></div>)}
    {!docs.length && family.catalog?.assetId && <button type="button" className="fx-btn fx-btn-sm" onClick={() => onOpen({ id: family.id, label: 'Описание и инструкции', kind: 'manual', ...family.catalog! })}>Описание и инструкции</button>}
    {!docs.length && !family.catalog?.assetId && <p className={`py-2 text-xs ${muted}`}>Инструкции пока не добавлены.</p>}
  </div>;
}

function ComparePanel({ families, catalog, onRemove }: { families: Family[]; catalog: Catalog; onRemove: (id: string) => void }) {
  const keys = [...new Set(families.flatMap((family) => family.params.map((param) => param.key)))];
  const paramFor = (family: Family, key: string) => family.params.find((param) => param.key === key);
  const valueFor = (param: ParamDef | undefined) => {
    if (!param) return '';
    const items = param.values?.map((item) => textOf(item.label)).filter(Boolean) || [];
    return items.length ? items.join(', ') : '';
  };
  return <section className="flex min-h-0 flex-col border-t border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/70">
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-slate-200 px-3 dark:border-slate-700">
      <GitCompareArrows className={`h-4 w-4 ${muted}`} /><h3 className="text-xs font-medium">Сравнение · {families.length}</h3>
      <button type="button" className="ml-auto fx-btn fx-btn-sm" onClick={() => families.forEach((family) => onRemove(family.id))}>Очистить</button>
    </div>
    <div className="min-h-0 overflow-auto">
      <table className="w-full min-w-[620px] border-collapse text-xs"><thead className="sticky top-0 bg-slate-100 dark:bg-slate-800"><tr>
        <th className="w-44 p-2 text-left font-medium text-slate-500 dark:text-slate-400">Параметр</th>
        {families.map((family) => <th key={family.id} className="min-w-44 p-2 text-left font-medium">
          <div className="flex items-start gap-2"><span className="min-w-0 flex-1"><span className="block font-mono text-slate-900 dark:text-slate-100">{family.code}</span><span className={`block truncate font-normal ${muted}`}>{manufacturerName(catalog, family)}</span></span>
            <button aria-label={`Убрать ${family.code} из сравнения`} onClick={() => onRemove(family.id)} className={`rounded p-1 ${muted} hover:bg-slate-200 dark:hover:bg-slate-700`}><X className="h-3.5 w-3.5" /></button></div>
        </th>)}
      </tr></thead><tbody>
        {keys.map((key) => <tr key={key} className="border-t border-slate-200 dark:border-slate-700"><th className="p-2 text-left font-normal text-slate-500 dark:text-slate-400">{textOf(paramFor(families[0], key)?.label) || key}</th>
          {families.map((family) => { const param = paramFor(family, key); const value = valueFor(param); return <td key={family.id} className="p-2 text-slate-800 dark:text-slate-100">{value || <span className={muted}>Не указано</span>}</td>; })}
        </tr>)}
        {!keys.length && <tr><td className={`p-3 ${muted}`} colSpan={families.length + 1}>Нет данных для сравнения.</td></tr>}
      </tbody></table>
    </div>
  </section>;
}

function CatalogDataTable({ table, onReport }: { table: CatalogTable; onReport?: (field: string, details?: ReportDetails) => void }) {
  const [rowLimit, setRowLimit] = useState(100);
  return <section className="space-y-2">
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><h3 className="text-xs font-medium">{table.title}</h3>
</div>
    {!table.rows.length ? <p className={`border-y py-2 text-xs ${muted} ${line}`}>Таблица пока не содержит строк.</p> :
      <div className={`max-h-[55vh] overflow-auto border-y ${line}`}><table className="w-full min-w-[560px] border-collapse text-left text-xs">
        <thead className="sticky top-0 bg-slate-50 text-slate-500 dark:bg-slate-800 dark:text-slate-300"><tr className="h-8">
          {table.columns.map((column) => <th key={column.key} className="px-2 font-medium">{column.label}{column.unit ? <span className={`ml-1 font-normal ${muted}`}>{column.unit}</span> : null}<span className={`ml-1 block font-normal ${muted}`}>{column.role === 'input' ? 'Входной параметр' : 'Результат'}</span></th>)}

        </tr></thead><tbody>
          {table.rows.slice(0, rowLimit).map((row) => <tr key={row.id} className={`border-t ${line}`}>
            {table.columns.map((column) => { const value = row.values[column.key]; const source = row.source || table.source; return <td key={column.key} className={`max-w-64 px-2 py-2 align-top ${value === null || value === '' ? muted : 'text-slate-800 dark:text-slate-100'}`}>{value === null || value === '' ? '—' : valueText(value)}
              {onReport && <button type="button" className="ml-2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" onClick={() => onReport(`${table.id}/${row.id}/${column.key}`, { currentValue: valueText(value) || undefined, source })}>Сообщить</button>}
            </td>; })}

          </tr>)}
        </tbody></table></div>}
    {table.rows.length > rowLimit && <button type="button" className="fx-btn fx-btn-sm" onClick={() => setRowLimit((limit) => limit + 100)}>Показать ещё строки ({table.rows.length - rowLimit})</button>}
  </section>;
}

export default function CatalogReader({ catalog, onManage, onReport }: {
  catalog: Catalog; onManage?: () => void; onReport?: (family: Family, field?: string, details?: ReportDetails) => void;
}) {
  const [classId, setClassId] = useState('');
  const [manufacturerId, setManufacturerId] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [familyLimit, setFamilyLimit] = useState(100);
  const [designation, setDesignation] = useState('');
  const [assetPreview, setAssetPreview] = useState<{ url: string; name: string; page?: number; busy?: boolean; error?: string } | null>(null);
  const sourceRequest = useRef(0);

  const allFamilies = useMemo(() => [
    ...catalog.families,
    ...catalog.components.map((component) => familyOfComponent(component, catalog)),
  ], [catalog]);
  const componentFor = (family: Family | undefined) => family?.id.startsWith('component:')
    ? catalog.components.find((component) => `component:${component.id}` === family.id)
    : undefined;
  const families = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return allFamilies.filter((family) => {
      const component = componentFor(family);
      return (!classId || family.classId === classId || component?.classIds?.includes(classId))
      && (!manufacturerId || family.manufacturerId === manufacturerId || (manufacturerId.startsWith('name:') && component?.manufacturer === manufacturerId.slice(5)))
      && (!q || [family.code, textOf(family.title), textOf(family.description), family.typeLabel && textOf(family.typeLabel), ...(family.aliases || []), ...(family.sections || []).map(section => `${section.title} ${section.text}`), ...(family.tables || []).flatMap(table => [table.title, ...table.rows.map(row => Object.values(row.values).join(' '))]), manufacturerName(catalog, family, component)].some((value) => value.toLocaleLowerCase().includes(q)));
    })
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.code.localeCompare(b.code, 'ru'));
  }, [allFamilies, catalog, classId, manufacturerId, query]);
  const selected = families.find((family) => family.id === selectedId) || families[0];
  const selectedComponent = componentFor(selected);
  const selectedClass = catalog.classes.find((item) => item.id === (classId && selectedComponent?.classIds?.includes(classId) ? classId : selected?.classId));
  const compareFamilies = compareIds.map((id) => allFamilies.find((family) => family.id === id)).filter((family): family is Family => !!family);
  const manufacturerOptions = [
    ...catalog.manufacturers.filter((maker) => !classId || allFamilies.some((family) => (family.classId === classId || componentFor(family)?.classIds?.includes(classId)) && family.manufacturerId === maker.id)),
    ...[...new Set(catalog.components.filter((component) => !component.manufacturerId && component.manufacturer && (!classId || component.classId === classId || component.classIds?.includes(classId))).map((component) => component.manufacturer!))]
      .map((name) => ({ id: `name:${name}`, name, shortName: name })),
  ];
  const parsed = selected && designation.trim() && (selected.designationMode || 'structured') === 'structured' ? parseWithFamily(selected, designation) : undefined;

  useEffect(() => () => { if (assetPreview?.url) URL.revokeObjectURL(assetPreview.url); }, [assetPreview?.url]);
  useEffect(() => () => { sourceRequest.current++; }, []);
  useEffect(() => { setDesignation(''); }, [selected?.id]);

  const toggleCompare = (family: Family) => setCompareIds((ids) => ids.includes(family.id) ? ids.filter((id) => id !== family.id) : ids.length < 4 ? [...ids, family.id] : ids);
  const report = (field?: string, details?: ReportDetails) => selected && onReport?.(selectedComponent ? { ...selected, id: selectedComponent.id } : selected, field, details);
  const openDocument = async (doc: CatalogDocument) => {
    if (!doc.assetId) return;
    const request = ++sourceRequest.current;
    setAssetPreview({ url: '', name: doc.label, busy: true });
    try { const url = await loadCatalogAsset(doc.assetId); if (sourceRequest.current !== request) { URL.revokeObjectURL(url); return; } setAssetPreview({ url, name: doc.label, page: sourcePhysicalPage(doc) }); }
    catch (error) { if (sourceRequest.current === request) setAssetPreview({ url: '', name: doc.label, error: error instanceof Error ? error.message : 'Не удалось открыть документ' }); }
  };
  const closeDocument = () => { sourceRequest.current++; setAssetPreview(null); };

  return <div className="@container relative flex h-full min-h-0 min-w-0 flex-col bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100">
    <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-1.5 dark:border-slate-800">
      <h2 className="mr-1 text-sm font-medium">Каталог</h2><span className={`text-xs ${muted}`}>{families.filter((family) => !family.id.startsWith('component:')).length} моделей · {families.filter((family) => family.id.startsWith('component:')).length} комплектующих</span>
      <div className="ml-auto flex items-center gap-2">
        {onManage && <button className="fx-btn fx-btn-sm" type="button" onClick={onManage}>Управление каталогом</button>}
      </div>
    </header>
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-1.5 dark:border-slate-800">
      <label className="flex h-7 min-w-[180px] max-w-[360px] flex-1 items-center gap-2 rounded border border-slate-200 px-2 dark:border-slate-700">
        <Search className={`h-3.5 w-3.5 shrink-0 ${muted}`} /><input aria-label="Поиск моделей" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Код, модель, назначение…" className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
      </label>
      <select aria-label="Тип оборудования" value={classId} onChange={(event) => { setClassId(event.target.value); setManufacturerId(''); setSelectedId(''); }} className="h-7 max-w-52 rounded border border-slate-200 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-900">
        <option value="">Все типы</option>{catalog.classes.map((item) => <option key={item.id} value={item.id}>{textOf(item.title)}</option>)}
      </select>
      <select aria-label="Производитель" value={manufacturerId} onChange={(event) => setManufacturerId(event.target.value)} className="h-7 max-w-52 rounded border border-slate-200 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-900">
        <option value="">Все производители</option>{manufacturerOptions.map((item) => <option key={item.id} value={item.id}>{item.shortName || item.name}</option>)}
      </select>
      {compareIds.length > 0 && <span className={`ml-auto text-xs ${muted}`}>Сравнение: {compareIds.length}/4</span>}
    </div>
    <div className="flex min-h-0 flex-1 flex-col @[1000px]:flex-row">
      <aside className="flex max-h-[35%] min-h-28 min-w-0 flex-col border-b border-slate-200 @[1000px]:max-h-none @[1000px]:w-[300px] @[1000px]:shrink-0 @[1000px]:border-b-0 @[1000px]:border-r dark:border-slate-800">
        <div className="flex h-8 shrink-0 items-center justify-between px-3 text-xs"><span className="font-medium">Модели и комплектующие</span><span className={muted}>{families.length}</span></div>
        <div className="min-h-0 flex-1 overflow-auto">
          {families.slice(0, familyLimit).map((family) => {
            const active = selected?.id === family.id;
            const component = componentFor(family);
            const cls = catalog.classes.find((item) => item.id === (classId && component?.classIds?.includes(classId) ? classId : family.classId));
            return <div key={family.id} className={`group flex min-h-9 items-center gap-2 border-t border-slate-100 px-2 dark:border-slate-800 ${active ? 'bg-slate-100 dark:bg-slate-800/70' : 'hover:bg-slate-50 dark:hover:bg-slate-900'}`}>
              <button type="button" onClick={() => { setSelectedId(family.id); setTab('overview'); }} aria-current={active ? 'true' : undefined} className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left">
                <span className="min-w-0 flex-1"><span className="block truncate font-mono text-xs">{family.code}</span><span className={`block truncate text-xs ${muted}`}>{manufacturerName(catalog, family, component)}{cls ? ` · ${textOf(cls.title)}` : ''}{component ? ` · ${component.equipmentType || component.kind}` : ''}</span></span>
                <ChevronRight className={`h-3.5 w-3.5 shrink-0 ${muted}`} />
              </button>
              <button type="button" aria-label={compareIds.includes(family.id) ? 'Убрать из сравнения' : 'Добавить к сравнению'} title={compareIds.includes(family.id) ? 'Убрать из сравнения' : 'Сравнить'} onClick={() => toggleCompare(family)} disabled={!compareIds.includes(family.id) && compareIds.length >= 4} className={`rounded p-1 ${compareIds.includes(family.id) ? 'text-emerald-700 dark:text-emerald-400' : `${muted} opacity-0 group-hover:opacity-100 focus:opacity-100`} disabled:opacity-30`}>
                {compareIds.includes(family.id) ? <Check className="h-4 w-4" /> : <GitCompareArrows className="h-4 w-4" />}
              </button>
            </div>;
          })}
          {!families.length && <div className={`px-3 py-3 text-xs ${muted}`}>Модели не найдены. Измените поиск или фильтры.</div>}
          {families.length > familyLimit && <button type="button" className="mx-2 my-2 fx-btn fx-btn-sm" onClick={() => setFamilyLimit((limit) => limit + 100)}>Показать ещё модели ({families.length - familyLimit})</button>}
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected ? <>
          <div className="shrink-0 border-b border-slate-200 px-4 pt-3 dark:border-slate-800">
            <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><h1 className="font-mono text-base font-medium">{selected.code}</h1><span className={`text-xs ${muted}`}>{manufacturerName(catalog, selected)}</span><span className={`text-xs ${muted}`}>{textOf(selectedClass?.title)}</span></div>
                <div className={`mt-1 text-xs ${muted}`}>{textOf(selected.title) || textOf(selected.description) || 'Описание не указано.'}</div></div>
              {onReport && <button type="button" className="fx-btn fx-btn-sm" onClick={() => report()}>Сообщить о неточности</button>}
            </div>
            <nav aria-label="Разделы карточки модели" className="mt-3 flex gap-1 overflow-x-auto">
              {TABS.map((item) => <button key={item.id} type="button" aria-selected={tab === item.id} onClick={() => setTab(item.id)} className={`whitespace-nowrap border-b-2 px-2.5 py-2 text-xs ${tab === item.id ? 'border-emerald-600 text-emerald-700 dark:text-emerald-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'}`}>{item.title}</button>)}
            </nav>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {tab === 'overview' && <div className="max-w-4xl space-y-5">
              <section><h3 className="mb-2 text-xs font-medium">Назначение</h3><p className="whitespace-pre-wrap text-xs leading-5 text-slate-700 dark:text-slate-300">{textOf(selected.description) || textOf(selected.title) || 'Описание не указано.'}</p></section>
              <section><h3 className="mb-2 text-xs font-medium">Общие сведения</h3><dl className={`divide-y border-y ${line}`}>
                {[['Тип', textOf(selectedClass?.title)], ['Вид изделия', textOf(selected.typeLabel)], ['Изготовитель', manufacturerName(catalog, selected)], ['Обозначения', selected.aliases?.join(', ') || '']].filter(([, value]) => value).map(([label, value]) => <div key={label} className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 py-2 text-xs"><dt className={muted}>{label}</dt><dd className="break-words">{value}</dd></div>)}
              </dl></section>
              {selectedComponent && <section><h3 className="mb-2 text-xs font-medium">Применимость комплектующего</h3><dl className={`divide-y border-y ${line}`}>
                <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 py-2 text-xs"><dt className={muted}>Типы оборудования</dt><dd>{(selectedComponent.classIds || [selectedComponent.classId]).map((id) => textOf(catalog.classes.find((item) => item.id === id)?.title) || id).join(', ') || 'Не указаны'}</dd></div>
                <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 py-2 text-xs"><dt className={muted}>Совместимые модели</dt><dd>{selectedComponent.familyIds?.length ? selectedComponent.familyIds.map((id) => catalog.families.find((family) => family.id === id)?.code || id).join(', ') : 'Не ограничены в данных каталога'}</dd></div>
              </dl></section>}
              {!!selected.facts && <section><h3 className="mb-2 text-xs font-medium">Признаки модели</h3><FactRows facts={selected.facts} definitions={selectedClass?.facts || []} /></section>}
              <CatalogContents key={selected.id} sections={selected.sections || []} />

            </div>}
            {tab === 'specs' && <div className="flex max-w-5xl flex-col gap-4">
              <div className="flex items-center gap-2"><h3 className="text-xs font-medium">Характеристики модели</h3></div>
              <CatalogContents key={`${selected.id}-specs`} sections={selected.sections || []} kind="specs" />
              {(selected.tables || []).filter(table => table.rows.some(row => row.verified)).map(table => <CatalogDataTable key={table.id} table={{ ...table, rows: table.rows.filter(row => row.verified) }} />)}
              <ValueRows family={selected} onReport={onReport ? (field, details) => report(field, details) : undefined} />
              {selected.specs.length > 0 && <section><h3 className="mb-2 text-xs font-medium">Данные спецификации</h3><div className={`divide-y border-y ${line}`}>{selected.specs.map((spec, index) => <div key={`${spec.key}-${index}`} className="grid grid-cols-[minmax(140px,0.7fr)_minmax(0,1fr)] gap-3 py-2 text-xs"><span className={muted}>{textOf(spec.label)}</span><span>{textOf(spec.value)}{spec.unit ? ` ${spec.unit}` : ''}</span></div>)}</div></section>}
            </div>}
            {tab === 'marking' && <div className="flex max-w-3xl flex-col gap-4">
              <CatalogContents key={`${selected.id}-marking`} sections={selected.sections || []} kind="marking" />
              <div><h3 className="mb-1 text-xs font-medium">Расшифровка обозначения</h3><p className={`text-xs ${muted}`}>Введите код целиком. Расшифровка строится по структуре этой модели; нераспознанный код остаётся без догадок.</p></div>
              <label className="flex flex-col gap-1 text-xs"><span className={muted}>Код изделия</span><input value={designation} onChange={(event) => setDesignation(event.target.value)} placeholder={selected.examples?.[0] || selected.code} className="fx-input font-mono" /></label>
              {designation.trim() && selected.designationMode === 'article' && <div className={`border-y px-2 py-3 text-xs ${line}`}>
                {selected.article && designation.trim().toLocaleLowerCase() === selected.article.toLocaleLowerCase() ? <span>Артикул совпадает с указанным для модели: <code className="font-mono">{selected.article}</code>.</span> : <span className={muted}>Для этой модели используется артикул. {selected.article ? `В каталоге указан: ${selected.article}; введённое значение не совпадает.` : 'Артикул не указан.'} Структурная расшифровка не задана.</span>}
              </div>}
              {designation.trim() && selected.designationMode === 'free' && <div className={`border-y px-2 py-3 text-xs ${muted} ${line}`}>Для этой модели каталог не задаёт структурную расшифровку обозначения.</div>}
              {designation.trim() && parsed && <div className={`border-y ${line}`}>
                <div className={`border-b px-2 py-2 text-xs ${parsed.complete ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'} ${line}`}>{parsed.complete ? 'Код разобран по модели' : 'Полная расшифровка не подтверждена'}</div>
              {Object.entries(parsed.values).map(([key, value]) => {
                  const param = selected.params.find((item) => item.key === key);
                  const choice = param?.values?.find((item) => item.code === String(value));
                  return <div key={key} className={`grid grid-cols-[minmax(130px,0.6fr)_minmax(0,1fr)_auto] items-center gap-2 border-b px-2 py-2 text-xs ${line}`}>
                    <span className={muted}>{textOf(param?.label) || key}</span><span className="break-words">{choice ? textOf(choice.label) : `${value}${param?.unit ? ` ${param.unit}` : ''}`}</span>
                    {onReport && <button className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" type="button" onClick={() => report(key, { currentValue: choice ? textOf(choice.label) : String(value), source: selected.catalog })}>Сообщить</button>}
                    {choice?.note && <span className={`col-start-2 col-span-2 ${muted}`}>{choice.note}</span>}
                  </div>;
                })}
                {parsed.rest && <div className="px-2 py-2 text-xs text-amber-700 dark:text-amber-400">Не разобранный остаток: <code className="font-mono">{parsed.rest}</code></div>}
                {!Object.keys(parsed.values).length && <div className={`px-2 py-3 text-xs ${muted}`}>Подходящих частей обозначения не найдено.</div>}
              </div>}
              {!designation.trim() && <div className={`border-y py-3 text-xs ${muted} ${line}`}>Введите обозначение, чтобы увидеть найденные параметры.</div>}
              {(selected.designationMode || 'structured') === 'structured' && <section><h3 className="mb-2 text-xs font-medium">Структура кода</h3><div className="flex flex-wrap gap-x-3 gap-y-1">{selected.positions.map((position, index) => <span key={position.key} className={`text-xs ${muted}`}><span className="text-slate-800 dark:text-slate-100">{textOf(position.label)}</span>{index < selected.positions.length - 1 ? ' · ' : ''}</span>)}</div></section>}
            </div>}
            {tab === 'documents' && <div className="max-w-5xl space-y-5"><CatalogContents key={`${selected.id}-instructions`} sections={selected.sections || []} />{!selected.sections?.length && <SourceBlock family={selected} onOpen={(doc) => void openDocument(doc)} />}
              {(selected.tables || []).filter(table => table.rows.some(row => row.verified)).map((table) => <CatalogDataTable key={table.id} table={{ ...table, rows: table.rows.filter(row => row.verified) }} onReport={onReport ? (field, details) => report(field, details) : undefined} />)}
              {selected.rules.length > 0 && <section><h3 className="mb-2 text-xs font-medium">Примечания к применению</h3><div className={`divide-y border-y ${line}`}>{selected.rules.map((rule) => <div key={rule.id} className="py-2 text-xs"><p>{rule.message}</p></div>)}</div></section>}
              {!!onReport && <button type="button" className="fx-btn fx-btn-sm" onClick={() => report('Устройство и применение')}>Сообщить о неточности</button>}
            </div>}
          </div>
        </> : <div className="fx-empty m-4"><div className="fx-empty-title">Выберите модель</div><div className="fx-empty-text">Слева показаны модели, подходящие под выбранные фильтры.</div></div>}
      </main>
    </div>
    {compareFamilies.length > 0 && <ComparePanel families={compareFamilies} catalog={catalog} onRemove={(id) => setCompareIds((ids) => ids.filter((item) => item !== id))} />}
    {assetPreview && <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDocument(); }}>
      <section role="dialog" aria-modal="true" aria-label={assetPreview.name} className="flex h-[min(90%,900px)] w-[min(100%,1100px)] min-w-0 flex-col border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-slate-200 px-3 dark:border-slate-700"><span className="min-w-0 flex-1 truncate text-xs">{assetPreview.name}</span><button type="button" className="fx-btn fx-btn-sm" onClick={closeDocument}>Закрыть</button></div>
        {assetPreview.busy ? <p className={`p-4 text-xs ${muted}`}>Открываем документ…</p> : assetPreview.error ? <p role="alert" className="p-4 text-xs text-rose-700 dark:text-rose-300">{assetPreview.error}</p> : assetPreview.url && <iframe title={assetPreview.name} src={`${assetPreview.url}${assetPreview.page ? `#page=${assetPreview.page}` : ''}`} className="min-h-0 flex-1 bg-white" />}
      </section>
    </div>}
  </div>;
}
