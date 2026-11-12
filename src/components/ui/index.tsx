/**
 * Общие элементы интерфейса Flux: кнопки, поля, шапка, таблица-обвязка — в controls.tsx (его берёт и Flux Studio, не
 * таща за собой окна рабочего стола), здесь они переэкспортируются, плюс диалог, который живёт на окнах Flux.
 */
import React from 'react';
import { WindowDialog } from './WindowDialog';
import { IconBtn } from './controls';

export * from './controls';
export { WindowDialog } from './WindowDialog';

/**
 * Диалог раздела: окно fx-dialog, шапка, тело, подвал с кнопками справа.
 * Раньше каждый раздел собирал своё окно (размытие фона, значок в цвете,
 * заголовок 18/700) — теперь все окна одного вида. Само окно — дочернее окно
 * программы (`WindowDialog`): двигается за шапку, тянется за края, блокирует
 * только свою программу. Esc закрывает, пока `busy` не запрещает; тело
 * прокручивается, когда окно сделали ниже содержимого.
 */
export function Dialog({ title, onClose, children, footer, width = 'max-w-md', busy, label, scrollBody: _scrollBody = false }: {
  title: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode;
  width?: string; busy?: boolean; label?: string; scrollBody?: boolean;
}) {
  return (
    <WindowDialog onClose={onClose} busy={busy} label={label ?? (typeof title === 'string' ? title : undefined)}
      className={`w-full ${width} fx-dialog flex flex-col overflow-hidden`}>
      <div className="fx-dialog-head shrink-0 cursor-default" data-dialog-drag>
        <h3 className="min-w-0 flex-1 truncate">{title}</h3>
        <IconBtn label="Закрыть окно" onClick={onClose} disabled={busy} className="-mr-2">
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </IconBtn>
      </div>
      <div className="fx-dialog-body min-h-0 flex-1 overflow-y-auto text-slate-700 dark:text-slate-300">{children}</div>
      {footer && <div className="fx-dialog-foot shrink-0 flex-wrap">{footer}</div>}
    </WindowDialog>
  );
}
