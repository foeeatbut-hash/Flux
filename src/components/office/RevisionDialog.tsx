/**
 * Выпуск ревизии документа: место и описание изменения.
 *
 * Отдельным файлом, потому что это разговор с человеком, а не часть редактора:
 * тот же диалог понадобится и таблице, когда у неё появятся ревизии. Экран
 * текстового документа при этом упирался в планку размера, и разговор — первое,
 * что из него стоит вынести: он самодостаточен и меняется отдельно.
 *
 * «Утвердить (→0)» показывается только у буквенной ревизии (A, B, …): по
 * правилам документооборота цифровая ревизия уже утверждена, и предлагать
 * утвердить её второй раз — обещать действие, которого не будет.
 */
import React from 'react';

export default function RevisionDialog({
  current, place, onPlace, desc, onDesc, busy, onIssue, onClose,
}: {
  /** Текущая ревизия: «A», «0», «1»… Пусто — ревизии ещё не было */
  current: string;
  place: string;
  onPlace: (v: string) => void;
  desc: string;
  onDesc: (v: string) => void;
  busy: boolean;
  onIssue: (mode: 'certify' | 'next') => void;
  onClose: () => void;
}) {
  const lettered = /^[A-Za-zА-Яа-я]$/.test(current);
  const field = 'w-full mt-0.5 px-2.5 py-1.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 '
    + 'dark:border-slate-800 rounded-lg text-slate-800 dark:text-white focus:outline-none focus:border-emerald-500';

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6" onClick={onClose}>
      <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xl p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800 dark:text-white">
          Выпустить ревизию (текущая: {current || '—'})
        </h3>
        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase">Место изменения</label>
          <input value={place} onChange={(e) => onPlace(e.target.value)}
            placeholder="напр. Разд. 3, лист 2" className={field} />
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase">Описание изменения</label>
          <textarea value={desc} onChange={(e) => onDesc(e.target.value)} rows={2}
            placeholder="что изменено" className={field} />
        </div>
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose}
            className="px-3.5 py-2 rounded-lg text-xs font-semibold text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-850 cursor-pointer">
            Отмена
          </button>
          {lettered && (
            <button type="button" onClick={() => onIssue('certify')} disabled={busy}
              className="px-3.5 py-2 rounded-lg border border-emerald-300 dark:border-emerald-800 text-emerald-700
                         dark:text-emerald-400 text-xs font-bold hover:bg-emerald-50 dark:hover:bg-emerald-950/30
                         cursor-pointer disabled:opacity-50">
              Утвердить (→0)
            </button>
          )}
          <button type="button" onClick={() => onIssue('next')} disabled={busy}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold cursor-pointer">
            Следующая ревизия
          </button>
        </div>
      </div>
    </div>
  );
}
