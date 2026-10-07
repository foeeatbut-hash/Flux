/**
 * Своё содержимое в заголовке окна: вкладки Проводника вместо названия раздела.
 *
 * Раздел вызывает `useWindowTitleBar(<Вкладки />, { height: 38, className })` и
 * кладёт результат в свою разметку. В окне содержимое уходит порталом в
 * заголовок рамы, а рама перестаёт рисовать значок и название; в панели и вне
 * окон — остаётся на месте вызова, поэтому раздел не знает, где он живёт.
 *
 * Кнопки окна (свернуть, развернуть с долями, закрыть) рама рисует сама, и
 * перетаскивание за пустое место полосы тоже её: содержимое слота получает
 * `pointer-events: none`, а интерактивные элементы сами включают `auto`.
 * Нажатие на пустое место проходит сквозь содержимое на узел-место, и это
 * нажатие рама уже умеет читать как начало перетаскивания. Обратной
 * стороной того же устройства живёт правило: у элемента слота, на который
 * можно нажать, обязан быть класс `pointer-events-auto`.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { usePaneId } from './paneTitle';
import { useWindowTitleStore } from '../store/windowTitleStore';

export interface TitleBarOptions {
  /** Окно, в чей заголовок вставлять. По умолчанию — окно, в котором стоит раздел */
  winId?: string;
  /** Высота заголовка, пока слот занят */
  height?: number;
  /** Фон и разделитель полосы (классы Tailwind) */
  className?: string;
}

export function useWindowTitleBar(node: React.ReactNode, options: TitleBarOptions = {}): React.ReactNode {
  const paneId = usePaneId();
  const winId = options.winId ?? (paneId.startsWith('win:') ? paneId.slice(4) : '');
  const height = options.height ?? 38;
  const className = options.className ?? '';
  const host = useWindowTitleStore((s) => (winId ? s.hosts[winId] : undefined));

  // Layout-эффект, а не обычный: заголовок должен поменять высоту до показа кадра, иначе окно на миг дёрнется
  React.useLayoutEffect(() => {
    if (!winId) return;
    useWindowTitleStore.getState().claim(winId, { height, className });
    return () => useWindowTitleStore.getState().release(winId);
  }, [winId, height, className]);

  // Не в окне: содержимое остаётся там, где его положил раздел
  if (!winId) return node;
  // Окно уже есть, а узел-место ещё не отдан: на один кадр показывать нечего
  if (!host) return null;
  return createPortal(<div className="pointer-events-none flex h-full w-full min-w-0 items-stretch">{node}</div>, host);
}
