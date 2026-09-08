/**
 * История версий документа Конструктора.
 *
 * Версия снимается не по желанию, а перед тем, как содержимое может
 * пострадать: перед обновлением данных из проекта, перед восстановлением
 * другой версии и перед сохранением поверх чужой правки. Поэтому в списке
 * важен не столько номер, сколько комментарий — он говорит, ОТ ЧЕГО эта
 * версия страхует.
 *
 * Вынесено из ConstructorScreen: панель самодостаточна и знает только про
 * список и две команды.
 */
import React from 'react';
import { History, X } from 'lucide-react';

export interface DocVersion {
  id: string;
  version: number;
  comment: string;
  createdAt: string;
}

export default function DocVersionsPanel({
  versions, fmtDate, onSave, onRestore, onClose,
}: {
  versions: DocVersion[];
  fmtDate: (v: string) => string;
  onSave: () => void;
  onRestore: (v: DocVersion) => void;
  onClose: () => void;
}) {
  return (
    <div className="shrink-0 w-72 @[900px]:w-80 h-full flex flex-col overflow-hidden
                    bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800">
        <span className="text-sm font-bold text-slate-800 dark:text-white">История версий</span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onSave}
            className="text-xs font-bold px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer flex items-center gap-1">
            <History className="w-3 h-3" /> Сохранить версию
          </button>
          <button type="button" onClick={onClose} aria-label="Закрыть"
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto divide-y divide-slate-100 dark:divide-slate-850">
        {versions.map((v) => (
          <div key={v.id} className="px-4 py-2.5 flex items-center gap-3">
            <div className="w-9 h-6 shrink-0 rounded bg-slate-100 dark:bg-slate-850 flex items-center justify-center text-xs font-bold text-slate-500">в{v.version}</div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 truncate">{v.comment || 'без комментария'}</div>
              <div className="text-2xs text-slate-400">{fmtDate(v.createdAt)}</div>
            </div>
            <button type="button" onClick={() => onRestore(v)} title="Восстановить эту версию"
              className="text-xs font-bold px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 hover:text-emerald-700 cursor-pointer">
              Восстановить
            </button>
          </div>
        ))}
        {versions.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-slate-400">
            Версий пока нет. Они создаются автоматически перед обновлением
            данных и кнопкой «Сохранить версию».
          </div>
        )}
      </div>
    </div>
  );
}
