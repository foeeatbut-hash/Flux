/** Страница модели: хлебные крошки, заголовок с главными характеристиками и вкладки. Открывается вместо списка, «Назад» возвращает список как был. */
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, Flag, Scale } from 'lucide-react';
import type { Catalog, CatalogDocument } from '../../../../catalog/model';
import { textOf } from '../../../../catalog/model';
import { catalogService, type CatalogUsage } from '../../../services/catalogService';
import { Btn, StatusChip } from '../ui';
import { Tabs } from '../../ui';
import ModelMarking from './ModelMarking';
import { Documents, Overview, Specs, Usage, Variants } from './ModelTabs';
import { documentCount, keyFacts, type Entry } from './readerModel';
import type { Report } from './ModelParts';

type Tab = 'overview' | 'specs' | 'variants' | 'marking' | 'documents' | 'usage';

export default function ModelPage({ entry, catalog, entries, compared, compareFull, onBack, onOpenEntry, onCompare, onReport, onOpenDocument }: {
  entry: Entry; catalog: Catalog; entries: Entry[]; compared: boolean; compareFull: boolean;
  onBack: () => void; onOpenEntry: (e: Entry) => void; onCompare: (e: Entry) => void; onReport?: Report; onOpenDocument: (d: CatalogDocument) => void;
}) {
  const [tab, setTab] = useState<Tab>('overview');
  const [usage, setUsage] = useState<CatalogUsage | null | 'error'>(null);
  const f = entry.family; const cls = catalog.classes.find((c) => c.id === f.classId);
  useEffect(() => { setTab('overview'); }, [f.id]);
  // Компонент не имеет учёта в ведомостях, поэтому запрос только для моделей
  useEffect(() => {
    setUsage(null);
    if (entry.isComponent) return;
    let stop = false;
    catalogService.usage(f.id).then((u) => { if (!stop) setUsage(Array.isArray(u?.usage) && u.total ? u : 'error'); }).catch(() => { if (!stop) setUsage('error'); });
    return () => { stop = true; };
  }, [f.id, entry.isComponent]);

  // «Семейство»: те же тип, подтип и изготовитель; у комплектующего — модели, к которым оно подходит
  const siblings = useMemo(() => entry.component
    ? entries.filter((e) => !e.isComponent && entry.component!.familyIds?.includes(e.family.id)).slice(0, 24)
    : entries.filter((e) => !e.isComponent && e.family.id !== f.id && e.family.classId === f.classId && e.family.kind === f.kind && e.makerKey === entry.makerKey).slice(0, 24),
  [entries, entry, f]);
  const facts = keyFacts(entry, catalog, 6);
  const used = usage && usage !== 'error' ? usage.total.projects : undefined;
  const docs = documentCount(f);
  const ctx = { entry, catalog, onReport, onOpenEntry, siblings };
  const crumbs = [textOf(cls?.title), entry.maker, f.code].filter(Boolean);

  return <div className="cat-page flex h-full min-h-0 flex-col">
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--flux-line)] px-4 py-1.5">
      <Btn tone="ghost" aria-label="Назад к списку" onClick={onBack}><ArrowLeft />Каталог</Btn>
      <nav aria-label="Путь" className="min-w-0 flex-1 truncate text-xs text-[var(--flux-text-muted)]">{crumbs.join(' › ')}</nav>
      <Btn aria-pressed={compared} disabled={!compared && compareFull} onClick={() => onCompare(entry)}>{compared ? <Check /> : <Scale />}{compared ? 'В сравнении' : 'Сравнить'}</Btn>
      {onReport && <Btn onClick={() => onReport()}><Flag />Сообщить о неточности</Btn>}
    </div>
    <header className="shrink-0 px-4 pb-0 pt-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="m-0 break-all font-mono text-[18px] font-semibold leading-6">{f.code}</h1><StatusChip status={f.status} />
      </div>
      <p className="m-0 mt-1 text-[13px]">{textOf(f.title) || textOf(f.description) || 'Описание не указано.'}</p>
      <p className="m-0 mt-1 text-xs text-[var(--flux-text-muted)]">{[entry.maker, textOf(cls?.title), entry.kindLabel].filter(Boolean).join(' · ')}</p>
      {facts.length > 0 && <dl className="m-0 mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-y border-[var(--flux-line)] py-3 @[640px]:grid-cols-3 @[1000px]:grid-cols-6">
        {facts.map((x) => <div key={x.label} className="min-w-0"><dt className="truncate text-xs text-[var(--flux-text-muted)]">{x.label}</dt><dd className="m-0 truncate text-[13px] font-medium" title={x.value}>{x.value}</dd></div>)}
      </dl>}
      <div className="mt-2 flex h-[42px] items-start overflow-x-auto [&_.fx-tabs]:h-10 [&_.fx-tabs]:self-start">
        <Tabs<Tab> label="Разделы страницы модели" value={tab} onChange={setTab} tabs={[
          { value: 'overview', label: 'Обзор' }, { value: 'specs', label: 'Характеристики' },
          { value: 'variants', label: entry.isComponent ? 'Совместимость' : 'Исполнения', count: entry.isComponent ? siblings.length || undefined : f.params.length || undefined },
          { value: 'marking', label: 'Маркировка' }, { value: 'documents', label: 'Документы', count: docs || undefined },
          { value: 'usage', label: 'В проектах', count: used || undefined },
        ]} />
      </div>
    </header>
    <div key={`${f.id}-${tab}`} className="cat-in min-h-0 flex-1 overflow-auto border-t border-[var(--flux-line)] p-4" role="tabpanel">
      {tab === 'overview' && <Overview {...ctx} usage={usage} />}
      {tab === 'specs' && <Specs {...ctx} />}
      {tab === 'variants' && <Variants {...ctx} />}
      {tab === 'marking' && <ModelMarking family={f} onReport={onReport} />}
      {tab === 'documents' && <Documents {...ctx} onOpenDocument={onOpenDocument} />}
      {tab === 'usage' && <Usage entry={entry} usage={usage} />}
    </div>
  </div>;
}
