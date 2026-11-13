/**
 * Запрос разрешения на подключение в запуске Studio: те же три ответа и те же слова, что в окне Flux
 * (src/components/modules/ConnectionPrompt.tsx, тексты — connectionPromptText.ts). Решение записывает главный процесс Studio
 * и держит в памяти до закрытия Studio; здесь только вопрос. Закрытие окна без ответа — «Не разрешать», как во Flux.
 */
import React, { useState } from 'react';
import Modal from '../../work/Modal';
import type { GrantAsk } from '../../../../modules/connections/model';
import type { ConnectDecision } from '../../../shared/runActions';
import {
  ALLOWED_TITLE, AUTHOR_TITLE, CHOICES, MORE_CLOSE, MORE_OPEN, NOT_GIVEN, NOT_GIVEN_TITLE, PROMPT_LABEL, REMEMBER_STUDIO, TECH_LABEL,
  allowedText, authorText, promptTitle, technicalText,
} from '../../../../src/components/modules/connectionPromptText';

export type RunGrantChoice = ConnectDecision;

export default function RunConnectPrompt({ ask, onChoose }: { ask: GrantAsk; onChoose: (choice: RunGrantChoice) => void }) {
  const [more, setMore] = useState(false);
  const [tech, setTech] = useState(false);
  return <Modal title={promptTitle(ask)} onClose={() => onChoose('never')}>
    <div data-testid="studio-grant-prompt" aria-label={PROMPT_LABEL} className="studio-grant">
      <p>{ask.does}</p>
      <button type="button" className="fx-btn" aria-expanded={more} onClick={() => setMore(v => !v)} data-testid="grant-more">{more ? MORE_CLOSE : MORE_OPEN}</button>
      {more && <div data-testid="grant-details">
        <p><b>{ALLOWED_TITLE}</b> {allowedText(ask)}</p>
        <p><b>{NOT_GIVEN_TITLE}</b></p>
        <ul>{NOT_GIVEN.map(line => <li key={line}>{line}</li>)}</ul>
        <p><b>{AUTHOR_TITLE}</b> {authorText(ask)}</p>
        <button type="button" className="fx-btn" aria-expanded={tech} onClick={() => setTech(v => !v)} data-testid="grant-tech">{TECH_LABEL}</button>
        {tech && <p className="fx-hint code" data-testid="grant-tech-text">{technicalText(ask)}</p>}
      </div>}
      <p className="fx-hint">{REMEMBER_STUDIO}</p>
      <div className="row studio-modal-actions">
        <button type="button" className="fx-btn" onClick={() => onChoose('never')} data-testid="grant-never">{CHOICES.never}</button>
        <button type="button" className="fx-btn" data-autofocus onClick={() => onChoose('once')} data-testid="grant-once">{CHOICES.once}</button>
        <button type="button" className="fx-btn fx-btn-primary" onClick={() => onChoose('always')} data-testid="grant-always">{CHOICES.always}</button>
      </div>
    </div>
  </Modal>;
}
