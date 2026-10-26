/**
 * Каталог для чтения: навигация по типам и изготовителям, поиск, галерея
 * карточек, страница модели. Раскладка и причины — docs/methodology/03-programs/catalog.md.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpDown, LayoutGrid, List, Search, SlidersHorizontal, X } from 'lucide-react';
import type { Catalog, CatalogDocument, Family } from '../../../catalog/model';
import { textOf } from '../../../catalog/model';
import { sourcePhysicalPage } from '../../../catalog/sources';
import { loadCatalogAsset } from '../../services/catalogAssetService';
import { plural } from '../../lib/plural';
import { Btn, Empty, Select } from './ui';
import { FilterSeg, Seg, SectionHead, Toolbar } from '../ui';
import CatalogNav from './reader/CatalogNav';
import { ModelCard, ModelTable } from './reader/CatalogGrid';
import ModelPage from './reader/ModelPage';
import { ComparePanel, DocumentDialog, type Preview } from './reader/CompareAndPreview';
import type { Report, ReportDetails } from './reader/ModelParts';
import { buildEntries, EMPTY_FILTERS, matches, navCounts, sortEntries, type Entry, type Filters, type Scope, type SortKey } from './reader/readerModel';

const PAGE = 60;
const MAX_COMPARE = 4;

export default function CatalogReader({ catalog, onManage, onReport }: {
  catalog: Catalog; onManage?: () => void; onReport?: (family: Family, field?: string, details?: ReportDetails) => void;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SortKey>('code');
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const [openId, setOpenId] = useState('');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [navOpen, setNavOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const request = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => buildEntries(catalog), [catalog]);
  const shown = useMemo(() => sortEntries(entries.filter((e) => matches(e, filters)), sort), [entries, filters, sort]);
  const counts = useMemo(() => navCounts(entries, filters), [entries, filters]);
  const opened = entries.find((e) => e.family.id === openId);
  const compared = compareIds.map((id) => entries.find((e) => e.family.id === id)).filter((e): e is Entry => !!e);
  const change = (patch: Partial<Filters>) => { setFilters((f) => ({ ...f, ...patch })); setLimit(PAGE); listRef.current?.scrollTo({ top: 0 }); };

  useEffect(() => () => { request.current++; }, []);
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview?.url]);
  // Запись могли убрать из каталога, пока страница была открыта
  useEffect(() => { if (openId && !opened) setOpenId(''); }, [openId, opened]);

  const toggleCompare = (e: Entry) => setCompareIds((ids) => ids.includes(e.family.id) ? ids.filter((id) => id !== e.family.id) : ids.length < MAX_COMPARE ? [...ids, e.family.id] : ids);
  const openDocument = async (doc: CatalogDocument) => {
    if (!doc.assetId) return;
    const mine = ++request.current;
    setPreview({ url: '', name: doc.label, busy: true });
    try {
      const url = await loadCatalogAsset(doc.assetId);
      if (request.current !== mine) { URL.revokeObjectURL(url); return; }
      setPreview({ url, name: doc.label, page: sourcePhysicalPage(doc) });
    } catch (error) { if (request.current === mine) setPreview({ url: '', name: doc.label, error: error instanceof Error ? error.message : 'Не удалось открыть документ' }); }
  };
  const closeDocument = () => { request.current++; setPreview(null); };
  const reportFor = (entry: Entry): Report | undefined => onReport
    ? (field, details) => onReport(entry.component ? { ...entry.family, id: entry.component.id } : entry.family, field, details) : undefined;

  const modelsTotal = entries.filter((e) => !e.isComponent).length;
  const partsTotal = entries.length - modelsTotal;
  const active = [
    filters.classId && { key: 'classId', label: textOf(catalog.classes.find((c) => c.id === filters.classId)?.title), clear: { classId: '', kindId: '' } },
    filters.kindId && { key: 'kindId', label: entries.find((e) => e.family.kind === filters.kindId && e.classIds.includes(filters.classId))?.kindLabel || filters.kindId, clear: { kindId: '' } },
    filters.makerKey && { key: 'makerKey', label: counts.makers.get(filters.makerKey)?.title || entries.find((e) => e.makerKey === filters.makerKey)?.maker || '', clear: { makerKey: '' } },
  ].filter(Boolean) as Array<{ key: string; label: string; clear: Partial<Filters> }>;
  const dirty = active.length > 0 || !!filters.query;

  return <div className="@container relative flex h-full min-h-0 min-w-0 flex-col bg-[var(--flux-surface)] text-[var(--flux-text)]">
    {opened && <ModelPage key="page" entry={opened} catalog={catalog} entries={entries} compared={compareIds.includes(opened.family.id)} compareFull={compareIds.length >= MAX_COMPARE}
      onBack={() => setOpenId('')} onOpenEntry={(e) => setOpenId(e.family.id)} onCompare={toggleCompare} onReport={reportFor(opened)} onOpenDocument={(d) => void openDocument(d)} />}
    {/* Список остаётся смонтированным под страницей модели: «Назад» возвращает ту же прокрутку и фильтры */}
    <div className={opened ? 'hidden' : 'flex h-full min-h-0 flex-col'}>
      <SectionHead title="Каталог" count={`${modelsTotal} ${plural(modelsTotal, 'модель', 'модели', 'моделей')} · ${partsTotal} ${plural(partsTotal, 'комплектующее', 'комплектующих', 'комплектующих')}`}
        actions={onManage && <Btn onClick={onManage}>Панель разработчика</Btn>} />
      <Toolbar>
        <label className="fx-input flex min-w-[180px] max-w-[360px] flex-1 items-center gap-2 !px-2">
          <Search className="h-4 w-4 shrink-0 text-[var(--flux-text-muted)]" />
          <input aria-label="Поиск моделей" value={filters.query} onChange={(e) => change({ query: e.target.value })} placeholder="Код, модель, назначение…" className="min-w-0 flex-1 bg-transparent outline-none" />
          {filters.query && <button type="button" aria-label="Очистить поиск" className="fx-ibtn" onClick={() => change({ query: '' })}><X /></button>}
        </label>
        <FilterSeg<Scope> label="Что показывать" value={filters.scope} onChange={(scope) => change({ scope })} options={[
          { value: 'models', label: 'Модели', count: counts.scope.models }, { value: 'components', label: 'Комплектующие', count: counts.scope.components }, { value: 'all', label: 'Всё', count: counts.scope.all }]} />
        <Btn className="@[880px]:hidden" aria-expanded={navOpen} onClick={() => setNavOpen((v) => !v)}><SlidersHorizontal />Фильтры{active.length ? ` · ${active.length}` : ''}</Btn>
        <span className="flex-1" />
        <label className="flex items-center gap-1 text-xs text-[var(--flux-text-muted)]"><ArrowUpDown className="h-4 w-4" /><Select aria-label="Порядок" value={sort} onChange={(v) => setSort(v as SortKey)} className="w-auto"
          options={[{ value: 'code', label: 'По коду' }, { value: 'maker', label: 'По изготовителю' }, { value: 'data', label: 'По полноте данных' }]} /></label>
        <Seg<'cards' | 'table'> label="Вид списка" value={view} onChange={setView} options={[{ value: 'cards', label: 'Карточки', hint: 'Карточки' }, { value: 'table', label: 'Список', hint: 'Таблица' }]} />
      </Toolbar>
      {dirty && <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--flux-line)] px-4 py-1.5 text-xs text-[var(--flux-text-muted)]">
        <span>Найдено {shown.length}</span>
        {active.map((a) => <button key={a.key} type="button" className="cat-chip" aria-label={`Сбросить: ${a.label}`} onClick={() => change(a.clear)}>{a.label}<X /></button>)}
        <Btn size="sm" tone="ghost" onClick={() => change({ ...EMPTY_FILTERS, scope: filters.scope })}>Сбросить всё</Btn>
      </div>}
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] @[880px]:grid-cols-[248px_minmax(0,1fr)] @[880px]:grid-rows-1">
        <aside aria-label="Фильтры" className="fx-side min-h-0 border-b border-r-0 @[880px]:border-b-0 @[880px]:border-r">
          <div className="cat-collapse cat-side" data-open={navOpen}>
            <div className="max-h-[46vh] overflow-auto @[880px]:h-full @[880px]:max-h-none">
              <CatalogNav catalog={catalog} filters={filters} counts={counts} total={counts.scope[filters.scope]} onChange={change} />
            </div>
          </div>
        </aside>
        <main ref={listRef} className="min-h-0 min-w-0 overflow-auto">
          {shown.length === 0 ? <div className="p-4"><Empty title="Модели не найдены. Измените поиск или фильтры." text="Поиск идёт по коду, названию, назначению, изготовителю и содержанию справочника.">
            {dirty && <Btn onClick={() => change({ ...EMPTY_FILTERS, scope: filters.scope })}>Сбросить фильтры</Btn>}</Empty></div>
            : view === 'cards' ? <div className="cat-grid p-4">{shown.slice(0, limit).map((e, i) => <ModelCard key={e.family.id} entry={e} catalog={catalog} index={i} picked={compareIds.includes(e.family.id)}
              blocked={compareIds.length >= MAX_COMPARE} onOpen={(x) => setOpenId(x.family.id)} onCompare={toggleCompare} />)}</div>
            : <ModelTable entries={shown.slice(0, limit)} catalog={catalog} picked={compareIds} blocked={compareIds.length >= MAX_COMPARE} onOpen={(x) => setOpenId(x.family.id)} onCompare={toggleCompare} />}
          {shown.length > limit && <div className="flex justify-center p-4 pt-0"><Btn onClick={() => setLimit((n) => n + PAGE)}>Показать ещё ({shown.length - limit})</Btn></div>}
        </main>
      </div>
      {compared.length > 0 && <ComparePanel entries={compared} catalog={catalog} onRemove={(id) => setCompareIds((ids) => ids.filter((x) => x !== id))} onClear={() => setCompareIds([])} onOpen={(e) => setOpenId(e.family.id)} />}
    </div>
    {preview && <DocumentDialog preview={preview} onClose={closeDocument} />}
  </div>;
}
