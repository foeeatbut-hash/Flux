import React from 'react';
import { Canceled } from './api';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'off';
export const Badge = ({ tone = 'off', children, ...rest }: { tone?: Tone; children: React.ReactNode } & React.HTMLAttributes<HTMLSpanElement>) =>
  <span className={`badge ${tone}`} {...rest}>{children}</span>;

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'danger' | 'ghost' | '' };
export const Btn = ({ tone = '', className = '', type = 'button', ...rest }: BtnProps) => <button type={type} className={`btn ${tone} ${className}`} {...rest} />;

export const Empty = ({ title, text }: { title: string; text?: string }) => <div className="empty"><b>{title}</b>{text}</div>;
export const ErrorLine = ({ text }: { text: string }) => (text ? <div className="error" role="alert">{text}</div> : null);
export const Field = ({ label, hint, children, id }: { label: string; hint?: string; children: React.ReactNode; id?: string }) =>
  <div className="field"><label htmlFor={id}>{label}</label>{children}{hint && <p className="hint">{hint}</p>}</div>;

export function Segs({ value, onChange, options, label }: { value: string; onChange: (v: any) => void; options: Array<{ value: string; label: string }>; label: string }) {
  return <div className="segs" role="group" aria-label={label}>{options.map(o =>
    <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}

/** Диалог решения. Подтверждение подписи — отдельное окно главного процесса: пароль здесь не вводится, хранилище уже открыто */
export function Dialog({ title, children, onClose, footer, busy }: { title: string; children: React.ReactNode; onClose: () => void; footer: React.ReactNode; busy?: boolean }) {
  React.useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy, onClose]);
  return <div className="overlay"><div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
    <header>{title}</header><div className="content">{children}</div><footer>{footer}</footer></div></div>;
}

/** Выполнить действие с индикацией занятости и ошибкой; отказ владельца в диалоге подтверждения ошибкой не считается */
export function useAction() {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const run = React.useCallback(async <T,>(fn: () => Promise<T>): Promise<{ value: T } | undefined> => {
    setBusy(true); setError('');
    try { return { value: await fn() }; }
    catch (e: any) { if (!(e instanceof Canceled)) setError(e?.message || 'Операция не выполнена.'); return undefined; }
    finally { setBusy(false); }
  }, []);
  return { busy, error, setError, run };
}
