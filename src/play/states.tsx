/**
 * Состояния экранов платформы: ждём, пусто, сорвалось, связь восстанавливается,
 * показанное устарело.
 *
 * Вынесены отдельно и написаны один раз намеренно. Платформа живёт на живой
 * связи, и у каждого её экрана этих состояний не одно, а все пять сразу:
 * группа грузится, приглашений нет, команда не ушла, сокет переподключается,
 * а список на экране старше тридцати пяти секунд и верить ему уже нельзя.
 * Пока каждый экран рисовал их сам, «переподключение» где-то было спиннером,
 * где-то — пустым списком, а где-то не было ничего: человек видел пустую
 * группу и решал, что его оттуда выгнали.
 *
 * Правило здесь одно: молчать нельзя. Пустой экран без слов люди читают как
 * поломку, а устаревший список без пометки — как правду.
 */
import React from 'react';
import { AlertTriangle, Loader2, PlugZap, RefreshCw } from 'lucide-react';

/** Ждём первого ответа: полоски вместо содержимого, без прыжка вёрстки. */
export function Waiting({ rows = 4 }: { rows?: number }) {
  return (
    <div className="p-3 space-y-2" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-14 rounded-xl bg-slate-100 dark:bg-slate-850 animate-pulse" />
      ))}
    </div>
  );
}

/** Пусто — и это нормальный ответ, а не сбой. */
export function Empty({ icon, title, hint, action }: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 px-6 text-center">
      <div className="w-11 h-11 rounded-2xl bg-slate-100 dark:bg-slate-850 flex items-center justify-center text-slate-400 dark:text-slate-500">
        {icon}
      </div>
      <p className="text-sm font-semibold text-slate-700 dark:text-slate-150">{title}</p>
      {hint && <p className="text-xs text-slate-400 dark:text-slate-500 max-w-sm leading-relaxed">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * Не вышло.
 *
 * Причина пишется словами и рядом ставится «Повторить»: отказ без кнопки
 * оставляет человека перезапускать программу — так было с лицензией, и это
 * оказалось дороже любой ошибки.
 */
export function Failure({ text, onRetry, busy }: { text: string; onRetry?: () => void; busy?: boolean }) {
  return (
    <div className="m-3 rounded-xl border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 p-3">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-rose-500 dark:text-rose-400" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-rose-700 dark:text-rose-300 leading-relaxed break-words">{text}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={busy}
              className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-2xs font-bold
                         bg-white dark:bg-slate-900 border border-rose-200 dark:border-rose-900/50
                         text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-950/60
                         disabled:opacity-50 cursor-pointer transition-colors"
            >
              {busy
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <RefreshCw className="w-3 h-3" />}
              Повторить
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Связь пропала.
 *
 * Полоса, а не пустой экран: пока сокет переподключается, показанное ещё верно,
 * и стирать его — значит врать сильнее, чем оставить с пометкой.
 */
export function Reconnecting({ note = 'Связь восстанавливается' }: { note?: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-950/30
                    border-b border-amber-200 dark:border-amber-900/50">
      <PlugZap className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400 animate-pulse" />
      <span className="text-2xs font-semibold text-amber-700 dark:text-amber-300">{note}</span>
    </div>
  );
}

/**
 * Показанному больше тридцати пяти секунд.
 *
 * ТЗ называет этот предел прямо: дальше состояние считается устаревшим. Оно
 * остаётся на экране — но с пометкой, потому что человек, нажавший «Готов» по
 * устаревшему лобби, получил бы отказ без объяснения.
 */
export function Stale({ seconds }: { seconds: number }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 dark:bg-slate-850
                    border-b border-slate-200 dark:border-slate-800">
      <RefreshCw className="w-3.5 h-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
      <span className="text-2xs font-semibold text-slate-500 dark:text-slate-400">
        Данные не обновлялись {seconds} с — возможно, они уже неверны
      </span>
    </div>
  );
}
