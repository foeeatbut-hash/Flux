/**
 * Метка «программа запущена» под кнопкой панели задач — как в Windows 11.
 *
 * Три состояния читаются боковым зрением без чтения подписей:
 *  - active — длинная акцентная черта: окно этой программы наверху;
 *  - open   — короткая серая: программа открыта, но другое окно активно;
 *  - min    — самая короткая и бледная: все окна программы свёрнуты.
 *
 * Метка стоит внутри нижнего края кнопки: полоса кнопок обрезает всё, что
 * выходит за кнопку, и метка под ней оставалась бы невидимой.
 *
 * Ширина метки постоянна, меняется только scaleX: переход идёт на видеокарте
 * (transform), а не пересчётом раскладки, и метка именно «вырастает» при
 * активации. При первом появлении — вырастает из нуля.
 */
import React from 'react';
import { DUR, EASE, reducedMotion } from '../lib/motion';
import { RUN_MARK, RUN_MARK_W } from '../lib/metrics';

export type RunState = 'active' | 'open' | 'min';

/** Доля длины полной (активной) метки */
const SCALE: Record<RunState, number> = { active: 1, open: 6 / RUN_MARK_W, min: 4 / RUN_MARK_W };

const TONE: Record<RunState, string> = {
  active: 'bg-emerald-600 dark:bg-emerald-400',
  open: 'bg-slate-400 dark:bg-slate-500',
  min: 'bg-slate-300 dark:bg-slate-600',
};

export default function TaskbarRunMark({ state }: { state: RunState }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || typeof el.animate !== 'function') return;
    el.animate(
      [{ transform: 'scaleX(0)' }, { transform: `scaleX(${SCALE[state]})` }],
      { duration: DUR.base, easing: EASE.move },
    );
    // Только первое появление: дальше метку ведёт CSS-переход ниже
  }, []);
  return (
    <span
      ref={ref}
      aria-hidden
      data-run-mark={state}
      style={{
        height: RUN_MARK, width: RUN_MARK_W, bottom: 2, left: '50%', marginLeft: -RUN_MARK_W / 2,
        transform: `scaleX(${SCALE[state]})`,
        transition: reducedMotion() ? 'none' : `transform ${DUR.base}ms ${EASE.move}, background-color ${DUR.base}ms ${EASE.move}`,
      }}
      className={`absolute rounded-full ${TONE[state]}`}
    />
  );
}
