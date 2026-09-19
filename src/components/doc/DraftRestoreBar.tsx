/**
 * «В прошлый раз правка не сохранилась. Вернуть?»
 *
 * Полоса поверх документа, а не тост: тост уезжает через несколько секунд, а
 * это единственная оставшаяся копия работы человека — предложение обязано
 * дождаться решения.
 *
 * Молча подставлять черновик нельзя тем более: человек открыл документ и
 * увидел бы текст, которого не ожидал, не понимая, откуда он и что стало с
 * серверной версией. Поэтому называем и причину, и время.
 */

import React from 'react';
import { RotateCcw, X, AlertTriangle } from 'lucide-react';
import { draftAgeText, type DocDraft } from '../../lib/docDraft';

export default function DraftRestoreBar({ draft, onRestore, onDismiss }: {
  draft: DocDraft;
  onRestore: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="absolute left-1/2 -translate-x-1/2 top-3 z-50 max-w-[min(680px,92%)]
                    flex items-center gap-3 px-3 py-2 rounded-xl shadow-2xl border
                    border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950"
      role="status" aria-label="Несохранённая правка">
      <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-amber-900 dark:text-amber-100">
          Правка {draftAgeText(draft)} не дошла до сервера
        </div>
        <div className="text-2xs text-amber-800 dark:text-amber-300 truncate" title={draft.reason}>
          {draft.reason}. Сейчас открыто то, что лежит на сервере.
        </div>
      </div>
      <button type="button" onClick={onRestore}
        className="shrink-0 px-2.5 py-1 rounded-lg text-2xs font-semibold cursor-pointer
                   bg-amber-600 text-white hover:bg-amber-700 flex items-center gap-1">
        <RotateCcw className="w-3 h-3" /> Вернуть правку
      </button>
      <button type="button" onClick={onDismiss} aria-label="Отказаться от черновика"
        className="shrink-0 w-6 h-6 rounded flex items-center justify-center cursor-pointer
                   text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
