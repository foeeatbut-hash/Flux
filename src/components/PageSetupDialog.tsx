import React, { useState } from 'react';
import { X, LayoutTemplate, Check } from 'lucide-react';
import { PAGE_SIZES, MARGIN_PRESETS, ptToMm, type PageSetup } from '../lib/docExport';
import { useEscapeClose } from '../lib/useDismiss';

/**
 * Окно «Разметка страницы» — то же, что вкладка Ворда: формат листа,
 * ориентация, поля.
 *
 * Наборы полей — вордовские плюс ГОСТ (слева 30 мм, справа 15 мм): именно так
 * оформляют пояснительные записки, и набирать это вручную каждый раз незачем.
 * Свои значения вводятся в миллиметрах, а хранятся в пунктах — человек думает
 * в миллиметрах, документ живёт в пунктах.
 */
export default function PageSetupDialog({ value, onApply, onClose }: {
  value: PageSetup;
  onApply: (setup: PageSetup) => void;
  onClose: () => void;
}) {
  useEscapeClose(true, onClose);

  const [setup, setSetup] = useState<PageSetup>(value);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 fx-backdrop" onClick={() => onClose()}>
        <div className="fx-dialog w-full max-w-lg overflow-hidden" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-800">
            <h3 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
              <LayoutTemplate className="w-4 h-4 text-sky-600" /> Разметка страницы
            </h3>
            <button type="button" onClick={() => onClose()} className="text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="p-5 space-y-4">
            <div>
              <div className="text-xs font-medium text-slate-500 mb-1.5">Формат листа</div>
              <div className="grid grid-cols-2 gap-1.5">
                {Object.entries(PAGE_SIZES).map(([key, s]) => (
                  <button key={key} type="button" onClick={() => setSetup(p => p && { ...p, size: key })}
                    className={`px-3 py-2 rounded-lg text-xs font-semibold text-left cursor-pointer border ${setup.size === key ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300' : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-850'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-slate-500 mb-1.5">Ориентация</div>
              <div className="flex gap-1.5">
                {([['portrait', 'Книжная'], ['landscape', 'Альбомная']] as const).map(([v, label]) => (
                  <button key={v} type="button" onClick={() => setSetup(p => p && { ...p, orientation: v })}
                    className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer border ${setup.orientation === v ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300' : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-850'}`}>
                    <span className={`border-2 border-current ${v === 'portrait' ? 'w-2.5 h-3.5' : 'w-3.5 h-2.5'}`} />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-slate-500 mb-1.5">Поля</div>
              <div className="space-y-1.5">
                {Object.entries(MARGIN_PRESETS).map(([key, m]) => {
                  const same = setup.margins.top === m.top && setup.margins.right === m.right
                    && setup.margins.bottom === m.bottom && setup.margins.left === m.left;
                  return (
                    <button key={key} type="button" onClick={() => setSetup(p => p && { ...p, margins: { top: m.top, right: m.right, bottom: m.bottom, left: m.left } })}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer border ${same ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300' : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-850'}`}>
                      {m.label}
                      {same && <Check className="w-3.5 h-3.5" />}
                    </button>
                  );
                })}
              </div>
              {/* Свои значения: вводим в миллиметрах, храним в пунктах */}
              <div className="grid grid-cols-4 gap-1.5 mt-2">
                {([['top', 'Сверху'], ['bottom', 'Снизу'], ['left', 'Слева'], ['right', 'Справа']] as const).map(([k, label]) => (
                  <label key={k} className="text-xs font-medium text-slate-500">
                    {label}, мм
                    <input type="number" min={0} max={100} step={1} value={ptToMm(setup.margins[k])}
                      onChange={e => {
                        const mm = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                        setSetup(p => p && { ...p, margins: { ...p.margins, [k]: Math.round(mm / (25.4 / 72) * 10) / 10 } });
                      }}
                      className="w-full mt-0.5 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-xs font-medium text-slate-700 dark:text-slate-300" />
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
            <button type="button" onClick={() => onClose()} className="fx-btn fx-btn-quiet fx-btn-sm">Отмена</button>
            <button type="button" onClick={() => onApply(setup)} className="fx-btn fx-btn-primary fx-btn-sm">Применить</button>
          </div>
        </div>
      </div>
  );
}
