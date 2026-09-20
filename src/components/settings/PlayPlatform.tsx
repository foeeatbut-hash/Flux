/**
 * Лист «Flux Play» в Параметрах: общий выключатель платформы.
 *
 * Лист видит только тот, кому выдано управление платформой, — и видит он его
 * даже при выключенной платформе. Иначе выключатель отнимал бы право, которым
 * его двигают, и включить платформу обратно было бы некому.
 *
 * Здесь же — единственное место во всей программе, где про платформу говорят
 * вслух: почему она не включается на этой базе. Умолчать об этом нельзя. Для
 * человека, который её включает, «переключатель не работает» без объяснения —
 * это поломка, и искать он её будет не там.
 */
import React from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { ENV_CONFIG, getAuthToken } from '../../config/env';
import { usePolicyStore } from '../../store/policyStore';
import type { PlatformState } from '../../lib/appPolicy';
import SectionShell from './SectionShell';

const authHeaders = (): Record<string, string> => {
  const token = getAuthToken();
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
};

export default function PlayPlatform({ addToast }: { addToast: (m: string, kind?: any) => void }) {
  const platform = usePolicyStore((s) => s.platform);
  const refresh = usePolicyStore((s) => s.refresh);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState('');

  const flip = async () => {
    setBusy(true);
    setFailure('');
    try {
      const res = await fetch(`${ENV_CONFIG.apiUrl}/play/platform`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ enabled: !platform.enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.error || `сервер ответил ${res.status}`));
      await refresh();
      addToast(
        (data?.platform as PlatformState)?.enabled
          ? 'Flux Play включён. Доступ к нему выдаётся отдельно, в карточке сотрудника.'
          : 'Flux Play выключен — раздел исчез у всех сотрудников.',
        'success',
      );
    } catch (e: any) {
      setFailure(e?.message || 'Не удалось изменить состояние');
    } finally {
      setBusy(false);
    }
  };

  const on = platform.enabled;

  return (
    <SectionShell
      title="Flux Play"
      desc="Встроенная игровая платформа: общий выключатель на всю компанию"
    >
      {!platform.supported && (
        <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 p-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">На этой базе платформа не включается</p>
              <p className="text-xs text-amber-700/80 dark:text-amber-300/80 mt-1 leading-relaxed">
                {platform.note || 'База не поддерживает то, на чём держится платформа.'}
              </p>
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={busy || !platform.supported}
        onClick={flip}
        className="w-full flex items-start gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-800
                   bg-white dark:bg-slate-950 text-left hover:border-emerald-500 transition-ui cursor-pointer
                   disabled:opacity-60 disabled:cursor-default disabled:hover:border-slate-200
                   dark:disabled:hover:border-slate-800"
      >
        <span className={`mt-0.5 shrink-0 w-9 h-5 rounded-full p-0.5 transition-colors ${on ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'}`}>
          <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">
            Платформа включена в компании
          </span>
          <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed text-pretty">
            Выключатель ничего не выдаёт: он только открывает саму возможность.
            Доступ каждому сотруднику выдаётся отдельно — в его карточке, в разделе «Сотрудники».
            Пока доступ не выдан, раздела для человека не существует.
          </span>
        </span>
        {busy && <Loader2 className="w-4 h-4 shrink-0 animate-spin text-slate-400" />}
      </button>

      {failure && (
        <p className="mt-3 text-xs font-semibold text-rose-600 dark:text-rose-400 leading-relaxed">{failure}</p>
      )}

      <p className="mt-4 text-xs text-slate-400 dark:text-slate-500 leading-relaxed">
        Выключение действует немедленно: раздел пропадает у всех, кто сейчас в программе,
        не дожидаясь перезапуска.
      </p>
    </SectionShell>
  );
}
