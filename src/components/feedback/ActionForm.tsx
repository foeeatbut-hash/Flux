/**
 * Форма действия обработчика.
 *
 * Кнопки переходов приходили с сервера вместе со списком того, что каждому
 * переходу нужно, — и этот список никто не читал. Окно слало одну причину, а
 * сервер требовал ещё исполнителя, версию исправления или основную карточку и
 * отвечал отказом. То есть «Взять в работу» и «Отдать на проверку» не работали
 * вовсе: человек нажимал кнопку, получал «Так менять нельзя» и не понимал,
 * чем он провинился.
 *
 * Теперь по тем же `needs` строится форма. Видимость кнопки серверную проверку
 * не заменяет: сервер проверяет то же самое ещё раз — здесь мы лишь не даём
 * человеку отправить заведомо неполное.
 */

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Action } from './FeedbackCard';

export interface Assignee { id: string; name: string }

/** Что человек ввёл для действия. Пустые поля не отправляются. */
export interface ActionInput {
  reason: string;
  assigneeId: string;
  resolvedVersion: string;
  noReleaseReason: string;
  targetReportId: string;
}

export const emptyInput = (): ActionInput => ({
  reason: '', assigneeId: '', resolvedVersion: '', noReleaseReason: '', targetReportId: '',
});

/** Чего не хватает. Пустая строка — можно отправлять. */
export function whatIsMissing(action: Action, input: ActionInput): string {
  if (action.needs.reason && !input.reason.trim()) return 'Напишите причину — её увидит автор';
  if (action.needs.assignee && !input.assigneeId) return 'Выберите, кто берётся за это';
  if (action.needs.release && !input.resolvedVersion.trim() && !input.noReleaseReason.trim()) {
    return 'Укажите версию с исправлением или объясните, почему выпуска не будет';
  }
  if (action.needs.target && !input.targetReportId.trim()) return 'Выберите основную карточку';
  return '';
}

const field = `w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg
                px-3 py-2 text-xs text-slate-800 dark:text-slate-150 outline-none focus:border-emerald-400`;

export default function ActionForm({ action, assignees, candidates, busy, failure, value, onChange, onSubmit, onCancel }: {
  action: Action;
  assignees: Assignee[];
  candidates: Array<{ id: string; number: number; title: string; status: string }>;
  busy: boolean;
  /** Что сказал сервер, если действие не прошло. Введённое при этом остаётся. */
  failure: string;
  value: ActionInput;
  onChange: (next: ActionInput) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const [complaint, setComplaint] = useState('');
  const set = (patch: Partial<ActionInput>) => { onChange({ ...value, ...patch }); setComplaint(''); };

  // Исполнитель по умолчанию — тот, кто нажал: чаще всего берут на себя
  useEffect(() => {
    if (action.needs.assignee && !value.assigneeId && assignees.length) {
      onChange({ ...value, assigneeId: assignees[0].id });
    }
    // Один раз на открытие формы: дальше выбор за человеком
  }, [action.action]);

  const send = () => {
    const missing = whatIsMissing(action, value);
    if (missing) { setComplaint(missing); return; }
    onSubmit();
  };

  return (
    <div className="rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50/60
                    dark:bg-emerald-950/20 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold text-slate-800 dark:text-slate-150">{action.action}</span>
        <span className="flex-1" />
        <button type="button" onClick={onCancel} aria-label="Отменить действие" disabled={busy}
          className="w-6 h-6 rounded-md flex items-center justify-center cursor-pointer text-slate-400
                     hover:bg-slate-200/60 dark:hover:bg-slate-800 disabled:opacity-40">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {action.needs.assignee && (
        <label className="block">
          <span className="block text-2xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Кто берётся</span>
          <select value={value.assigneeId} onChange={(e) => set({ assigneeId: e.target.value })} className={field}>
            <option value="">— выберите —</option>
            {assignees.map((one) => <option key={one.id} value={one.id}>{one.name}</option>)}
          </select>
          {!assignees.length && (
            <span className="block mt-1 text-2xs text-amber-700 dark:text-amber-400">
              Некому назначить: ни у кого нет права «Разбор обращений»
            </span>
          )}
        </label>
      )}

      {action.needs.release && (
        <>
          <label className="block">
            <span className="block text-2xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
              В какой версии исправлено
            </span>
            <input value={value.resolvedVersion} onChange={(e) => set({ resolvedVersion: e.target.value })}
              placeholder="1.3.0" className={field} />
          </label>
          <label className="block">
            <span className="block text-2xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
              …или почему выпуска не будет
            </span>
            <input value={value.noReleaseReason} onChange={(e) => set({ noReleaseReason: e.target.value })}
              placeholder="Настройка на стороне сервера, обновление не нужно" className={field} />
          </label>
        </>
      )}

      {action.needs.target && (
        <label className="block">
          <span className="block text-2xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
            Основная карточка
          </span>
          <select value={value.targetReportId} onChange={(e) => set({ targetReportId: e.target.value })} className={field}>
            <option value="">— выберите —</option>
            {candidates.map((one) => (
              <option key={one.id} value={one.id}>{`ОБР-${String(one.number).padStart(6, '0')} · ${one.title}`}</option>
            ))}
          </select>
          {!candidates.length && (
            <span className="block mt-1 text-2xs text-amber-700 dark:text-amber-400">
              Похожих карточек не нашлось — связывать не с чем
            </span>
          )}
        </label>
      )}

      {action.needs.reason && (
        <label className="block">
          <span className="block text-2xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
            Причина или вопрос — это увидит автор
          </span>
          <textarea value={value.reason} rows={2} onChange={(e) => set({ reason: e.target.value })}
            className={`${field} resize-none`} />
        </label>
      )}

      {complaint && <p className="text-xs text-rose-600 dark:text-rose-400">{complaint}</p>}
      {/* Отказ сервера показывается здесь же, и введённое НЕ стирается: при
          расхождении ревизий человек не должен набирать всё заново */}
      {failure && <p className="text-xs text-rose-600 dark:text-rose-400">{failure}</p>}

      <div className="flex items-center gap-2">
        <span className="flex-1" />
        <button type="button" onClick={onCancel} disabled={busy}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer bg-slate-100 dark:bg-slate-900
                     hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 disabled:opacity-50">
          Отмена
        </button>
        <button type="button" onClick={send} disabled={busy}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer bg-emerald-600 text-white
                     hover:bg-emerald-700 disabled:opacity-50">
          {busy ? 'Применяем…' : 'Подтвердить'}
        </button>
      </div>
    </div>
  );
}
