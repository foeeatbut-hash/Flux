import React, { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useGuideStore } from '../../guide/store';
import { isTourTargetInteraction, tourRequiresProject } from '../../guide/tourRuntime';
import { ChevronLeft, ChevronRight, Pause, Play, SkipForward, X } from 'lucide-react';

interface Rect { top: number; left: number; width: number; height: number; }

/**
 * Первый ВИДИМЫЙ элемент по метке, а не просто первый.
 *
 * Один и тот же раздел помечен в трёх местах — пункт левого меню, кнопка на
 * панели задач, плитка в Пуске, — и в каждой оболочке видно только одно из них.
 * Обычный поиск возвращал бы скрытый элемент нулевого размера: подсветка
 * вставала бы в угол экрана.
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

/**
 * Подсветка целевого элемента обучающего сценария Flux Guide.
 *
 * Механика та же, что была у демонстраций: тень-затемнение вокруг подсвеченной
 * кнопки, подсказка с номером шага, продвижение кликом по цели или «Далее».
 * Состояние тура живёт в store Guide (src/guide/store.ts), а не у старого
 * помощника — сценарий один, оболочка одна (ТЗ §14).
 */
export default function GuideSpotlight() {
  const activeTour = useGuideStore((s) => s.activeTour);
  const tourStepIndex = useGuideStore((s) => s.tourStepIndex);
  const highlightSelector = useGuideStore((s) => s.highlightSelector);
  const advanceTour = useGuideStore((s) => s.advanceTour);
  const cancelTour = useGuideStore((s) => s.cancelTour);
  const backTour = useGuideStore((s) => s.backTour);
  const pauseTour = useGuideStore((s) => s.pauseTour);
  const skipTourStep = useGuideStore((s) => s.skipTourStep);
  const completeTourStep = useGuideStore((s) => s.completeTourStep);
  const paused = useGuideStore((s) => s.tourPaused);
  const stepCompleted = useGuideStore((s) => s.tourStepCompleted);
  const activeProjectGetter = useGuideStore((s) => s.activeProjectGetter);

  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const elRef = useRef<Element | null>(null);

  const step = activeTour ? activeTour.steps[tourStepIndex] : null;
  const isLast = activeTour ? tourStepIndex >= activeTour.steps.length - 1 : false;

  useEffect(() => {
    if (!activeTour || paused) { setRect(null); setMissing(false); setUnavailable(false); elRef.current = null; return; }
    if (!highlightSelector) { setRect(null); setMissing(false); setUnavailable(false); elRef.current = null; return; }
    setMissing(false);
    setUnavailable(false);

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
        const disabled = (el as HTMLButtonElement).disabled
          || el.getAttribute('aria-disabled') === 'true';
        if (disabled) {
          setUnavailable(true);
          setMissing(true);
          setRect(null);
          return;
        }
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
        setMissing(true);
        setRect(null);
      }
    };
    tick();

    return () => { cancelled = true; if (raf) clearTimeout(raf); };
  }, [activeTour, tourStepIndex, highlightSelector, paused, retryNonce]);

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
      if (isTourTargetInteraction(e.target, el)) {
        // Цель лишь отмечается как выполненная: сотрудник сам выбирает момент
        // перехода, а действие на странице не должно запускать автопереход.
        completeTourStep();
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
  }, [rect, completeTourStep]);

  if (!activeTour || !step) return null;
  const projectRequired = tourRequiresProject(activeTour.id);
  const hasActiveProject = !!activeProjectGetter?.();

  const pad = 6;
  const hole = rect ? {
    top: Math.max(0, rect.top - pad),
    left: Math.max(0, rect.left - pad),
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  } : null;

  const tipStyle: React.CSSProperties = hole
    ? {
        top: Math.min(window.innerHeight - 160, hole.top + hole.height + 12),
        left: Math.min(window.innerWidth - 340, Math.max(12, hole.left)),
      }
    : { top: window.innerHeight / 2 - 80, left: window.innerWidth / 2 - 170 };

  return createPortal(
    <div className="fixed inset-0 z-[9998] pointer-events-none">
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

      <div
        className="absolute w-[330px] bg-white dark:bg-dark-panel border border-emerald-600/60 rounded-xl shadow-lg p-3.5 pointer-events-auto"
        style={tipStyle}
      >
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            Flux Guide · шаг {tourStepIndex + 1}/{activeTour.steps.length}
          </span>
          <button type="button" onClick={cancelTour} className="p-0.5 text-slate-500 dark:text-dark-text-muted hover:text-rose-600 dark:hover:text-rose-400 cursor-pointer" title="Завершить демонстрацию">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="text-xs text-slate-800 dark:text-dark-text-main leading-relaxed mb-3">{step.text}</p>
        {projectRequired && !hasActiveProject && <p role="status" className="text-xs text-amber-700 dark:text-amber-300 mb-2">Проект не выбран. Приостановите демонстрацию, выберите проект на панели Flux и продолжите.</p>}
        {missing && <p role="status" className="text-xs text-amber-700 dark:text-amber-300 mb-2">{unavailable ? 'Элемент сейчас недоступен. Проверьте права и завершение загрузки.' : 'Не вижу нужный элемент. Проверьте открытую вкладку и доступ к функции.'}</p>}
        {missing && <button type="button" onClick={() => { setMissing(false); setUnavailable(false); setRetryNonce((n) => n + 1); }} className="text-xs text-emerald-700 dark:text-emerald-400 underline underline-offset-2 mb-2">Проверить снова</button>}
        {paused && <p role="status" className="text-xs text-slate-600 dark:text-dark-text-muted mb-2">Демонстрация приостановлена.</p>}
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs text-slate-600 dark:text-dark-text-muted">
            {paused ? 'Продолжите, когда будете готовы'
              : !step.target ? 'Информационный шаг'
              : missing ? 'Этого элемента сейчас нет на экране — «Далее»'
                : stepCompleted ? 'Действие замечено. Перейдите к следующему шагу.'
                  : rect ? 'Выполните действие на подсвеченном элементе'
                  : 'Ищу элемент на экране…'}
          </span>
          <div className="flex items-center gap-1">
            <button type="button" onClick={backTour} disabled={tourStepIndex === 0} title="Назад" className="p-1.5 text-slate-600 dark:text-dark-text-muted disabled:opacity-40"><ChevronLeft className="w-4 h-4" /></button>
            <button type="button" onClick={pauseTour} title={paused ? 'Продолжить' : 'Пауза'} className="p-1.5 text-slate-600 dark:text-dark-text-muted">{paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}</button>
            <button type="button" onClick={skipTourStep} title="Пропустить шаг" className="p-1.5 text-slate-600 dark:text-dark-text-muted"><SkipForward className="w-4 h-4" /></button>
            <button type="button" onClick={advanceTour} disabled={paused || (!!step.target && !stepCompleted)} className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 enabled:hover:bg-emerald-500 disabled:opacity-40 text-white text-xs rounded-lg">
              {isLast ? 'Завершить' : 'Далее'}{!isLast && <ChevronRight className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
