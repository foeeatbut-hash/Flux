/**
 * Мелкие элементы ввода редакторов: поле с подписью, текстовое поле, поле со списком значений.
 * Подпись всегда связана с полем (htmlFor), чтобы читалка экрана и тесты находили поле по тексту.
 */
import React, { useEffect, useId, useState } from 'react';

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (id: string, describedBy?: string) => React.ReactNode }) {
  const id = useId();
  const note = error ? `${id}-e` : hint ? `${id}-h` : undefined;
  return (
    <div className="ed-field">
      <label htmlFor={id}>{label}</label>
      {children(id, note)}
      {error ? <p className="ed-error" id={`${id}-e`} role="alert">{error}</p> : hint ? <p className="ed-hint" id={`${id}-h`}>{hint}</p> : null}
    </div>
  );
}

export function TextField({ label, value, onChange, placeholder, hint, error, mono }: {
  label: string; value: string; onChange: (value: string) => void; placeholder?: string; hint?: string; error?: string; mono?: boolean;
}) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(id, note) => (
        <input id={id} className="ed-input" value={value} placeholder={placeholder} aria-describedby={note} aria-invalid={error ? true : undefined}
          spellCheck={false} data-mono={mono || undefined} onChange={event => onChange(event.target.value)} />
      )}
    </Field>
  );
}

/**
 * Поле, которое применяет значение, когда ввод закончен (уход из поля или Enter): список через
 * запятую или число нельзя разбирать на каждой букве — запятая в конце пропала бы под пальцами.
 */
export function CommittedField({ label, value, onCommit, placeholder, hint, error }: {
  label: string; value: string; onCommit: (value: string) => void; placeholder?: string; hint?: string; error?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  return (
    <Field label={label} hint={hint} error={error}>
      {(id, note) => (
        <input id={id} className="ed-input" value={draft} placeholder={placeholder} aria-describedby={note} aria-invalid={error ? true : undefined}
          spellCheck={false} onChange={event => setDraft(event.target.value)} onBlur={commit}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} />
      )}
    </Field>
  );
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  const id = useId();
  return (
    <div className="ed-check">
      <input id={id} type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

export function SelectField({ label, value, onChange, children, hint, error }: {
  label: string; value: string; onChange: (value: string) => void; children: React.ReactNode; hint?: string; error?: string;
}) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(id, note) => (
        <select id={id} className="ed-input" value={value} aria-describedby={note} aria-invalid={error ? true : undefined} onChange={event => onChange(event.target.value)}>
          {children}
        </select>
      )}
    </Field>
  );
}

/** Стрелки, Home и End в списке вкладок: выбор и фокус переходят на соседнюю вкладку (roving tabindex) */
export function tabKeys<T extends string>(event: React.KeyboardEvent<HTMLElement>, order: T[], current: T, set: (key: T) => void) {
  const index = order.indexOf(current);
  const next = event.key === 'ArrowRight' ? (index + 1) % order.length
    : event.key === 'ArrowLeft' ? (index - 1 + order.length) % order.length
    : event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : -1;
  if (next < 0) return;
  event.preventDefault();
  set(order[next]);
  const tabs = event.currentTarget.querySelectorAll<HTMLElement>('[role=tab]');
  requestAnimationFrame(() => tabs[next]?.focus());
}

/** Поле таблицы: подпись есть для читалки экрана и проверок как настоящий <label>, но на экране скрыта */
export function HiddenLabelInput({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return <><label className="ed-sr" htmlFor={id}>{label}</label><input id={id} className="ed-input" {...props} /></>;
}
export function HiddenLabelSelect({ label, children, ...props }: { label: string; children: React.ReactNode } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return <><label className="ed-sr" htmlFor={id}>{label}</label><select id={id} className="ed-input" {...props}>{children}</select></>;
}
