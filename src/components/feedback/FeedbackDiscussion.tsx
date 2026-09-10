/**
 * Обсуждение обращения: сообщения и история событий.
 *
 * Внутренняя заметка помечена и цветом, и словами. Это не украшение: она видна
 * только тем, кто разбирает, и обработчик должен понимать, что пишет мимо
 * автора, ДО того как нажал «Отправить», а не после. Сервер это тоже
 * проверяет — здесь речь о том, чтобы человек не ошибся.
 */
import React, { useState } from 'react';
import { Lock, MessageSquare } from 'lucide-react';
import { LIMITS, newRequestId } from '../../../feedback/contracts';

export interface Comment {
  id: string;
  authorId: string;
  visibility: 'PUBLIC' | 'INTERNAL';
  text: string;
  redacted?: boolean;
  createdAt: string;
}

export interface Event {
  id: string;
  kind: string;
  visibility: string;
  createdAt: string;
  actorId?: string;
  data?: string;
}

const KIND_NAMES: Record<string, string> = {
  created: 'Обращение заведено',
  statusChanged: 'Состояние изменено',
  commented: 'Сообщение',
  assigned: 'Назначен исполнитель',
  priorityChanged: 'Изменён приоритет',
  attachmentAdded: 'Приложен файл',
};

export default function FeedbackDiscussion({ comments, events, names, canInternal, busy, onSend }: {
  comments: Comment[];
  events: Event[];
  names: Record<string, string>;
  canInternal: boolean;
  busy: boolean;
  onSend: (text: string, visibility: 'PUBLIC' | 'INTERNAL', clientRequestId: string) => void;
}) {
  const [text, setText] = useState('');
  const [internal, setInternal] = useState(false);

  const send = () => {
    if (!text.trim() || busy) return;
    onSend(text.trim(), internal ? 'INTERNAL' : 'PUBLIC', newRequestId());
    setText('');
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {comments.length === 0 && (
          <p className="text-xs text-slate-500 dark:text-slate-400">Сообщений пока нет.</p>
        )}
        {comments.map((one) => (
          <div key={one.id}
            className={`rounded-lg border p-2.5 ${one.visibility === 'INTERNAL'
              ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20'
              : 'border-slate-200 dark:border-slate-800'}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-150">
                {names[one.authorId] || 'Сотрудник'}
              </span>
              {one.visibility === 'INTERNAL' && (
                <span className="flex items-center gap-1 text-2xs font-semibold text-amber-700 dark:text-amber-400">
                  <Lock className="w-3 h-3" /> только для разбирающих
                </span>
              )}
              <span className="flex-1" />
              <span className="text-2xs text-slate-500 dark:text-slate-400">
                {new Date(one.createdAt).toLocaleString('ru-RU')}
              </span>
            </div>
            <p className="text-xs text-slate-800 dark:text-slate-150 whitespace-pre-wrap break-words">
              {one.redacted ? 'Сообщение убрано обработчиком.' : one.text}
            </p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5 space-y-2">
        <textarea value={text} rows={3} maxLength={LIMITS.comment} onChange={(e) => setText(e.target.value)}
          placeholder={internal ? 'Заметка для тех, кто разбирает — автор её не увидит' : 'Ответ автору обращения'}
          className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg
                     px-3 py-2 text-sm text-slate-800 dark:text-slate-150 outline-none focus:border-emerald-400 resize-none" />
        <div className="flex items-center gap-2">
          {canInternal && (
            <button type="button" onClick={() => setInternal((v) => !v)}
              className={`px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 text-xs font-semibold cursor-pointer border
                ${internal
                  ? 'bg-amber-100 dark:bg-amber-900/40 border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300'
                  : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'}`}>
              {internal ? <Lock className="w-3.5 h-3.5" /> : <MessageSquare className="w-3.5 h-3.5" />}
              {internal ? 'Внутренняя заметка' : 'Виден автору'}
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={send} disabled={busy || !text.trim()}
            className="px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer bg-emerald-600 text-white
                       hover:bg-emerald-700 disabled:opacity-50">
            Отправить
          </button>
        </div>
      </div>

      <details className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5">
        <summary className="text-xs font-semibold text-slate-700 dark:text-slate-150 cursor-pointer">
          Что происходило ({events.length})
        </summary>
        <div className="mt-2 space-y-1">
          {events.map((one) => (
            <div key={one.id} className="flex gap-2 text-2xs text-slate-500 dark:text-slate-400">
              <span className="shrink-0">{new Date(one.createdAt).toLocaleString('ru-RU')}</span>
              <span className="min-w-0 flex-1">
                {KIND_NAMES[one.kind] || one.kind}
                {one.actorId && names[one.actorId] ? ` — ${names[one.actorId]}` : ''}
              </span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
