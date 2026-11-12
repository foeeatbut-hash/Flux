/**
 * Диалог, который Flux рисует по просьбе программы (flux.dialogs) и при закрытии окна с несохранённым.
 *
 * Программа даёт простой текст (заголовок, текст, подписи кнопок), разметку делает Flux: тексты выводятся как текст,
 * без ссылок и HTML. Диалог — дочернее окно этой программы (`WindowDialog`): блокирует только её окно, а в шапке всегда
 * стоит название программы, чтобы человек видел, кто спрашивает. Опасное действие (`danger`) и вопрос о закрытии
 * начинаются с «Отмены»: случайный Enter ничего не теряет.
 */
import React, { useState } from 'react';
import { WindowDialog } from '../ui/WindowDialog';
import type { PageDialog, PageDialogAnswer } from '../../../modules/page/model';
import { DIALOG_LIMITS } from '../../../modules/page/model';

export interface ProgramDialogProps {
  /** Название программы: стоит в шапке */
  program: string;
  request: PageDialog;
  /** Ответ: confirm — true/false, alert — null, prompt — строка либо null */
  onAnswer: (answer: PageDialogAnswer) => void;
  /** Начать с «Отмены» (опасное действие, вопрос о закрытии) */
  cancelFirst?: boolean;
}

export default function ProgramDialog({ program, request, onAnswer, cancelFirst }: ProgramDialogProps) {
  const [value, setValue] = useState(request.kind === 'prompt' ? request.value ?? '' : '');
  const cancelAnswer: PageDialogAnswer = request.kind === 'confirm' ? false : null;
  const danger = request.kind === 'confirm' && !!request.danger;
  const first = cancelFirst || danger;
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    onAnswer(request.kind === 'confirm' ? true : request.kind === 'prompt' ? value : null);
  };
  const title = `${program} — ${request.title}`;
  return <WindowDialog onClose={() => onAnswer(cancelAnswer)} resizable={false} label={title} className="w-full max-w-md fx-dialog overflow-hidden">
    <form onSubmit={submit} data-testid="program-dialog" data-kind={request.kind}>
      <div className="fx-dialog-head pr-10" data-dialog-drag>
        <h3 className="min-w-0 truncate" title={title} data-testid="program-dialog-title">{title}</h3>
      </div>
      <div className="fx-dialog-body">
        {request.text && <p className="whitespace-pre-wrap break-words" data-testid="program-dialog-text">{request.text}</p>}
        {request.kind === 'prompt' && <label className="fx-field mt-3">
          <span className="fx-label">{request.label}</span>
          <input className="fx-input fx-btn-lg" type="text" autoFocus value={value} maxLength={request.maxLength || DIALOG_LIMITS.defaultMaxLength}
            onChange={event => setValue(event.target.value)} onFocus={event => event.currentTarget.select()} data-testid="program-dialog-input" />
        </label>}
      </div>
      <div className="fx-dialog-foot">
        {request.kind !== 'alert' && <button type="button" autoFocus={request.kind === 'confirm' && first} className="fx-btn fx-btn-lg" onClick={() => onAnswer(cancelAnswer)} data-testid="program-dialog-cancel">
          {(request.kind === 'confirm' && request.cancel) || 'Отмена'}</button>}
        <button type="submit" autoFocus={request.kind === 'alert' || (request.kind === 'confirm' && !first)} className={`fx-btn fx-btn-lg ${danger ? 'fx-btn-danger-fill' : 'fx-btn-primary'}`} data-testid="program-dialog-ok">
          {(request.kind === 'confirm' && request.ok) || (request.kind === 'alert' ? 'Понятно' : 'OK')}</button>
      </div>
    </form>
  </WindowDialog>;
}
