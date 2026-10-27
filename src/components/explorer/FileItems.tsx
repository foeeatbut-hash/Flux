/**
 * Размер и статусы документооборота для стола и свойств файла.
 *
 * Строки и плитки старого Проводника ушли вместе с ним; здесь остаётся то, чем
 * пользуются стол (значки, список, свойства) и архивное окно.
 */
import React from 'react';

export const formatSize = (bytes: number) => {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
};

// ── Статусы документооборота (код A/B/C/D → человекочитаемый поток) ──
// Проводник 2.0 §6.2: вместо безымянной цветной точки — понятный чип.
export const FILE_STATUSES: Record<string, { label: string; dot: string; chip: string }> = {
  D: { label: 'Черновик',    dot: 'bg-slate-400',   chip: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  C: { label: 'На проверке', dot: 'bg-amber-500',   chip: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400' },
  B: { label: 'Согласован',  dot: 'bg-sky-500',     chip: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400' },
  A: { label: 'Выдан',       dot: 'bg-emerald-500', chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' },
};
export const STATUS_ORDER = ['D', 'C', 'B', 'A'];
export const statusOf = (code: string | undefined) => FILE_STATUSES[code || 'D'] || FILE_STATUSES.D;

export const StatusChip = ({ code, onClick }: { code?: string; onClick?: (e: React.MouseEvent) => void }) => {
  const s = statusOf(code);
  return (
    <span
      onClick={onClick}
      title={onClick ? 'Сменить статус документа' : s.label}
      className={`inline-flex items-center gap-1 text-2xs font-semibold px-1.5 py-0.5 rounded-full ${s.chip} ${onClick ? 'cursor-pointer hover:brightness-95' : ''}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} /> {s.label}
    </span>
  );
};
