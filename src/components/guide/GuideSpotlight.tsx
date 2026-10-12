import React, { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useGuideStore } from '../../guide/store';
import { evaluateTourResult, expectedResultForStep, tourRequiresProject } from '../../guide/tourRuntime';
import { ChevronLeft, ChevronRight, Pause, Play, SkipForward, X } from 'lucide-react';
import { activeWindowPath, useWindowStore } from '../../store/windowStore';

interface Rect { top: number; left: number; width: number; height: number; }
interface Viewport { width: number; height: number; }

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
  const [resultPresentAtEntry, setResultPresentAtEntry] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [darkTheme, setDarkTheme] = useState(() => document.documentElement.classList.contains('dark'));
  const [viewport, setViewport] = useState<Viewport>(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const elRef = useRef<Element | null>(null);

  const step = activeTour ? activeTour.steps[tourStepIndex] : null;
  const isLast = activeTour ? tourStepIndex >= activeTour.steps.length - 1 : false;

  useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    const observer = new MutationObserver(() => setDarkTheme(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

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
    if (!activeTour || !step || paused) return;
    setResultPresentAtEntry(false);
    let initialProbe = true;
    const checkExpectedResult = () => {
      if (useGuideStore.getState().tourStepCompleted) return;
      const expected = expectedResultForStep(step);
      if (!expected) return;
      const windows = useWindowStore.getState();
      const probe = {
        activeRoute: activeWindowPath(windows.windows, windows.desk),
        projectSelected: !!activeProjectGetter?.(),
        visible: (selector: string) => !!firstVisible(selector),
        text: (selector: string) => firstVisible(selector)?.innerText || '',
        attribute: (selector: string, name: string) => firstVisible(selector)?.getAttribute(name) || null,
        value: (selector: string) => {
          const element = firstVisible(selector);
          if (!element) return '';
          return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.value : element.innerText || element.textContent || '';
        },
      };
      const matched = evaluateTourResult(expected, probe);
      if (matched) {
        if (initialProbe) setResultPresentAtEntry(true);
        completeTourStep();
      }
      initialProbe = false;
    };
    const recompute = () => {
      const el = elRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    const observer = window.setInterval(checkExpectedResult, 300);
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
    document.addEventListener('click', checkExpectedResult, true);
    document.addEventListener('input', checkExpectedResult, true);
    document.addEventListener('change', checkExpectedResult, true);
    checkExpectedResult();
    return () => {
      clearInterval(observer);
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
      document.removeEventListener('click', checkExpectedResult, true);
      document.removeEventListener('input', checkExpectedResult, true);
      document.removeEventListener('change', checkExpectedResult, true);
    };
  }, [activeTour, step, paused, activeProjectGetter, completeTourStep]);

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

  const tipWidth = Math.max(0, Math.min(330, viewport.width - 24));
  const maxLeft = Math.max(12, viewport.width - tipWidth - 12);
  const rightCandidate = hole ? hole.left + hole.width + 12 : 12;
  const leftCandidate = hole ? hole.left - tipWidth - 12 : 12;
  const tipLeft = hole && rightCandidate <= maxLeft
    ? rightCandidate
    : hole && leftCandidate >= 12
      ? leftCandidate
      : Math.max(12, Math.min(maxLeft, hole?.left || 12));
  const topCandidate = hole ? hole.top + hole.height + 12 : (viewport.height - 200) / 2;
  const tipTop = Math.max(12, Math.min(Math.max(12, viewport.height - 220), topCandidate));
  const tipStyle: React.CSSProperties = {
    position: 'absolute', top: tipTop, left: tipLeft, width: tipWidth,
    maxHeight: Math.max(120, viewport.height - 24), overflowY: 'auto',
    backgroundColor: darkTheme ? 'var(--color-dark-panel)' : '#fff',
    color: darkTheme ? 'var(--color-dark-text-main)' : '#1f2937',
  };

  return createPortal(
    <div className="fixed inset-0 z-[9998] pointer-events-none" style={{ position: 'fixed', inset: 0, zIndex: 9998, pointerEvents: 'none' }}>
      {hole && (
        <div
          className="absolute rounded-lg"
          style={{
            position: 'absolute',
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
        className="absolute bg-white dark:bg-dark-panel border border-emerald-600/60 rounded-xl shadow-sm p-3.5 pointer-events-auto"
        style={{ ...tipStyle, pointerEvents: 'auto' }}
      >
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            Flux Guide · шаг {tourStepIndex + 1}/{activeTour.steps.length}
          </span>
          <button type="button" onClick={cancelTour} className="p-0.5 text-slate-500 dark:text-dark-text-muted hover:text-rose-600 dark:hover:text-rose-400 cursor-pointer" title="Завершить демонстрацию">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="text-xs text-slate-800 dark:text-dark-text-main leading-relaxed mb-3" style={{ color: darkTheme ? 'var(--color-dark-text-main)' : '#1f2937' }}>{step.text}</p>
        {projectRequired && !hasActiveProject && <p role="status" className="text-xs text-amber-700 dark:text-amber-300 mb-2">Проект не выбран. Приостановите демонстрацию, выберите проект на панели Flux и продолжите.</p>}
        {missing && <p role="status" className="text-xs text-amber-700 dark:text-amber-300 mb-2">{unavailable ? 'Элемент сейчас недоступен. Проверьте права и завершение загрузки.' : 'Не вижу нужный элемент. Проверьте открытую вкладку и доступ к функции.'}</p>}
        {missing && <button type="button" onClick={() => { setMissing(false); setUnavailable(false); setRetryNonce((n) => n + 1); }} className="text-xs text-emerald-700 dark:text-emerald-400 underline underline-offset-2 mb-2">Проверить снова</button>}
        {paused && <p role="status" className="text-xs text-slate-600 dark:text-dark-text-muted mb-2">Демонстрация приостановлена.</p>}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <span className="text-2xs text-slate-600 dark:text-dark-text-muted sm:max-w-44" style={{ color: darkTheme ? 'var(--color-dark-text-muted)' : '#475569' }}>
            {paused ? 'Продолжите, когда будете готовы'
              : step.requiredContext ? 'Нужно выбрать проект, чтобы продолжить'
              : !step.target ? 'Информационный шаг'
              : missing ? 'Цели нет на экране. Повторите поиск, пропустите шаг или завершите демонстрацию.'
                : resultPresentAtEntry ? 'Ожидаемое состояние уже есть. Проверьте его; повторять действие не нужно.'
                : stepCompleted ? 'Ожидаемый результат появился. Можно перейти дальше.'
                  : rect ? 'Ожидаю указанный результат на экране'
                  : 'Ищу элемент на экране…'}
          </span>
          <div className="flex items-center gap-1 self-end">
            <button type="button" onClick={backTour} disabled={tourStepIndex === 0} title="Назад" className="p-1.5 text-slate-600 dark:text-dark-text-muted disabled:opacity-40" style={{ color: darkTheme ? 'var(--color-dark-text-muted)' : '#475569' }}><ChevronLeft className="w-4 h-4" /></button>
            <button type="button" onClick={pauseTour} title={paused ? 'Продолжить' : 'Пауза'} className="p-1.5 text-slate-600 dark:text-dark-text-muted" style={{ color: darkTheme ? 'var(--color-dark-text-muted)' : '#475569' }}>{paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}</button>
            {!step.requiredContext && <button type="button" onClick={skipTourStep} title="Пропустить шаг" className="p-1.5 text-slate-600 dark:text-dark-text-muted" style={{ color: darkTheme ? 'var(--color-dark-text-muted)' : '#475569' }}><SkipForward className="w-4 h-4" /></button>}
            <button type="button" onClick={advanceTour} disabled={paused || ((!!step.target || !!step.requiredContext) && !stepCompleted)} className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 enabled:hover:bg-emerald-500 disabled:opacity-40 text-white text-xs rounded-lg">
              {isLast ? 'Завершить' : 'Далее'}{!isLast && <ChevronRight className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
