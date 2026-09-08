/**
 * «Сообщить об ошибке».
 *
 * Сообщение уходит в канал «Ошибки» — общий, а не личную переписку с
 * администратором. Это решение владельца, и оно про то, как чинят на самом
 * деле: «у меня тоже такое было» стоит дороже, чем ещё одно письмо в
 * одиночку. Канал видят все сотрудники и по умолчанию он молчит — уведомлений
 * о сообщениях в группах программа не шлёт.
 *
 * Ничего не уходит наружу: сообщение попадает на сервер компании, туда же, где
 * лежит вся переписка. Что именно приложено, человек видит галочками до
 * отправки — молча собирать журнал и отсылать его нельзя.
 */
import React from 'react';
import { X, Bug, Check } from 'lucide-react';
import { useStore } from '../../store/store';
import { useToastStore } from '../../store/toastStore';
import { ENV_CONFIG, getAuthToken } from '../../config/env';
import { todayLog, hasLogFiles } from '../../lib/crashLog';
import { Z } from '../../lib/layers';

const headers = (): Record<string, string> => {
  const t = getAuthToken();
  return { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
};

/** Кусок журнала, который влезает в сообщение и остаётся читаемым */
const LOG_TAIL = 4000;

export default function ReportProblem({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.user);
  const { addToast } = useToastStore();
  const [text, setText] = React.useState('');
  const [withLog, setWithLog] = React.useState(true);
  const [withVersion, setWithVersion] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [logSize, setLogSize] = React.useState(0);

  React.useEffect(() => {
    void todayLog().then((t) => setLogSize(t.length));
  }, []);

  const send = async () => {
    if (!text.trim()) { addToast('Опишите, что случилось', 'info'); return; }
    setBusy(true);
    try {
      const groups = await fetch(`${ENV_CONFIG.apiUrl}/chat/groups`, { headers: headers() }).then((r) => r.json());
      const errors = (Array.isArray(groups) ? groups : []).find((g: any) => g.name === 'Ошибки');
      if (!errors) throw new Error('канал «Ошибки» не найден');

      const parts = [text.trim()];
      if (withVersion) {
        parts.push(`\n— версия ${__APP_VERSION__}, раздел ${window.location.hash.replace(/^#/, '') || '/'}`);
      }
      if (withLog) {
        const log = await todayLog();
        if (log) parts.push(`\nЖурнал за сегодня (конец):\n${log.slice(-LOG_TAIL)}`);
      }

      const res = await fetch(`${ENV_CONFIG.apiUrl}/chat/group-messages`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ senderId: me?.id, chatGroupId: errors.id, content: parts.join('\n') }),
      });
      if (!res.ok) throw new Error('сообщение не ушло');
      addToast('Сообщение в канале «Ошибки» — его видят все', 'success');
      onClose();
    } catch (err: any) {
      addToast(`Не удалось отправить: ${err?.message || 'нет связи'}`, 'error');
    } finally { setBusy(false); }
  };

  const Row = ({ on, onFlip, title, hint }: { on: boolean; onFlip: () => void; title: string; hint: string }) => (
    <button type="button" onClick={onFlip}
      className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left cursor-pointer
                 hover:bg-slate-100 dark:hover:bg-slate-850">
      <span className={`mt-0.5 w-4 h-4 rounded shrink-0 flex items-center justify-center border
                        ${on ? 'bg-emerald-600 border-emerald-600' : 'border-slate-300 dark:border-slate-700'}`}>
        {on && <Check className="w-3 h-3 text-white" />}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-slate-800 dark:text-slate-100">{title}</span>
        <span className="block text-2xs text-slate-500 dark:text-slate-400">{hint}</span>
      </span>
    </button>
  );

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-slate-900/40 backdrop-blur-[1px] p-4"
      style={{ zIndex: Z.modal }} onMouseDown={onClose}>
      <div role="dialog" aria-label="Сообщить об ошибке" onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-dark-border
                   bg-white dark:bg-dark-surface shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-dark-border">
          <Bug className="w-4 h-4 text-rose-500" />
          <span className="text-sm font-bold text-slate-800 dark:text-slate-100">Сообщить об ошибке</span>
          <span className="flex-1" />
          <button type="button" onClick={onClose} aria-label="Закрыть"
            className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <label className="block">
            <span className="block text-2xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Что случилось</span>
            <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={3}
              placeholder="Закрылась Таблица при вставке столбца"
              className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg
                         px-3 py-2 text-sm text-slate-800 dark:text-slate-150 outline-none focus:border-emerald-400 resize-none" />
          </label>

          <div>
            <span className="block text-2xs font-semibold text-slate-500 dark:text-slate-400 mb-1">К сообщению приложим</span>
            <Row on={withVersion} onFlip={() => setWithVersion((v) => !v)}
              title={`Версия ${__APP_VERSION__} и открытый раздел`}
              hint="По ним видно, где искать" />
            <Row on={withLog && hasLogFiles()} onFlip={() => setWithLog((v) => !v)}
              title={hasLogFiles() ? `Журнал за сегодня (${Math.round(logSize / 1024)} КБ)` : 'Журнал недоступен в браузере'}
              hint={hasLogFiles() ? 'Последние строки — то, что происходило до сбоя' : 'Файлы журналов ведёт программа на компьютере'} />
          </div>

          <p className="text-2xs text-slate-500 dark:text-slate-400 leading-relaxed">
            Уйдёт в канал «Ошибки» — его видят все сотрудники, и по умолчанию он молчит.
            Наружу не уходит ничего: сообщение попадает на сервер компании.
          </p>

          <div className="flex items-center gap-2 pt-1">
            <span className="flex-1" />
            <button type="button" onClick={onClose}
              className="px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer text-slate-600 dark:text-slate-300
                         hover:bg-slate-100 dark:hover:bg-slate-850">
              Отмена
            </button>
            <button type="button" onClick={send} disabled={busy}
              className="px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer bg-emerald-600 text-white
                         hover:bg-emerald-700 disabled:opacity-50">
              Отправить
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
