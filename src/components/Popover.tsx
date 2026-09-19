/**
 * Список, раскрытый от кнопки, — порталом в body.
 *
 * Зачем отдельный компонент. Лента живёт в полосе с `overflow-y-hidden`:
 * иначе панель инструментов растягивала бы окно, стоило органу не влезть по
 * высоте. Меню схлопнутой группы раскрывалось внутри этой полосы через
 * `position: absolute` — и обрезалось её нижним краем. `z-index` тут не
 * помогает вовсе: обрезающий контейнер режет потомков независимо от слоя.
 *
 * Живой замер на окне шириной 640: полоса кончается на 204-й точке, список
 * занимает с 201-й по 275-ю. Семьдесят одна точка из семидесяти четырёх — под
 * ножом; человек нажимал «⋯» и не видел НИЧЕГО. В узком окне схлопываются все
 * группы разом, то есть лента переставала работать целиком.
 *
 * Лечится единственным способом — вынести список из обрезающего контейнера.
 * Портал в body, место считается от кнопки, у краёв экрана список
 * переворачивается вверх и прижимается к краю. Образец — `ContextMenu.tsx`,
 * он так живёт давно; здесь то же самое, но привязано к кнопке, а не к точке
 * указателя.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOverlay } from '../store/overlayStore';
import { Z } from '../lib/layers';

export interface PopoverProps {
  /** Кнопка, от которой раскрываемся: список встаёт под ней */
  anchor: HTMLElement | null;
  onClose: () => void;
  /** К какому краю кнопки прижимать список */
  align?: 'left' | 'right';
  children: React.ReactNode;
  /** Доступное имя: что это за список */
  label?: string;
  className?: string;
}

/** Отступ от кнопки и от края экрана */
const GAP = 4;
const EDGE = 6;

export default function Popover({ anchor, onClose, align = 'left', children, label, className }: PopoverProps) {
  // Пока открыто, страница браузера уступает место: родной слой Chromium выше
  // любой разметки
  useOverlay(true);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Место считаем ПОСЛЕ отрисовки: до неё неизвестна высота списка, а от неё
  // зависит, вниз он раскроется или вверх
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el || !anchor) return;
      const a = anchor.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Снизу не помещается, а сверху помещается — раскрываемся вверх. Если не
      // помещается нигде, всё равно вниз: обрезать верх хуже, чем низ
      const below = vh - a.bottom - GAP;
      const above = a.top - GAP;
      const up = box.height > below && above > below;
      const top = up ? Math.max(EDGE, a.top - GAP - box.height) : a.bottom + GAP;

      const want = align === 'right' ? a.right - box.width : a.left;
      const left = Math.max(EDGE, Math.min(want, vw - box.width - EDGE));
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, align]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const outside = (e: MouseEvent) => {
      // Нажатие по самой кнопке отдаём кнопке: она переключает открытость сама,
      // иначе закрытие и открытие гасят друг друга и список не открывается
      if (ref.current?.contains(e.target as Node)) return;
      if (anchor?.contains(e.target as Node)) return;
      onClose();
    };
    // Прокрутка уводит кнопку из-под списка — закрываемся, как контекстное меню
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('mousedown', outside, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      /* Та же метка, что у контекстного меню: те, кто закрывается «по нажатию
         мимо себя», должны узнавать наш портал как своё продолжение */
      data-popover
      className={`fixed rounded-xl shadow-2xl select-none bg-white dark:bg-slate-900
                  border border-slate-200 dark:border-slate-800 ${className || ''}`}
      style={{
        zIndex: Z.modal,
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        // До первого замера список не мигает в углу экрана
        visibility: pos ? 'visible' : 'hidden',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
