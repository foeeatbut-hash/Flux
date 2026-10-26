/**
 * Метка «программа запущена» под кнопкой панели задач.
 *
 * Ширина метки постоянна, меняется только scaleX: активная кнопка получает
 * длинную метку, запущенная неактивная — короче. Так переход идёт на видеокарте
 * (transform), а не пересчётом раскладки, и метка именно «вырастает» при
 * активации. При первом появлении — вырастает из нуля.
 */
import React from 'react';
import { DUR, EASE, reducedMotion } from '../lib/motion';
import { RUN_MARK } from '../lib/metrics';

/** Доля длины неактивной метки: прежние поля 24% против 16% у активной */
const IDLE_SCALE = 52 / 68;

export default function TaskbarRunMark({ active }: { active: boolean }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || typeof el.animate !== 'function') return;
    el.animate(
      [{ transform: 'scaleX(0)' }, { transform: `scaleX(${active ? 1 : IDLE_SCALE})` }],
      { duration: DUR.base, easing: EASE.move },
    );
    // Только первое появление: дальше метку ведёт CSS-переход ниже
  }, []);
  return (
    <span
      ref={ref}
      aria-hidden
      style={{
        height: RUN_MARK, bottom: -5,
        transform: `scaleX(${active ? 1 : IDLE_SCALE})`,
        transition: reducedMotion() ? 'none' : `transform ${DUR.base}ms ${EASE.move}`,
      }}
      className="absolute left-[16%] right-[16%] rounded-sm bg-emerald-600 dark:bg-emerald-400"
    />
  );
}
