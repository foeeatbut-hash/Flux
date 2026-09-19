/**
 * Меню «Файл» — не вкладка, а экран.
 *
 * Как в Ворде: нажатие уводит с документа и возвращает стрелкой. Сделано так не
 * для сходства, а потому что здесь живут действия, которые нельзя нажать
 * случайно: выпуск ревизии, сохранение как шаблон, отправка наружу. Пока экран
 * открыт, документа не видно — и это правильно: человек занят не правкой.
 */
import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { ribbonIcon } from './icons';
import type { FileMenuSection } from '../../lib/ribbon';
import { useEscape } from '../../lib/useEscape';

export default function FileMenu({ sections, info, onClose }: {
  sections: FileMenuSection[];
  /** «Сведения»: пары «что — значение». Первый раздел экрана */
  info?: { label: string; value: string }[];
  onClose: () => void;
}) {
  // Esc возвращает к документу — как из любого окна поверх него
  useEscape(true, onClose);

  return (
    <div className="absolute inset-0 z-[70] flex bg-white dark:bg-slate-950">
      <div className="w-44 shrink-0 bg-emerald-600 dark:bg-emerald-700 py-3 px-2">
        <button type="button" onClick={onClose}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-bold text-white
                     hover:bg-emerald-700 dark:hover:bg-emerald-600 cursor-pointer">
          <ArrowLeft className="w-4 h-4" /> К документу
        </button>
        <div className="mt-3 space-y-0.5">
          {sections.map((s) => (
            <a key={s.name} href={`#file-${encodeURIComponent(s.name)}`}
              className="block px-2 py-1.5 rounded-lg text-2xs font-semibold text-emerald-50 hover:bg-emerald-700
                         dark:hover:bg-emerald-600 cursor-pointer">
              {s.name}
            </a>
          ))}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-auto p-6">
        {!!info?.length && (
          <div className="mb-7">
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-150 mb-2">Сведения</h3>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 max-w-2xl">
              {info.map((i) => (
                <div key={i.label} className="flex items-baseline justify-between gap-3 py-1
                                              border-b border-slate-100 dark:border-slate-850">
                  <span className="text-2xs text-slate-500 dark:text-slate-400">{i.label}</span>
                  <span className="text-2xs font-semibold text-slate-800 dark:text-slate-150 text-right truncate">{i.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {sections.map((s) => (
          <div key={s.name} id={`file-${encodeURIComponent(s.name)}`} className="mb-7">
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-150 mb-2">{s.name}</h3>
            <div className="grid gap-1.5 max-w-2xl" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
              {s.items.map((it) => {
                const Icon = ribbonIcon(it.icon);
                return (
                  <button key={it.label} type="button" disabled={!!it.disabled}
                    title={it.disabled || it.hint || it.label}
                    onClick={() => { if (!it.disabled) it.run(); }}
                    className={`flex items-start gap-2.5 text-left px-3 py-2 rounded-xl border transition-ui
                      ${it.disabled
                        ? 'border-transparent text-slate-350 dark:text-slate-455 cursor-not-allowed'
                        : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900 cursor-pointer'}`}>
                    <Icon className="w-4 h-4 mt-0.5 shrink-0 text-slate-400" />
                    <span className="min-w-0">
                      <span className={`block text-2xs font-bold ${it.disabled
                        ? 'text-slate-350 dark:text-slate-455' : 'text-slate-700 dark:text-slate-300'}`}>{it.label}</span>
                      {(it.hint || it.disabled) && (
                        <span className="block text-2xs leading-snug text-slate-400 dark:text-slate-455">
                          {it.disabled || it.hint}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
