/**
 * Пометки чертежа списком: кто, когда, на какой ревизии и учтено ли.
 *
 * Это и есть ответ на вопрос «что мы писали поставщику»: по чертежу пометки
 * разбросаны, а решение принимают по списку. Отсюда же состояние замечания —
 * учтено, не учтено — и переход к месту на листе.
 */
import React from 'react';
import { X, Trash2 } from 'lucide-react';
import type { Markup } from './MarkupLayer';

const STATE_LABEL: Record<string, string> = {
  OPEN: 'не разобрано', DONE: 'учтено', REJECTED: 'не учтено',
};

export default function MarkupList({
  markups, currentRevision, selectedId, onSelect, onState, onRemove, onClose,
}: {
  markups: Markup[];
  currentRevision: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onState: (id: string, state: 'OPEN' | 'DONE' | 'REJECTED') => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute right-3 top-3 z-40 w-96 max-h-[80%] flex flex-col rounded-xl overflow-hidden shadow-2xl
                    bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <span className="text-sm font-bold text-slate-800 dark:text-slate-150">
          Пометки чертежа <span className="text-slate-400 font-normal">({markups.length})</span>
        </span>
        <button type="button" onClick={onClose} aria-label="Закрыть список пометок"
          className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-150 cursor-pointer">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="overflow-auto divide-y divide-slate-100 dark:divide-slate-850">
        {markups.map((m) => {
          const old = m.revision !== currentRevision;
          return (
            <div key={m.id}
              className={`px-4 py-2.5 cursor-pointer ${m.id === selectedId ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-850'}`}
              onClick={() => onSelect(m.id)}>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: old ? '#94a3b8' : m.color }} />
                <span className="text-2xs font-bold text-slate-700 dark:text-slate-300 truncate flex-1">
                  {m.text || 'без замечания'}
                </span>
                <span className="text-2xs font-mono text-slate-400 shrink-0">стр. {m.page}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-2xs text-slate-400 dark:text-slate-455">
                <span>{m.createdBy?.name || 'кто-то'}</span>
                <span>·</span>
                <span>ред. {m.revision}{old ? ' (прошлая)' : ''}</span>
                <span>·</span>
                <span>{STATE_LABEL[m.state]}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                {(['DONE', 'REJECTED', 'OPEN'] as const).map((s) => (
                  <button key={s} type="button"
                    onClick={(e) => { e.stopPropagation(); onState(m.id, s); }}
                    className={`px-2 h-5 rounded-md text-2xs font-semibold cursor-pointer transition-ui
                      ${m.state === s
                        ? 'bg-emerald-600 text-white'
                        : 'border border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850'}`}>
                    {STATE_LABEL[s]}
                  </button>
                ))}
                <span className="flex-1" />
                <button type="button" title="Снять пометку"
                  onClick={(e) => { e.stopPropagation(); onRemove(m.id); }}
                  className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          );
        })}
        {markups.length === 0 && (
          <div className="px-4 py-6 text-center text-2xs text-slate-400 dark:text-slate-455">
            Пометок нет. Выберите на вкладке «Пометки», чем помечать, и обведите место на чертеже.
          </div>
        )}
      </div>
    </div>
  );
}
