import React from 'react';
import { useStore } from '../store/store';
import { fetchLicenseStatus, usePersonLicenseStore } from '../lib/license';
import { gateState } from '../lib/licenseGate';
import LicenseSection from '../components/settings/LicenseSection';
import FluxLogo from '../components/FluxLogo';

/** Проверка после входа: лицензия принадлежит сотруднику, а не клиентскому компьютеру. */
export default function LicenseGate({ children }: { children: React.ReactNode }) {
  const user = useStore(s => s.user);
  const status = usePersonLicenseStore(s => s.status);
  const [failure, setFailure] = React.useState('');
  const [checking, setChecking] = React.useState(false);
  const generation = React.useRef(0);
  const load = React.useCallback(async () => {
    if (!user) return;
    const current = ++generation.current;
    setChecking(true);
    try {
      const result = await fetchLicenseStatus();
      if (current !== generation.current) return;
      usePersonLicenseStore.getState().setStatus(result); setFailure('');
    } catch (e: any) {
      if (current !== generation.current) return;
      usePersonLicenseStore.getState().setStatus(null); setFailure(e.message || 'Сервер не ответил');
    } finally { if (current === generation.current) setChecking(false); }
  }, [user?.id]);

  React.useEffect(() => {
    generation.current++;
    usePersonLicenseStore.getState().setStatus(null); setFailure('');
    if (!user) return;
    void load();
    const timer = window.setInterval(() => { void load(); }, 60000);
    const changed = () => { void load(); };
    window.addEventListener('flux:license-changed', changed);
    window.addEventListener('focus', changed);
    return () => { generation.current++; window.clearInterval(timer); window.removeEventListener('flux:license-changed', changed); window.removeEventListener('focus', changed); };
  }, [user?.id, load]);

  if (!user) return <>{children}</>;
  const state = gateState({ status, failure });
  if (state.kind === 'licensed' || state.kind === 'readonly') {
    const text = state.kind === 'readonly' ? state.text : status?.warn ? `Лицензия истекает через ${status.daysLeft} дн. Обратитесь к владельцу Flux для продления.` : '';
    if (!text) return <>{children}</>;
    return <div className="h-full w-full flex flex-col min-w-0"><div role="status" className="shrink-0 px-4 py-2 text-xs text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900">{text}</div><div className="flex-1 min-h-0 min-w-0">{children}</div></div>;
  }
  return <div className="h-full w-full overflow-auto flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-6"><div className="w-full max-w-2xl space-y-4 text-slate-800 dark:text-dark-text-main"><div className="flex gap-3 items-center"><FluxLogo size={40} /><h1 className="text-[15px] font-semibold">Лицензия компании</h1></div>
    {state.kind === 'loading' ? <p className="text-sm">Проверяем лицензию сотрудника…</p> : state.kind === 'offline' ? <><p className="text-sm">{state.text}. {state.detail}</p><button className="fx-btn" disabled={checking} onClick={() => void load()}>Повторить проверку</button></> : <><p className="text-sm">{state.text}</p>{status?.canActivate ? <LicenseSection /> : <p className="text-xs text-slate-500 dark:text-slate-400">Администратор получает один запрос на сотрудников и применяет подписанный ключ владельца.</p>}<button className="fx-btn" disabled={checking} onClick={() => void load()}>Проверить снова</button></>}
    <button className="fx-btn" onClick={() => useStore.getState().setUser(null)}>Выйти из профиля</button>
  </div></div>;
}
