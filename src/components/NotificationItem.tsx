/**
 * Одно уведомление в центре уведомлений: заголовок, текст, время, отложить и
 * перейти. Непрочитанное отмечено точкой перед заголовком, а не заливкой и не
 * полосой слева: полоса по методологии — примета сгенерированного интерфейса,
 * заливка спорит с выделением.
 */
import { Clock, ExternalLink } from 'lucide-react';
import { SNOOZE_CHOICES, type FeedItem } from '../lib/notifCenter';

const fmt = (iso?: string) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
};

export default function NotificationItem({ n, snoozing, onSnoozeMenu, onSnooze, onGo }: {
  n: FeedItem;
  snoozing: boolean;
  onSnoozeMenu: (open: boolean) => void;
  onSnooze: (choice: typeof SNOOZE_CHOICES[number]['id']) => void;
  onGo: (route?: string) => void;
}) {
  return (
    <div
      data-personal-id={n.kind === 'personal' && !n.isRead ? n.id.slice(2) : undefined}
      className="px-3 py-2 rounded-lg transition-colors bg-slate-500/10 hover:bg-slate-500/15"
    >
      <div className="flex items-start gap-1.5">
        <span aria-label={n.isRead ? undefined : 'Не прочитано'}
          className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${n.isRead ? 'bg-transparent' : 'bg-emerald-500'}`} />
        <div className={`min-w-0 flex-1 break-words text-sm leading-snug ${
          n.kind === 'personal' ? 'font-medium text-slate-900 dark:text-slate-100' : 'text-slate-800 dark:text-slate-100'
        }`}>{n.title}</div>
        {n.kind === 'personal' && <span className="text-2xs shrink-0 text-slate-500 dark:text-slate-400">вам</span>}
      </div>
      {n.body && <div className="break-words text-xs text-slate-600 dark:text-slate-300 mt-0.5 leading-snug pl-3">{n.body}</div>}
      <div className="flex items-center gap-1 mt-1.5 pl-3">
        <span className="text-2xs text-slate-500 dark:text-slate-400 flex items-center gap-0.5 mr-auto min-w-0">
          {n.who ? <span className="min-w-0 truncate font-semibold mr-1">{n.who}</span> : null}
          <Clock className="w-2.5 h-2.5 shrink-0" />{fmt(n.createdAt)}
        </span>
        {n.kind === 'personal' && (snoozing ? (
          SNOOZE_CHOICES.map((c) => (
            <button key={c.id} type="button" onClick={() => onSnooze(c.id)}
              className="px-1.5 py-0.5 rounded-md text-2xs font-semibold text-slate-700 dark:text-slate-100
                         hover:bg-slate-500/20 cursor-pointer">
              {c.label}
            </button>
          ))
        ) : (
          <button type="button" onClick={() => onSnoozeMenu(true)} title="Вернуть позже" aria-label="Вернуть позже"
            className="p-1 rounded-md text-slate-500 hover:bg-slate-500/20 cursor-pointer">
            <Clock className="w-3 h-3" />
          </button>
        ))}
        {n.targetRoute && n.targetRoute !== '#' && (
          <button type="button" onClick={() => onGo(n.targetRoute)} title="Открыть" aria-label="Открыть"
            className="p-1 rounded-md text-emerald-700 dark:text-emerald-400 hover:bg-slate-500/20 cursor-pointer">
            <ExternalLink className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}
