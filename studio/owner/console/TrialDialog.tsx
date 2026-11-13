/**
 * Диалог программы в пробном запуске владельца: во Flux его рисует окно Flux, в Studio — свой диалог с теми же текстами
 * и ответами (общая часть с запуском разработчика — studio/renderer/work/programDialog.ts), чтобы владелец видел,
 * что и как спросят у человека. Закрытие (Esc, «Отмена») отвечает программе отказом.
 */
import React, { useState } from 'react';
import type { PageDialog, PageDialogAnswer } from '../../../modules/page/model';
import { dialogCancel, dialogCancelLabel, dialogOkLabel, dialogSubmit } from '../../renderer/work/programDialog';
import { Btn, Dialog, Field } from './ui';

export default function TrialDialog({ program, request, onAnswer }: { program: string; request: PageDialog; onAnswer: (answer: PageDialogAnswer) => void }) {
  const [value, setValue] = useState(request.kind === 'prompt' ? request.value ?? '' : '');
  const cancel = dialogCancel(request);
  return <Dialog title={`${program} — ${request.title}`} onClose={() => onAnswer(cancel)}
    footer={<>
      {request.kind !== 'alert' && <Btn onClick={() => onAnswer(cancel)}>{dialogCancelLabel(request)}</Btn>}
      <Btn tone={request.kind === 'confirm' && request.danger ? 'danger' : 'primary'} data-testid="trial-dialog-ok" onClick={() => onAnswer(dialogSubmit(request, value))}>{dialogOkLabel(request)}</Btn>
    </>}>
    <div data-testid="trial-dialog">
      {request.text && <p className="hint" style={{ whiteSpace: 'pre-wrap' }}>{request.text}</p>}
      {request.kind === 'prompt' && <Field label={request.label} id="trial-dialog-input">
        <input id="trial-dialog-input" value={value} maxLength={request.maxLength} autoFocus onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onAnswer(dialogSubmit(request, value)); }} /></Field>}
    </div>
  </Dialog>;
}
