/**
 * Напоминание о старых черновиках и панель разбора (лист «States»).
 *
 * Напоминание — одна строка над списком, без всплывающих окон: черновики
 * копятся незаметно, но поверх работы не выскакивают. «Позже» усыпляет его
 * на сутки, «Оставить все» — навсегда для этих файлов.
 */
import React from 'react';

function plural(n: number, one: string, few: string, many: string) {
  const m = n % 100;
  if (m >= 11 && m <= 14) return many;
  return n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many;
}

export const oldPhrase = (count: number, days: number) =>
  `${count} ${plural(count, 'черновик старше', 'черновика старше', 'черновиков старше')} ${days} ${plural(days, 'день', 'дня', 'дней')}`;

export function ReminderBanner({ count, days, onReview, onLater }: { count: number; days: number; onReview: () => void; onLater: () => void }) {
  return <div role="status" data-drafts-reminder className="mx-2 mb-1 flex h-8 shrink-0 items-center gap-1 rounded bg-[var(--flux-sel)] pl-2 pr-1 text-xs">
    <span className="min-w-0 flex-1 truncate">{oldPhrase(count, days)}</span>
    <button type="button" className="fx-btn fx-btn-sm" onClick={onReview}>Разобрать</button>
    <button type="button" className="fx-btn fx-btn-sm fx-btn-quiet" onClick={onLater}>Позже</button>
  </div>;
}

export function ReviewBar({ count, days, onPublish, onTrash, onKeep, onDone }: {
  count: number; days: number; onPublish: () => void; onTrash: () => void; onKeep: () => void; onDone: () => void;
}) {
  return <div data-drafts-review className="mx-2 mb-1 flex shrink-0 flex-col gap-1 rounded bg-[var(--flux-sel)] p-1.5 text-xs">
    <div className="flex h-6 items-center gap-1">
      <span className="min-w-0 flex-1 truncate font-medium">{count ? oldPhrase(count, days) : 'Старых черновиков не осталось'}</span>
      <button type="button" className="fx-btn fx-btn-sm fx-btn-quiet" onClick={onDone}>Готово</button>
    </div>
    <div className="flex gap-1">
      <button type="button" disabled={!count} className="fx-btn fx-btn-sm min-w-0 flex-1" onClick={onPublish}>Опубликовать все</button>
      <button type="button" disabled={!count} className="fx-btn fx-btn-sm fx-btn-danger min-w-0 flex-1" onClick={onTrash}>Удалить все</button>
      <button type="button" disabled={!count} className="fx-btn fx-btn-sm min-w-0 flex-1" onClick={onKeep}>Оставить все</button>
    </div>
  </div>;
}
