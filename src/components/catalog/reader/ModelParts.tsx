/** Общие части страницы модели: строки признаков, исполнения по параметрам, таблицы справочника, список документов. */
import React, { useState } from 'react';
import { FileText } from 'lucide-react';
import type { CatalogDocument, CatalogRef, CatalogTable, FactDef, Facts, Family, ParamDef } from '../../../../catalog/model';
import { textOf } from '../../../../catalog/model';
import { Btn } from '../ui';
import { paramOptions, valueText } from './readerModel';

export type ReportDetails = { currentValue?: string; source?: CatalogRef };
export type Report = (field?: string, details?: ReportDetails) => void;

const muted = 'text-[var(--flux-text-muted)]';

function ReportLink({ onClick }: { onClick: () => void }) {
  return <button type="button" className="ml-2 text-xs text-[var(--flux-text-muted)] hover:text-[var(--flux-text)] hover:underline" onClick={onClick}>Сообщить</button>;
}

export function FactRows({ facts, definitions }: { facts?: Facts; definitions: FactDef[] }) {
  const rows = Object.entries(facts || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!rows.length) return <p className={`text-xs ${muted}`}>Характеристики пока не указаны.</p>;
  return <dl className="cat-def">
    {rows.map(([key, value]) => {
      const def = definitions.find((d) => d.key === key);
      const choice = def?.values?.find((v) => v.code === String(value));
      return <React.Fragment key={key}><dt>{def ? textOf(def.label) : key}</dt>
        <dd>{choice ? textOf(choice.label) : valueText(value)}{def?.unit ? ` ${def.unit}` : ''}</dd></React.Fragment>;
    })}
  </dl>;
}

/** Исполнения: у каждого параметра — допустимые значения отдельными метками, а не строкой через запятую */
export function ParamTable({ family, onReport }: { family: Family; onReport?: Report }) {
  const params: ParamDef[] = family.params || [];
  if (!params.length) return <p className={`text-xs ${muted}`}>Для этой модели исполнения ещё не добавлены.</p>;
  return <div className="overflow-x-auto"><table className="fx-table min-w-[480px]">
    <thead><tr><th>Параметр</th><th>{family.designationMode === 'article' ? 'Значение' : 'Допустимые значения'}</th><th>Единица</th></tr></thead>
    <tbody>{params.map((param) => {
      const options = paramOptions(param);
      return <tr key={param.key} className="align-top">
        <td className="whitespace-nowrap">{textOf(param.label) || param.key}
          {onReport && <ReportLink onClick={() => onReport(param.key, { currentValue: options.join(', ') || undefined, source: family.catalog })} />}</td>
        <td className="!h-auto py-1.5">{options.length
          ? <span className="flex flex-wrap gap-1">{options.map((o) => <span key={o} className="fx-badge">{o}</span>)}</span>
          : <span className={muted}>{param.kind === 'number' && (param.min !== undefined || param.max !== undefined)
            ? `от ${param.min ?? '…'} до ${param.max ?? '…'}${param.unit ? ` ${param.unit}` : ''}` : param.kind === 'number' ? 'Любое число' : 'Не указано'}</span>}</td>
        <td className={muted}>{param.unit || '—'}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}

export function DataTable({ table, onReport }: { table: CatalogTable; onReport?: Report }) {
  const [limit, setLimit] = useState(100);
  return <section className="space-y-2">
    <h3 className="text-[13px] font-semibold">{table.title}</h3>
    {!table.rows.length ? <p className={`text-xs ${muted}`}>Таблица пока не содержит строк.</p> :
      <div className="max-h-[55vh] overflow-auto"><table className="fx-table min-w-[560px]">
        <thead className="sticky top-0"><tr>{table.columns.map((c) => <th key={c.key}>{c.label}{c.unit ? <span className="ml-1 font-normal">{c.unit}</span> : null}</th>)}</tr></thead>
        <tbody>{table.rows.slice(0, limit).map((row) => <tr key={row.id}>
          {table.columns.map((c) => {
            const v = row.values[c.key]; const empty = v === null || v === '' || v === undefined;
            return <td key={c.key} className={`max-w-64 ${empty ? muted : ''}`}>{empty ? '—' : valueText(v)}
              {onReport && <ReportLink onClick={() => onReport(`${table.id}/${row.id}/${c.key}`, { currentValue: valueText(v) || undefined, source: row.source || table.source })} />}</td>;
          })}
        </tr>)}</tbody>
      </table></div>}
    {table.rows.length > limit && <Btn size="sm" onClick={() => setLimit((n) => n + 100)}>Показать ещё строки ({table.rows.length - limit})</Btn>}
  </section>;
}

export function SourceList({ family, onOpen }: { family: Family; onOpen: (doc: CatalogDocument) => void }) {
  const docs = family.documents || [];
  if (!docs.length && family.catalog?.assetId) {
    return <Btn onClick={() => onOpen({ id: family.id, label: 'Описание и инструкции', kind: 'manual', ...family.catalog! })}><FileText />Описание и инструкции</Btn>;
  }
  if (!docs.length) return <p className={`text-xs ${muted}`}>Инструкции пока не добавлены.</p>;
  return <ul className="m-0 list-none p-0">{docs.map((doc) => <li key={doc.id} className="flex items-center gap-2 border-b border-[var(--flux-line)] py-2 text-[13px]">
    <FileText className={`h-4 w-4 shrink-0 ${muted}`} />
    <span className="min-w-0 flex-1 truncate">{doc.label.replace(/: PDF стр\. .*$/, '')}</span>
    {doc.assetId && <Btn size="sm" onClick={() => onOpen(doc)}>Открыть</Btn>}
  </li>)}</ul>;
}

export function Block({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return <section className="space-y-2">
    <div className="flex items-center gap-2"><h3 className="text-[13px] font-semibold">{title}</h3>{right}</div>
    {children}
  </section>;
}
