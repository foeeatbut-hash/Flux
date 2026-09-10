/**
 * Список обращений: свои у сотрудника, очередь у обработчика.
 *
 * Виртуализация не украшение: обращений за год набирается несколько тысяч, а
 * очередь открывают первым делом утром. Список без виртуализации на такой
 * длине заметно подтормаживает при прокрутке — это уже проходили на журнале
 * действий.
 */
import React, { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, Lightbulb, HelpCircle, Timer } from 'lucide-react';
import { STATUS_NAMES, TYPE_NAMES, reportNumber, type Status, type ReportType } from '../../../feedback/contracts';

const ICONS: Record<ReportType, any> = {
  BUG: AlertTriangle, IDEA: Lightbulb, QUESTION: HelpCircle, PERFORMANCE: Timer,
};

/** Цвет состояния: закрытое приглушено, ждущее ответа выделено. */
const TONE: Partial<Record<Status, string>> = {
  NEW: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  NEEDS_INFO: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  IN_PROGRESS: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  DONE: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  REJECTED: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  DUPLICATE: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  WITHDRAWN: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
};

export interface Row {
  id: string;
  number: number;
  type: ReportType;
  title: string;
  status: Status;
  priority?: string;
  createdAt: string;
  unread?: boolean;
}

export default function FeedbackList({ rows, activeId, onPick }: {
  rows: Row[];
  activeId: string;
  onPick: (id: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => box.current,
    estimateSize: () => 64,
    overscan: 8,
  });
  const items = virtual.getVirtualItems();
  const height = useMemo(() => virtual.getTotalSize(), [virtual, rows.length]);

  if (!rows.length) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <p className="text-xs text-slate-500 dark:text-slate-400 text-center">
          Пока пусто. Обращение появится здесь сразу после отправки.
        </p>
      </div>
    );
  }

  return (
    <div ref={box} className="h-full overflow-y-auto scrollbar-thin">
      <div style={{ height, position: 'relative' }}>
        {items.map((item) => {
          const row = rows[item.index];
          const Icon = ICONS[row.type] || AlertTriangle;
          return (
            <button key={row.id} type="button" onClick={() => onPick(row.id)}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
              className={`text-left px-3 py-2 border-b border-slate-100 dark:border-slate-850 cursor-pointer
                ${activeId === row.id ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'hover:bg-slate-50 dark:hover:bg-slate-900'}`}>
              <span className="flex items-center gap-2">
                <Icon className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                <span className="text-xs font-mono text-slate-500 dark:text-slate-400">{reportNumber(row.number)}</span>
                <span className={`px-1.5 py-0.5 rounded text-2xs font-semibold ${TONE[row.status] || 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'}`}>
                  {STATUS_NAMES[row.status]}
                </span>
                {row.unread && <span aria-label="Есть новое" className="w-1.5 h-1.5 rounded-full bg-rose-500" />}
              </span>
              <span className="block mt-1 text-xs font-semibold text-slate-800 dark:text-slate-150 truncate">
                {row.title}
              </span>
              <span className="block text-2xs text-slate-500 dark:text-slate-400">
                {TYPE_NAMES[row.type]} · {new Date(row.createdAt).toLocaleDateString('ru-RU')}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
