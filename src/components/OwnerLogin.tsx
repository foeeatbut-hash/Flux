import React from 'react';
import { Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { getServerBaseUrl, setAuthToken } from '../config/env';
import { useStore } from '../store/store';

/** Выбор ключа и подпись выполняются в оболочке; содержимое хранилища в React не поступает. */
export default function OwnerLogin() {
  const bridge = (window as any).electron?.ipcRenderer;
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
      const result = await bridge.invoke('owner:select-key');
      if (result.ok === false) { setFileName(''); throw new Error(result.error); }
      if (!result.canceled) { setFileName(result.name); setPassword(''); setShowPassword(false); setCapsLock(false); }
    } catch (e: any) { setError(e.message || 'Не удалось выбрать ключ.'); }
  };
  const login = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const origin = new URL(getServerBaseUrl() || window.location.origin).origin;
      const challengeResponse = await fetch('/api/owner/challenge', { credentials: 'omit' });
      const challenge = await challengeResponse.json();
      if (!challengeResponse.ok) throw new Error(challenge.error || 'Сервер не разрешил вход владельца.');
      const signed = await bridge.invoke('owner:sign-login', { challenge, serverUrl: origin, password });
      if (signed.ok === false) throw new Error(signed.error);
      setPassword('');
      const response = await fetch('/api/owner/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: challenge.nonce, sig: signed.sig }) });
      const result = await response.json();
      if (!response.ok || !result.success || !result.token) throw new Error(result.error || result.message || 'Не удалось подтвердить ключ владельца.');
      await setAuthToken(result.token);
      useStore.getState().setUser(result.user);
    } catch (e: any) { setError(e.message || 'Не удалось войти.'); }
    finally { setPassword(''); setShowPassword(false); setCapsLock(false); setBusy(false); }
  };
  return <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
    <button type="button" className="fx-btn fx-btn-quiet" aria-expanded={open} disabled={busy} onClick={() => { setOpen(v => !v); setError(''); setPassword(''); setShowPassword(false); setCapsLock(false); }}><KeyRound className="w-4 h-4" />Вход владельца</button>
    {open && (bridge ? <form className="space-y-3 mt-3" onSubmit={login}>
      <p className="fx-hint">Основной файл: %USERPROFILE%\.flux-owner\vault.flux-owner. Запасной файл: копия, сохранённая при первом запуске. Для запасного файла нужен отдельный пароль запасного ключа.</p>
      <button type="button" className="fx-btn max-w-full" onClick={() => void select()} disabled={busy}><span className="truncate">{fileName || 'Выбрать файл ключа'}</span></button>
      <div className="fx-field"><label className="fx-label block mb-1" htmlFor="owner-vault-password">Пароль выбранного файла .flux-owner</label><div className="flex items-center gap-2 min-w-0"><input id="owner-vault-password" className="fx-input flex-1 min-w-0" type={showPassword ? 'text' : 'password'} autoComplete="off" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} onKeyDown={event => setCapsLock(event.getModifierState('CapsLock'))} onKeyUp={event => setCapsLock(event.getModifierState('CapsLock'))} onBlur={() => setCapsLock(false)} required minLength={12} maxLength={1024} /><button type="button" className="fx-ibtn shrink-0" disabled={busy} aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'} aria-pressed={showPassword} onClick={() => setShowPassword(v => !v)}>{showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button></div></div>
      {capsLock && <p className="fx-hint" role="status">Включён Caps Lock. Проверьте регистр букв.</p>}
      {error && <p className="fx-error" role="alert">{error}</p>}
      <div className="flex justify-end"><button className="fx-btn fx-btn-primary" type="submit" disabled={busy || !fileName || password.length < 12}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}Войти с ключом</button></div>
    </form> : <p className="fx-hint mt-2">Вход с ключом доступен в приложении Flux для Windows. В браузер приватный ключ не загружается.</p>)}
  </div>;
}
