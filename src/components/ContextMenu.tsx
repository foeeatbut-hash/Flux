import React, { useEffect, useRef, useState } from 'react';
import { useOverlay } from '../store/overlayStore';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import { Z } from '../lib/layers';

/**
 * Контекстное меню (ПКМ) в стиле системы: портал поверх всего, закрывается по
 * нажатию мимо, Escape и прокрутке.
 *
 * Умеет подменю и разделители — и это не украшение. Список в полтора десятка
 * строк читается медленнее, чем короткий список с раскрытиями: глаз ищет
 * строку среди семи, а не среди пятнадцати. Правило одно на всю программу —
 * верхний уровень не длиннее семи пунктов, остальное уходит в подменю
 * (см. docs/os-design.md, §4.4).
 */
export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Отметка «выбрано» — как в системном меню «Вид» */
  checked?: boolean;
  /** Черта перед пунктом: отделяет опасное и разное по смыслу */
  separated?: boolean;
  /** Подменю; тогда onClick не нужен */
  items?: MenuItem[];
  onClick?: () => void;
}

/** Высота строки и запас на рамку — по ним меню решает, куда ему открыться */
const ROW = 30;
const FRAME = 16;
const MIN_W = 224;

function Rows({ items, onClose, depth }: { items: MenuItem[]; onClose: () => void; depth: number }) {
  const [open, setOpen] = useState<number | null>(null);
  const timer = useRef<any>(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <>
      {items.map((it, i) => {
        const hasSub = !!it.items?.length;
        return (
          <div key={i} className="relative">
            {it.separated && <div className="my-1 h-px bg-slate-200 dark:bg-slate-700" aria-hidden />}
            <button
              type="button"
              disabled={it.disabled}
              aria-haspopup={hasSub || undefined}
              aria-expanded={hasSub ? open === i : undefined}
              onMouseEnter={() => {
                clearTimeout(timer.current);
                // Подменю ждёт четверть секунды: движение мыши наискось через
                // соседний пункт не должно открывать чужой список
                if (hasSub) timer.current = setTimeout(() => setOpen(i), 220);
                else setOpen(null);
              }}
              onMouseLeave={() => clearTimeout(timer.current)}
              onClick={() => {
                if (hasSub) { setOpen(open === i ? null : i); return; }
                onClose();
                it.onClick?.();
              }}
              className={`w-full flex items-center gap-2.5 px-3.5 py-1.5 text-left text-xs font-semibold
                          cursor-pointer disabled:opacity-40 disabled:cursor-default ${
                it.danger
                  ? 'text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              } ${open === i ? 'bg-slate-100 dark:bg-slate-800' : ''}`}
            >
              <span className="w-4 h-4 flex items-center justify-center shrink-0">
                {it.checked ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : it.icon}
              </span>
              <span className="flex-1 truncate">{it.label}</span>
              {hasSub && <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-400" />}
            </button>

            {hasSub && open === i && (
              <div
                onMouseEnter={() => clearTimeout(timer.current)}
                className="absolute top-[-6px] left-full ml-0.5 min-w-52 py-1.5 rounded-xl select-none
                           bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-2xl"
                style={{ zIndex: Z.modal + depth + 1 }}
              >
                <Rows items={it.items!} onClose={onClose} depth={depth + 1} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export default function ContextMenu({ x, y, items, onClose }: {
  x: number; y: number; items: MenuItem[]; onClose: () => void;
}) {
  // Пока это открыто, страница браузера уступает место: родной слой Chromium
  // выше любой разметки, и без этого панель оказалась бы под страницей
  useOverlay(true);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', handleOutside, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    return () => {
      window.removeEventListener('mousedown', handleOutside, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);

  // Не выезжаем за края окна. Подменю раскрывается вправо, поэтому справа
  // оставляем место и под него: меню, упёршееся в край, открыло бы список
  // за экраном
  const vw = typeof window !== 'undefined' ? window.innerWidth : 9999;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 9999;
  const deep = items.some((i) => i.items?.length);
  const style: React.CSSProperties = {
    left: Math.max(4, Math.min(x, vw - MIN_W - (deep ? MIN_W : 0))),
    top: Math.max(4, Math.min(y, vh - items.length * ROW - FRAME)),
    zIndex: Z.modal,
  };

  return createPortal(
    <div
      ref={ref}
      /* Метка для тех, кто закрывается «по нажатию мимо себя»: меню — портал в
         body, и без метки такое нажатие читается как «мимо». Пуск на этом и
         спотыкался: нажатие по пункту его меню сначала закрывало сам Пуск,
         пункт исчезал вместе с ним, и до срабатывания дело не доходило */
      data-context-menu
      className="fixed min-w-56 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700
                 rounded-xl shadow-2xl select-none"
      style={style}
      onContextMenu={(e) => e.preventDefault()}
      /* Меню — портал в body, но события React пускает по дереву компонентов, а
         не по дереву узлов: нажатие в меню доходило до того, над чем меню
         открыто. На рабочем столе это стоило пункту меню срабатывания — стол
         перехватывал указатель на своё выделение рамкой, и мышь отпускалась уже
         не над кнопкой, так что нажатия не случалось вовсе */
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Rows items={items} onClose={onClose} depth={0} />
    </div>,
    document.body,
  );
}
