import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Plus, RefreshCw, X } from 'lucide-react';
import type { OfficeField, OfficeQuery, OfficeQueryFilter, OfficeQueryResult } from './fluxData';
import { Btn, Input } from '../ui';

interface Props {
  query: OfficeQuery;
  fields: OfficeField[];
  result: OfficeQueryResult | null;
  loading: boolean;
  error: string;
  selectedIds: string[];
  onQueryChange: (query: OfficeQuery) => void;
  onRun: () => void;
  onSelectionChange: (ids: string[]) => void;
}

const OPERATORS: Array<{ value: OfficeQueryFilter['op']; label: string }> = [
  { value: 'contains', label: 'содержит' }, { value: 'equals', label: 'равно' },
  { value: 'notEquals', label: 'не равно' }, { value: 'gt', label: 'больше' },
  { value: 'lt', label: 'меньше' }, { value: 'empty', label: 'пусто' },
  { value: 'notEmpty', label: 'не пусто' },
];

export default function FluxSelectionPanel({ query, fields, result, loading, error, selectedIds, onQueryChange, onRun, onSelectionChange }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: result?.rows.length || 0, getScrollElement: () => scrollRef.current, estimateSize: () => 34, overscan: 8 });
  const visibleIds = result?.rows.map((row) => row.entityId).filter((id) => !query.excludedEntityIds.includes(id)) || [];
  const availableTypes = [...new Set((result?.rows || []).map((row) => String(row.values.equipType?.value ?? '')).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const filterField = fields[0]?.fieldKey || '';

  const setFilter = (index: number, next: OfficeQueryFilter) => {
    const filters = [...query.filters]; filters[index] = next;
    onQueryChange({ ...query, filters });
  };
  const setSort = (index: number, key: string, direction: 'asc' | 'desc') => {
    const sort = [...query.sort]; sort[index] = { fieldKey: key, direction };
    onQueryChange({ ...query, sort });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 p-3">
        <label className="block text-xs text-slate-600 dark:text-slate-300">Источник
        <select aria-label="Источник данных" className="fx-input mt-1 w-full" value={query.sources[0] || ''} onChange={(e) => onQueryChange({ ...query, sources: e.target.value ? [e.target.value] : [], columns: undefined, filters: [], sort: [], types: [], excludedEntityIds: [] })}>
            <option value="">Выберите источник</option>
            {[...new Set(fields.map((field) => field.sourceId))].map((source) => <option key={source} value={source}>{sourceTitle(source)}</option>)}
          </select>
        </label>
        {query.sources[0] === 'equipment' && availableTypes.length > 0 && <fieldset>
          <legend className="mb-1 text-xs text-slate-600 dark:text-slate-300">Тип оборудования</legend>
          <div className="flex max-h-24 flex-wrap gap-x-3 gap-y-1 overflow-auto">
            {availableTypes.map((type) => <label key={type} className="flex items-center gap-1 text-xs text-slate-700 dark:text-slate-300"><input className="accent-emerald-600" type="checkbox" checked={query.types.includes(type)} onChange={(event) => onQueryChange({ ...query, types: event.target.checked ? [...query.types, type] : query.types.filter((item) => item !== type) })} />{type}</label>)}
          </div>
        </fieldset>}
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
            <span>Фильтры</span>
            <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" disabled={!filterField} onClick={() => onQueryChange({ ...query, filters: [...query.filters, { fieldKey: filterField, op: 'contains', value: '' }] })}>
              <Plus className="h-3.5 w-3.5" /> Добавить
            </button>
          </div>
          {query.filters.map((filter, index) => (
            <div key={`${filter.fieldKey}:${index}`} className="mb-2 grid grid-cols-[minmax(0,1fr)_110px_minmax(0,1fr)_28px] gap-1.5">
              <select aria-label="Поле фильтра" className="fx-input min-w-0" value={filter.fieldKey} onChange={(e) => setFilter(index, { ...filter, fieldKey: e.target.value })}>
                {fields.map((field) => <option key={`${field.sourceId}:${field.fieldKey}`} value={field.fieldKey}>{field.displayName}</option>)}
              </select>
              <select aria-label="Условие фильтра" className="fx-input min-w-0" value={filter.op} onChange={(e) => setFilter(index, { ...filter, op: e.target.value as OfficeQueryFilter['op'] })}>
                {OPERATORS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              {filter.op !== 'empty' && filter.op !== 'notEmpty' ? <Input aria-label="Значение фильтра" value={filter.value || ''} onChange={(e) => setFilter(index, { ...filter, value: e.target.value })} /> : <span />}
              <button type="button" aria-label="Удалить фильтр" className="fx-btn fx-btn-quiet fx-btn-sm" onClick={() => onQueryChange({ ...query, filters: query.filters.filter((_, at) => at !== index) })}><X className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          {!query.filters.length && <p className="text-xs text-slate-500 dark:text-slate-400">Условия не заданы. Можно добавить фильтр по любому доступному полю.</p>}
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
            <span>Сортировка</span>
            <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" disabled={!fields.length || query.sort.length >= 4} onClick={() => onQueryChange({ ...query, sort: [...query.sort, { fieldKey: fields[0].fieldKey, direction: 'asc' }] })}>
              <Plus className="h-3.5 w-3.5" /> Уровень
            </button>
          </div>
          {query.sort.map((sort, index) => (
            <div key={`${sort.fieldKey}:${index}`} className="mb-2 grid grid-cols-[minmax(0,1fr)_100px_28px] gap-1.5">
              <select aria-label={`Поле сортировки ${index + 1}`} className="fx-input min-w-0" value={sort.fieldKey} onChange={(e) => setSort(index, e.target.value, sort.direction)}>
                {fields.map((field) => <option key={`${field.sourceId}:${field.fieldKey}`} value={field.fieldKey}>{field.displayName}</option>)}
              </select>
              <select aria-label={`Направление сортировки ${index + 1}`} className="fx-input" value={sort.direction} onChange={(e) => setSort(index, sort.fieldKey, e.target.value as 'asc' | 'desc')}>
                <option value="asc">По возрастанию</option><option value="desc">По убыванию</option>
              </select>
              <button type="button" aria-label="Удалить уровень сортировки" className="fx-btn fx-btn-quiet fx-btn-sm" onClick={() => onQueryChange({ ...query, sort: query.sort.filter((_, at) => at !== index) })}><X className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Btn tone="primary" onClick={onRun} disabled={loading || !query.projectId || !query.sources.length}><RefreshCw className={loading ? 'animate-spin' : ''} />Обновить выборку</Btn>
          {result && <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">Найдено: {result.total.toLocaleString('ru-RU')}</span>}
        </div>
        {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      </div>

      <div className="flex min-h-0 flex-1 flex-col border-t border-slate-200 dark:border-slate-800">
        <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-xs text-slate-600 dark:text-slate-300">
          <input className="accent-emerald-600" aria-label="Выбрать все строки" type="checkbox" checked={allVisibleSelected} onChange={(e) => onSelectionChange(e.target.checked ? [...new Set([...selectedIds, ...visibleIds])] : selectedIds.filter((id) => !visibleIds.includes(id)))} />
          <span>{selectedIds.length ? `Выбрано ${selectedIds.length}` : 'Выберите строки или отметьте все найденные'}</span>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div role="grid" aria-label="Предпросмотр выборки" className="min-w-max text-xs">
            <div role="row" className="sticky top-0 z-10 flex min-w-max border-b border-slate-200 bg-white font-semibold text-slate-800 dark:border-slate-800 dark:bg-dark-surface dark:text-dark-text-main"><span role="columnheader" className="w-8 shrink-0" />{previewFields(fields, query.sources, query.columns).map((field) => <span key={`${field.sourceId}:${field.fieldKey}`} role="columnheader" className="w-40 shrink-0 px-2 py-2">{field.displayName}</span>)}</div>
            <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
              {virtual.getVirtualItems().map((item) => {
                const row = result?.rows[item.index]; if (!row) return null;
                const columns = previewFields(fields, query.sources, query.columns);
                return <div role="row" key={`${row.sourceId}:${row.entityId}`} style={{ position: 'absolute', transform: `translateY(${item.start}px)`, height: item.size }} className="flex min-w-max items-center border-b border-slate-100 text-slate-700 dark:border-slate-800 dark:text-dark-text-main">
                  <span role="gridcell" className="flex w-8 shrink-0 justify-center"><input className="accent-emerald-600" type="checkbox" aria-label={`Выбрать строку ${row.tag || row.entityId}`} disabled={query.excludedEntityIds.includes(row.entityId)} checked={selectedIds.includes(row.entityId)} onChange={(e) => onSelectionChange(e.target.checked ? [...selectedIds, row.entityId] : selectedIds.filter((id) => id !== row.entityId))} /></span>
                  {columns.map((field) => <span role="gridcell" key={`${field.sourceId}:${field.fieldKey}`} className="w-40 shrink-0 truncate px-2" title={String(row.values[field.fieldKey]?.value ?? '—')}>{String(row.values[field.fieldKey]?.value ?? '—')}</span>)}
                  <span role="gridcell" className="w-20 shrink-0 px-1"><button type="button" className="text-xs text-slate-500 underline disabled:no-underline" aria-label={`${query.excludedEntityIds.includes(row.entityId) ? 'Включить' : 'Исключить'} строку ${row.tag || row.entityId}`} onClick={() => {
                    const excluded = query.excludedEntityIds.includes(row.entityId);
                    const next = excluded ? query.excludedEntityIds.filter((id) => id !== row.entityId) : [...query.excludedEntityIds, row.entityId];
                    onQueryChange({ ...query, excludedEntityIds: next });
                    if (!excluded) onSelectionChange(selectedIds.filter((id) => id !== row.entityId));
                  }}>{query.excludedEntityIds.includes(row.entityId) ? 'Включить' : 'Исключить'}</button></span>
                </div>;
              })}
            </div>
          </div>
          {!result?.rows.length && <p className="p-4 text-xs text-slate-500 dark:text-slate-400">{loading ? 'Загрузка выборки…' : 'Задайте источник и нажмите «Обновить выборку».'}</p>}
        </div>
      </div>
    </div>
  );
}

function sourceTitle(source: string) {
  const names: Record<string, string> = { tags: 'Теги', equipment: 'Оборудование', management: 'Менеджмент', e3: 'E3Flux', e3flux: 'E3Flux' };
  return names[source] || source;
}

function previewFields(fields: OfficeField[], sources: string[], requested?: string[]) {
  const selected = requested?.length ? new Set(requested) : null;
  const available = fields.filter((field) => sources.includes(field.sourceId) && (!selected || selected.has(field.fieldKey)));
  const defaults = ['identifier', 'tag', 'name', 'equipType', 'system.name'];
  const rank = (fieldKey: string) => { const at = defaults.indexOf(fieldKey); return at < 0 ? defaults.length : at; };
  const ranked = available.sort((a, b) => rank(a.fieldKey) - rank(b.fieldKey) || a.displayName.localeCompare(b.displayName, 'ru'));
  return ranked.slice(0, 4);
}
