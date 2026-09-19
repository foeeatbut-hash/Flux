/**
 * Полоса миниатюр страниц слева.
 *
 * Раньше здесь был список надписей «Стр. 1», «Стр. 2» — по нему нельзя узнать
 * страницу, а именно за этим к миниатюрам и идут: в документации поставщика на
 * сорок листов нужный узнают по виду, а не по номеру.
 *
 * Рисуем по одной странице за раз и только те, что видны: сорок страниц,
 * отрисованных разом, подвешивают окно на несколько секунд — а человек в этот
 * момент думает, что программа умерла.
 */
import React, { useEffect, useRef, useState } from 'react';

/** Ширина миниатюры в точках — по ней считается масштаб отрисовки */
const THUMB_W = 88;

export default function PageThumbs({ pdf, pages, page, onPick }: {
  /** Открытый документ pdf.js */
  pdf: any;
  pages: number;
  page: number;
  onPick: (page: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState<Record<number, string>>({});
  /** Сколько страниц уже показано в полосе: остальные подгружаются прокруткой */
  const [shown, setShown] = useState(Math.min(pages, 12));

  useEffect(() => { setShown(Math.min(pages, 12)); setDrawn({}); }, [pdf, pages]);

  // Отрисовка по очереди, по одной странице: очередь важнее скорости — иначе
  // десяток параллельных отрисовок отбирает окно у самой страницы
  useEffect(() => {
    if (!pdf) return;
    let alive = true;
    // Задача отрисовки отменяется явно: флаг останавливает наш цикл, но сама
    // отрисовка — дело pdf.js, и без отмены она дорисовывает миниатюру уже
    // закрытой полосы, отбирая окно у страницы, которую человек смотрит
    let task: any = null;
    (async () => {
      for (let i = 1; i <= shown; i++) {
        if (!alive) return;
        if (drawn[i]) continue;
        try {
          const p = await pdf.getPage(i);
          if (!alive) return;
          const base = p.getViewport({ scale: 1 });
          const view = p.getViewport({ scale: THUMB_W / base.width });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(view.width);
          canvas.height = Math.round(view.height);
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          task = p.render({ canvasContext: ctx, viewport: view });
          await task.promise;
          task = null;
          if (!alive) return;
          const url = canvas.toDataURL('image/png');
          setDrawn((all) => ({ ...all, [i]: url }));
        } catch (_) { /* страница без миниатюры покажется рамкой с номером */ }
      }
    })();
    return () => { alive = false; task?.cancel(); };
  }, [pdf, shown, drawn]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el || shown >= pages) return;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) {
      setShown((n) => Math.min(pages, n + 12));
    }
  };

  return (
    <div ref={boxRef} onScroll={onScroll}
      className="w-32 shrink-0 border-r border-slate-300 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-auto py-2 space-y-2">
      {Array.from({ length: shown }).map((_, i) => {
        const n = i + 1;
        const active = page === n;
        return (
          <button key={n} type="button" onClick={() => onPick(n)}
            title={`Страница ${n}`}
            className={`block w-full px-2 cursor-pointer group`}>
            <span className={`block rounded border overflow-hidden bg-white
              ${active ? 'border-emerald-600 ring-2 ring-emerald-500/30' : 'border-slate-300 dark:border-slate-700 group-hover:border-slate-400'}`}>
              {drawn[n]
                ? <img src={drawn[n]} alt="" className="block w-full" />
                : <span className="block w-full" style={{ height: THUMB_W * 1.41 }} />}
            </span>
            <span className={`block text-2xs mt-0.5 ${active ? 'text-emerald-700 dark:text-emerald-400 font-bold' : 'text-slate-500 dark:text-slate-400'}`}>
              {n}
            </span>
          </button>
        );
      })}
      {shown < pages && (
        <p className="px-2 text-2xs text-slate-400 text-center">ещё {pages - shown}…</p>
      )}
    </div>
  );
}
