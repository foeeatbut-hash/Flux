import React from 'react';
import { Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';

/**
 * Вход владельца файлом ключа: общий вид у Flux и Flux Studio. Выбор файла и
 * подпись выполняет оболочка программы (главный процесс), содержимое хранилища
 * в React не поступает; сюда приходит только «выбрано имя файла» и «вход удался».
 */
export interface OwnerLoginApi {
  /** Открывает выбор файла; { ok: false } — файл не подошёл, { canceled: true } — окно закрыли */
  selectKey: () => Promise<{ ok?: boolean; error?: string; canceled?: boolean; name?: string }>;
  /** Подписывает одноразовый запрос сервера и входит; ошибка — исключением с текстом для человека */
  signIn: (password: string) => Promise<void>;
}

export default function OwnerLoginPanel({ api, unavailableText = 'Вход владельца с ключом доступен в приложении Flux для Windows.' }: { api: OwnerLoginApi | null; unavailableText?: string }) {
  const [open, setOpen] = React.useState(false);
  const [fileName, setFileName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [capsLock, setCapsLock] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const select = async () => {
    setError('');
    try {
      const result = await api!.selectKey();
      if (result.ok === false) { setFileName(''); throw new Error(result.error); }
      if (!result.canceled) { setFileName(result.name || ''); setPassword(''); setShowPassword(false); setCapsLock(false); }
    } catch (e: any) { setError(e.message || 'Не удалось выбрать ключ.'); }
  };
  const login = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const typed = password;
      // Фраза не живёт в поле дольше, чем нужно для подписи
      setPassword('');
      await api!.signIn(typed);
    } catch (e: any) { setError(e.message || 'Не удалось войти.'); }
    finally { setPassword(''); setShowPassword(false); setCapsLock(false); setBusy(false); }
  };
  return <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
    <button type="button" className="fx-btn fx-btn-quiet" aria-expanded={open} disabled={busy} onClick={() => { setOpen(v => !v); setError(''); setPassword(''); setShowPassword(false); setCapsLock(false); }}><KeyRound className="w-4 h-4" />Вход владельца</button>
    {open && (api ? <form className="space-y-3 mt-3" onSubmit={login}>
      <button type="button" className="fx-btn max-w-full" onClick={() => void select()} disabled={busy}><span className="truncate">{fileName || 'Выбрать файл ключа'}</span></button>
      <div className="fx-field"><label className="fx-label block mb-1" htmlFor="owner-vault-password">Пароль ключа владельца</label><div className="flex items-center gap-2 min-w-0"><input id="owner-vault-password" className="fx-input flex-1 min-w-0" type={showPassword ? 'text' : 'password'} autoComplete="off" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} onKeyDown={event => setCapsLock(event.getModifierState('CapsLock'))} onKeyUp={event => setCapsLock(event.getModifierState('CapsLock'))} onBlur={() => setCapsLock(false)} required minLength={12} maxLength={1024} /><button type="button" className="fx-ibtn shrink-0" disabled={busy} aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'} aria-pressed={showPassword} onClick={() => setShowPassword(v => !v)}>{showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button></div></div>
      {capsLock && <p className="fx-hint" role="status">Включён Caps Lock. Проверьте регистр букв.</p>}
      {error && <p className="fx-error" role="alert">{error}</p>}
      <div className="flex justify-end"><button className="fx-btn fx-btn-primary" type="submit" disabled={busy || !fileName || password.length < 12}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}Войти с ключом</button></div>
    </form> : <p className="fx-hint mt-2">{unavailableText}</p>)}
  </div>;
}
