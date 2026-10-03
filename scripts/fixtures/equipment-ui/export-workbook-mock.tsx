import React, { forwardRef, useImperativeHandle } from 'react';
import type { ExportGrid } from '../../../src/lib/exportGrid';

interface Props { grid: ExportGrid; name: string }

const ExportWorkbook = forwardRef(function ExportWorkbook({ grid, name }: Props, ref: React.ForwardedRef<any>) {
  useImperativeHandle(ref, () => ({ save: async () => true, output: async () => {}, template: async () => undefined, applyTemplate: async () => {}, hasBook: () => true }));
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Пробный лист книги">
    <div className="fx-bar flex h-9 shrink-0 items-center gap-2 px-3 text-xs text-slate-600 dark:text-slate-300"><span className="truncate">{name}.xlsx</span><span className="ml-auto">Рабочая книга</span></div>
    <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-slate-50 dark:bg-slate-900 p-3">
      <table className="fx-table w-max min-w-full bg-white dark:bg-slate-950"><thead><tr>{grid.headers.map((heading, index) => <th key={index}>{heading}</th>)}</tr></thead><tbody>{grid.rows.map((row, index) => <tr key={grid.rowKeys[index]}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table>
    </div>
  </div>;
});

export default ExportWorkbook;
