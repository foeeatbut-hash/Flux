import React from 'react';
import { X, Plus, ArrowUp } from 'lucide-react';
import { IconBtn, Btn } from '../ui';

/**
 * Список строк настроек: статусы, причины выпуска, коды рассмотрения, типы
 * документов. Один редактор на все списки — колонки описываются данными, а
 * не повторяются разметкой в каждом разделе.
 */
export interface RowColumn<T> {
  key: keyof T & string; title: string; width?: string; mono?: boolean;
  kind?: 'text' | 'number' | 'select' | 'check';
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
}

export default function RowsEditor<T extends Record<string, any>>({ rows, columns, onChange, blank, disabled, addLabel, label }: {
  rows: T[]; columns: RowColumn<T>[]; onChange: (rows: T[]) => void; blank: T; disabled?: boolean; addLabel: string; label: string;
}) {
  const set = (i: number, key: string, value: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  const up = (i: number) => { if (i < 1) return; const next = rows.slice(); [next[i - 1], next[i]] = [next[i], next[i - 1]]; onChange(next); };
  return (
    <div className="flex flex-col gap-1.5">
      <table className="fx-table" aria-label={label}>
        <thead><tr>{columns.map((c) => <th key={c.key} style={c.width ? { width: c.width } : undefined}>{c.title}</th>)}<th style={{ width: 56 }} /></tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key}>
                  {c.kind === 'select'
                    ? <select className="fx-input cursor-pointer w-full" value={String(row[c.key] ?? '')} disabled={disabled} aria-label={c.title} onChange={(e) => set(i, c.key, e.target.value)}>
                        {(c.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    : c.kind === 'check'
                      ? <input type="checkbox" checked={!!row[c.key]} disabled={disabled} aria-label={c.title} onChange={(e) => set(i, c.key, e.target.checked)} />
                      : <input className={`fx-input w-full ${c.mono ? 'font-mono' : ''}`} value={String(row[c.key] ?? '')} disabled={disabled} aria-label={c.title}
                          type={c.kind === 'number' ? 'number' : 'text'} placeholder={c.placeholder}
                          onChange={(e) => set(i, c.key, c.kind === 'number' ? Number(e.target.value) || 0 : e.target.value)} />}
                </td>
              ))}
              <td className="whitespace-nowrap">
                <span className="fx-row-acts">
                  <IconBtn label="Выше" disabled={disabled || i === 0} onClick={() => up(i)}><ArrowUp className="w-3.5 h-3.5" /></IconBtn>
                  <IconBtn label="Убрать строку" disabled={disabled} onClick={() => onChange(rows.filter((_, j) => j !== i))}><X className="w-3.5 h-3.5" /></IconBtn>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!disabled && <div><Btn tone="ghost" size="sm" onClick={() => onChange([...rows, { ...blank }])}><Plus className="w-3.5 h-3.5" /> {addLabel}</Btn></div>}
    </div>
  );
}
