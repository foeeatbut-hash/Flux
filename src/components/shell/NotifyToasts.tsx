/**
 * Всплывашки уведомлений над панелью задач.
 *
 * Уведомление умело ровно две вещи: появиться и быть прочитанным. Этого мало:
 * письмо, пришедшее посреди сверки ведомости, сейчас не прочитать, а закрыть
 * значит забыть. Поэтому у карточки три ответа — «Открыть», «Отложить» и
 * «Убрать», — и отложенное возвращается само в назначенный час.
 *
 * Живут в углу над панелью задач, а не по центру экрана: уведомление не должно
 * закрывать собой работу, ради которой программу и открыли.
 */
import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bell, X, Clock, ExternalLink, MessageSquare, Mail, FileText, ShieldAlert, Video } from 'lucide-react';
import { useShellNotifyStore } from '../../store/shellNotifyStore';
import { SNOOZE_CHOICES } from '../../lib/notifCenter';
import { openLink } from '../../lib/openLink';

/** Значок по категории: тот же смысл, что у кнопки программы на панели задач */
function CategoryIcon({ category, source }: { category?: string; source: string }) {
  const cls = 'w-4 h-4';
  if (source === 'reminder') return <Clock className={`${cls} text-emerald-600 dark:text-emerald-400`} />;
  switch (category) {
    case 'ЧАТ': return <MessageSquare className={`${cls} text-emerald-600 dark:text-emerald-400`} />;
    case 'ДОКУМЕНТЫ': return <FileText className={`${cls} text-sky-600 dark:text-sky-400`} />;
    case 'ДОСТУП': return <ShieldAlert className={`${cls} text-rose-600 dark:text-rose-400`} />;
    case 'ПОЧТА': return <Mail className={`${cls} text-emerald-600 dark:text-emerald-400`} />;
    default: return <Bell className={`${cls} text-amber-600 dark:text-amber-400`} />;
  }
}

export default function NotifyToasts({ onOpen }: { onOpen: (route: string) => void }) {
  const toasts = useShellNotifyStore((s) => s.toasts);
  const dismiss = useShellNotifyStore((s) => s.dismiss);
  const snooze = useShellNotifyStore((s) => s.snooze);
  const [snoozing, setSnoozing] = React.useState<string | null>(null);

  // Сама уходит через полминуты — но только если на неё не смотрят: увести
  // карточку из-под курсора значит отнять у человека выбор, который он делает
  const [held, setHeld] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!toasts.length) return;
    const t = setInterval(() => {
      const now = Date.now();
      for (const x of toasts) {
        if (x.id !== held && x.id !== snoozing && now - x.at > 30000) dismiss(x.id);
      }
    }, 2000);
    return () => clearInterval(t);
  }, [toasts, held, snoozing, dismiss]);

  if (!toasts.length) return null;

  return (
    <div
      style={{ bottom: 'calc(var(--flux-taskbar-h, 0px) + 0.75rem)' }}
      className="fixed right-4 z-[9000] flex flex-col gap-2 w-[340px] max-w-[calc(100vw-2rem)]"
    >
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
            onMouseEnter={() => setHeld(t.id)}
            onMouseLeave={() => { setHeld(null); setSnoozing(null); }}
            className="fx-pop !p-0 overflow-hidden"
          >
            <div className="flex items-start gap-2.5 p-3">
              <span className="mt-0.5 shrink-0"><CategoryIcon category={t.category} source={t.source} /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">{t.title}</span>
                {t.body && (
                  <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{t.body}</span>
                )}
              </span>
              <button type="button" onClick={() => dismiss(t.id)} aria-label="Убрать"
                className="fx-ibtn shrink-0 -mr-1 -mt-0.5">
                <X />
              </button>
            </div>

            {snoozing === t.id ? (
              <div className="flex items-center gap-1 px-2 pb-2">
                <span className="text-xs text-slate-400 px-1">Вернуть через</span>
                {SNOOZE_CHOICES.map((c) => (
                  <button key={c.id} type="button" onClick={() => { snooze(t.id, c.id); setSnoozing(null); }}
                    className="fx-btn fx-btn-quiet fx-btn-sm">
                    {c.label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-1 px-2 pb-2">
                {t.action && (
                  <button type="button" onClick={() => { openLink(t.action!.url); dismiss(t.id); }}
                    className="fx-btn fx-btn-primary fx-btn-sm">
                    <Video className="!w-3.5 !h-3.5" /> {t.action.label}
                  </button>
                )}
                {t.route && (
                  <button type="button" onClick={() => { onOpen(t.route!); dismiss(t.id); }}
                    className="fx-btn fx-btn-sm">
                    <ExternalLink className="!w-3.5 !h-3.5" /> Открыть
                  </button>
                )}
                <button type="button" onClick={() => setSnoozing(t.id)}
                  className="fx-btn fx-btn-quiet fx-btn-sm">
                  <Clock className="!w-3.5 !h-3.5" /> Отложить
                </button>
              </div>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
