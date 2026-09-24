/**
 * «Быть в сети» — переключатель для администратора.
 *
 * Право скрыть себя есть только у главного администратора, и это решение
 * владельца, а не мера предосторожности: если невидимкой может стать любой,
 * раздел «кто сейчас в программе» перестаёт отвечать на свой же вопрос.
 *
 * Разрешение спрашивается у сервера, а не считается по роли на месте: правами
 * распоряжается сервер, и переключатель, который потом получит отказ, хуже
 * отсутствующего. Не разрешено — блока нет вовсе.
 *
 * Скрытие убирает оба следа сразу — зелёную точку и «был(а) N назад». Одно без
 * другого ничего не скрывает: «заходил минуту назад» — тот же ответ другими
 * словами.
 */
import React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { ENV_CONFIG, getAuthToken } from '../../config/env';

export default function OnlineVisibility({ addToast }: { addToast?: (m: string, kind?: any) => void }) {
  const [allowed, setAllowed] = React.useState(false);
  const [hidden, setHidden] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [ready, setReady] = React.useState(false);

  const headers = (): Record<string, string> => {
    const t = getAuthToken();
    return t ? { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }
      : { 'Content-Type': 'application/json' };
  };

  React.useEffect(() => {
    let alive = true;
    fetch(`${ENV_CONFIG.apiUrl}/presence/visibility`, { headers: headers() })
      .then((r) => r.json())
      .then((d: any) => {
        if (!alive) return;
        setAllowed(!!d?.allowed);
        setHidden(!!d?.hidden);
        setReady(true);
      })
      .catch(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, []);

  if (!ready || !allowed) return null;

  const flip = async () => {
    const next = !hidden;
    setBusy(true);
    try {
      const res = await fetch(`${ENV_CONFIG.apiUrl}/presence/visibility`, {
        method: 'PUT', headers: headers(), body: JSON.stringify({ hidden: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || 'Не удалось сохранить');
      setHidden(!!data.hidden);
      addToast?.(data.hidden
        ? 'Вы скрыты: сотрудники видят вас не в сети'
        : 'Вы снова в сети для всех', 'success');
    } catch (e: any) {
      addToast?.(e?.message || 'Не удалось сохранить', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 rounded-xl border border-slate-150 dark:border-slate-850 bg-slate-50/50 dark:bg-slate-900/30">
      <div className="text-xs font-bold text-slate-400 mb-1">Присутствие</div>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
        Видно ли сотрудникам, что вы в программе. Доступно только вам как главному администратору.
      </p>
      <button
        type="button"
        onClick={flip}
        role="switch"
        aria-checked={!hidden}
        disabled={busy}
        className={`w-full flex items-start gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-800
                    bg-white dark:bg-slate-950 text-left transition-ui
                    ${busy ? 'opacity-50 cursor-wait' : 'hover:border-emerald-500 cursor-pointer'}`}
      >
        <span className={`mt-0.5 shrink-0 w-9 h-5 rounded-full p-0.5 transition-colors ${hidden ? 'bg-slate-300 dark:bg-slate-700' : 'bg-emerald-600'}`}>
          <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${hidden ? '' : 'translate-x-4'}`} />
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
            {hidden ? <EyeOff className="w-4 h-4 text-slate-400" /> : <Eye className="w-4 h-4 text-emerald-600" />}
            Показывать, что я в сети
          </span>
          <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5 text-pretty">
            {hidden
              ? 'Сейчас вы скрыты: у сотрудников вы «не в сети», и когда вы заходили — тоже не видно. Себя вы видите как обычно.'
              : 'Сотрудники видят зелёную точку в чате и в списке сотрудников, а после ухода — когда вы были в последний раз.'}
          </span>
        </span>
      </button>
    </div>
  );
}
