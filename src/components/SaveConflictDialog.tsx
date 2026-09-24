/**
 * Разбор «сохранил поверх чужой правки».
 *
 * Закрыть мимо кнопок нельзя. Выбор здесь решает судьбу двух работ, а «потом
 * разберусь» означало бы автосохранение, которое молча ничего не пишет: человек
 * правит документ час, уверенный, что всё сохраняется.
 *
 * Правки на экране в этот момент целы — они в книге, просто не записаны. Об
 * этом сказано в первой же строке, иначе окно читается как «всё пропало».
 */
import React from 'react';
import { conflictText, CONFLICT_CHOICES, type ConflictChoice, type ConflictInfo } from '../lib/docConflict';

export default function SaveConflictDialog({
  info, meName, onChoose,
}: {
  info: ConflictInfo;
  meName: string;
  onChoose: (choice: ConflictChoice) => void;
}) {
  return (
    <div className="absolute inset-0 z-[80] flex items-center justify-center p-4 fx-backdrop">
      <div
        role="dialog"
        aria-label="Документ изменился"
        className="fx-dialog w-[520px] max-w-full overflow-hidden border-amber-300 dark:border-amber-800 dark:bg-dark-surface"
      >
        <div className="px-4 py-3 border-b border-slate-200 dark:border-dark-border">
          <b className="block text-sm font-semibold text-slate-800 dark:text-slate-150">
            Документ изменился, пока вы его правили
          </b>
          <span className="block mt-1 text-xs text-slate-600 dark:text-slate-350">
            {conflictText(info, meName)}
          </span>
        </div>
        <div className="p-2">
          {CONFLICT_CHOICES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onChoose(c.id)}
              className="w-full text-left px-3 py-2.5 rounded-xl cursor-pointer
                         hover:bg-slate-100 dark:hover:bg-slate-850 transition-colors"
            >
              <b className="block text-sm font-semibold text-slate-800 dark:text-slate-150">{c.label}</b>
              <span className="block text-2xs text-slate-500 dark:text-slate-400">{c.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
