import React from 'react';
import { AlertTriangle, Lock } from 'lucide-react';
import { LOCK_VIOLATION_TEXT } from '../../../shared/docflow/links';
import type { DocflowConfig, DocflowTone } from '../../../shared/docflow/config';
import type { DocEntryInfo } from './docEntryInfo';
import type { FolderColumn } from './viewModel';

/** Столбцы документооборота в «Таблице» Проводника и значок «имя не по маске» у имени (docs/docflow-program.md, 3.2). */
export const DOC_COLUMNS: FolderColumn[] = ['cipher', 'docType', 'docRev', 'docStatus', 'inRegistry'];
export const isDocColumn = (column: FolderColumn) => DOC_COLUMNS.includes(column);

const DOT: Record<DocflowTone, string> = {
  slate: 'bg-slate-400', sky: 'bg-sky-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500', rose: 'bg-rose-500',
  // Фиолетового в палитре Flux нет: как и в реестре, «на проверке» рисуется синим
  violet: 'bg-sky-500',
};

/** Замок у имени заблокированного файла; красный — файл изменён вне Flux при блокировке. */
export function LockBadge({ info }: { info: DocEntryInfo | null }) {
  const link = info?.link;
  if (!link?.locked || link.unlinkedAt) return null;
  const text = link.lockViolation
    ? `Нарушена блокировка: файл ${LOCK_VIOLATION_TEXT[link.lockViolation]}`
    : `Заблокирован: связан со строкой документооборота${link.lockedByName ? `, ${link.lockedByName}` : ''}. Снять замок можно в строке реестра`;
  return <span data-lock-badge={link.lockViolation || 'locked'} title={text} aria-label={text} className={`inline-flex shrink-0 ${link.lockViolation ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}`}><Lock size={13} aria-hidden /></span>;
}

export function OffMaskBadge({ problems }: { problems: string[] }) {
  if (!problems.length) return null;
  const text = `Имя не по маске проекта: ${problems.join('; ')}`;
  return <span data-off-mask title={text} aria-label={text} className="inline-flex shrink-0 text-amber-600 dark:text-amber-400"><AlertTriangle size={14} aria-hidden /></span>;
}

export function StatusDot({ status, config }: { status: string; config: DocflowConfig }) {
  const meta = config.statuses.find((s) => s.code === status);
  return <span className="inline-flex items-center gap-1.5"><span className={`h-2 w-2 shrink-0 rounded-full ${DOT[meta?.tone || 'slate']}`} aria-hidden />{meta?.label || status || '—'}</span>;
}

/** Содержимое ячейки столбца документооборота; пусто — «—». */
export function docCell(info: DocEntryInfo | null | undefined, column: FolderColumn, config: DocflowConfig | undefined): React.ReactNode {
  if (!info || info.ignored || !config) return '—';
  const fields = info.parsed?.fields || {};
  switch (column) {
    case 'cipher': return fields['шифр'] || info.item?.cipher || '—';
    case 'docType': {
      const code = fields['тип'] || info.item?.vdrCode || '';
      const title = config.vdrTypes.find((t) => t.code.toUpperCase() === code.toUpperCase())?.titleRu;
      return code ? (title ? `${code} · ${title}` : code) : '—';
    }
    case 'docRev': {
      const rev = fields['ред'] || (info.role === 'remarks' ? info.remarksTo?.revision : '') || '';
      const last = info.item?.revision;
      return rev ? (last && last.toUpperCase() !== rev.toUpperCase() ? `${rev} (последняя ${last})` : rev) : '—';
    }
    case 'docStatus': return info.item ? <StatusDot status={info.item.status} config={config} /> : '—';
    case 'inRegistry':
      if (!info.item) return '—';
      return info.role === 'remarks' ? `Замечания к ред. ${info.remarksTo?.revision || info.link?.revision || ''} · ${info.item.title || info.item.cipher}` : info.item.title || info.item.cipher || 'Строка без названия';
    default: return '—';
  }
}
