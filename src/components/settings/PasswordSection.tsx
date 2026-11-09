/**
 * «Пароль» — раздел Настроек: человек сам меняет свой пароль для входа.
 *
 * Сервер (PUT /api/users/:id) уже требует текущий пароль и длину не меньше 8;
 * здесь те же правила проверяются заранее, чтобы не ждать ответа, а причины
 * отказа сервера показываются по-русски рядом с нужным полем.
 *
 * Главное, что человек должен узнать после смены: сессия привязана к паролю,
 * поэтому сервер завершает ВСЕ сессии этого профиля, в том числе текущую, —
 * на других компьютерах и здесь нужно войти заново. Об этом сказано на самой
 * странице (а не только в уведомлении, которое успевает исчезнуть).
 */
import React from 'react';
import { useStore } from '../../store/store';
import { useToastStore } from '../../store/toastStore';
import { changeOwnPassword } from '../../services/passwordApi';
import { Btn, Field, Input, Status } from '../ui';

/** Должно совпадать с MIN_PASSWORD в server/routes/users.ts */
export const MIN_PASSWORD_LENGTH = 8;

export type PasswordProblem = { field: 'current' | 'next' | 'repeat' | 'form'; text: string };

/** Проверка формы до отправки; null — можно отправлять */
export function checkPasswordForm(current: string, next: string, repeat: string): PasswordProblem | null {
  if (!current) return { field: 'current', text: 'Введите текущий пароль.' };
  if (next.length < MIN_PASSWORD_LENGTH) return { field: 'next', text: `Новый пароль не короче ${MIN_PASSWORD_LENGTH} символов.` };
  if (next === current) return { field: 'next', text: 'Новый пароль совпадает с текущим.' };
  if (repeat !== next) return { field: 'repeat', text: 'Пароли не совпадают.' };
  return null;
}

/** Отказ сервера: к какому полю относится и что сказать (тексты сервера уже русские) */
export function serverProblem(message: string): PasswordProblem {
  if (/текущий пароль/i.test(message)) return { field: 'current', text: 'Текущий пароль указан неверно.' };
  if (/не короче/i.test(message)) return { field: 'next', text: message };
  return { field: 'form', text: message || 'Не удалось сменить пароль. Проверьте соединение и повторите.' };
}

export default function PasswordSection() {
  const user = useStore((s) => s.user);
  const setUser = useStore((s) => s.setUser);
  const addToast = useToastStore((s) => s.addToast);
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [repeat, setRepeat] = React.useState('');
  const [problem, setProblem] = React.useState<PasswordProblem | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);

  if (!user) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const found = checkPasswordForm(current, next, repeat);
    setProblem(found);
    if (found) return;
    setBusy(true);
    try {
      await changeOwnPassword(user.id, current, next);
      setCurrent(''); setNext(''); setRepeat('');
      setDone(true);
      // Уведомление остаётся, даже если следующий же запрос вернёт 401 и откроет экран входа
      addToast('Пароль изменён. Все сессии завершены — войдите с новым паролем.', 'success');
    } catch (error: any) {
      setProblem(serverProblem(String(error?.message || '')));
    } finally {
      setBusy(false);
    }
  };

  const mark = (field: PasswordProblem['field']) => (problem?.field === field ? { 'aria-invalid': true, 'aria-describedby': `pw-error-${field}` } as const : {});
  const error = (field: PasswordProblem['field']) => problem?.field === field
    ? <span id={`pw-error-${field}`} className="fx-error" role="alert">{problem.text}</span> : null;

  return (
    <div className="max-w-xl" data-testid="password-section">
      <h2 className="text-[15px] leading-5 font-semibold text-slate-900 dark:text-white">Пароль</h2>
      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 mb-3">
        Пароль для входа в Flux под профилем «{user.name || user.symbol}». Забытый пароль сбрасывает администратор.
      </p>

      {done ? (
        <div className="space-y-3" role="status" data-testid="password-done">
          <Status tone="emerald">Пароль изменён</Status>
          <p className="text-xs text-slate-600 dark:text-slate-300">
            Сессии этого профиля завершены везде: на других компьютерах и в этом окне. Чтобы продолжить,
            войдите с новым паролем.
          </p>
          <Btn tone="primary" onClick={() => { void setUser(null); }}>Войти заново</Btn>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={submit} noValidate>
          <Field label="Текущий пароль">
            <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} disabled={busy} {...mark('current')} />
            {error('current')}
          </Field>
          <Field label="Новый пароль" hint={`Не короче ${MIN_PASSWORD_LENGTH} символов.`}>
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} disabled={busy} {...mark('next')} />
            {error('next')}
          </Field>
          <Field label="Повторите новый пароль">
            <Input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} disabled={busy} {...mark('repeat')} />
            {error('repeat')}
          </Field>
          {error('form')}
          <p className="text-xs text-slate-500 dark:text-slate-400">
            После смены пароля вход завершится на всех ваших компьютерах, в том числе на этом: войдите заново с новым паролем.
          </p>
          <Btn type="submit" tone="primary" disabled={busy}>{busy ? 'Меняем…' : 'Сменить пароль'}</Btn>
        </form>
      )}
    </div>
  );
}
