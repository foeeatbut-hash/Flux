import React from 'react';
import {
  Tag, Fan, Table2, FileText, FolderOpen, ClipboardList, MessagesSquare, NotebookPen,
  Boxes, ChevronRight, Search, Mail,
} from 'lucide-react';
import { KIND_RU } from '../../lib/insight';

/**
 * Мелкие части панели связей: значок вида объекта, строка перехода, пустое
 * состояние. Вынесены отдельно, потому что одинаково выглядят во всех трёх
 * режимах панели — и должны меняться разом, а не в трёх местах.
 */

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  tag: Tag, element: Fan, system: Boxes, doc: Table2, file: FolderOpen,
  vdr: ClipboardList, note: NotebookPen, chat: MessagesSquare, section: FileText, mail: Mail,
};

// Цветом выделены только объекты самого проекта — теги и оборудование.
// Остальное серое: amber, rose и sky в программе означают предупреждение,
// конфликт и изменение, и раскрашивать ими виды объектов значило бы врать.
const KIND_TONE: Record<string, string> = {
  tag: 'text-emerald-600 dark:text-emerald-400',
  element: 'text-emerald-600 dark:text-emerald-400',
};

export function KindIcon({ kind, className = 'w-4 h-4' }: { kind: string; className?: string }) {
  const Icon = KIND_ICON[kind] || FileText;
  return <Icon className={`${className} ${KIND_TONE[kind] || 'text-slate-500 dark:text-slate-400'} shrink-0`} />;
}

export function kindLabel(kind: string): string {
  return KIND_RU[kind] || kind;
}

/**
 * Строка списка: значок, название, пояснение, пометка.
 *
 * Вся строка — одна кнопка, а не ссылка внутри строки: попасть мышью в мелкий
 * текст трудно, а промах по строке ощущается как «не работает».
 */
export function Row({ icon, title, subtitle, badge, onClick, onSide, sideTitle, disabled }: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  badge?: string;
  onClick?: () => void;
  onSide?: () => void;
  sideTitle?: string;
  disabled?: boolean;
}) {
  return (
    <div className="group flex items-stretch gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || !onClick}
        className="flex-1 min-w-0 flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-left
                   hover:bg-slate-50 dark:hover:bg-slate-850 disabled:hover:bg-transparent
                   disabled:cursor-default cursor-pointer transition-colors"
      >
        <span className="shrink-0">{icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-slate-800 dark:text-slate-150 truncate">{title}</span>
          {subtitle && <span className="block text-2xs text-slate-500 dark:text-slate-400 truncate">{subtitle}</span>}
        </span>
        {badge && (
          <span className="shrink-0 px-1.5 py-0.5 rounded-md text-2xs font-bold tabular-nums
                           bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">{badge}</span>
        )}
        {onClick && <ChevronRight className="w-3.5 h-3.5 text-slate-300 dark:text-slate-455 shrink-0" />}
      </button>
      {onSide && (
        <button
          type="button"
          onClick={onSide}
          title={sideTitle || 'Связи объекта'}
          className="shrink-0 px-2 rounded-[10px] text-slate-300 dark:text-slate-455
                     hover:text-emerald-600 dark:hover:text-emerald-400
                     hover:bg-emerald-50 dark:hover:bg-emerald-950/30 cursor-pointer transition-colors"
        >
          <Search className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

/** Заголовок группы с пояснением: список без объяснения читают как упрёк */
export function GroupHead({ title, hint, count, right }: {
  title: string; hint?: string; count?: number; right?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 pt-3 pb-1">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400">{title}</h3>
          {count !== undefined && (
            <span className="px-1.5 py-0.5 rounded-md text-2xs font-bold tabular-nums
                             bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">{count}</span>
          )}
        </div>
        {hint && <p className="mt-0.5 text-2xs text-slate-400 dark:text-slate-500 leading-snug">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

/** Пустое состояние: говорит, что это не ошибка, а нормальный ответ */
export function Empty({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 px-8 text-center">
      <div className="w-11 h-11 rounded-2xl bg-slate-100 dark:bg-slate-850 flex items-center justify-center text-slate-400 dark:text-slate-500">
        {icon}
      </div>
      <p className="text-sm font-semibold text-slate-700 dark:text-slate-150">{title}</p>
      {hint && <p className="text-xs text-slate-400 dark:text-slate-500 max-w-xs leading-relaxed">{hint}</p>}
    </div>
  );
}

/** Полоски вместо содержимого, пока считается ответ */
export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="p-3 space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-11 rounded-[10px] bg-slate-100 dark:bg-slate-850 animate-pulse" />
      ))}
    </div>
  );
}
