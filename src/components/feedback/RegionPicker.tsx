/**
 * Выбор области окна для снимка.
 *
 * Зачем это отдельно от обрезки в редакторе: обрезать можно и потом, но снимок
 * целого окна человек отправляет раньше, чем успевает обрезать, — а на нём
 * рядом с поломкой оказывается открытая переписка в соседней панели. Выбрать
 * сразу дешевле, чем вспомнить потом.
 *
 * Порядок кадров важнее, чем кажется. Рамка и затемнение — часть того же окна,
 * и если снять его, не убрав их, они попадут на снимок. Поэтому: показать
 * выбор → убрать его → дождаться настоящего нарисованного кадра → снять.
 *
 * Координаты отдаются в независимых точках клиентской области — тех же, в
 * которых работает разметка. Пересчёт в настоящие пиксели делает оболочка: она
 * знает масштаб именно этого экрана, а окно на втором мониторе с другим
 * масштабом посчитало бы это неверно.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Z } from '../../lib/layers';
import { MIN_REGION_DIP, clampRect, rectOf, type Rect } from '../../feedback/shapes';

export default function RegionPicker({ onPick, onCancel }: {
  onPick: (region: Rect) => void;
  onCancel: () => void;
}) {
  const [from, setFrom] = useState<{ x: number; y: number } | null>(null);
  const [to, setTo] = useState<{ x: number; y: number } | null>(null);
  const [tooSmall, setTooSmall] = useState(false);
  const surface = useRef<HTMLDivElement>(null);

  // Отмена клавишей — здесь же, а не общим обработчиком: выбор области
  // перекрывает всё окно, и уйти из него надо уметь, ничего не выбрав
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onCancel]);

  const point = (event: React.PointerEvent) => ({ x: event.clientX, y: event.clientY });

  const done = (event: React.PointerEvent) => {
    if (!from) return;
    const end = point(event);
    setFrom(null);
    setTo(null);
    const box = rectOf(from.x, from.y, end.x, end.y);
    const fitted = clampRect(box, window.innerWidth, window.innerHeight);
    if (!fitted) {
      // Случайное нажатие мышью — не повод снимать точку в шестнадцать
      // пикселей и не повод молча закрыть выбор
      setTooSmall(true);
      return;
    }
    onPick(fitted);
  };

  const box = from && to ? rectOf(from.x, from.y, to.x, to.y) : null;

  return (
    <div ref={surface} style={{ zIndex: Z.modal }}
      className="fixed inset-0 cursor-crosshair select-none touch-none"
      onPointerDown={(e) => { setTooSmall(false); setFrom(point(e)); setTo(point(e)); }}
      onPointerMove={(e) => { if (from) setTo(point(e)); }}
      onPointerUp={done}
      onPointerCancel={() => { setFrom(null); setTo(null); }}>
      {/* Затемнение четырьмя полосами вокруг выбранного: так видно, что именно
          попадёт на снимок, а вырезать «дырку» в одном слое нечем */}
      {[
        { top: 0, left: 0, right: 0, height: box ? box.y : '100%' },
        ...(box ? [
          { top: box.y, left: 0, width: box.x, height: box.height },
          { top: box.y, left: box.x + box.width, right: 0, height: box.height },
          { top: box.y + box.height, left: 0, right: 0, bottom: 0 },
        ] : []),
      ].map((style, index) => (
        <div key={index} style={style as React.CSSProperties} className="absolute bg-slate-950/50" />
      ))}

      {box && (
        <div className="absolute border-2 border-emerald-400"
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}>
          <span className="absolute -top-6 left-0 px-1.5 py-0.5 rounded bg-emerald-600 text-white text-2xs font-semibold whitespace-nowrap">
            {Math.round(box.width)} × {Math.round(box.height)}
          </span>
        </div>
      )}

      <div className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-2 rounded-lg bg-slate-900/90 text-white
                      text-xs font-semibold shadow-lg">
        {tooSmall
          ? `Слишком маленькая область — не меньше ${MIN_REGION_DIP}×${MIN_REGION_DIP} точек`
          : 'Обведите то, что показать. Esc — отмена'}
      </div>
    </div>
  );
}
