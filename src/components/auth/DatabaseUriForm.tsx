import React from 'react';
import { Database, Loader2 } from 'lucide-react';

/**
 * Поля подключения к общей базе MariaDB/MySQL: общие у Flux (панель под окном
 * входа) и Flux Studio (первый шаг входа). Возвращает фрагмент — обёртку
 * (рамку панели или карточку) выбирает вызывающий, чтобы у соседних блоков
 * сохранялись одни и те же отступы.
 */
interface DatabaseUriFormProps {
  draft: string;
  onDraft: (value: string) => void;
  busy: boolean;
  /** Подключение сохранено и ждёт перезапуска программы: поле и кнопка недоступны */
  locked?: boolean;
  error?: string;
  /** Что показать про текущую базу: «Сейчас подключена база …» */
  currentNote?: React.ReactNode;
  unsupported?: boolean;
  lockedNote?: React.ReactNode;
  hint?: React.ReactNode;
  onSubmit: () => void;
  submitLabel?: string;
  /** Кнопки слева от главной: «Закрыть», «Отмена» и т. п. */
  secondary?: React.ReactNode;
  /** Вместо главной кнопки (например, «Перезапустить Flux») */
  primaryOverride?: React.ReactNode;
  /** Дополнительные поля между подсказкой и ошибкой (галочка «Запомнить») */
  extra?: React.ReactNode;
}

export default function DatabaseUriForm({
  draft, onDraft, busy, locked = false, error = '', currentNote, unsupported = false, lockedNote, hint, onSubmit,
  submitLabel = 'Проверить и подключить', secondary, primaryOverride, extra,
}: DatabaseUriFormProps) {
  return <>
    <label className="fx-field block"><span className="fx-label block mb-1">URI базы MariaDB/MySQL</span>
      <input className="fx-input w-full font-mono" type="password" value={draft} autoFocus spellCheck={false} autoComplete="new-password" disabled={busy || locked} placeholder="mysql://USER:PASSWORD@HOST:3306/Flux" onChange={e => onDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !busy && !locked) onSubmit(); }} />
    </label>
    {hint}
    {currentNote}
    {unsupported && <p className="fx-error" role="status">Сохранённый тип базы не поддерживается. Укажите URI MariaDB/MySQL.</p>}
    {extra}
    {error && <p className="fx-error" role="alert">{error}</p>}
    {locked && lockedNote}
    <div className="flex flex-wrap items-center justify-end gap-2">
      {secondary}
      {primaryOverride ?? <button type="button" className="fx-btn fx-btn-primary" disabled={busy || !draft.trim()} onClick={onSubmit}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}{submitLabel}</button>}
    </div>
  </>;
}

/** Кнопка-«шапка» подключения к базе под окном входа: показывает, к какой базе подключена программа */
export function DatabaseButton({ label, expanded, disabled, onClick }: { label: string; expanded: boolean; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="fx-btn fx-btn-quiet max-w-full" aria-expanded={expanded} disabled={disabled} onClick={onClick}>
    <Database className="w-4 h-4 shrink-0" />
    <span className="truncate">{label}</span>
  </button>;
}
