import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';

type Mode = 'hybrid' | 'xml' | 'catalog';
type Source = 'xml' | 'catalog' | 'manual';
interface Model {
  id: string;
  code: string;
  manufacturer?: string;
  manufacturerSearch?: string;
  title?: { ru?: string } | string;
  specs?: Array<{ label?: { ru?: string } | string; value: string; unit?: string }>;
  catalog?: unknown;
}
interface Snapshot {
  mode: Mode;
  binding?: { modelId: string; code: string; manufacturer?: string; revision?: string; at?: string };
  matches: Model[];
  effective: Array<{ group?: string; key: string; value: string; unit?: string; source: Source }>;
  warnings: string[];
}
interface CatalogIndex {
  components?: Model[];
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
  const [query, setQuery] = useState('');
  const [allModels, setAllModels] = useState<Model[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);

  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const data = await readJson<Snapshot>(await fetch(`/api/equipment/component/${encodeURIComponent(componentId)}/catalog-source`, { signal }));
      setSnapshot(data);
      setMode(data.mode);
      setSelectedId((current) => current || data.binding?.modelId || '');
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
        setAllModels((body.components || []).map((model: any) => ({
          ...model,
          manufacturer: model.manufacturer || manufacturers.get(model.manufacturerId)?.name || '',
          manufacturerSearch: manufacturers.get(model.manufacturerId)?.search || model.manufacturer || '',
        })));
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
    for (const item of [...(snapshot?.matches || []), ...searchResults]) byId.set(item.id, item);
    return [...byId.values()];
  }, [snapshot?.matches, searchResults]);
  const chosen = candidates.find((item) => item.id === selectedId);

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
          ...(selectedId || snapshot?.binding?.modelId ? { modelId: selectedId || snapshot?.binding?.modelId } : {}),
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
          {snapshot.matches.map((model) => <ModelChoice key={model.id} model={model} selected={selectedId === model.id} onSelect={() => setSelectedId(model.id)} />)}
        </div> : <div className="fx-note">Автоматических совпадений нет. Найдите модель и выберите её вручную.</div>}
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input className="fx-input min-w-0 flex-1" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Искать по коду или производителю" aria-label="Поиск модели каталога" />
          {query && <button type="button" onClick={() => setQuery('')} className="fx-btn fx-btn-quiet fx-btn-sm" aria-label="Очистить поиск"><X className="w-3.5 h-3.5" /></button>}
        </div>
        {query.trim().length >= 2 && <div className="space-y-1" role="group" aria-label="Результаты поиска каталога">
          {searchResults.map((model) => <ModelChoice key={model.id} model={model} selected={selectedId === model.id} onSelect={() => setSelectedId(model.id)} />)}
          {searchLoading && <div className="fx-note flex items-center gap-2"><LoaderCircle className="w-3.5 h-3.5 animate-spin" />Поиск в каталоге…</div>}
          {catalogLoaded && !searchResults.length && !error && <div className="fx-note">Модели не найдены.</div>}
        </div>}
        {chosen && <div className="fx-note">Выбрано: <span className="font-mono">{chosen.code}</span>{chosen.manufacturer ? ` · ${chosen.manufacturer}` : ''}</div>}
      </div>}

      {snapshot?.binding && <div className="fx-note border-y border-slate-200 dark:border-slate-800">
        Источник: {mode === 'xml' ? 'XML' : 'каталог'}{snapshot.binding.code && <> · <span className="font-mono">{snapshot.binding.code}</span></>}{snapshot.binding.manufacturer ? ` · ${snapshot.binding.manufacturer}` : ''}
        {snapshot.binding.at && <> · снимок от {new Date(snapshot.binding.at).toLocaleString('ru-RU')}</>}
      </div>}

      {snapshot?.warnings?.length > 0 && <div className="py-1">
        {snapshot.warnings.map((warning, index) => <div key={index} className="fx-note fx-note-warn flex items-start gap-2"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{warning}</div>)}
      </div>}

      {snapshot?.effective?.length ? <div className="py-2">
        <div className="fx-label mb-1">Параметры и источник значения</div>
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {snapshot.effective.map((param, index) => <div key={`${param.group || ''}/${param.key}/${index}`} className="fx-set-row min-h-8 py-1.5">
            <span className="fx-set-text min-w-0 truncate" title={[param.group, param.key].filter(Boolean).join(' · ')}>{param.group ? `${param.group} · ` : ''}{param.key}</span>
            <span className="text-xs text-slate-800 dark:text-slate-300 shrink-0">{param.value}{param.unit ? ` ${param.unit}` : ''}</span>
            <span className="fx-badge">{sourceLabel[param.source]}</span>
          </div>)}
        </div>
      </div> : null}

      <div className="flex items-center gap-2 pt-2">
        <button type="button" className="fx-btn fx-btn-primary fx-btn-sm" disabled={busy} onClick={() => void save(mode === 'hybrid' || mode === 'catalog')}>
          {busy ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : snapshot?.binding ? <RefreshCw className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
          {mode === 'xml' ? 'Сохранить источник' : snapshot?.binding ? 'Привязать / обновить снимок' : 'Привязать модель'}
        </button>
        {conflict && <button type="button" className="fx-btn fx-btn-sm" disabled={busy} onClick={() => void load()}><RefreshCw className="w-3.5 h-3.5" />Обновить данные</button>}
      </div>
      {error && <div className="fx-error mt-2" role="alert">{error}</div>}
    </>}
  </section>;
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
