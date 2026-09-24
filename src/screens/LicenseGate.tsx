/**
 * Гейт лицензии: показывается ПОСЛЕ стартовой заставки и ДО экрана входа.
 * Пока лицензия не активирована или просрочена — дальше не пускает.
 *
 * Состояний четыре, и они разведены нарочно (см. `lib/licenseGate.ts`): ждём
 * ответа, ответ не пришёл, ответ пришёл отрицательный, лицензия есть. Раньше
 * второе и третье были одним: при упавшем сервере человеку показывали «ещё не
 * активирована», и он шёл искать ключ, который у него уже был.
 */
import React from 'react';
import { useLocation } from 'react-router-dom';
import { fetchLicenseStatus, activateLicense, LicenseStatus } from '../lib/license';
import { gateState, reasonText } from '../lib/licenseGate';
import FluxLogo from '../components/FluxLogo';

export default function LicenseGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [status, setStatus] = React.useState<LicenseStatus | null>(null);
  /** Почему не удалось спросить сервер. Пусто — сбоя не было */
  const [failure, setFailure] = React.useState('');
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState('');
  const [copied, setCopied] = React.useState(false);

  const load = React.useCallback(async () => {
    setChecking(true);
    try {
      const s = await fetchLicenseStatus();
      setStatus(s);
      setFailure('');
    } catch (e: any) {
      // Ответа нет — состояние лицензии неизвестно, и подменять его отказом
      // нельзя: это разные новости для человека
      setStatus(null);
      setFailure(e?.message || 'сервер не ответил');
    } finally {
      setChecking(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  // Отдельные окна открываются уже после входа — их не гейтим.
  // Пульт захвата к тому же не ходит в базу: он лишь следит за буфером,
  // а всё, что он захватил, попадёт в программу через главное окно —
  // а оно за гейтом
  if (location.pathname === '/sticker' || location.pathname === '/capture') return <>{children}</>;

  const state = gateState({ status, failure });

  if (state.kind === 'licensed') return <>{children}</>;

  // Пока статус не загружен — короткий индикатор (заставка уже погашена)
  if (state.kind === 'loading') {
    return (
      <div className="w-full h-full flex items-center justify-center bg-slate-950">
        <div className="w-5 h-5 rounded-full border-2 border-slate-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const res = await activateLicense(code.trim());
      if (res.licensed) { setStatus(res); setFailure(''); return; }
      setError(res.error || reasonText(res.reason));
    } catch (e: any) {
      setError(e?.message || 'Ошибка активации.');
    } finally {
      setBusy(false);
    }
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(status?.machineId || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) { /* буфер недоступен — код всё равно виден и выделяется */ }
  };

  return (
    <div className="w-full h-full flex items-center justify-center bg-slate-950 p-6">
      <div className="max-w-lg w-full bg-slate-900 border border-slate-800 rounded-lg p-8 space-y-6">
        <div className="flex items-center gap-3">
          <FluxLogo size={40} />
          <div>
            <div className="text-base font-semibold text-white">
              {state.kind === 'offline' ? 'Проверка лицензии' : 'Активация лицензии'}
            </div>
            <div className="text-xs text-slate-400">Программа защищена лицензией на один компьютер</div>
          </div>
        </div>

        {/* Сбой связи: сказать, что случилось, и дать нажать «Повторить».
            Требовать ключ в этот момент бессмысленно — мы не знаем, нужен ли он */}
        {state.kind === 'offline' ? (
          <>
            <div className="p-3 text-xs font-medium text-amber-200 bg-amber-950/30 border border-amber-900/50 rounded-lg space-y-1">
              <p className="font-medium">{state.text}</p>
              <p className="text-amber-300/80">{state.detail}</p>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed">
              Это не значит, что лицензии нет: программа не смогла спросить о ней. Проверьте
              связь с сервером и повторите — если не выйдет, покажите это сообщение тому, кто
              занимается сервером.
            </p>
            <button type="button" onClick={load} disabled={checking}
              className="w-full h-9 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium
                         cursor-pointer disabled:opacity-50">
              {checking ? 'Проверяем…' : 'Повторить'}
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-300 leading-relaxed">
              Отправьте владельцу программы <b>код этого компьютера</b> (ниже) и введите
              полученный ключ активации.
            </p>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-400">Код этого компьютера</label>
              <div className="flex items-stretch gap-2">
                <div className="flex-1 font-mono text-sm text-emerald-300 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2.5 select-all">
                  {status?.machineId || '—'}
                </div>
                <button type="button" onClick={copyId} className="px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 cursor-pointer">
                  {copied ? 'Скопировано' : 'Копировать'}
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-400">Ключ активации</label>
              <textarea
                value={code}
                onChange={(e) => setCode(e.target.value)}
                rows={3}
                placeholder="FLUX1.…"
                className="w-full font-mono text-xs bg-slate-950 text-slate-100 p-3 border border-slate-800 rounded-lg outline-none focus:border-emerald-500 resize-none break-all"
              />
            </div>

            <div className="p-3 text-xs font-medium text-rose-300 bg-rose-950/30 border border-rose-900/50 rounded-lg">
              {error || state.text}
            </div>

            <button type="button"
              onClick={submit}
              disabled={busy || !code.trim()}
              className="w-full h-9 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium cursor-pointer disabled:opacity-50"
            >
              {busy ? 'Проверка…' : 'Активировать'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
