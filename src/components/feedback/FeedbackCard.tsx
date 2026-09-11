/**
 * Карточка обращения: что написал автор и что с этим стало.
 *
 * Кнопки действий не придумываются здесь: их список приходит с сервера
 * (`/actions`) из тех же правил, по которым сервер проверяет переход. Иначе
 * окно рано или поздно предложит то, что сервер откажется делать, — и человек
 * будет нажимать кнопку, получая отказ, не понимая, чем он провинился.
 */
import React, { useState } from 'react';
import { Paperclip, User as UserIcon } from 'lucide-react';
import ActionForm, { emptyInput, type ActionInput, type Assignee } from './ActionForm';
import {
  PRIORITIES, PRIORITY_NAMES, STATUS_NAMES, TYPE_NAMES, FREQUENCY_NAMES, IMPACT_NAMES,
  reportNumber, newRequestId, type Status,
} from '../../../feedback/contracts';

export interface Card {
  id: string;
  number: number;
  type: any;
  title: string;
  description: string;
  status: Status;
  priority?: string;
  revision: number;
  authorId: string;
  assigneeId?: string | null;
  createdAt: string;
  appVersion?: string;
  sectionKey?: string;
  frequency?: any;
  impact?: any;
  reproduction?: string;
  expected?: string;
  actual?: string;
  benefit?: string;
  attachments?: Array<{ id: string; displayName: string; byteLength: number; kind: string; mime?: string }>;
}

export interface Action {
  to: Status;
  action: string;
  needs: { reason: boolean; assignee: boolean; release: boolean; target: boolean };
}

const ACTION_NAMES: Record<string, string> = {
  take: 'Взять в разбор',
  plan: 'Запланировать',
  start: 'В работу',
  ask: 'Спросить автора',
  answer: 'Ответить',
  verify: 'На проверку',
  done: 'Готово',
  reject: 'Отклонить',
  duplicate: 'Отметить дублем',
  withdraw: 'Отозвать',
  reopen: 'Вернуть в работу',
};

function Line({ name, value }: { name: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-3 py-1">
      <span className="w-32 shrink-0 text-xs text-slate-500 dark:text-slate-400">{name}</span>
      <span className="min-w-0 flex-1 text-xs text-slate-800 dark:text-slate-150 whitespace-pre-wrap break-words">{value}</span>
    </div>
  );
}

export default function FeedbackCard({
  card, actions, names, triage, busy, assignees, candidates, failure, onAct, onPriority, onOpenFile,
}: {
  card: Card;
  actions: Action[];
  names: Record<string, string>;
  triage: boolean;
  busy: boolean;
  /** Кому можно поручить разбор — приходит с сервера. */
  assignees: Assignee[];
  /** Похожие карточки для связывания дубля. */
  candidates: Array<{ id: string; number: number; title: string; status: string }>;
  /** Что сказал сервер, если действие не прошло. */
  failure: string;
  onAct: (to: Status, input: ActionInput, clientRequestId: string) => void;
  onPriority: (priority: string, clientRequestId: string) => void;
  onOpenFile: (id: string, name: string, inline: boolean) => void;
}) {
  /**
   * Какое действие сейчас заполняют.
   *
   * Раньше здесь было одно поле причины на все переходы, и «Взять в работу»
   * уходило на сервер без исполнителя, а «Отдать на проверку» — без версии.
   * Сервер отвечал отказом, и человек не понимал, чем провинился.
   */
  const [picked, setPicked] = useState<Action | null>(null);
  const [input, setInput] = useState<ActionInput>(emptyInput);
  const steps = (() => {
    try { const list = JSON.parse(card.reproduction || '[]'); return Array.isArray(list) ? list : []; }
    catch (_) { return []; }
  })();

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-slate-500 dark:text-slate-400">{reportNumber(card.number)}</span>
          <span className="px-1.5 py-0.5 rounded text-2xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
            {STATUS_NAMES[card.status]}
          </span>
          <span className="text-2xs text-slate-500 dark:text-slate-400">{TYPE_NAMES[card.type]}</span>
        </div>
        <h2 className="mt-1 text-sm font-bold text-slate-900 dark:text-white break-words">{card.title}</h2>
        <p className="mt-0.5 text-2xs text-slate-500 dark:text-slate-400">
          {names[card.authorId] || 'Сотрудник'} · {new Date(card.createdAt).toLocaleString('ru-RU')}
          {card.appVersion ? ` · версия ${card.appVersion}` : ''}
          {card.sectionKey ? ` · раздел ${card.sectionKey}` : ''}
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
        <Line name="Что произошло" value={card.description} />
        {steps.length > 0 && <Line name="Шаги" value={steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')} />}
        <Line name="Ожидалось" value={card.expected} />
        <Line name="Получилось" value={card.actual} />
        <Line name="Польза" value={card.benefit} />
        <Line name="Как часто" value={card.frequency ? FREQUENCY_NAMES[card.frequency] : ''} />
        <Line name="Насколько мешает" value={card.impact ? IMPACT_NAMES[card.impact] : ''} />
        <Line name="Исполнитель" value={card.assigneeId ? (names[card.assigneeId] || 'Сотрудник') : ''} />
      </div>

      {!!card.attachments?.length && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-1.5">
          <div className="text-xs font-bold text-slate-800 dark:text-slate-150">Вложения</div>
          {card.attachments.map((one) => {
            // Картинки и PDF открываются в окне, остальное сохраняется: открыть
            // присланный файл в браузере — самый дешёвый способ выполнить чужую
            // разметку, а вложение к обращению открывают не задумываясь
            const inline = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(one.mime || '');
            return (
              <div key={one.id} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                <Paperclip className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                <span className="min-w-0 flex-1 truncate">{one.displayName}</span>
                <span className="shrink-0 text-slate-500 dark:text-slate-400">
                  {Math.max(1, Math.round(one.byteLength / 1024))} КБ
                </span>
                <button type="button" onClick={() => void onOpenFile(one.id, one.displayName, inline)}
                  className="shrink-0 px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200
                             dark:hover:bg-slate-800 text-2xs font-semibold cursor-pointer">
                  {inline ? 'Открыть' : 'Сохранить'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {triage && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <UserIcon className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-xs font-bold text-slate-800 dark:text-slate-150">Важность</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PRIORITIES.map((one) => (
              <button key={one} type="button" disabled={busy}
                onClick={() => onPriority(one, newRequestId())}
                title={PRIORITY_NAMES[one]}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border disabled:opacity-50
                  ${card.priority === one
                    ? 'bg-emerald-600 border-emerald-600 text-white'
                    : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300'}`}>
                {one}
              </button>
            ))}
          </div>
        </div>
      )}

      {actions.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2">
          <div className="text-xs font-bold text-slate-800 dark:text-slate-150">Что можно сделать</div>
          {picked ? (
            <ActionForm
              action={picked} assignees={assignees} candidates={candidates} busy={busy} failure={failure}
              value={input} onChange={setInput}
              onSubmit={() => onAct(picked.to, input, newRequestId())}
              onCancel={() => { setPicked(null); setInput(emptyInput()); }}
            />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {actions.map((one) => (
                <button key={`${one.action}-${one.to}`} type="button" disabled={busy}
                  onClick={() => {
                    // Действию без обязательных полей форма не нужна: лишний
                    // шаг там, где нечего заполнять, — это просто лишний шаг
                    const needsSomething = one.needs.reason || one.needs.assignee
                      || one.needs.release || one.needs.target;
                    if (needsSomething) { setInput(emptyInput()); setPicked(one); return; }
                    onAct(one.to, emptyInput(), newRequestId());
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer bg-slate-100 dark:bg-slate-900
                             hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 disabled:opacity-50">
                  {ACTION_NAMES[one.action] || one.action}
                </button>
              ))}
            </div>
          )}
          {!picked && failure && <p className="text-xs text-rose-600 dark:text-rose-400">{failure}</p>}
        </div>
      )}
    </div>
  );
}
