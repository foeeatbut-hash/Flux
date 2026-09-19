import React, { useEffect, useRef, useState } from 'react';
import {
  ptToMm, mmToPt, fmtMm, handlePosPt, dragTo, rulerTicks,
  type RulerHandle, type RulerModel,
} from '../lib/docStyle';

/**
 * Линейка над листом — как в Ворде.
 *
 * Что делает: показывает сантиметры, серые поля и белую текстовую область, и
 * даёт пять бегунков — левое и правое поле страницы, красную строку, отступы
 * абзаца слева и справа.
 *
 * Поля меняют весь документ, отступы — только выделенные абзацы. Это разделение
 * из Ворда, и оно не косметическое: перепутав их, человек сдвигает либо один
 * абзац вместо всего документа, либо наоборот.
 *
 * Пока тянут — двигается только бегунок, документ не трогаем. Правка уходит на
 * отпускании мыши: иначе каждое дрожание руки попадало бы в отмену отдельным
 * шагом, и «отменить» пришлось бы жать сорок раз.
 *
 * Вся арифметика (прилипание, ограничители, деления) живёт в src/lib/docStyle.ts
 * и проверяется числами — scripts/test-doc-style.ts.
 */

interface Props {
  model: RulerModel;
  /** Пикселей на пункт: масштаб листа на экране */
  pxPerPt: number;
  /** Левый край листа в пикселях относительно родителя */
  leftPx: number;
  /** Есть ли выделение: без него отступы абзаца двигать некуда */
  hasSelection: boolean;
  onMargins: (patch: { marginLeftPt?: number; marginRightPt?: number }) => void;
  onIndents: (patch: { firstLinePt?: number; indentStartPt?: number; indentEndPt?: number }) => void;
}

const HANDLE_TITLE: Record<RulerHandle, string> = {
  marginLeft: 'Левое поле страницы',
  marginRight: 'Правое поле страницы',
  firstLine: 'Отступ первой строки (красная строка)',
  indentStart: 'Отступ абзаца слева',
  indentEnd: 'Отступ абзаца справа',
};

export default function DocRuler({ model, pxPerPt, leftPx, hasSelection, onMargins, onIndents }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  // Что тянем и куда доехали — пока тянем, документ не меняем
  const [drag, setDrag] = useState<{ h: RulerHandle; valuePt: number } | null>(null);
  const dragRef = useRef<typeof drag>(null);
  dragRef.current = drag;

  const widthPx = model.pageWidthPt * pxPerPt;

  // Пока тянут, показываем лист с уже сдвинутой границей — иначе не видно, что
  // получится, и приходится отпускать и пробовать заново
  const shown: RulerModel = drag ? { ...model, ...patchOf(drag.h, drag.valuePt) } : model;

  useEffect(() => {
    if (!drag) return;
    const strip = stripRef.current;
    if (!strip) return;

    const xToPt = (clientX: number) => {
      const box = strip.getBoundingClientRect();
      return (clientX - box.left) / pxPerPt;
    };
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setDrag({ h: d.h, valuePt: dragTo(model, d.h, xToPt(e.clientX)) });
    };
    const up = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      if (d.h === 'marginLeft') onMargins({ marginLeftPt: d.valuePt });
      else if (d.h === 'marginRight') onMargins({ marginRightPt: d.valuePt });
      else if (d.h === 'firstLine') onIndents({ firstLinePt: d.valuePt });
      else if (d.h === 'indentStart') onIndents({ indentStartPt: d.valuePt });
      else onIndents({ indentEndPt: d.valuePt });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [drag?.h, model, pxPerPt, onMargins, onIndents]);

  const start = (h: RulerHandle) => (e: React.PointerEvent) => {
    e.preventDefault();
    setDrag({ h, valuePt: valueOf(model, h) });
  };

  const textLeftPx = shown.marginLeftPt * pxPerPt;
  const textRightPx = (shown.pageWidthPt - shown.marginRightPt) * pxPerPt;
  const posPx = (h: RulerHandle) => handlePosPt(shown, h) * pxPerPt;

  return (
    <div className="relative h-6 select-none" data-doc-ruler="1">
      <div
        ref={stripRef}
        className="absolute top-0 h-5 rounded-sm border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800 overflow-hidden"
        style={{ left: leftPx, width: widthPx }}
      >
        {/* Текстовая область — светлая, поля тёмные: сразу видно, где текст */}
        <div
          className="absolute top-0 bottom-0 bg-white dark:bg-slate-950"
          style={{ left: textLeftPx, width: Math.max(0, textRightPx - textLeftPx) }}
        />
        {rulerTicks(shown).map((t, i) => (
          <div key={i} className="absolute top-0" style={{ left: t.xPt * pxPerPt }}>
            <div className={`w-px bg-slate-400 dark:bg-slate-600 ${t.big ? 'h-2' : 'h-1'}`} />
            {t.label && (
              <div className="absolute top-1.5 -translate-x-1/2 text-2xs leading-none font-semibold text-slate-500 dark:text-slate-400">
                {t.label}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Бегунки полей — вертикальные ручки на границе серого и белого */}
      {(['marginLeft', 'marginRight'] as RulerHandle[]).map(h => (
        <button
          key={h} type="button" title={`${HANDLE_TITLE[h]} · ${fmtMm(valueOf(shown, h))}`}
          onPointerDown={start(h)}
          className="absolute top-0 h-5 w-2 -ml-1 cursor-col-resize bg-transparent border-0 p-0"
        style={{ left: leftPx + posPx(h) }}
        >
          <span className="block mx-auto h-5 w-0.5 bg-slate-500 dark:bg-slate-400" />
        </button>
      ))}

      {/* Отступы абзаца: треугольник сверху — красная строка, снизу — отступ */}
      {hasSelection && (
        <>
          <Marker h="firstLine" left={leftPx + posPx('firstLine')} down title={`${HANDLE_TITLE.firstLine} · ${fmtMm(shown.firstLinePt)}`} onDown={start('firstLine')} />
          <Marker h="indentStart" left={leftPx + posPx('indentStart')} title={`${HANDLE_TITLE.indentStart} · ${fmtMm(shown.indentStartPt)}`} onDown={start('indentStart')} />
          <Marker h="indentEnd" left={leftPx + posPx('indentEnd')} title={`${HANDLE_TITLE.indentEnd} · ${fmtMm(shown.indentEndPt)}`} onDown={start('indentEnd')} />
        </>
      )}

      {/* Подсказка со значением — пока тянут, видно число в миллиметрах */}
      {drag && (
        <div
          className="absolute -top-6 z-10 px-1.5 py-0.5 rounded bg-slate-900 text-white text-2xs font-bold whitespace-nowrap -translate-x-1/2"
          style={{ left: leftPx + posPx(drag.h) }}
        >
          {HANDLE_TITLE[drag.h].split(' ')[0]}: {fmtMm(valueOf(shown, drag.h))}
        </div>
      )}
    </div>
  );
}

/** Треугольный бегунок отступа: вершиной вниз — красная строка, вверх — отступ */
function Marker({ h, left, down, title, onDown }: {
  h: RulerHandle; left: number; down?: boolean; title: string; onDown: (e: React.PointerEvent) => void;
}) {
  return (
    <button
      type="button" title={title} onPointerDown={onDown} data-ruler-handle={h}
      className="absolute w-3 h-2 -ml-1.5 cursor-col-resize bg-transparent border-0 p-0"
      style={{ left, top: down ? -2 : 18 }}
    >
      <span
        className="block w-0 h-0 mx-auto"
        style={{
          borderLeft: '5px solid transparent',
          borderRight: '5px solid transparent',
          ...(down
            ? { borderTop: '6px solid currentColor' }
            : { borderBottom: '6px solid currentColor' }),
          color: '#475569',
        }}
      />
    </button>
  );
}

/** Значение величины, за которую тянут */
function valueOf(m: RulerModel, h: RulerHandle): number {
  switch (h) {
    case 'marginLeft': return m.marginLeftPt;
    case 'marginRight': return m.marginRightPt;
    case 'firstLine': return m.firstLinePt;
    case 'indentStart': return m.indentStartPt;
    case 'indentEnd': return m.indentEndPt;
  }
}

/** Что подменить в модели, чтобы показать лист во время перетаскивания */
function patchOf(h: RulerHandle, valuePt: number): Partial<RulerModel> {
  switch (h) {
    case 'marginLeft': return { marginLeftPt: valuePt };
    case 'marginRight': return { marginRightPt: valuePt };
    case 'firstLine': return { firstLinePt: valuePt };
    case 'indentStart': return { indentStartPt: valuePt };
    case 'indentEnd': return { indentEndPt: valuePt };
  }
}

export { ptToMm, mmToPt };
