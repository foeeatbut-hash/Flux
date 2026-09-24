import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { X, Send, Paperclip, Loader2, AlertTriangle, PenLine, Minus, Languages } from 'lucide-react';
import { mailService, type MailAccount, type MailSignature } from '../../services/mailService';
import { useEscapeClose } from '../../lib/useDismiss';
import { useToastStore } from '../../store/toastStore';
import { useTranslateStore } from '../../store/translateStore';
import { detectLang } from '../../translate/lang';
import { joinSegments } from '../../translate/engine';

/**
 * Окно письма: новое, ответ, ответить всем, пересылка.
 *
 * Кого поставить в «кому», какую тему подставить и как процитировать исходное
 * письмо, считает сервер: там лежат заголовки письма и адрес самого ящика.
 * Без этого «ответить всем» отправляет письмо и себе самому — классическая
 * ошибка, которую видно только на живой переписке.
 *
 * Подпись подставляется отдельным блоком под курсором ввода, а не вшивается в
 * текст: человек должен видеть, чем подписывается, и уметь это убрать.
 */

export type ComposeMode = 'NEW' | 'REPLY' | 'REPLY_ALL' | 'FORWARD';

interface Props {
  account: MailAccount;
  mode: ComposeMode;
  /** Письмо, на которое отвечаем или которое пересылаем */
  messageId?: string;
  onClose: () => void;
  onSent: () => void;
}

const field =
  'w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 ' +
  'text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500';

const TITLES: Record<ComposeMode, string> = {
  NEW: 'Новое письмо',
  REPLY: 'Ответ',
  REPLY_ALL: 'Ответ всем',
  FORWARD: 'Переслать',
};

export default function MailCompose({ account, mode, messageId, onClose, onSent }: Props) {
  const { addToast } = useToastStore();
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [quote, setQuote] = useState('');
  const [inReplyToId, setInReplyToId] = useState('');
  const [signature, setSignature] = useState<MailSignature | null>(null);
  const [useSig, setUseSig] = useState(true);
  const [showCopies, setShowCopies] = useState(false);

  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const [keepRu, setKeepRu] = useState(true);
  const many = useTranslateStore((s) => s.many);

  useEscapeClose(true, () => { if (!sending) onClose(); });

  /**
   * Русский текст → английский, прямо в поле письма.
   *
   * Заказчику уходят два варианта, и второй раньше писали вручную по памяти
   * прошлого письма — отсюда и расхождения в названиях. Здесь тот же словарь и
   * та же память, что у документов: узел, названный в ведомости `air handling
   * unit`, так же назовётся и в письме.
   */
  const toEnglish = () => {
    const el = bodyRef.current;
    if (!el) return;
    const ru = (el.innerText || '').trim();
    if (!ru) { addToast('Сначала напишите письмо', 'error'); return; }
    if (detectLang(ru) !== 'ru') { addToast('Письмо и так не по-русски', 'error'); return; }
    const en = joinSegments(many(ru, 'ru', 'en')).trim();
    if (!en) { addToast('Перевод не собрался — словарь пуст', 'error'); return; }
    el.innerText = keepRu ? `${en}\n\n— — —\n\n${ru}` : en;
    if (subject.trim() && detectLang(subject) === 'ru') {
      setSubject(joinSegments(many(subject, 'ru', 'en')).trim() || subject);
    }
    addToast('Английский вариант подставлен — прочитайте перед отправкой', 'info');
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await mailService.prepare({ accountId: account.id, mode, messageId });
        if (!alive) return;
        setTo(r.draft.to);
        setCc(r.draft.cc);
        setSubject(r.draft.subject);
        setQuote(r.draft.quote);
        setInReplyToId(r.draft.inReplyToId || '');
        setSignature(r.signature);
        if (r.draft.cc) setShowCopies(true);
      } catch (err: any) {
        if (alive) setError(err?.message || 'Не удалось подготовить письмо');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [account.id, mode, messageId]);

  // Курсор в поле письма, как только оно готово: человек садится писать,
  // а не искать, куда нажать
  useEffect(() => {
    if (loading) return;
    const t = setTimeout(() => bodyRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [loading]);

  const submit = async () => {
    if (!to.trim()) { setError('Укажите, кому отправить письмо'); return; }
    setSending(true);
    setError('');
    try {
      const written = bodyRef.current?.innerHTML || '';
      const sig = useSig && signature?.html ? `<br><br>${signature.html}` : '';
      const html = `${written}${sig}${quote ? `<blockquote style="margin:1em 0;padding-left:1em;border-left:3px solid #ccc">${quote}</blockquote>` : ''}`;
      const r = await mailService.send({
        accountId: account.id,
        to, cc, bcc, subject,
        html,
        inReplyToId,
      });
      addToast(r.warning || 'Письмо отправлено', r.warning ? 'info' : 'success');
      onSent();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Не удалось отправить письмо');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto" role="dialog" aria-modal="true" aria-label={TITLES[mode]}>
      <div className="fixed inset-0 fx-backdrop" onClick={() => !sending && onClose()} />
      <div className="flex min-h-full items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          className="fx-dialog @container relative w-full max-w-3xl max-h-[90vh] flex flex-col"
        >
          <div className="shrink-0 flex items-center justify-between gap-2 px-5 py-3 border-b border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-2 min-w-0">
              <PenLine className="w-4 h-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
              <h3 className="flex-1 min-w-0 truncate text-base font-semibold text-slate-900 dark:text-white">{TITLES[mode]}</h3>
            </div>
            <button
              type="button" title="Закрыть" aria-label="Закрыть" onClick={onClose} disabled={sending}
              className="p-1 shrink-0 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {loading ? (
            <div className="flex-1 flex items-center justify-center gap-2 p-10 text-slate-500 dark:text-slate-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Готовим письмо…
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 py-4 flex flex-col gap-2.5">
              {/* От кого — не поле ввода: адрес задаётся ящиком */}
              <div className="flex items-baseline gap-2 pb-2 border-b border-slate-100 dark:border-slate-800">
                <span className="shrink-0 w-16 text-xs font-semibold text-slate-500 dark:text-slate-400">От кого</span>
                <span className="flex-1 min-w-0 truncate text-sm text-slate-700 dark:text-slate-300">
                  {account.displayName ? `${account.displayName} <${account.email}>` : account.email}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <label className="shrink-0 w-16 text-xs font-semibold text-slate-500 dark:text-slate-400" htmlFor="mail-to">Кому</label>
                <input
                  id="mail-to" value={to} onChange={(e) => setTo(e.target.value)} disabled={sending}
                  placeholder="адрес@почта.ру, второй@почта.ру" className={`${field} flex-1 min-w-0`}
                />
                <button
                  type="button" onClick={() => setShowCopies((v) => !v)}
                  className="shrink-0 text-xs font-semibold text-slate-500 hover:text-emerald-700 dark:text-slate-400 dark:hover:text-emerald-400 cursor-pointer"
                >
                  {showCopies ? 'Скрыть копии' : 'Копия'}
                </button>
              </div>

              {showCopies && (
                <>
                  <div className="flex items-center gap-2">
                    <label className="shrink-0 w-16 text-xs font-semibold text-slate-500 dark:text-slate-400" htmlFor="mail-cc">Копия</label>
                    <input id="mail-cc" value={cc} onChange={(e) => setCc(e.target.value)} disabled={sending} className={`${field} flex-1 min-w-0`} />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="shrink-0 w-16 text-xs font-semibold text-slate-500 dark:text-slate-400" htmlFor="mail-bcc">Скрытая</label>
                    <input id="mail-bcc" value={bcc} onChange={(e) => setBcc(e.target.value)} disabled={sending} className={`${field} flex-1 min-w-0`} />
                  </div>
                </>
              )}

              <div className="flex items-center gap-2">
                <label className="shrink-0 w-16 text-xs font-semibold text-slate-500 dark:text-slate-400" htmlFor="mail-subj">Тема</label>
                <input id="mail-subj" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={sending} className={`${field} flex-1 min-w-0`} />
              </div>

              {/* Ответить заказчику по-английски. Кнопка не отправляет письмо
                  и не подменяет его молча: перевод встаёт в поле, и его видно
                  до отправки — иначе заказчик первым узнает, что там вышло */}
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={toEnglish} disabled={sending}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs font-semibold
                             text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40
                             cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
                  <Languages className="w-3.5 h-3.5" />
                  Английский вариант
                </button>
                <label className="flex items-center gap-1.5 text-2xs text-slate-500 dark:text-slate-400 cursor-pointer">
                  <input type="checkbox" checked={keepRu} onChange={(e) => setKeepRu(e.target.checked)}
                    className="accent-emerald-600 cursor-pointer" />
                  оставить русский ниже
                </label>
              </div>

              {/* Тело письма */}
              <div
                ref={bodyRef}
                contentEditable={!sending}
                suppressContentEditableWarning
                role="textbox"
                aria-multiline="true"
                aria-label="Текст письма"
                className="min-h-[11rem] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />

              {/* Подпись видно до отправки, а не после — и её можно снять */}
              {signature?.html && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 overflow-hidden">
                  <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-slate-200 dark:border-slate-800">
                    <span className="flex-1 min-w-0 truncate text-2xs font-semibold text-slate-500 dark:text-slate-400">
                      Подпись: {signature.name}
                    </span>
                    <button
                      type="button" onClick={() => setUseSig((v) => !v)}
                      className="shrink-0 flex items-center gap-1 text-2xs font-semibold text-slate-500 hover:text-emerald-700 dark:text-slate-400 dark:hover:text-emerald-400 cursor-pointer"
                    >
                      <Minus className="w-3 h-3" />
                      {useSig ? 'Не подписывать' : 'Подписать'}
                    </button>
                  </div>
                  {useSig && (
                    <div
                      className="px-3 py-2 text-sm text-slate-700 dark:text-slate-300 [&_img]:max-w-full"
                      dangerouslySetInnerHTML={{ __html: signature.html }}
                    />
                  )}
                </div>
              )}

              {quote && (
                <details className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40">
                  <summary className="px-3 py-1.5 text-2xs font-semibold text-slate-500 dark:text-slate-400 cursor-pointer">
                    Цитата исходного письма
                  </summary>
                  <div className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400" dangerouslySetInnerHTML={{ __html: quote }} />
                </details>
              )}

              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                  <span className="flex-1 min-w-0">{error}</span>
                </div>
              )}
            </div>
          )}

          <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-800">
            <span className="flex items-center gap-1.5 text-2xs text-slate-400 dark:text-slate-500">
              <Paperclip className="w-3.5 h-3.5" />
              Вложения — в следующей версии
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button" onClick={onClose} disabled={sending}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-slate-650 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-850 cursor-pointer"
              >
                Отмена
              </button>
              <button
                type="button" onClick={submit} disabled={sending || loading}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-semibold shadow-md cursor-pointer disabled:opacity-60"
              >
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                {sending ? 'Отправляем…' : 'Отправить'}
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
