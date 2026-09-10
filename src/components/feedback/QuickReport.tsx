/**
 * «Сообщить об ошибке» в одну строку.
 *
 * Решение владельца: сотруднику журналы не показываются вовсе. Он пишет, что
 * случилось, и нажимает «Отправить»; технические записи уезжают вместе с
 * обращением сами, разбирающему они и нужны. Это осознанный размен: галочка
 * «приложить технические записи» и предпросмотр пакета съедали ровно ту минуту,
 * из-за которой человек закрывал форму и не сообщал ничего.
 *
 * Размен честный ровно потому, что записывать нечего лишнего: в записи нет ни
 * содержимого документов, ни имён файлов, ни паролей — только виды событий,
 * длительности и исходы (см. `diagnostics/contracts.ts`). Снимок экрана — дело
 * другое, на нём может оказаться чужая переписка, поэтому он остаётся по
 * явному нажатию и с предпросмотром.
 *
 * Подробная форма никуда не делась: она живёт в разделе «Замечания и
 * предложения» — там, где заводят идеи и разбирают чужое.
 */
import React, { useEffect, useState } from 'react';
import { Bug, Check, FileDown, X } from 'lucide-react';
import { Z } from '../../lib/layers';
import { useEscapeClose } from '../../lib/useDismiss';
import { LIMITS } from '../../../feedback/contracts';
import { useComposer, saveNote } from '../../feedback/useComposer';
import { draftToFile } from '../../feedback/draftDb';
import { submissionQueue, type QueueItem } from '../../feedback/submissionQueue';
import { newRequestId } from '../../../feedback/contracts';

/**
 * Заголовок из написанного.
 *
 * У обращения должен быть заголовок — по нему его находят в очереди и в
 * списке. Спрашивать его отдельно значило бы вернуть вторую строку, поэтому он
 * берётся из первого предложения, а всё написанное целиком становится
 * описанием.
 */
export function titleFrom(text: string): string {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  const stop = clean.search(/[.!?]\s|[.!?]$/);
  const first = stop > 0 ? clean.slice(0, stop + 1) : clean;
  return first.length > LIMITS.title.max ? `${first.slice(0, LIMITS.title.max - 1)}…` : first;
}

/** Что мешает отправить. Пустая строка — ничего. */
export function whyNotSend(text: string): string {
  const clean = String(text || '').trim();
  if (clean.length < LIMITS.description.min) return 'Напишите чуть подробнее — хотя бы одним предложением';
  if (titleFrom(clean).length < LIMITS.title.min) return 'Первое предложение слишком короткое';
  return '';
}

export default function QuickReport({ userId, appVersion, sectionKey, onClose }: {
  userId: string;
  appVersion: string;
  sectionKey?: string;
  onClose: () => void;
}) {
  const [draftId] = useState(() => newRequestId());
  const composer = useComposer(draftId, userId, appVersion, sectionKey || '', 'BUG');
  const { fields, setFields } = composer;
  const [text, setText] = useState('');
  const [queued, setQueued] = useState<QueueItem | null>(null);
  const [sending, setSending] = useState(false);
  const [complaint, setComplaint] = useState('');

  useEscapeClose(true, () => { if (!sending) onClose(); });

  // Записи прикладываются сами — здесь это не выбор человека, а устройство
  useEffect(() => {
    setFields((prev) => ({ ...prev, technicalEvents: true, appContext: true }));
  }, [setFields]);

  useEffect(() => submissionQueue.subscribe((items) => {
    setQueued(items.find((i) => i.key.endsWith(`|${draftId}`)) || null);
  }), [draftId]);

  /**
   * Забрать написанное файлом.
   *
   * Нужно ровно в одном случае: браузер отказал в хранилище, и черновик негде
   * держать. Обещать «сохранено» в этот момент нельзя, а человек уже написал
   * текст — пусть заберёт его себе.
   */
  const saveToFile = () => {
    const draft = composer.draft;
    if (!draft) return;
    const blob = draftToFile({ ...draft, fields: { ...draft.fields, описание: text.trim() } });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `обращение-${new Date().toLocaleDateString('ru-RU')}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
  };

  const send = async () => {
    const why = whyNotSend(text);
    if (why) { setComplaint(why); return; }
    setSending(true);
    setComplaint('');
    try {
      // Заголовок и описание подаются прямо в отправку, а не через состояние:
      // человек нажал «Отправить», и уехать должно написанное им, а не то, что
      // успело дойти до следующей отрисовки
      const clean = text.trim();
      const refused = await composer.send({
        title: titleFrom(clean), description: clean, technicalEvents: true, appContext: true,
      });
      if (refused) setComplaint(refused);
    } finally { setSending(false); }
  };

  const busy = sending || (queued ? ['QUEUED', 'UPLOADING', 'COMMITTING'].includes(queued.state) : false);
  const sent = queued?.state === 'SENT';

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-slate-900/40 backdrop-blur-[1px] p-4"
      style={{ zIndex: Z.modal }} onMouseDown={() => { if (!busy) onClose(); }}>
      <div role="dialog" aria-label="Сообщить об ошибке" onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-dark-border
                   bg-white dark:bg-dark-surface shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-dark-border">
          <Bug className="w-4 h-4 text-rose-500" />
          <span className="text-sm font-bold text-slate-800 dark:text-slate-100">Сообщить об ошибке</span>
          <span className="flex-1" />
          <button type="button" onClick={onClose} aria-label="Закрыть" disabled={busy}
            className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer text-slate-400
                       hover:bg-slate-100 dark:hover:bg-slate-850 disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {sent ? (
            <div className="flex items-start gap-2">
              <Check className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" />
              <p className="text-xs text-slate-700 dark:text-slate-300">
                Отправлено. Обращение появилось в разделе «Замечания и предложения» — там будет
                видно, что с ним стало, и придёт ответ.
              </p>
            </div>
          ) : (
            <>
              <label className="block">
                <span className="block text-2xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
                  Что случилось
                </span>
                <textarea autoFocus value={text} rows={3} maxLength={LIMITS.description.max}
                  onChange={(e) => { setText(e.target.value); if (complaint) setComplaint(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(); }}
                  placeholder="Закрылась Таблица, когда я вставлял столбец"
                  className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg
                             px-3 py-2 text-sm text-slate-800 dark:text-slate-150 outline-none
                             focus:border-emerald-400 resize-none" />
              </label>

              <p className="text-2xs text-slate-500 dark:text-slate-400 leading-relaxed">
                Программа сама приложит свои технические записи за последнее время — по ним видно,
                что происходило перед сбоем. Ни текста документов, ни имён файлов, ни паролей в них
                нет, и наружу они не уходят: всё остаётся на сервере компании.
              </p>

              {complaint && <p className="text-xs text-rose-600 dark:text-rose-400">{complaint}</p>}
              {composer.metaError && (
                <p className="text-xs text-rose-600 dark:text-rose-400">
                  Сервер обращений не ответил: {composer.metaError}. Написанное сохранится и уйдёт,
                  когда связь вернётся.
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-200 dark:border-dark-border">
          <span className="min-w-0 flex-1 text-2xs text-slate-500 dark:text-slate-400 truncate">
            {queued ? queued.note : saveNote(composer.save)}
          </span>
          {/* Браузер отказал в хранилище — написанное нельзя терять молча:
              предлагаем забрать его файлом, раз уж сохранить негде */}
          {!sent && ['quota', 'unavailable', 'tooMany'].includes(composer.save) && (
            <button type="button" onClick={saveToFile}
              className="px-3 py-2 rounded-lg flex items-center gap-1.5 text-xs font-semibold cursor-pointer
                         bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800
                         text-slate-700 dark:text-slate-300">
              <FileDown className="w-3.5 h-3.5" /> Сохранить текст файлом
            </button>
          )}
          {sent ? (
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700">
              Готово
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose} disabled={busy}
                className="px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer text-slate-600 dark:text-slate-300
                           hover:bg-slate-100 dark:hover:bg-slate-850 disabled:opacity-50">
                Отмена
              </button>
              <button type="button" onClick={() => void send()} disabled={busy}
                className="px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer bg-emerald-600 text-white
                           hover:bg-emerald-700 disabled:opacity-50">
                {busy ? 'Отправляем…' : 'Отправить'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
