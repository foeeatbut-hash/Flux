/**
 * Панель долей экрана у кнопки разворота.
 *
 * Шесть картинок без единой подписи: доли нарисованы в тех же пропорциях, в
 * каких встанут окна. Слова тут мешали бы — «две трети слева, треть справа»
 * читается дольше, чем рисунок этого же.
 *
 * Наведение на долю зажигает место на самом столе: человек видит, куда встанет
 * окно, до того как нажал.
 */
import React from 'react';
import { layoutsFor, type Layout, type Share } from '../lib/layouts';
import type { Area } from '../lib/windows';

/** Картинка раскладки: 92 × 58, промежуток 3, поля 3 — числа из разбора */
const CARD_W = 92;
const CARD_H = 58;
const GAP = 8;
export const PANEL_W = CARD_W * 2 + GAP + 16;

/** Высота панели зависит от числа раскладок: на узком столе их меньше */
export const panelHeight = (count: number) =>
  Math.ceil(count / 2) * CARD_H + (Math.ceil(count / 2) - 1) * GAP + 16;

export default function SnapPanel({ area, x, y, onPick, onHover, onClose }: {
  area: Area;
  x: number;
  y: number;
  /** Выбрали долю: раскладка и её номер — оболочка ставит окно и предлагает соседей */
  onPick: (layout: Layout, index: number) => void;
  /** Курсор над долей — подсветить место на столе. null, когда ушёл */
  onHover: (share: Share | null) => void;
  onClose: () => void;
}) {
  const layouts = React.useMemo(() => layoutsFor(area), [area.w, area.h]);
  const [pick, setPick] = React.useState<{ l: number; s: number } | null>(null);

  // Клавиатура: цифра выбирает раскладку целиком — окно встаёт в первую долю.
  // Esc закрывает, ничего не двигая
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= layouts.length) {
        e.preventDefault();
        onPick(layouts[n - 1], 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layouts, onPick, onClose]);

  if (!layouts.length) return null;

  return (
    <>
      {/* Нажатие мимо закрывает панель, окно при этом не двигается */}
      <div className="absolute inset-0 z-[60]" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        role="group"
        aria-label="Куда поставить окно"
        className="fx-pop absolute z-[61] p-2"
        style={{ left: x, top: y, width: PANEL_W, display: 'grid', gap: GAP, gridTemplateColumns: `repeat(2, ${CARD_W}px)` }}
        onMouseLeave={() => { setPick(null); onHover(null); }}
      >
        {layouts.map((l, li) => (
          <div key={l.id} title={l.name}
            className="relative rounded-md border border-slate-200 dark:border-slate-800
                       bg-slate-50 dark:bg-slate-950 overflow-hidden"
            style={{ width: CARD_W, height: CARD_H }}>
            {l.shares.map((s, si) => {
              const on = pick?.l === li && pick?.s === si;
              return (
                <button
                  key={si}
                  type="button"
                  aria-label={`${l.name}: доля ${si + 1}`}
                  onMouseEnter={() => { setPick({ l: li, s: si }); onHover(s); }}
                  onClick={() => onPick(l, si)}
                  className={`absolute rounded-sm cursor-pointer transition-colors ${
                    on ? 'bg-emerald-600' : 'bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700'
                  }`}
                  style={{
                    left: `calc(${s.x * 100}% + 3px)`,
                    top: `calc(${s.y * 100}% + 3px)`,
                    width: `calc(${s.w * 100}% - 6px)`,
                    height: `calc(${s.h * 100}% - 6px)`,
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
