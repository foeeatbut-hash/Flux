import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useOverlay } from '../store/overlayStore';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import { Z } from '../lib/layers';
import { useWindowStore } from '../store/windowStore';
import { displayAt } from '../../workspace/displays';
import { placeContextMenu, placeSubmenu, type MenuBounds } from '../lib/contextMenu';

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

const MIN_W = 224;

function SubmenuRows({ items, onClose, depth, bounds, parent }: {
  items: MenuItem[]; onClose: () => void; depth: number; bounds: MenuBounds; parent: HTMLDivElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ side: 'left' | 'right'; left: number; top: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const child = ref.current?.getBoundingClientRect();
    const owner = parent?.getBoundingClientRect();
    if (!child || !owner) return;
    const p = placeSubmenu(
      { x: owner.left, y: owner.top, w: owner.width, h: owner.height },
      { x: child.left, y: child.top, w: child.width, h: child.height }, bounds,
    );
    setPlacement(p);
  }, [bounds.x, bounds.y, bounds.w, bounds.h, parent]);
  return createPortal(<div ref={ref} data-context-menu
    className="fx-pop fixed min-w-52 select-none"
    style={{ zIndex: Z.modal + depth + 1, left: placement?.left ?? bounds.x, top: placement?.top ?? bounds.y,
      maxHeight: placement?.maxHeight ?? Math.max(1, bounds.h - 8), maxWidth: Math.max(1, bounds.w - 8), overflowY: 'auto' }}>
    <Rows items={items} onClose={onClose} depth={depth} bounds={bounds} />
  </div>, document.body);
}

function Rows({ items, onClose, depth, bounds }: { items: MenuItem[]; onClose: () => void; depth: number; bounds: MenuBounds }) {
  const [open, setOpen] = useState<number | null>(null);
  const timer = useRef<any>(null);
  const rowRefs = useRef<Record<number, HTMLDivElement | null>>({});
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <>
      {items.map((it, i) => {
        const hasSub = !!it.items?.length;
        return (
          <div key={i} ref={(node) => { rowRefs.current[i] = node; }} className="relative">
            {it.separated && <div className="fx-menu-sep" aria-hidden />}
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
              data-active={open === i}
              className={`fx-menu-item ${it.danger ? 'is-danger' : ''}`}
            >
              <span className="w-4 h-4 flex items-center justify-center shrink-0 text-slate-400 [&>svg]:w-4 [&>svg]:h-4">
                {it.checked ? <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" /> : it.icon}
              </span>
              <span className="flex-1 truncate">{it.label}</span>
              {hasSub && <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-400" />}
            </button>

            {hasSub && open === i && (
              <SubmenuRows items={it.items!} onClose={onClose} depth={depth + 1} bounds={bounds} parent={rowRefs.current[i]} />
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
  const displays = useWindowStore((s) => s.displays);
  const activeDisplayId = useWindowStore((s) => s.activeDisplayId);
  const active = displays.find((d) => d.id === activeDisplayId) || displayAt(displays, x, y);
  const bounds: MenuBounds = active?.workArea || {
    x: 0, y: 0,
    w: typeof window === 'undefined' ? 9999 : window.innerWidth,
    h: typeof window === 'undefined' ? 9999 : window.innerHeight,
  };
  const [position, setPosition] = useState(() => placeContextMenu(x, y, MIN_W, 1, bounds));

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', handleOutside, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    function handleOutside(e: MouseEvent) {
      if ((e.target as Element)?.closest?.('[data-context-menu]')) return;
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    return () => {
      window.removeEventListener('mousedown', handleOutside, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);

  // Замеряем готовую разметку: подписи, разделители и вложенные пункты делают
  // высоту разной, поэтому оценка по числу строк обрезала длинные меню.
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setPosition(placeContextMenu(x, y, rect.width, rect.height, bounds));
  }, [x, y, items, bounds.x, bounds.y, bounds.w, bounds.h]);

  const style: React.CSSProperties = {
    left: position.left,
    top: position.top,
    maxHeight: position.maxHeight,
    maxWidth: position.maxWidth,
    overflow: 'visible',
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
      className="fx-pop fixed min-w-56 select-none"
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
      <div className="overflow-y-auto scrollbar-thin" style={{ maxHeight: position.maxHeight, maxWidth: position.maxWidth }}>
        <Rows items={items} onClose={onClose} depth={0} bounds={bounds} />
      </div>
    </div>,
    document.body,
  );
}
