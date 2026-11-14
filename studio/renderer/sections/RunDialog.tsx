/**
 * Диалог программы в запуске на тестовой базе: во Flux его рисует окно Flux (src/components/modules/ProgramDialog.tsx),
 * в Studio — свой простой диалог с теми же текстами и ответами, чтобы разработчик видел, что и как спросят у человека.
 */
import React, { useState } from 'react';
import Modal from '../work/Modal';
import type { PageDialog, PageDialogAnswer } from '../../../modules/page/model';
import { dialogCancel, dialogCancelLabel, dialogOkLabel, dialogSubmit } from '../work/programDialog';

/** `scoped` — диалог поверх своего окна программы, а не всего окна Studio: окно программы блокируется само, остальные работают */
export default function RunDialog({ program, request, onAnswer, scoped }: { program: string; request: PageDialog; onAnswer: (answer: PageDialogAnswer) => void; scoped?: boolean }) {
  const [value, setValue] = useState(request.kind === 'prompt' ? request.value ?? '' : '');
  const cancel = dialogCancel(request);
  return <Modal title={`${program} — ${request.title}`} onClose={() => onAnswer(cancel)} scoped={scoped}>
    <form onSubmit={e => { e.preventDefault(); onAnswer(dialogSubmit(request, value)); }} data-testid="studio-run-dialog">
      {request.text && <p className="fx-hint" style={{ whiteSpace: 'pre-wrap' }}>{request.text}</p>}
      {request.kind === 'prompt' && <div className="field"><label htmlFor="run-dialog-input">{request.label}</label>
        <input id="run-dialog-input" className="fx-input" value={value} maxLength={request.maxLength} onChange={e => setValue(e.target.value)} /></div>}
      <div className="row studio-modal-actions">
        {request.kind !== 'alert' && <button type="button" className="fx-btn" onClick={() => onAnswer(cancel)}>{dialogCancelLabel(request)}</button>}
        <button type="submit" className={request.kind === 'confirm' && request.danger ? 'fx-btn fx-btn-danger-fill' : 'fx-btn fx-btn-primary'}>
          {dialogOkLabel(request)}</button>
      </div>
    </form>
  </Modal>;
}
