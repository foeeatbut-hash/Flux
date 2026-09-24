import React from 'react';
import { CheckCircle2, Loader2, RefreshCw, X, AlertTriangle, Ban } from 'lucide-react';

/**
 * Центр операций: что сейчас ввозится и чем кончилось недавнее.
 *
 * Заказчик приносит расчёт папкой — двадцать три выгрузки за раз. Раньше такой
 * ввоз жил во вкладке браузера и умирал вместе с ней: закрыл на седьмом файле
 * — дальше ничего не уехало, а какие семь уехали, узнать было неоткуда.
 *
 * Теперь очередь живёт на сервере, а это окно только смотрит. Поэтому здесь
 * нет ни одной кнопки «продолжить»: продолжать нечего, оно и так идёт. Есть
 * «Отменить» — и она честно говорит, что задание, которое пишется прямо
 * сейчас, не обрывается: оборванная запись оставила бы в проекте полуустановку.
 */

export interface OperationJob {
  id: string; fileName: string; state: string; attempt: number; error: string;
  summary?: { newBlocks?: number; updatedBlocks?: number; tagsLinked?: number; tagsCreated?: number } | null;
}
export interface OperationBatch {
  id: string; title: string; state: string; category: string; createdAt: string;
  total: number; done: number; failed: number; cancelled: number; running: number; queued: number;
  jobs: OperationJob[];
}

const STATE_WORD: Record<string, string> = {
  QUEUED: 'в очереди', RUNNING: 'пишется', DONE: 'готово',
  FAILED: 'не удалось', CANCELLED: 'отменено',
};

const stateIcon = (state: string) =>
  state === 'DONE' ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
    : state === 'FAILED' ? <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
      : state === 'CANCELLED' ? <Ban className="w-3.5 h-3.5 text-slate-400" />
        : state === 'RUNNING' ? <Loader2 className="w-3.5 h-3.5 text-sky-500 animate-spin" />
          : <Loader2 className="w-3.5 h-3.5 text-slate-300" />;

interface Props {
  batches: OperationBatch[];
  loading: boolean;
  onRefresh: () => void;
  onCancel: (batchId: string) => void;
  onClose: () => void;
}

export default function ImportOperations({ batches, loading, onRefresh, onCancel, onClose }: Props) {
  const [open, setOpen] = React.useState<Record<string, boolean>>({});

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label="Центр операций">
      <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden flex flex-col max-h-[80vh]">
        <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">Центр операций</div>
            <div className="text-2xs text-slate-500 dark:text-slate-400 truncate">
              ввоз идёт на сервере — это окно можно закрыть
            </div>
          </div>
          <span className="flex-1" />
          <button type="button" onClick={onRefresh} className="p-1 text-slate-400 hover:text-emerald-600 cursor-pointer" title="Обновить">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-150 cursor-pointer" aria-label="Закрыть">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {batches.length === 0 && (
            <div className="blank">
              <div className="blank-title">Ничего не ввозится</div>
              <div className="blank-text">
                Партия появится здесь, как только вы отправите файлы расчёта в фоновый импорт.
              </div>
            </div>
          )}

          {batches.map((b) => {
            const left = b.queued + b.running;
            const pct = b.total ? Math.round(((b.done + b.failed + b.cancelled) / b.total) * 100) : 0;
            return (
              <div key={b.id} className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
                <div className="px-3 py-2 flex items-center gap-2">
                  {stateIcon(b.state === 'RUNNING' && b.running ? 'RUNNING' : b.state)}
                  <button type="button" onClick={() => setOpen((o) => ({ ...o, [b.id]: !o[b.id] }))}
                    className="flex-1 min-w-0 text-left cursor-pointer">
                    <div className="text-xs font-semibold truncate">{b.title}</div>
                    <div className="text-2xs text-slate-500 dark:text-slate-400">
                      {b.done} из {b.total} готово
                      {b.failed ? ` · не удалось: ${b.failed}` : ''}
                      {b.cancelled ? ` · отменено: ${b.cancelled}` : ''}
                    </div>
                  </button>
                  {left > 0 && (
                    <button type="button" onClick={() => onCancel(b.id)}
                      className="shrink-0 px-2 py-1 text-2xs rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer hover:text-rose-600">
                      Отменить
                    </button>
                  )}
                </div>
                <div className="h-1 bg-slate-100 dark:bg-slate-800">
                  <div className={`h-1 ${b.failed ? 'bg-rose-400' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
                </div>

                {open[b.id] && (
                  <div className="divide-y divide-slate-100 dark:divide-slate-850">
                    {b.jobs.map((j) => (
                      <div key={j.id} className="px-3 py-1.5 flex items-start gap-2 text-2xs">
                        {stateIcon(j.state)}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-slate-700 dark:text-slate-300">{j.fileName}</div>
                          <div className="text-slate-500 dark:text-slate-400">
                            {STATE_WORD[j.state] || j.state}
                            {j.summary ? ` · новых ${j.summary.newBlocks ?? 0}, обновлено ${j.summary.updatedBlocks ?? 0}` : ''}
                            {j.attempt > 1 && j.state !== 'DONE' ? ` · попытка ${j.attempt}` : ''}
                          </div>
                          {/* Причина показывается целиком: «не удалось» без
                              причины человек читает как «программа сломалась» */}
                          {j.error && <div className="text-rose-600 dark:text-rose-400 break-words">{j.error}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
