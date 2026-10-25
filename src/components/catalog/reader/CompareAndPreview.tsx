/** Сравнение моделей (до четырёх) и просмотр документа каталога в окне. */
import React from 'react';
import { X } from 'lucide-react';
import type { Catalog } from '../../../../catalog/model';
import { textOf } from '../../../../catalog/model';
import { Btn, Dialog } from '../../ui';
import { documentCount, paramOptions, valueText, type Entry } from './readerModel';

export function ComparePanel({ entries, catalog, onRemove, onClear, onOpen }: {
  entries: Entry[]; catalog: Catalog; onRemove: (id: string) => void; onClear: () => void; onOpen: (e: Entry) => void;
}) {
  const keys = [...new Set(entries.flatMap((e) => e.family.params.map((p) => p.key)))];
  // Признаки модели сравниваются так же, как параметры: у части записей параметров нет, а признаки заполнены
  const defs = catalog.classes.flatMap((c) => c.facts);
  const factKeys = [...new Set(entries.flatMap((e) => Object.keys(e.family.facts || {})))].filter((k) => k !== 'kind' && entries.some((e) => e.family.facts?.[k] !== undefined && e.family.facts?.[k] !== ''));
  const factOf = (e: Entry, key: string) => { const raw = e.family.facts?.[key]; if (raw === undefined || raw === '') return ''; const d = defs.find((x) => x.key === key); const c = d?.values?.find((v) => v.code === String(raw)); return c ? textOf(c.label) : `${valueText(raw)}${d?.unit ? ` ${d.unit}` : ''}`; };
  const statusWord = (e: Entry) => ({ full: 'сверено', partial: 'сверить', draft: 'черновик' }[e.family.status]);
  const general: Array<[string, (e: Entry) => string]> = [['Изготовитель', (e) => e.maker], ['Подтип', (e) => e.kindLabel], ['Данные', statusWord], ['Документов', (e) => String(documentCount(e.family))]];
  const optionsOf = (e: Entry, key: string) => paramOptions(e.family.params.find((p) => p.key === key)).join(', ');
  const labelOf = (key: string) => textOf(entries.map((e) => e.family.params.find((p) => p.key === key)?.label).find(Boolean)) || key;
  return <section aria-label="Сравнение моделей" className="cat-in flex max-h-[45%] min-h-0 shrink-0 flex-col border-t border-[var(--flux-line)] bg-[var(--flux-bg)]">
    <div className="flex h-10 shrink-0 items-center gap-2 px-4">
      <h3 className="m-0 text-[13px] font-semibold">Сравнение · {entries.length}</h3>
      <Btn size="sm" tone="ghost" className="ml-auto" onClick={onClear}>Очистить</Btn>
    </div>
    <div className="min-h-0 overflow-auto px-4 pb-3">
      <table className="fx-table min-w-[620px]">
        <thead><tr><th className="w-44">Параметр</th>{entries.map((e) => <th key={e.family.id} className="min-w-44">
          <span className="flex items-center gap-1"><button type="button" className="min-w-0 truncate font-mono text-[var(--flux-text)] hover:underline" onClick={() => onOpen(e)}>{e.family.code}</button>
            <button type="button" aria-label={`Убрать ${e.family.code} из сравнения`} className="fx-ibtn ml-auto" onClick={() => onRemove(e.family.id)}><X /></button></span>
          <span className="block truncate font-normal">{e.maker}</span></th>)}</tr></thead>
        <tbody>
          {general.map(([label, get]) => <tr key={label}><td className="text-[var(--flux-text-muted)]">{label}</td>{entries.map((e) => <td key={e.family.id}>{get(e) || '—'}</td>)}</tr>)}
          {factKeys.map((key) => <tr key={`f-${key}`}><td className="text-[var(--flux-text-muted)]">{textOf(defs.find((d) => d.key === key)?.label) || key}</td>
            {entries.map((e) => { const v = factOf(e, key); return <td key={e.family.id} className={v ? '' : 'text-[var(--flux-text-faint)]'}>{v || '—'}</td>; })}</tr>)}
          {keys.map((key) => <tr key={key}><td className="text-[var(--flux-text-muted)]">{labelOf(key)}</td>
            {entries.map((e) => { const v = optionsOf(e, key); return <td key={e.family.id} className={v ? '' : 'text-[var(--flux-text-faint)]'}>{v || '—'}</td>; })}</tr>)}
        </tbody>
      </table>
      {entries.length < 2 && <p className="mt-2 text-xs text-[var(--flux-text-muted)]">Добавьте ещё одну запись, чтобы сравнить параметры.</p>}
    </div>
  </section>;
}

export interface Preview { url: string; name: string; page?: number; busy?: boolean; error?: string }

export function DocumentDialog({ preview, onClose }: { preview: Preview; onClose: () => void }) {
  return <Dialog title={preview.name} label={preview.name} onClose={onClose} width="max-w-5xl">
    {preview.busy ? <p role="status" className="text-xs">Открываем документ…</p>
      : preview.error ? <p role="alert" className="text-xs text-[var(--flux-bad-text)]">{preview.error}</p>
      : preview.url && <iframe title={preview.name} src={`${preview.url}${preview.page ? `#page=${preview.page}` : ''}`} className="h-[70vh] w-full rounded-md border border-[var(--flux-line)] bg-white" />}
  </Dialog>;
}
