/**
 * Запрос разрешения на подключение программы к внешней программе — по образцу
 * запросов Windows и телефона, для человека, а не для программиста: имя программы,
 * одна строка о том, что будет делаться, и три ответа. Подробности раскрываются
 * ссылкой; технические сведения (адрес, порт, COM-объект) — ещё ниже, свёрнуто.
 * Фокус на «Только сейчас» (безопасный выбор), Esc и закрытие окна — «Не разрешать».
 * Тексты — в connectionPromptText.ts: те же слова показывает запуск программы в Studio.
 */
import React, { useState } from 'react';
import { Btn, Dialog } from '../ui';
import type { GrantAsk } from '../../../modules/connections/model';
import { DEFAULT_COLOR } from '../../../modules/store/model';
import type { GrantChoice } from '../../services/moduleConnections';
import { ModuleIcon } from '../store/StoreParts';
import {
  ALLOWED_TITLE, AUTHOR_TITLE, CHOICES, MORE_CLOSE, MORE_OPEN, NOT_GIVEN, NOT_GIVEN_TITLE, PROMPT_LABEL, REMEMBER_FLUX, TECH_LABEL,
  allowedText, authorText, promptTitle, technicalText,
} from './connectionPromptText';

export default function ConnectionPrompt({ ask, onChoose }: { ask: GrantAsk; onChoose: (choice: GrantChoice) => void }) {
  const [more, setMore] = useState(false);
  const [tech, setTech] = useState(false);
  return <Dialog title={promptTitle(ask)} onClose={() => onChoose('never')} width="max-w-lg" label={PROMPT_LABEL}
    footer={<>
      <Btn onClick={() => onChoose('never')} data-testid="grant-never">{CHOICES.never}</Btn>
      <Btn autoFocus onClick={() => onChoose('once')} data-testid="grant-once">{CHOICES.once}</Btn>
      <Btn tone="primary" onClick={() => onChoose('always')} data-testid="grant-always">{CHOICES.always}</Btn>
    </>}>
    <div className="flex flex-col gap-3" data-testid="grant-prompt">
      <div className="flex items-center gap-3">
        <ModuleIcon listing={{ name: ask.moduleName, color: DEFAULT_COLOR }} size={48} />
        <div className="min-w-0 text-sm">{ask.does}</div>
      </div>
      <button type="button" className="self-start text-sm text-[var(--flux-accent)] underline" aria-expanded={more} onClick={() => setMore(v => !v)} data-testid="grant-more">
        {more ? MORE_CLOSE : MORE_OPEN}
      </button>
      {more && <div className="flex flex-col gap-2 text-sm" data-testid="grant-details">
        <div><b>{ALLOWED_TITLE}</b> {allowedText(ask)}</div>
        <div><b>{NOT_GIVEN_TITLE}</b>
          <ul className="ml-5 list-disc">
            {NOT_GIVEN.map(line => <li key={line}>{line}</li>)}
          </ul></div>
        <div><b>{AUTHOR_TITLE}</b> {authorText(ask)}</div>
        <button type="button" className="self-start text-xs text-[var(--flux-text-muted)] underline" aria-expanded={tech} onClick={() => setTech(v => !v)} data-testid="grant-tech">{TECH_LABEL}</button>
        {tech && <div className="text-xs text-[var(--flux-text-muted)]" data-testid="grant-tech-text">{technicalText(ask)}</div>}
      </div>}
      <div className="text-xs text-[var(--flux-text-muted)]">{REMEMBER_FLUX}</div>
    </div>
  </Dialog>;
}
