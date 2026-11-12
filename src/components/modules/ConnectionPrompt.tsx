/**
 * Запрос разрешения на подключение программы к внешней программе — по образцу
 * запросов Windows и телефона, для человека, а не для программиста: имя программы,
 * одна строка о том, что будет делаться, и три ответа. Подробности раскрываются
 * ссылкой; технические сведения (адрес, порт, COM-объект) — ещё ниже, свёрнуто.
 * Фокус на «Только сейчас» (безопасный выбор), Esc и закрытие окна — «Не разрешать».
 */
import React, { useState } from 'react';
import { Btn, Dialog } from '../ui';
import { ACCESS_NAMES, type GrantAsk } from '../../../modules/connections/model';
import { DEFAULT_COLOR } from '../../../modules/store/model';
import type { GrantChoice } from '../../services/moduleConnections';
import { ModuleIcon } from '../store/StoreParts';

const KIND_WORDS = { read: 'читать', write: 'изменять', send: 'отправлять данные' } as const;

export default function ConnectionPrompt({ ask, onChoose }: { ask: GrantAsk; onChoose: (choice: GrantChoice) => void }) {
  const [more, setMore] = useState(false);
  const [tech, setTech] = useState(false);
  const verified = ask.verifiedAt ? new Date(ask.verifiedAt).toLocaleDateString('ru-RU') : '';
  return <Dialog title={`«${ask.moduleName}» хочет подключиться к ${ask.app}`} onClose={() => onChoose('never')} width="max-w-lg" label="Запрос разрешения на подключение"
    footer={<>
      <Btn onClick={() => onChoose('never')} data-testid="grant-never">Не разрешать</Btn>
      <Btn autoFocus onClick={() => onChoose('once')} data-testid="grant-once">Только сейчас</Btn>
      <Btn tone="primary" onClick={() => onChoose('always')} data-testid="grant-always">Разрешить всегда</Btn>
    </>}>
    <div className="flex flex-col gap-3" data-testid="grant-prompt">
      <div className="flex items-center gap-3">
        <ModuleIcon listing={{ name: ask.moduleName, color: DEFAULT_COLOR }} size={48} />
        <div className="min-w-0 text-sm">{ask.does}</div>
      </div>
      <button type="button" className="self-start text-sm text-[var(--flux-accent)] underline" aria-expanded={more} onClick={() => setMore(v => !v)} data-testid="grant-more">
        {more ? 'Скрыть подробности' : 'Подробнее'}
      </button>
      {more && <div className="flex flex-col gap-2 text-sm" data-testid="grant-details">
        <div><b>Разрешается:</b> {KIND_WORDS[ask.access]} — в программе «{ask.app}».</div>
        <div><b>Программа не получит:</b>
          <ul className="ml-5 list-disc">
            <li>права менять данные Flux — она их только читает;</li>
            <li>доступа к файлам вашего компьютера;</li>
            <li>других адресов и программ — они закрыты.</li>
          </ul></div>
        <div><b>Выпустил:</b> {ask.author}{verified ? `; проверено владельцем ${verified}` : ''}. Версия {ask.version}.</div>
        <button type="button" className="self-start text-xs text-[var(--flux-text-muted)] underline" aria-expanded={tech} onClick={() => setTech(v => !v)} data-testid="grant-tech">Для специалиста</button>
        {tech && <div className="text-xs text-[var(--flux-text-muted)]" data-testid="grant-tech-text">{ask.technical} · доступ: {ACCESS_NAMES[ask.access]}</div>}
      </div>}
      <div className="text-xs text-[var(--flux-text-muted)]">Выбор «Разрешить всегда» или «Не разрешать» запомнится для этой программы на этом компьютере. Изменить его можно в Store, на странице программы.</div>
    </div>
  </Dialog>;
}
