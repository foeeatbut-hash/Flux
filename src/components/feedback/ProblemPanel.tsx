/**
 * Сообщить о проблеме — одно поле и одна кнопка.
 *
 * Выдвигается из кнопки в верхней панели. Всё, что человек здесь видит:
 * заголовок, крестик, «Что случилось?» и «Отправить». Ни галочек про журналы,
 * ни предпросмотра пакета, ни объясняющего абзаца — они и съедали ту минуту,
 * из-за которой форму закрывали, так и не сообщив ни о чём.
 *
 * Технические записи прикладываются сами. Это осознанный размен, и он честен
 * ровно потому, что в записях нечему утечь: виды событий, длительности и
 * исходы — без текста документов, имён файлов и паролей. Снимок экрана — дело
 * другое, на нём бывает чужая переписка, и он остаётся в подробной форме
 * раздела «Замечания и предложения», по явному действию.
 *
 * Панель НЕ модальная: она не затемняет программу и не мешает смотреть на то,
 * о чём человек пишет. Ровно за этим её и сделали панелью, а не диалогом.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Bug, Check, FileDown, X } from 'lucide-react';
import { Z } from '../../lib/layers';
import { useEscapeClose } from '../../lib/useDismiss';
import { LIMITS, titleFrom } from '../../../feedback/contracts';
import { useComposer } from '../../feedback/useComposer';
import { draftToFile, QUICK_DRAFT } from '../../feedback/draftDb';
import { submissionQueue, type QueueItem } from '../../feedback/submissionQueue';
import { useProblemPanel, closeProblemPanel } from '../../feedback/problemPanel';
import { useStore } from '../../store/store';

/** Что мешает отправить. Пустая строка — ничего. */
export function whyNotSend(text: string): string {
  return String(text || '').trim() ? '' : 'Напишите, что случилось';
}

/** Ширина панели: ориентир из задания, на узком экране — окно минус отступы. */
const WIDTH = 360;
const MAX_WIDTH = 400;
const GUTTER = 12;

/**
 * Что показать про ход отправки.
 *
 * Разные исходы — разные разговоры, и складывать их в одну надпись нельзя:
 * «сохранено, отправим» и «черновик сохранён» отличаются тем, дойдёт ли
 * написанное само. Обещать очередь до того, как она создана, — обман.
 */
function progressOf(item: QueueItem | null, save: string): { text: string; done: boolean } {
  if (!item) return { text: '', done: false };
  switch (item.state) {
    case 'SENT':
      return { text: 'Отправлено', done: true };
    case 'QUEUED':
    case 'UPLOADING':
    case 'COMMITTING':
      // Очередь уже есть — обещание про «отправим при подключении» правдиво
      return {
        text: navigator.onLine === false
          ? 'Сохранено. Отправим при подключении'
          : (item.note || 'Отправляем…'),
        done: false,
      };
    case 'NEEDS_SIGN_IN':
      return { text: 'Войдите, чтобы отправить', done: false };
    case 'FAILED_RETRYABLE':
      return { text: 'Сохранено. Отправим при подключении', done: false };
    case 'NEEDS_REVIEW':
      return { text: item.note || 'Отправить не вышло', done: false };
    default:
      return { text: save === 'saved' ? 'Черновик сохранён' : '', done: false };
  }
}

export default function ProblemPanel() {
  const open = useProblemPanel((s) => s.open);
  const anchor = useProblemPanel((s) => s.anchor);
  const context = useProblemPanel((s) => s.context);
  // Личность берётся из состояния программы, а не из свойств: панель висит в
  // корне и не должна требовать, чтобы её кто-то снабжал данными
  const me = useStore((s) => s.user);

  if (!open) return null;
  // До входа отправлять некому и не от кого: черновик уехал бы в контур без
  // человека, а потом отправился бы от следующего вошедшего
  if (!me?.id) {
    return (
      <SignInFirst anchor={anchor} />
    );
  }
  return (
    <PanelBody userId={me.id} appVersion={__APP_VERSION__} anchor={anchor}
      sectionKey={context.sectionKey || ''} />
  );
}

/** Единственное, что можно сказать не вошедшему. */
function SignInFirst({ anchor }: { anchor: { top: number; right: number } | null }) {
  useEscapeClose(true, closeProblemPanel);
  return (
    <div role="dialog" aria-label="Сообщить о проблеме"
      style={{
        position: 'fixed', top: anchor ? anchor.top : 40, right: anchor ? anchor.right : GUTTER,
        zIndex: Z.tray, width: `min(${MAX_WIDTH}px, calc(100vw - ${GUTTER * 2}px))`,
      }}
      className="rounded-xl border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface
                 shadow-xl p-3 flex items-center gap-2">
      <Bug className="w-4 h-4 text-rose-500 shrink-0" />
      <span className="flex-1 text-sm text-slate-700 dark:text-slate-300">Войдите, чтобы отправить</span>
      <button type="button" onClick={closeProblemPanel} aria-label="Закрыть"
        className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer text-slate-400
                   hover:bg-slate-100 dark:hover:bg-slate-850">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/**
 * Содержимое отдельным компонентом.
 *
 * Иначе `useComposer` жил бы всё время работы программы и держал бы черновик
 * открытым; а так форма поднимается при открытии панели и уходит при
 * закрытии — вместе со своими подписками и таймерами.
 */
function PanelBody({ userId, appVersion, anchor, sectionKey }: {
  userId: string;
  appVersion: string;
  anchor: { top: number; right: number } | null;
  sectionKey: string;
}) {
  const composer = useComposer(QUICK_DRAFT, userId, appVersion, sectionKey, 'BUG');
  const { fields, setFields } = composer;
  const text = fields.description;
  const [queued, setQueued] = useState<QueueItem | null>(null);
  const [complaint, setComplaint] = useState('');
  const [shown, setShown] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Записи прикладываются сами — здесь это не выбор человека, а устройство
  useEffect(() => {
    setFields((prev) => ({ ...prev, technicalEvents: true, appContext: true }));
  }, [setFields]);

  // Выдвижение: один кадр на переход из свёрнутого в развёрнутое. Системную
  // настройку «меньше движения» уважает общее правило в index.css
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (!composer.sentKey) return undefined;
    return submissionQueue.subscribe((items) => {
      setQueued(items.find((i) => i.key === composer.sentKey) || null);
    });
  }, [composer.sentKey]);

  /** Свернуть, сохранив написанное. Закрытие отправку не отменяет. */
  const dismiss = () => { void composer.flush(); closeProblemPanel(); };

  useEscapeClose(true, dismiss);

  // Клик мимо панели сворачивает её — как и любую панель оболочки
  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) dismiss();
    };
    // На следующем кадре: иначе тот же клик, что открыл панель, её и закроет
    const id = setTimeout(() => document.addEventListener('mousedown', outside), 0);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', outside); };
  });

  const send = async () => {
    const why = whyNotSend(text);
    if (why) { setComplaint(why); return; }
    setComplaint('');
    const clean = text.trim();
    // Заголовок и сообщение подаются прямо в отправку: человек нажал
    // «Отправить», и уехать должно написанное им, а не то, что успело дойти до
    // следующей отрисовки
    const refused = await composer.send({
      title: titleFrom(clean), description: clean, technicalEvents: true, appContext: true,
    });
    if (refused) setComplaint(refused);
  };

  /**
   * Забрать написанное файлом.
   *
   * Нужно ровно в одном случае: браузер отказал в хранилище, и черновик негде
   * держать. Обещать «сохранено» в этот момент нельзя, а текст уже написан —
   * пусть человек заберёт его себе. Работает и без ответа сервера: именно
   * тогда она и нужна.
   */
  const saveToFile = () => {
    const draft = composer.draft || {
      id: 'без-сервера', deploymentId: '', userId, draftId: QUICK_DRAFT,
      updatedAt: Date.now(), state: 'EDITING' as const, fields: {}, attachments: [],
    };
    const blob = draftToFile({ ...draft, fields: { ...draft.fields, description: text.trim() } });
    const url = URL.createObjectURL(blob);
    const anchorEl = document.createElement('a');
    anchorEl.href = url;
    anchorEl.download = `обращение-${new Date().toISOString().slice(0, 10)}.json`;
    anchorEl.click();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
  };

  const progress = progressOf(queued, composer.save);
  const busy = !!queued && !progress.done && queued.state !== 'NEEDS_REVIEW';
  const noStorage = composer.save === 'quota' || composer.save === 'unavailable';
  const number = queued?.reportNumber || '';

  const top = anchor ? anchor.top : 40;
  const right = anchor ? anchor.right : GUTTER;

  return (
    <div
      ref={box}
      role="dialog"
      aria-label="Сообщить о проблеме"
      style={{
        position: 'fixed', top, right, zIndex: Z.tray,
        width: `min(${MAX_WIDTH}px, max(${WIDTH}px, calc(100vw - ${GUTTER * 2}px)))`,
        maxWidth: `calc(100vw - ${GUTTER * 2}px)`,
        opacity: shown ? 1 : 0,
        transform: shown ? 'translateY(0)' : 'translateY(-6px)',
        transition: 'opacity 150ms ease-out, transform 150ms ease-out',
      }}
      className="rounded-xl border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface
                 shadow-xl overflow-hidden"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-dark-border">
        <Bug className="w-4 h-4 text-rose-500" />
        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">Сообщить о проблеме</span>
        <span className="flex-1" />
        <button type="button" onClick={dismiss} aria-label="Закрыть"
          className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer text-slate-400
                     hover:bg-slate-100 dark:hover:bg-slate-850">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-3 space-y-2">
        {progress.done ? (
          <div className="flex items-start gap-2">
            <Check className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600" />
            <p className="text-sm text-slate-700 dark:text-slate-300">
              Отправлено{number ? ` · ${number}` : ''}
            </p>
          </div>
        ) : (
          <>
            <label className="block">
              <span className="sr-only">Что случилось</span>
              <textarea autoFocus value={text} rows={4} maxLength={LIMITS.description.max}
                disabled={busy}
                onChange={(e) => {
                  setFields((prev) => ({ ...prev, description: e.target.value }));
                  if (complaint) setComplaint('');
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(); }}
                placeholder="Что случилось?"
                className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg
                           px-3 py-2 text-sm text-slate-800 dark:text-slate-150 outline-none
                           focus:border-emerald-400 resize-none disabled:opacity-60" />
            </label>
            {complaint && <p className="text-xs text-rose-600 dark:text-rose-400">{complaint}</p>}
          </>
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border-t border-slate-200 dark:border-dark-border">
        <span className="min-w-0 flex-1 text-2xs text-slate-500 dark:text-slate-400 truncate">
          {progress.done ? '' : progress.text}
          {/* Отказ хранилища — единственное состояние, где предлагаем файл:
              это аварийное спасение текста, а не второй способ отправки */}
          {!progress.done && noStorage && ' · Не удалось сохранить текст'}
        </span>
        {progress.done ? (
          <>
            <a href="#/feedback" onClick={closeProblemPanel}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer bg-slate-100
                         dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800
                         text-slate-700 dark:text-slate-300">
              Открыть
            </a>
            <button type="button" onClick={closeProblemPanel}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer bg-emerald-600
                         text-white hover:bg-emerald-700">
              Готово
            </button>
          </>
        ) : (
          <>
            {noStorage && (
              <button type="button" onClick={saveToFile} title="Сохранить написанное файлом"
                className="px-2.5 py-1.5 rounded-lg flex items-center gap-1 text-xs font-semibold cursor-pointer
                           bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800
                           text-slate-700 dark:text-slate-300">
                <FileDown className="w-3.5 h-3.5" /> Сохранить текст
              </button>
            )}
            <button type="button" onClick={() => void send()} disabled={busy}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer bg-emerald-600 text-white
                         hover:bg-emerald-700 disabled:opacity-50">
              Отправить
            </button>
          </>
        )}
      </div>
    </div>
  );
}
