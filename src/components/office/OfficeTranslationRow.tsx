import React from 'react';
import { Area, Btn, Status } from '../ui';
import type { OfficeTranslationApplyItem, OfficeTranslationUnit } from './TranslationBridgeContext';

/** Фрагмент в панели: что прочитал редактор, что предложил переводчик и решил человек. */
export interface ReviewedUnit {
  unit: OfficeTranslationUnit;
  item: OfficeTranslationApplyItem;
  origin: string;
  missing: string[];
  confirmed: boolean;
  /** Пропущен: в запись не идёт (уже актуален, или человек исключил его). */
  skipped: boolean;
}

const STATUS_WORD: Record<NonNullable<OfficeTranslationUnit['status']>, string> = {
  new: 'Новый', current: 'Актуален', stale: 'Устарел', detached: 'Оригинала нет', replaced: 'Заменён',
};

function label(item: OfficeTranslationApplyItem, index: number): string {
  if (item.displayLabel) return item.displayLabel;
  if (item.fieldKey) return item.fieldKey;
  const where = item.location as { sheetName?: unknown; address?: unknown };
  if (typeof where.sheetName === 'string' && typeof where.address === 'string') return `${where.sheetName} · ${where.address}`;
  if (typeof where.address === 'string') return where.address;
  return `Фрагмент ${index + 1}`;
}

export function TranslationRow({ row, index, total, onEdit, onConfirm, onSkip }: {
  row: ReviewedUnit; index: number; total: number;
  onEdit: (text: string) => void; onConfirm: () => void; onSkip: () => void;
}) {
  const { item, unit, confirmed, skipped, origin, missing } = row;
  const stale = unit.status === 'stale' || unit.status === 'detached';
  const state = skipped ? 'Пропущен' : confirmed ? 'Проверен' : 'Проверить';
  return (
    <div className={`flex flex-col gap-1 border-b border-slate-200 py-2 dark:border-dark-border ${skipped ? 'opacity-60' : ''}`} data-testid="tr-row" data-key={item.key}>
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 truncate font-medium" title={label(item, index)}>{label(item, index)}</span>
        <span className="ml-auto shrink-0 tabular-nums text-slate-500 dark:text-dark-text-muted">{index + 1} / {total}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <Status tone={skipped ? 'slate' : confirmed ? 'emerald' : 'amber'}>{state}</Status>
        {unit.status && <Status tone={stale ? 'amber' : unit.status === 'new' ? 'sky' : 'slate'}>{STATUS_WORD[unit.status]}</Status>}
        <span className="text-slate-500 dark:text-dark-text-muted">{origin}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-xs text-slate-500 dark:text-dark-text-muted">{item.source}</p>
      <Area value={item.targetText} rows={2} disabled={skipped} aria-label={`Перевод: ${label(item, index)}`} onChange={(e) => onEdit(e.target.value)} />
      {missing.length > 0 && <span className="fx-hint">Нет в словаре: {missing.join(', ')}</span>}
      <div className="flex gap-2">
        {!skipped && !confirmed && <Btn size="sm" disabled={!item.targetText.trim()} onClick={onConfirm}>Подтвердить</Btn>}
        <Btn size="sm" tone="ghost" onClick={onSkip}>{skipped ? 'Вернуть' : 'Пропустить'}</Btn>
      </div>
    </div>
  );
}
