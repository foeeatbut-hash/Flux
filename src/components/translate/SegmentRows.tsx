/**
 * Строки сверки: исходник, перевод, откуда он взялся.
 *
 * Это главный экран переводчика и единственное место, где решается, можно ли
 * отдавать результат заказчику. Поэтому происхождение видно у каждой строки, а
 * не сводкой внизу: сводка «85 % готово» не говорит, какие именно 15 % надо
 * прочитать глазами.
 *
 * Перевод правится прямо здесь. Правка — это и есть подтверждение: строка,
 * которую человек тронул, становится зелёной и уходит в память, когда нажмут
 * «Запомнить».
 */
import React from 'react';
import { Check, Pencil } from 'lucide-react';
import type { Segment } from '../../translate/types';
import { ORIGIN_LABEL } from '../../translate/types';

export interface Row extends Segment {
  /** Человек прочитал строку и согласен: пойдёт в память */
  ok?: boolean;
}

/** Цвет по происхождению: зелёный — подтверждено, янтарный — проверьте */
function toneOf(r: Row): string {
  if (r.ok) return 'border-l-emerald-500';
  switch (r.origin) {
    case 'tm': return 'border-l-emerald-500';
    case 'phrase': return 'border-l-sky-500';
    case 'tm-fuzzy': return 'border-l-amber-500';
    case 'model': return 'border-l-sky-500';
    case 'glossary': return 'border-l-slate-300 dark:border-l-slate-700';
    case 'none': return 'border-l-rose-400';
    default: return 'border-l-transparent';
  }
}

export default function SegmentRows({
  rows, side, showOrigin, onChange, onConfirm,
}: {
  rows: Row[];
  /** Рядом (два столбца) или столбиком — в узком окне столбиком читается лучше */
  side: boolean;
  showOrigin: boolean;
  onChange: (i: number, dst: string) => void;
  onConfirm: (i: number) => void;
}) {
  const real = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.origin !== 'kept' || r.src.trim());
  if (!real.length) {
    return (
      <div className="h-full flex items-center justify-center text-2xs text-slate-400 dark:text-slate-500 px-6 text-center">
        Вставьте текст слева и нажмите «Перевести».
        <br />
        Программа берёт перевод из памяти проекта, словаря и узоров деловых писем.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto scrollbar-thin">
      {real.map(({ r, i }) => (
        <div key={i}
          className={`border-l-2 ${toneOf(r)} border-b border-slate-100 dark:border-slate-850
                      px-3 py-2 ${side ? 'grid grid-cols-2 gap-3' : 'flex flex-col gap-1'}`}>
          <div className="min-w-0">
            <span className="block text-xs text-slate-600 dark:text-slate-400 whitespace-pre-wrap break-words">
              {r.src}
            </span>
            {showOrigin && (
              <span className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-2xs text-slate-400 dark:text-slate-500">
                <span className="font-semibold">
                  {ORIGIN_LABEL[r.origin]}
                  {r.score !== undefined && r.origin === 'tm-fuzzy' && ` · ${Math.round(r.score * 100)} %`}
                </span>
                {/* Пропущенные слова прописными не набираем: это цитата из
                    текста, и в верхнем регистре её не узнать */}
                {r.missing?.length ? <span>нет в словаре: {r.missing.slice(0, 4).join(', ')}</span> : null}
              </span>
            )}
          </div>

          <div className="min-w-0 flex items-start gap-1.5">
            <textarea
              value={r.dst}
              onChange={(e) => onChange(i, e.target.value)}
              rows={Math.min(6, Math.max(1, Math.ceil((r.dst.length || r.src.length) / 60)))}
              placeholder={r.origin === 'none' ? 'Не нашлось — напишите сами' : ''}
              className="flex-1 min-w-0 bg-transparent text-xs text-slate-800 dark:text-slate-150 resize-none
                         outline-none border border-transparent hover:border-slate-200 focus:border-emerald-400
                         dark:hover:border-slate-800 rounded px-1.5 py-1 placeholder:text-rose-400"
            />
            <button type="button" onClick={() => onConfirm(i)}
              title={r.ok ? 'Строка подтверждена' : 'Подтвердить строку'}
              className={`shrink-0 mt-0.5 p-1 rounded-md cursor-pointer ${r.ok
                ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40'
                : 'text-slate-300 dark:text-slate-500 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40'}`}>
              {r.ok ? <Check className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
