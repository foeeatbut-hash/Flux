/**
 * Предпросмотр бланка: листы вкладками, страница в пропорциях A4/A3.
 *
 * Рисуется из той же сетки, из которой пишутся xlsx и PDF, поэтому
 * предпросмотр — не «примерно так», а ровно то, что уйдёт заводу. Щелчок по
 * ячейке открывает в конструкторе блок, из которого она пришла.
 */
import React, { useMemo, useState } from 'react';
import type { SheetGrid } from '../../../catalog/blank/model';
import { sheetHtml, PREVIEW_CSS } from '../../lib/blankHtml';

export default function BlankPreview({ sheets, selectedBlock, onPickBlock }: {
  sheets: SheetGrid[]; selectedBlock?: string; onPickBlock?: (blockId: string) => void;
}) {
  const [tab, setTab] = useState(0);
  const cur = sheets[Math.min(tab, sheets.length - 1)];
  const html = useMemo(() => (cur ? sheetHtml(cur, { selectedBlock, interactive: !!onPickBlock }) : ''), [cur, selectedBlock, onPickBlock]);
  if (!cur) return <div className="text-xs text-slate-400 p-4">Нет листов: в ведомости нет позиций или шаблон пуст.</div>;
  const ratio = cur.page.orientation === 'landscape' ? 297 / 210 : 210 / 297;
  return (
    <div className="flex flex-col min-h-0 h-full gap-2">
      <div className="flex gap-1 overflow-x-auto pb-1">
        {sheets.map((s, i) => (
          <button key={s.name + i} type="button" onClick={() => setTab(i)} aria-pressed={i === tab}
            className={`px-2 py-1 rounded-md text-2xs font-semibold whitespace-nowrap cursor-pointer border ${i === tab ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-emerald-400'}`}>
            {s.name}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto rounded-lg bg-slate-100 dark:bg-slate-950 p-3">
        <style>{PREVIEW_CSS}</style>
        {/* Бумага остаётся белой и в тёмной теме: это лист, который уйдёт на печать */}
        <div className="mx-auto bg-white text-black shadow-sm" style={{ width: '100%', maxWidth: 900, minHeight: Math.round(420 / ratio), padding: '6mm' }}
          onClick={(e) => {
            const td = (e.target as HTMLElement).closest('td[data-block]') as HTMLElement | null;
            if (td && onPickBlock) onPickBlock(td.dataset.block || '');
          }}
          dangerouslySetInnerHTML={{ __html: html }} />
        <div className="text-center text-2xs text-slate-400 mt-2">
          {cur.page.paper}, {cur.page.orientation === 'portrait' ? 'книжная' : 'альбомная'} · колонтитул: {[cur.footer.left, cur.footer.center, cur.footer.right].filter(Boolean).join(' | ') || '—'}
        </div>
      </div>
    </div>
  );
}
