/** Список читателя: карточки моделей галереей или таблица. Карточка — кнопка, открывающая страницу модели. */
import React from 'react';
import { Check, FileText, Scale } from 'lucide-react';
import type { Catalog } from '../../../../catalog/model';
import { textOf } from '../../../../catalog/model';
import { StatusChip } from '../ui';
import { documentCount, keyFacts, type Entry } from './readerModel';

const nameOf = (catalog: Catalog, e: Entry) => textOf(catalog.classes.find((c) => c.id === e.family.classId)?.title);

function CompareToggle({ entry, picked, blocked, onToggle }: { entry: Entry; picked: boolean; blocked: boolean; onToggle: (e: Entry) => void }) {
  const label = picked ? 'Убрать из сравнения' : 'Добавить к сравнению';
  return <button type="button" aria-label={label} title={blocked ? 'В сравнении может быть не больше четырёх' : label} aria-pressed={picked} disabled={!picked && blocked}
    onClick={(ev) => { ev.stopPropagation(); onToggle(entry); }} className={`fx-ibtn ${picked ? 'text-[var(--flux-accent-text)]' : ''}`}>
    {picked ? <Check /> : <Scale />}
  </button>;
}

export function ModelCard({ entry, catalog, index, picked, blocked, onOpen, onCompare }: {
  entry: Entry; catalog: Catalog; index: number; picked: boolean; blocked: boolean; onOpen: (e: Entry) => void; onCompare: (e: Entry) => void;
}) {
  const f = entry.family; const facts = keyFacts(entry, catalog, 3); const docs = documentCount(f);
  // Карточка — не кнопка целиком: внутри неё своя кнопка сравнения, а вложенные кнопки в разметке запрещены
  return <div className="cat-in relative" style={{ '--i': index } as React.CSSProperties}>
    <div role="button" tabIndex={0} className="cat-card h-full" data-picked={picked} aria-label={`Открыть ${f.code}`}
      onClick={() => onOpen(entry)} onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onOpen(entry); } }}>
      <div className="flex items-start gap-2 pr-6">
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold">{f.code}</span>
        <StatusChip status={f.status} />
      </div>
      {/* У многих записей название повторяет код — тогда подпись берём из вида изделия */}
      <div className="line-clamp-2 min-h-10 text-[13px]">{(textOf(f.title) !== f.code && textOf(f.title)) || textOf(f.typeLabel) || textOf(f.title) || 'Описание не указано'}</div>
      <div className="truncate text-xs text-[var(--flux-text-muted)]">{[entry.maker, nameOf(catalog, entry), entry.kindLabel].filter(Boolean).join(' · ')}</div>
      {facts.length > 0 ? <dl className="cat-facts">{facts.map((x) => <React.Fragment key={x.label}><dt>{x.label}</dt><dd title={x.value}>{x.value}</dd></React.Fragment>)}</dl>
        : <p className="m-0 text-xs text-[var(--flux-text-muted)]">{docs > 0 ? 'Характеристики — в документах' : 'Характеристики не заполнены'}</p>}
      <div className="mt-auto flex items-center gap-3 pt-1 text-xs text-[var(--flux-text-muted)]">
        {entry.isComponent && <span>Комплектующее</span>}
        {f.params.length > 0 && !entry.isComponent && <span className="tabular-nums">{f.params.length} параметров</span>}
        {docs > 0 && <span className="inline-flex items-center gap-1"><FileText className="h-3.5 w-3.5" />{docs}</span>}
      </div>
    </div>
    <div className="absolute right-2 top-2"><CompareToggle entry={entry} picked={picked} blocked={blocked} onToggle={onCompare} /></div>
  </div>;
}

export function ModelTable({ entries, catalog, picked, blocked, onOpen, onCompare }: {
  entries: Entry[]; catalog: Catalog; picked: string[]; blocked: boolean; onOpen: (e: Entry) => void; onCompare: (e: Entry) => void;
}) {
  return <table className="fx-table cat-in">
    <thead><tr><th>Код</th><th>Название</th><th className="hidden @[760px]:table-cell">Изготовитель</th><th className="hidden @[960px]:table-cell">Тип</th><th>Данные</th><th aria-label="Сравнение" className="w-10" /></tr></thead>
    <tbody>{entries.map((e) => <tr key={e.family.id} className="cursor-pointer" tabIndex={0} aria-selected={picked.includes(e.family.id)}
      onClick={() => onOpen(e)} onKeyDown={(ev) => { if (ev.key === 'Enter') onOpen(e); }}>
      <td className="font-mono">{e.family.code}</td>
      <td className="max-w-0 truncate">{textOf(e.family.title) || '—'}</td>
      <td className="hidden @[760px]:table-cell">{e.maker || '—'}</td>
      <td className="hidden @[960px]:table-cell text-[var(--flux-text-muted)]">{[nameOf(catalog, e), e.kindLabel].filter(Boolean).join(' · ')}</td>
      <td><StatusChip status={e.family.status} /></td>
      <td><div className="fx-row-acts"><CompareToggle entry={e} picked={picked.includes(e.family.id)} blocked={blocked} onToggle={onCompare} /></div></td>
    </tr>)}</tbody>
  </table>;
}
