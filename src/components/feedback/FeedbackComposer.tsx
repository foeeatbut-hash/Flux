/**
 * Форма обращения: одно окно на идею, ошибку, «тормозит» и вопрос.
 *
 * Раньше вход был один — «Сообщить об ошибке» в Настройках, — и сообщение
 * уходило репликой в общий канал: без номера, без статуса и без ответа автору.
 * Здесь у обращения появляется номер и судьба, поэтому форма спрашивает то,
 * без чего его нельзя разобрать, и ровно столько, сколько человек согласится
 * заполнить: обязательны заголовок и описание, остальное — по виду обращения.
 *
 * Состояние формы, черновик и сборка пакета живут в `useComposer`; здесь только
 * разметка и переключение «правка ↔ предпросмотр».
 */
import React, { useEffect, useState } from 'react';
import { X, Paperclip, Trash2, Check, Send, Eye, Pencil } from 'lucide-react';
import { Z } from '../../lib/layers';
import { useEscapeClose } from '../../lib/useDismiss';
import { useComposer, saveNote, type Fields } from '../../feedback/useComposer';
import { submissionQueue, type QueueItem } from '../../feedback/submissionQueue';
import { LIMITS, TYPES, TYPE_NAMES, FREQUENCIES, FREQUENCY_NAMES, IMPACTS, IMPACT_NAMES, newRequestId }
  from '../../../feedback/contracts';
import type { ReportType } from '../../../feedback/contracts';
import FeedbackPreview from './FeedbackPreview';

interface Props {
  userId: string;
  appVersion: string;
  /** Раздел, из которого позвали: подставляется, но остаётся видимым. */
  sectionKey?: string;
  initialType?: ReportType;
  onClose: () => void;
  /** Отправка подтверждена сервером: номер карточки уже есть. */
  onSent?: (reportId: string) => void;
}

const field = `w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg
  px-3 py-2 text-sm text-slate-800 dark:text-slate-150 outline-none focus:border-emerald-400`;

function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span className="block mb-1">
      <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">{children}</span>
      {hint && <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">{hint}</span>}
    </span>
  );
}

function Choice<T extends string>({ list, names, value, onPick }: {
  list: readonly T[]; names: Record<T, string>; value: T; onPick: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((one) => (
        <button key={one} type="button" onClick={() => onPick(one)}
          className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold cursor-pointer border
            ${value === one
              ? 'bg-emerald-600 border-emerald-600 text-white'
              : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850'}`}>
          {names[one]}
        </button>
      ))}
    </div>
  );
}

function Consent({ on, onFlip, title, hint }: { on: boolean; onFlip: () => void; title: string; hint: string }) {
  return (
    <button type="button" onClick={onFlip}
      className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left cursor-pointer
                 hover:bg-slate-100 dark:hover:bg-slate-850">
      <span className={`mt-0.5 w-4 h-4 rounded shrink-0 flex items-center justify-center border
                        ${on ? 'bg-emerald-600 border-emerald-600' : 'border-slate-300 dark:border-slate-700'}`}>
        {on && <Check className="w-3 h-3 text-white" />}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-slate-800 dark:text-slate-100">{title}</span>
        <span className="block text-xs text-slate-500 dark:text-slate-400">{hint}</span>
      </span>
    </button>
  );
}

export default function FeedbackComposer({ userId, appVersion, sectionKey = '', initialType = 'BUG', onClose, onSent }: Props) {
  // Черновик заводится один на открытие окна: продолжение начатого — это тот же
  // черновик, а не новый рядом
  const [draftId] = useState(() => newRequestId());
  const composer = useComposer(draftId, userId, appVersion, sectionKey, initialType);
  const { fields, setFields, attachments } = composer;
  const [preview, setPreview] = useState(false);
  const [complaint, setComplaint] = useState('');
  const [queued, setQueued] = useState<QueueItem | null>(null);
  const [sending, setSending] = useState(false);

  useEscapeClose(true, () => { if (!sending) onClose(); });

  // За отправкой следим через очередь: она переживает закрытие окна, и «идёт
  // отправка» здесь — отражение её состояния, а не отдельный счётчик
  useEffect(() => submissionQueue.subscribe((items) => {
    const mine = items.find((i) => i.key.endsWith(`|${draftId}`));
    setQueued(mine || null);
    if (mine?.state === 'SENT' && mine.reportId) onSent?.(mine.reportId);
  }), [draftId, onSent]);

  const set = (patch: Partial<Fields>) => setFields((prev) => ({ ...prev, ...patch }));
  const bug = fields.type === 'BUG' || fields.type === 'PERFORMANCE';

  const pick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => {
      for (const file of Array.from(input.files || [])) {
        const refused = composer.addFile(file);
        if (refused) setComplaint(refused);
      }
    };
    input.click();
  };

  const send = async () => {
    setSending(true);
    try {
      const refused = await composer.send();
      if (refused) setComplaint(refused);
    } finally { setSending(false); }
  };

  const busy = sending || (queued ? ['QUEUED', 'UPLOADING', 'COMMITTING'].includes(queued.state) : false);
  const sent = queued?.state === 'SENT';

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-slate-900/40 backdrop-blur-[1px] p-4"
      style={{ zIndex: Z.modal }} onMouseDown={() => { if (!busy) onClose(); }}>
      <div role="dialog" aria-label="Обращение" onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl border border-slate-200 dark:border-dark-border
                   bg-white dark:bg-dark-surface shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-dark-border">
          <span className="text-sm font-bold text-slate-800 dark:text-slate-100">
            {preview ? 'Что уйдёт' : 'Обращение'}
          </span>
          <span className="flex-1" />
          <button type="button" onClick={() => setPreview((v) => !v)}
            className="px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 text-xs font-semibold cursor-pointer
                       text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850">
            {preview ? <Pencil className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {preview ? 'Править' : 'Посмотреть, что уйдёт'}
          </button>
          <button type="button" onClick={onClose} aria-label="Закрыть" disabled={busy}
            className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer text-slate-400
                       hover:bg-slate-100 dark:hover:bg-slate-850 disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-3">
          {composer.metaError && (
            <p className="text-xs text-rose-600 dark:text-rose-400">
              Сервер обращений не ответил: {composer.metaError}. Написанное сохранится на этом компьютере.
            </p>
          )}

          {preview ? (
            <FeedbackPreview fields={fields} attachments={attachments} appVersion={appVersion} />
          ) : (
            <>
              <div>
                <Label>С чем обращаетесь</Label>
                <Choice list={TYPES} names={TYPE_NAMES} value={fields.type} onPick={(type) => set({ type })} />
              </div>

              <label className="block">
                <Label hint={`${fields.title.trim().length}/${LIMITS.title.max}`}>Коротко, одной строкой</Label>
                <input value={fields.title} maxLength={LIMITS.title.max} autoFocus
                  onChange={(e) => set({ title: e.target.value })}
                  placeholder="Закрылась Таблица при вставке столбца" className={field} />
              </label>

              <label className="block">
                <Label>{bug ? 'Что произошло' : 'Что предлагаете'}</Label>
                <textarea value={fields.description} rows={4} maxLength={LIMITS.description.max}
                  onChange={(e) => set({ description: e.target.value })}
                  placeholder={bug ? 'Опишите своими словами — как рассказали бы коллеге' : 'Что стало бы удобнее и кому'}
                  className={`${field} resize-none`} />
              </label>

              {bug && (
                <>
                  <div>
                    <Label hint="по одному действию в строке">Что вы делали</Label>
                    <div className="space-y-1.5">
                      {fields.steps.map((step, index) => (
                        <input key={index} value={step} maxLength={LIMITS.step} className={field}
                          placeholder={index === 0 ? 'Открыл спецификацию проекта' : 'Дальше…'}
                          onChange={(e) => {
                            const steps = fields.steps.slice();
                            steps[index] = e.target.value;
                            // Пустая строка снизу появляется сама: просить нажать
                            // «добавить шаг» ради второго действия — лишнее
                            if (index === steps.length - 1 && e.target.value && steps.length < LIMITS.steps) steps.push('');
                            set({ steps });
                          }} />
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block">
                      <Label>Чего ждали</Label>
                      <input value={fields.expected} maxLength={LIMITS.expected} className={field}
                        onChange={(e) => set({ expected: e.target.value })} placeholder="Столбец добавится" />
                    </label>
                    <label className="block">
                      <Label>Что получилось</Label>
                      <input value={fields.actual} maxLength={LIMITS.actual} className={field}
                        onChange={(e) => set({ actual: e.target.value })} placeholder="Окно закрылось" />
                    </label>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <Label>Как часто</Label>
                      <Choice list={FREQUENCIES} names={FREQUENCY_NAMES} value={fields.frequency}
                        onPick={(frequency) => set({ frequency })} />
                    </div>
                    <div>
                      <Label>Насколько мешает</Label>
                      <Choice list={IMPACTS} names={IMPACT_NAMES} value={fields.impact}
                        onPick={(impact) => set({ impact })} />
                    </div>
                  </div>
                </>
              )}

              {fields.type === 'IDEA' && (
                <label className="block">
                  <Label>Что это даст</Label>
                  <textarea value={fields.benefit} rows={2} maxLength={LIMITS.benefit}
                    onChange={(e) => set({ benefit: e.target.value })} className={`${field} resize-none`}
                    placeholder="Сколько времени экономит и кому" />
                </label>
              )}

              <div>
                <Label hint={`не больше ${LIMITS.attachments}`}>Вложения</Label>
                <div className="space-y-1.5">
                  {attachments.map((item) => (
                    <div key={item.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg
                                                   border border-slate-200 dark:border-slate-800">
                      <Paperclip className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-700 dark:text-slate-300">{item.name}</span>
                      <button type="button" onClick={() => composer.dropFile(item.id)} aria-label="Убрать вложение"
                        className="w-6 h-6 rounded-lg flex items-center justify-center cursor-pointer
                                   text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <button type="button" onClick={pick}
                    className="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800
                               text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer">
                    Приложить файл…
                  </button>
                </div>
              </div>

              <div>
                <Label>Что приложить к обращению</Label>
                <Consent on={fields.appContext} onFlip={() => set({ appContext: !fields.appContext })}
                  title={`Версия программы (${appVersion}) и раздел`}
                  hint="По ним видно, где искать" />
                <Consent on={fields.technicalEvents} onFlip={() => set({ technicalEvents: !fields.technicalEvents })}
                  title="Технические записи этого окна"
                  hint="Время и результат операций — без текста документов, имён файлов и паролей" />
              </div>
            </>
          )}

          {complaint && <p className="text-xs text-rose-600 dark:text-rose-400">{complaint}</p>}
          {composer.error && <p className="text-xs text-rose-600 dark:text-rose-400">{composer.error}</p>}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-200 dark:border-dark-border">
          <span className="min-w-0 flex-1 text-xs text-slate-500 dark:text-slate-400 truncate">
            {queued ? queued.note : saveNote(composer.save)}
          </span>
          {sent ? (
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700">
              Готово
            </button>
          ) : (
            <>
              {queued && queued.state !== 'SENT' && (
                <button type="button" onClick={() => submissionQueue.cancel(queued.key)}
                  className="px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer text-slate-600 dark:text-slate-300
                             hover:bg-slate-100 dark:hover:bg-slate-850">
                  Отменить отправку
                </button>
              )}
              <button type="button" onClick={send} disabled={busy || !composer.ready}
                title={composer.ready ? '' : 'Заполните заголовок и описание'}
                className="px-4 py-2 rounded-lg flex items-center gap-1.5 text-xs font-semibold cursor-pointer
                           bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                <Send className="w-3.5 h-3.5" />
                {busy ? 'Отправляем…' : 'Отправить'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
