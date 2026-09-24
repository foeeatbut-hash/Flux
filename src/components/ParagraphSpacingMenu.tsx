import React from 'react';
import { describeParagraph, LINE_SPACINGS, PARA_SPACINGS, FIRST_LINE_GOST_PT } from '../lib/docStyle';

/**
 * Панель интервалов — междустрочный, до и после абзаца, красная строка.
 *
 * Своя, потому что в ленте движка этого нет совсем: команды на выравнивание
 * есть, на интервалы — нет. А без 1,5 строки и красной строки 1,25 см
 * пояснительную записку по ГОСТ не сдать.
 *
 * Только содержимое, без своей кнопки: кнопка живёт на ленте (орган
 * doc.spacing), и вторая, всплывавшая рядом с первой, заставляла нажимать
 * «Интервал» дважды — сперва на ленте, потом в облачке над ней.
 *
 * Всё применяется к выделенным абзацам, а не ко всему документу — как в Ворде.
 * Пустой стиль абзаца показываем как «ничего не выбрано», а не как одинарный
 * интервал: иначе панель врёт про то, что стоит в документе.
 */
export default function ParagraphSpacingMenu({ style, onApply }: {
  /** Стиль абзаца под курсором; null — курсора в тексте нет */
  style: any;
  onApply: (patch: any) => void;
}) {
  const apply = (patch: any) => onApply(patch);

  return (
          <div className="fx-pop w-64 overflow-hidden p-3 space-y-3">
            {!style && (
              <p className="text-2xs text-amber-600 dark:text-amber-400 font-semibold">
                Поставьте курсор в текст — интервал применяется к выделенным абзацам
              </p>
            )}
            <div>
              <div className="text-xs font-medium text-slate-500 mb-1">Междустрочный</div>
              <div className="grid grid-cols-2 gap-1">
                {LINE_SPACINGS.map(s => (
                  <button key={s.v} type="button"
                    onClick={() => apply({ lineSpacing: s.v })}
                    className={`px-2 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border ${describeParagraph(style).lineSpacing === s.v ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300' : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-850'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-500 mb-1">Интервал до абзаца</div>
              <div className="grid grid-cols-4 gap-1">
                {PARA_SPACINGS.map(s => (
                  <button key={s.v} type="button"
                    onClick={() => apply({ spaceAbove: s.v ? { v: s.v } : null })}
                    className={`px-1 py-1.5 rounded-lg text-2xs font-semibold cursor-pointer border ${(describeParagraph(style).before ?? 0) === s.v ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300' : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-850'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-500 mb-1">Интервал после абзаца</div>
              <div className="grid grid-cols-4 gap-1">
                {PARA_SPACINGS.map(s => (
                  <button key={s.v} type="button"
                    onClick={() => apply({ spaceBelow: s.v ? { v: s.v } : null })}
                    className={`px-1 py-1.5 rounded-lg text-2xs font-semibold cursor-pointer border ${(describeParagraph(style).after ?? 0) === s.v ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300' : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-850'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="pt-1 border-t border-slate-100 dark:border-slate-850 space-y-1">
              <button type="button"
                onClick={() => apply({ indentFirstLine: { v: FIRST_LINE_GOST_PT } })}
                className="fx-btn fx-btn-sm w-full">
                Красная строка 1,25 см
              </button>
              <button type="button"
                onClick={() => apply({ indentFirstLine: null, indentStart: null, indentEnd: null })}
                className="fx-btn fx-btn-sm w-full">
                Убрать отступы абзаца
              </button>
              {/* Один щелчок под записку: 1,5 строки и красная строка */}
              <button type="button"
                onClick={() => apply({ lineSpacing: 1.5, indentFirstLine: { v: FIRST_LINE_GOST_PT }, spaceAbove: null, spaceBelow: null })}
                className="fx-btn fx-btn-primary fx-btn-sm w-full">
                Как в записке по ГОСТ
              </button>
            </div>
          </div>
  );
}
