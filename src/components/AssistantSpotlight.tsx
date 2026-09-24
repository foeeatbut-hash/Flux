import React, { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAssistantStore } from '../store/assistantStore';
import { ChevronRight, X } from 'lucide-react';

interface Rect { top: number; left: number; width: number; height: number; }

/**
 * Первый ВИДИМЫЙ элемент по метке, а не просто первый.
 *
 * В этом и была причина того, что демонстрации показывали не туда. Один и тот
 * же раздел помечен в трёх местах — пункт левого меню, кнопка на панели задач,
 * плитка в Пуске, — и в каждой оболочке видно только одно из них. Обычный поиск
 * возвращал первое совпадение по разметке, то есть чаще всего скрытый пункт
 * меню размером ноль на ноль: подсветка вставала в угол экрана или не
 * появлялась вовсе, а подсказка при этом просила «нажмите подсвеченный
 * элемент».
 */
export function firstVisible(selector: string): HTMLElement | null {
  let list: NodeListOf<Element>;
  try { list = document.querySelectorAll(selector); } catch (_) { return null; }
  for (const el of Array.from(list)) {
    const node = el as HTMLElement;
    const r = node.getBoundingClientRect();
    if (r.width > 2 && r.height > 2) return node;
  }
  return null;
}

// Подсвечивает целевой элемент во время демонстрации и продвигает тур,
// когда пользователь кликает по подсвеченному элементу.
export default function AssistantSpotlight() {
  const activeTour = useAssistantStore(s => s.activeTour);
  const tourStepIndex = useAssistantStore(s => s.tourStepIndex);
  const highlightSelector = useAssistantStore(s => s.highlightSelector);
  const advanceTour = useAssistantStore(s => s.advanceTour);
  const cancelTour = useAssistantStore(s => s.cancelTour);

  const [rect, setRect] = useState<Rect | null>(null);
  /**
   * Элемент не нашёлся за отведённое время.
   *
   * Раньше в этом случае подсветки просто не было, а подсказка всё равно
   * говорила «нажмите подсвеченный элемент». Человек искал глазами то, чего на
   * экране нет, — худший исход для демонстрации, которая учит.
   */
  const [missing, setMissing] = useState(false);
  const elRef = useRef<Element | null>(null);

  const step = activeTour ? activeTour.steps[tourStepIndex] : null;
  const isLast = activeTour ? tourStepIndex >= activeTour.steps.length - 1 : false;

  // Ищем целевой элемент (с учётом того, что страница может ещё грузиться)
  useEffect(() => {
    if (!activeTour) { setRect(null); setMissing(false); elRef.current = null; return; }
    if (!highlightSelector) { setRect(null); setMissing(false); elRef.current = null; return; }
    setMissing(false);

    let cancelled = false;
    let attempts = 0;
    let raf = 0;

    const compute = (el: Element) => {
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };

    const tick = () => {
      if (cancelled) return;
      const el = firstVisible(highlightSelector);
      if (el) {
        elRef.current = el;
        // Прокручиваем элемент в зону видимости только если он реально вне экрана,
        // и через nearest — чтобы не сдвигать весь интерфейс
        try {
          const r = el.getBoundingClientRect();
          const offscreen = r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth;
          if (offscreen) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (_) {}
        compute(el);
      } else if (attempts < 40) {
        attempts++;
        raf = window.setTimeout(tick, 100);
      } else {
        // Ждать дольше бессмысленно: за четыре секунды раздел успевает
        // открыться на любой машине. Значит, элемента тут нет — и сказать об
        // этом надо прямо, а не молча показывать подсказку без подсветки
        setMissing(true);
        setRect(null);
      }
    };
    tick();

    return () => { cancelled = true; if (raf) clearTimeout(raf); };
  }, [activeTour, tourStepIndex, highlightSelector]);

  // Пересчёт позиции при прокрутке/ресайзе и продвижение тура по клику на элемент
  useEffect(() => {
    if (!elRef.current) return;
    const recompute = () => {
      const el = elRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    const onClick = (e: MouseEvent) => {
      const el = elRef.current;
      if (el && (el === e.target || el.contains(e.target as Node))) {
        // даём клику обработаться (навигация/фокус), затем следующий шаг
        setTimeout(() => advanceTour(), 120);
      }
    };
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
      document.removeEventListener('click', onClick, true);
    };
  }, [rect, advanceTour]);

  if (!activeTour || !step) return null;

  const pad = 6;
  const hole = rect ? {
    top: Math.max(0, rect.top - pad),
    left: Math.max(0, rect.left - pad),
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  } : null;

  // Позиция подсказки: под элементом, иначе по центру
  const tipStyle: React.CSSProperties = hole
    ? {
        top: Math.min(window.innerHeight - 160, hole.top + hole.height + 12),
        left: Math.min(window.innerWidth - 340, Math.max(12, hole.left)),
      }
    : { top: window.innerHeight / 2 - 80, left: window.innerWidth / 2 - 170 };

  return createPortal(
    <div className="fixed inset-0 z-[9998] pointer-events-none">
      {/* Подсветка-кольцо вокруг элемента с затемнением остального экрана */}
      {hole && (
        <div
          className="absolute rounded-lg"
          style={{
            top: hole.top, left: hole.left, width: hole.width, height: hole.height,
            boxShadow: '0 0 0 9999px rgba(15,23,42,0.55)',
            border: '2px solid #10b981',
            transition: 'all 0.2s ease',
          }}
        >
          <span className="absolute inset-0 rounded-lg animate-ping" style={{ border: '2px solid #34d399' }} />
        </div>
      )}

      {/* Карточка-подсказка */}
      <div
        className="absolute w-[330px] bg-slate-900 border border-emerald-600/60 rounded-xl shadow-2xl p-3.5 pointer-events-auto"
        style={tipStyle}
      >
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-emerald-400">
            Демонстрация · шаг {tourStepIndex + 1}/{activeTour.steps.length}
          </span>
          <button type="button" onClick={cancelTour} className="p-0.5 text-slate-400 hover:text-rose-400 cursor-pointer" title="Завершить демонстрацию">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="text-xs text-slate-100 leading-relaxed mb-3">{step.text}</p>
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs text-slate-500">
            {!step.target ? 'Нажмите «Далее»'
              : missing ? 'Этого элемента сейчас нет на экране — «Далее»'
                : rect ? 'Нажмите подсвеченный элемент или «Далее»'
                  : 'Ищу элемент на экране…'}
          </span>
          <button type="button"
            onClick={advanceTour}
            className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg cursor-pointer transition-colors"
          >
            {isLast ? 'Завершить' : 'Далее'}
            {!isLast && <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
