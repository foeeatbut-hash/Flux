import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import DataIssueDialog from '../catalog/DataIssueDialog';
import type { CatalogDataIssueContext } from '../../../feedback/catalogDataIssue';

type Mode = 'hybrid' | 'xml' | 'catalog';
type Source = 'xml' | 'catalog' | 'manual';
interface Model {
  id: string;
  code: string;
  manufacturer?: string;
  manufacturerSearch?: string;
  title?: { ru?: string } | string;
  specs?: Array<{ label?: { ru?: string } | string; value: string; unit?: string }>;
  effectiveSpecs?: Array<{ label?: { ru?: string } | string; value: string; unit?: string }>;
  catalog?: unknown;
  sourceType?: 'component' | 'family';
  sourceRevision?: string;
  parsedValues?: Record<string, string | number>;
  status?: string;
}
interface Snapshot {
  mode: Mode;
  binding?: { modelId: string; code: string; manufacturer?: string; revision?: string; catalogRevision?: string; sourceRevision?: string; sourceType?: 'component' | 'family'; at?: string; snapshot?: Model };
  matches: Model[];
  updateAvailable?: Model;
  effective: Array<{ group?: string; key: string; value: string; unit?: string; source: Source; revision?: string; sourceRef?: { file: string; pages?: string; edition?: string } }>;
  warnings: string[];
  discrepancies: Array<{ group: string; key: string; xmlValue: string; catalogValue: string; xmlUnit?: string; catalogUnit?: string; sourceRef?: { file: string; pages?: string; edition?: string } }>;
}
interface CatalogIndex {
  components?: Model[];
  families?: Model[];
  meta?: Record<string, { updatedAt?: string }>;
  manufacturers?: Array<{ id: string; name: string; shortName?: string }>;
}

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'hybrid', label: 'XML + заполнить пропуски из каталога' },
  { value: 'xml', label: 'Только XML' },
  { value: 'catalog', label: 'Каталог' },
];
const sourceLabel: Record<Source, string> = { xml: 'XML', catalog: 'Каталог', manual: 'Ручная правка' };
const text = (value: { ru?: string } | string | undefined) =>
  typeof value === 'string' ? value : String((value as { ru?: string } | null)?.ru || '');

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(String(body?.error || body?.message || `Ошибка ${response.status}`)) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return body as T;
}

export default function CatalogSourcePanel({ componentId, onChanged }: { componentId: string; onChanged: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [mode, setMode] = useState<Mode>('hybrid');
  const [selectedId, setSelectedId] = useState('');
  const [selectedType, setSelectedType] = useState<'component' | 'family'>('component');
  const [query, setQuery] = useState('');
  const [allModels, setAllModels] = useState<Model[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [reviewUpdate, setReviewUpdate] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueField, setIssueField] = useState<{ key?: string; value?: string; source?: { file: string; pages?: string; edition?: string } } | null>(null);

  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const data = await readJson<Snapshot>(await fetch(`/api/equipment/component/${encodeURIComponent(componentId)}/catalog-source`, { signal }));
      setSnapshot(data);
      setMode(data.mode);
      setSelectedId((current) => current || data.binding?.modelId || '');
      setSelectedType(data.binding?.sourceType || 'component');
      setReviewUpdate(false);
      setConflict(false);
    } catch (e: any) {
      if (e?.name !== 'AbortError') setError(e?.message || 'Не удалось загрузить источник параметров');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    setSelectedId('');
    setSelectedType('component');
    void load(controller.signal);
    return () => controller.abort();
  }, [componentId]);

  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) { setSearchResults([]); setSearchLoading(false); return; }
    const fold = (value: unknown) => String(value || '').toLocaleLowerCase('ru').trim();
    const q = fold(needle);
    if (catalogLoaded) {
      setSearchResults(allModels.filter((model) => [model.code, model.manufacturer, model.manufacturerSearch, text(model.title)]
        .some((value) => fold(value).includes(q))));
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        setError('');
        const body = await readJson<CatalogIndex>(await fetch('/api/catalog', { signal: controller.signal }));
        const manufacturers = new Map((body.manufacturers || []).map((maker) => [maker.id, {
          name: maker.name || maker.shortName || '',
          search: [maker.name, maker.shortName].filter(Boolean).join(' '),
        }]));
        const components = (body.components || []).map((model: any) => ({
          ...model,
          manufacturer: model.manufacturer || manufacturers.get(model.manufacturerId)?.name || '',
          manufacturerSearch: manufacturers.get(model.manufacturerId)?.search || model.manufacturer || '',
          sourceType: 'component' as const,
          sourceRevision: body.meta?.[model.id]?.updatedAt,
        }));
        const families = (body.families || []).map((family: any) => ({
          ...family, kind: 'other', sourceType: 'family' as const, sourceRevision: body.meta?.[family.id]?.updatedAt,
          manufacturer: manufacturers.get(family.manufacturerId)?.name || '',
          manufacturerSearch: manufacturers.get(family.manufacturerId)?.search || '',
          specs: (family.specs || []).map((spec: any) => ({ label: spec.label, value: spec.value?.ru || '', unit: spec.unit })),
        }));
        setAllModels([...components, ...families]);
        setCatalogLoaded(true);
      } catch (e: any) {
        if (e?.name !== 'AbortError') setError(e?.message || 'Не удалось найти модель в каталоге');
      } finally {
        if (!controller.signal.aborted) setSearchLoading(false);
      }
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, catalogLoaded, allModels]);

  const candidates = useMemo(() => {
    const byId = new Map<string, Model>();
    for (const item of [...(snapshot?.matches || []), ...searchResults]) byId.set(`${item.sourceType || 'component'}:${item.id}`, item);
    return [...byId.values()];
  }, [snapshot?.matches, searchResults]);
  const chosen = candidates.find((item) => item.id === selectedId && (item.sourceType || 'component') === selectedType);

  const save = async (refresh: boolean) => {
    if ((mode === 'catalog' || mode === 'hybrid') && !selectedId && !snapshot?.binding?.modelId) {
      setError('Выберите точную модель каталога');
      return;
    }
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      const response = await fetch(`/api/equipment/component/${encodeURIComponent(componentId)}/catalog-source`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          ...(selectedId || snapshot?.binding?.modelId ? { modelId: selectedId || snapshot?.binding?.modelId, sourceType: chosen?.sourceType || snapshot?.binding?.sourceType || 'component' } : {}),
          ...(refresh ? { refresh: true } : {}),
          ...(snapshot?.binding?.revision ? { expectedRevision: snapshot.binding.revision } : {}),
        }),
      });
      if (response.status === 409) {
        const body = await response.json().catch(() => ({}));
        setConflict(true);
        setError(body?.error || 'Эту связь изменил другой участник. Обновите данные перед сохранением.');
        return;
      }
      await readJson<{ ok: true; binding: Snapshot['binding'] }>(response);
      // PUT возвращает только новую привязку; эффективные значения и revision
      // читаются заново тем же способом, что и после обновления карточки.
      await load();
      setReviewUpdate(false);
      onChanged();
    } catch (e: any) {
      setError(e?.message || 'Не удалось сохранить источник параметров');
    } finally {
      setBusy(false);
    }
  };

  return <section className="fx-set-group" aria-label="Источник параметров">
    <div className="fx-group-title">Источник параметров</div>
    {loading && <div className="fx-note flex items-center gap-2"><LoaderCircle className="w-3.5 h-3.5 animate-spin" />Загрузка источника…</div>}
    {!loading && <>
      <div className="fx-field py-2">
        <label className="fx-label" htmlFor={`catalog-mode-${componentId}`}>Откуда брать характеристики</label>
        <select id={`catalog-mode-${componentId}`} className="fx-input" value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as Mode)}>
          {MODES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <div className="fx-hint">Ручные правки сохраняют приоритет. В смешанном режиме XML задаёт заполненные поля, каталог — пропуски.</div>
      </div>

      {(mode === 'hybrid' || mode === 'catalog') && <div className="fx-set-row items-start">
        <div className="fx-set-text">
          <div>Модель каталога</div>
          <div className="fx-set-desc">Выберите изделие, которое точно соответствует позиции.</div>
        </div>
        <span className="fx-n">{snapshot?.matches.length || 0} совпадений</span>
      </div>}

      {(mode === 'hybrid' || mode === 'catalog') && <div className="space-y-2 py-2">
        {snapshot?.matches.length ? <div className="space-y-1" role="group" aria-label="Подходящие модели каталога">
          {snapshot.matches.map((model) => <ModelChoice key={`${model.sourceType || 'component'}:${model.id}`} model={model} selected={selectedId === model.id && selectedType === (model.sourceType || 'component')} onSelect={() => { setSelectedId(model.id); setSelectedType(model.sourceType || 'component'); }} />)}
        </div> : <div className="fx-note">Автоматических совпадений нет. Найдите модель и выберите её вручную.</div>}
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input className="fx-input min-w-0 flex-1" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Искать по коду или производителю" aria-label="Поиск модели каталога" />
          {query && <button type="button" onClick={() => setQuery('')} className="fx-btn fx-btn-quiet fx-btn-sm" aria-label="Очистить поиск"><X className="w-3.5 h-3.5" /></button>}
        </div>
        {query.trim().length >= 2 && <div className="space-y-1" role="group" aria-label="Результаты поиска каталога">
          {searchResults.map((model) => <ModelChoice key={`${model.sourceType || 'component'}:${model.id}`} model={model} selected={selectedId === model.id && selectedType === (model.sourceType || 'component')} onSelect={() => { setSelectedId(model.id); setSelectedType(model.sourceType || 'component'); }} />)}
          {searchLoading && <div className="fx-note flex items-center gap-2"><LoaderCircle className="w-3.5 h-3.5 animate-spin" />Поиск в каталоге…</div>}
          {catalogLoaded && !searchResults.length && !error && <div className="fx-note">Модели не найдены.</div>}
        </div>}
        {chosen && <div className="fx-note">Выбрано: <span className="font-mono">{chosen.code}</span>{chosen.manufacturer ? ` · ${chosen.manufacturer}` : ''}</div>}
      </div>}

      {snapshot?.binding && <div className="fx-note border-y border-slate-200 dark:border-slate-800">
        Источник: {mode === 'xml' ? 'XML' : 'каталог'}{snapshot.binding.code && <> · <span className="font-mono">{snapshot.binding.code}</span></>}{snapshot.binding.manufacturer ? ` · ${snapshot.binding.manufacturer}` : ''}
        {snapshot.binding.sourceRevision && <> · ревизия каталога {snapshot.binding.sourceRevision}</>}{snapshot.binding.at && <> · снимок от {new Date(snapshot.binding.at).toLocaleString('ru-RU')}</>}
      </div>}

      {snapshot?.updateAvailable && <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950/30">
        <div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" /><span className="flex-1">Опубликована новая ревизия {snapshot.updateAvailable.sourceRevision}. Снимок проекта не изменён.</span>
          <button type="button" className="fx-btn fx-btn-sm" onClick={() => setReviewUpdate(v => !v)}>{reviewUpdate ? 'Скрыть изменения' : 'Посмотреть изменения'}</button></div>
        {reviewUpdate && <>
          <div className="grid grid-cols-3 gap-2 font-medium"><span>Характеристика</span><span>Снимок проекта</span><span>Новая ревизия</span></div>
          {diffSpecs(snapshot.binding?.snapshot?.effectiveSpecs || snapshot.binding?.snapshot?.specs || [], snapshot.updateAvailable.specs || []).map((change, index) =>
            <div key={`${change.label}/${index}`} className="grid grid-cols-3 gap-2 border-t border-amber-200 pt-1 dark:border-amber-900"><span>{change.label}</span><span>{change.before || '—'}</span><span>{change.after || '—'}</span></div>)}
          <button type="button" className="fx-btn fx-btn-primary fx-btn-sm" disabled={busy} onClick={() => void save(true)}>Применить новую ревизию</button>
        </>}
      </div>}

      {snapshot?.warnings?.length > 0 && <div className="py-1">
        {snapshot.warnings.map((warning, index) => <div key={index} className="fx-note fx-note-warn flex items-start gap-2"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{warning}</div>)}
      </div>}

      {!!snapshot?.discrepancies?.length && <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950/30" role="status" aria-label="Расхождения XML и каталога">
        <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300"><AlertTriangle className="h-4 w-4 shrink-0" />XML и каталог расходятся в {snapshot.discrepancies.length} параметрах</div>
        {snapshot.discrepancies.map((item, index) => <div key={`${item.group}/${item.key}/${index}`} className="grid grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)] gap-x-3 border-t border-amber-200 pt-1 dark:border-amber-900">
          <span className="text-slate-700 dark:text-slate-300">{item.group ? `${item.group} · ` : ''}{item.key}</span>
          <span><span className="text-slate-500 dark:text-slate-400">XML:</span> {item.xmlValue}{item.xmlUnit ? ` ${item.xmlUnit}` : ''}<br /><span className="text-slate-500 dark:text-slate-400">Каталог{item.sourceRef?.file ? ` (${item.sourceRef.file}${item.sourceRef.pages ? `, стр. ${item.sourceRef.pages}` : ''})` : ''}:</span> {item.catalogValue}{item.catalogUnit ? ` ${item.catalogUnit}` : ''}</span>
        </div>)}
      </div>}

      {snapshot?.effective?.length ? <div className="py-2">
        <div className="fx-label mb-1">Параметры и источник значения</div>
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {snapshot.effective.map((param, index) => {
            const discrepancy = snapshot.discrepancies?.find(item => item.group === (param.group || '') && item.key === param.key);
            const detail = discrepancy ? `Расхождение: XML — ${discrepancy.xmlValue}${discrepancy.xmlUnit ? ` ${discrepancy.xmlUnit}` : ''}; каталог — ${discrepancy.catalogValue}${discrepancy.catalogUnit ? ` ${discrepancy.catalogUnit}` : ''}${discrepancy.sourceRef?.file ? `. Источник каталога: ${discrepancy.sourceRef.file}${discrepancy.sourceRef.pages ? `, стр. ${discrepancy.sourceRef.pages}` : ''}` : ''}` : undefined;
            return <div key={`${param.group || ''}/${param.key}/${index}`} title={detail} aria-label={detail ? `${param.group ? `${param.group} · ` : ''}${param.key}. ${detail}` : undefined} className={`fx-set-row min-h-8 py-1.5 ${discrepancy ? 'rounded-sm border-l-2 border-amber-500 bg-amber-50 px-1.5 dark:border-amber-400 dark:bg-amber-950/30' : ''}`}>
            <span className="fx-set-text min-w-0 truncate" title={[param.group, param.key].filter(Boolean).join(' · ')}>{param.group ? `${param.group} · ` : ''}{param.key}</span>
            <span className="text-xs text-slate-800 dark:text-slate-300 shrink-0">{param.value}{param.unit ? ` ${param.unit}` : ''}</span>
            <span className="fx-badge">{sourceLabel[param.source]}</span>
            {discrepancy && <span className="fx-badge border border-amber-300 text-amber-800 dark:border-amber-700 dark:text-amber-300" title={detail}>Расхождение</span>}
            <button type="button" className="fx-btn fx-btn-quiet fx-btn-sm" onClick={() => { setIssueField({ key: [param.group, param.key].filter(Boolean).join(' · '), value: `${param.value}${param.unit ? ` ${param.unit}` : ''}`, source: param.sourceRef }); setIssueOpen(true); }}>Сообщить</button>
          </div>})}
        </div>
      </div> : null}

      <div className="flex items-center gap-2 pt-2">
        <button type="button" className="fx-btn fx-btn-primary fx-btn-sm" disabled={busy} onClick={() => void save(mode === 'hybrid' || mode === 'catalog')}>
          {busy ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : snapshot?.binding ? <RefreshCw className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
          {mode === 'xml' ? 'Сохранить источник' : snapshot?.binding ? 'Сохранить источник' : 'Привязать модель'}
        </button>
        {snapshot?.binding && <button type="button" className="fx-btn fx-btn-sm" onClick={() => { setIssueField(null); setIssueOpen(true); }}>Сообщить о неточности</button>}
        {conflict && <button type="button" className="fx-btn fx-btn-sm" disabled={busy} onClick={() => void load()}><RefreshCw className="w-3.5 h-3.5" />Обновить данные</button>}
      </div>
      {error && <div className="fx-error mt-2" role="alert">{error}</div>}
    </>}
    {issueOpen && snapshot?.binding && <DataIssueDialog context={issueContext(snapshot.binding, issueField || undefined)} onClose={() => setIssueOpen(false)} />}
  </section>;
}

function diffSpecs(before: Model['specs'], after: Model['specs']) {
  const asText = (spec?: NonNullable<Model['specs']>[number]) => spec ? `${spec.value}${spec.unit ? ` ${spec.unit}` : ''}` : '';
  const previous = new Map((before || []).map(spec => [text(spec.label), spec]));
  const next = new Map((after || []).map(spec => [text(spec.label), spec]));
  return [...new Set([...previous.keys(), ...next.keys()])].map(label => ({ label, before: asText(previous.get(label)), after: asText(next.get(label)) }))
    .filter(change => change.before !== change.after);
}

function issueContext(binding: NonNullable<Snapshot['binding']>, field?: { key?: string; value?: string; source?: { file: string; pages?: string; edition?: string } }): CatalogDataIssueContext {
  const model = binding.snapshot;
  const catalog = model?.catalog as any;
  return {
    program: 'equipment', entityId: binding.modelId, entityTitle: [binding.code, binding.manufacturer].filter(Boolean).join(' · ') || binding.modelId,
    revision: binding.sourceRevision || binding.catalogRevision || binding.revision,
    ...(field?.key ? { field: field.key } : {}), ...(field?.value ? { currentValue: field.value } : {}),
    ...(field?.source?.file ? { source: field.source } : catalog?.file ? { source: { file: catalog.file, pages: catalog.pages, edition: catalog.edition } } : {}),
  };
}

function ModelChoice({ model, selected, onSelect }: { model: Model; selected: boolean; onSelect: () => void }) {
  const title = text(model.title);
  return <button type="button" aria-pressed={selected} onClick={onSelect} className={`fx-li h-auto min-h-8 whitespace-normal ${selected ? 'is-on' : ''}`}>
    <span className="min-w-0 flex-1 text-left">
      <span className="font-mono">{model.code}</span>
      {(model.manufacturer || title) && <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">{[model.manufacturer, title].filter(Boolean).join(' · ')}</span>}
      {!!model.specs?.length && <span className="block text-xs text-slate-400 truncate">{model.specs.slice(0, 4).map((spec) => `${text(spec.label)}: ${spec.value}${spec.unit ? ` ${spec.unit}` : ''}`).join(' · ')}</span>}
    </span>
    {selected && <Check className="w-4 h-4 text-slate-500 shrink-0" />}
  </button>;
}
