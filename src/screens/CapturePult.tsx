import React, { useEffect, useRef, useState } from 'react';
import { Scissors, Frame, Check, X, Plus } from 'lucide-react';

/**
 * Свёрнутый пульт захвата. Живёт в отдельном окне Electron поверх всех окон,
 * пока главное окно скрыто.
 *
 * Строка подсказки — единственное, что инженер читает во время захвата,
 * поэтому она всегда говорит, что происходит и чего от него ждут.
 */

type State =
  | { name: 'idle' }
  | { name: 'stale' }
  | { name: 'ready'; kind: 'text' | 'table' | 'image'; lines: number; chars: number; cells: number;
      truncated: number; preview?: string }
  | { name: 'basket'; count: number; lines: number };

type Tone = 'idle' | 'ok' | 'warn' | 'info';

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};

function describe(s: State): { tone: Tone; hint: string; count: string; live: boolean } {
  switch (s.name) {
    case 'stale':
      return { tone: 'warn', hint: 'Выделение не изменилось — выделите текст и скопируйте', count: 'то же, что было', live: false };
    case 'basket':
      return {
        tone: 'ok',
        hint: `В корзине ${s.count} ${plural(s.count, 'захват', 'захвата', 'захватов')} — разобрать?`,
        count: `${s.lines} ${plural(s.lines, 'строка', 'строки', 'строк')}`,
        live: true,
      };
    case 'ready': {
      if (s.kind === 'image') {
        return { tone: 'info', hint: 'В буфере картинка — распознавание появится позже', count: 'картинка', live: false };
      }
      if (s.truncated) {
        return {
          tone: 'warn',
          hint: `Захвачено много — возьму первые ${s.chars.toLocaleString('ru')} знаков`,
          count: `+${s.truncated.toLocaleString('ru')} знаков отрезано`,
          live: true,
        };
      }
      if (s.kind === 'table') {
        return {
          tone: 'ok',
          hint: `Захвачена таблица: ${s.lines} ${plural(s.lines, 'строка', 'строки', 'строк')}`,
          count: `${s.cells} ${plural(s.cells, 'ячейка', 'ячейки', 'ячеек')}`,
          live: true,
        };
      }
      return {
        tone: 'ok',
        hint: `Захвачено: ${s.lines} ${plural(s.lines, 'строка', 'строки', 'строк')}`,
        count: `${s.chars.toLocaleString('ru')} ${plural(s.chars, 'знак', 'знака', 'знаков')}`,
        live: true,
      };
    }
    default:
      return { tone: 'idle', hint: 'Выделите текст для добавления в программу', count: 'жду копирования', live: false };
  }
}

const TONE_BG: Record<Tone, string> = {
  idle: 'bg-slate-100 dark:bg-slate-800',
  ok: 'bg-emerald-50 dark:bg-emerald-950/50',
  warn: 'bg-amber-50 dark:bg-amber-950/50',
  info: 'bg-sky-50 dark:bg-sky-950/50',
};
const TONE_DOT: Record<Tone, string> = {
  idle: 'bg-slate-400',
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  info: 'bg-sky-500',
};

export default function CapturePult() {
  const [state, setState] = useState<State>({ name: 'idle' });
  const [basket, setBasket] = useState(0);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const api = (window as any).electron?.capture;

  useEffect(() => {
    if (!api) return;
    api.sync().then((d: any) => { if (d) { setState(d.state); setBasket(d.basket); } }).catch(() => {});
    return api.onState((d: any) => { setState(d.state); setBasket(d.basket); });
  }, []);

  // Окно без рамки таскаем сами: -webkit-app-region ломает нажатия на кнопки
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return;
      api?.move(e.screenX - drag.current.x, e.screenY - drag.current.y);
      drag.current = { x: e.screenX, y: e.screenY };
    };
    const up = () => { drag.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  const d = describe(state);
  const hasCurrent = state.name === 'ready' && state.kind !== 'image';
  const preview = state.name === 'ready' ? (state.preview || '') : '';

  return (
    <div className="w-full h-full p-1.5 select-none" style={{ background: 'transparent' }}>
      <div className="fx-dialog w-full h-full overflow-hidden flex flex-col">
        <div
          className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold cursor-move
                      text-slate-800 dark:text-slate-100 ${TONE_BG[d.tone]}`}
          onMouseDown={(e) => { drag.current = { x: e.screenX, y: e.screenY }; }}
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${TONE_DOT[d.tone]}`} />
          <span className="leading-snug">{d.hint}</span>
        </div>

        <div className="flex items-center gap-2 px-3 py-1.5">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-md border border-emerald-600 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
            <Scissors className="w-3 h-3" /> Текст
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-slate-400 opacity-60"
                title="Снимок области с распознаванием — следующим этапом">
            <Frame className="w-3 h-3" /> Область
          </span>
          {basket > 0 ? (
            <button
              onClick={() => api?.clearBasket()}
              title="Очистить корзину"
              className="fx-btn fx-btn-danger fx-btn-sm ml-auto"
            >
              корзина {basket} <X className="w-2.5 h-2.5" />
            </button>
          ) : (
            <span className="ml-auto text-2xs font-mono text-slate-300 dark:text-slate-500">Ctrl+Shift+X</span>
          )}
        </div>

        {/* Что именно взято — чтобы не разворачивать программу ради проверки */}
        <div className="px-3 pb-1 h-4">
          {preview && (
            <div className="text-2xs font-mono text-slate-400 dark:text-slate-500 truncate" title={preview}>
              {preview}
            </div>
          )}
        </div>

        <div className="mt-auto flex items-center gap-2 px-3 py-2 border-t border-slate-100 dark:border-slate-800
                        bg-slate-50 dark:bg-slate-800/50">
          <span className="flex-1 text-2xs font-mono text-slate-500 dark:text-slate-400 truncate">{d.count}</span>
          <button
            onClick={() => api?.toBasket()}
            disabled={!hasCurrent}
            title="Отложить и захватить ещё"
            className="w-7 h-7 grid place-items-center rounded-md border border-slate-200 dark:border-slate-700
                       text-slate-500 hover:text-emerald-600 disabled:opacity-35 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => api?.confirm()}
            disabled={!d.live}
            title="Разобрать в программе"
            className={`w-7 h-7 grid place-items-center rounded-md cursor-pointer border
                        ${d.live
                          ? 'bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700'
                          : 'border-slate-200 dark:border-slate-700 text-slate-400 opacity-40'}`}
          >
            <Check className="w-4 h-4" />
          </button>
          <button
            onClick={() => api?.cancel()}
            title="Выйти из захвата"
            className="w-7 h-7 grid place-items-center rounded-md border border-slate-200 dark:border-slate-700
                       text-slate-500 hover:text-rose-500 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
