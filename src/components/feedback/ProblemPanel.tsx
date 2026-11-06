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
import { getSimilarModuleReports, markAffected, type SimilarModuleReport } from '../../feedback/feedbackApi';
import { useComposer } from '../../feedback/useComposer';
import { draftToFile, QUICK_DRAFT } from '../../feedback/draftDb';
import { submissionQueue, type QueueItem } from '../../feedback/submissionQueue';
import { useProblemPanel, closeProblemPanel } from '../../feedback/problemPanel';
import { useStore } from '../../store/store';
import { useModuleStore } from '../../store/moduleStoreState';
import { useWindowStore } from '../../store/windowStore';
import { topWindow } from '../../lib/windows';
import { reportSaveError, saveBlob } from '../../lib/saveToWindows';

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
  const windows = useWindowStore((s) => s.windows);
  const desk = useWindowStore((s) => s.desk);
  const local = useModuleStore((s) => s.local);
  const top = topWindow(windows.filter((w) => w.desk === desk));
  const activePath = top?.path || '';
  // Метаданные читаются только внутри верхнего окна: в другом окне может
  // продолжать работать другая версия той же подпрограммы.
  const frame = top && Array.from(document.querySelectorAll<HTMLElement>('[data-win]')).find((el) => el.dataset.win === top.id);
  const running = frame?.querySelector<HTMLElement>('[data-running-module]')?.dataset;
  const runningModule = running?.runningModule && running.runningVersion && (running.runningChannel === 'test' || running.runningChannel === 'production')
    ? { id: running.runningModule, name: running.runningName || running.runningModule, version: running.runningVersion,
      channel: running.runningChannel as 'test' | 'production', apiVersion: running.runningApi, developer: running.runningDeveloper } : undefined;
  const activeId = context.moduleId || /^\/module\/([^/?]+)/.exec(activePath)?.[1] || '';
  const modules = local?.runnable || [];
  const actual = context.moduleSource === 'running' ? context.module : (!context.moduleId ? runningModule : undefined);
  const storeModule = actual || (context.module && !modules.some((m) => m.manifest.id === context.module!.id) ? context.module : undefined);

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
      sectionKey={context.sectionKey || ''} modules={modules} activeId={activeId} storeModule={storeModule} moduleDiagnostics={context.moduleDiagnostics} />
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
      className="fx-pop !p-3 flex items-center gap-2">
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
function PanelBody({ userId, appVersion, anchor, sectionKey, modules, activeId, storeModule, moduleDiagnostics }: {
  userId: string;
  appVersion: string;
  anchor: { top: number; right: number } | null;
  sectionKey: string;
  modules: NonNullable<ReturnType<typeof useModuleStore.getState>['local']>['runnable'];
  activeId: string;
  storeModule?: import('../../feedback/problemPanel').ProblemContext['module'];
  moduleDiagnostics?: import('../../feedback/problemPanel').ProblemContext['moduleDiagnostics'];
}) {
  const composer = useComposer(QUICK_DRAFT, userId, appVersion, sectionKey, 'BUG');
  const { fields, setFields } = composer;
  const [recipient, setRecipient] = useState(() => (modules.some((m) => m.manifest.id === activeId) || storeModule?.id === activeId) ? activeId : '');
  const selected = storeModule?.id === recipient ? undefined : modules.find((m) => m.manifest.id === recipient);
  const fallback = storeModule?.id === recipient ? storeModule : undefined;
  useEffect(() => {
    if (activeId && (modules.some((m) => m.manifest.id === activeId) || storeModule?.id === activeId)) setRecipient(activeId);
  }, [activeId]);
  const [similar, setSimilar] = useState<SimilarModuleReport[]>([]);
  const [affected, setAffected] = useState('');
  const [similarError, setSimilarError] = useState('');
  useEffect(() => {
    let current = true;
    setSimilar([]); setAffected(''); setSimilarError('');
    if (recipient) getSimilarModuleReports(recipient).then((rows) => { if (current) setSimilar(rows); })
      .catch(() => { if (current) setSimilarError('Похожие обращения не загрузились'); });
    return () => { current = false; };
  }, [recipient]);
  const text = fields.description;
  const [queued, setQueued] = useState<QueueItem | null>(null);
  const [complaint, setComplaint] = useState('');
  // Пока форма не вернула управление, второе нажатие не нужно: кнопка занята
  const [submitting, setSubmitting] = useState(false);
  // Форма очищается в момент отправки, а на экране до подтверждения должно
  // оставаться то, что уехало, — показываем это отдельно
  const [sentText, setSentText] = useState('');
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
    if (!composer.sentKey) { setQueued(null); return undefined; }
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
      // Кнопка в верхней панели сама закрывает панель по клику: если закрыть её
      // здесь, клик по кнопке тут же открыл бы панель заново
      if ((e.target as Element | null)?.closest?.('[data-problem-toggle]')) return;
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
    setSubmitting(true);
    try {
      const refused = await composer.send({
        title: titleFrom(clean), description: clean, technicalEvents: true, appContext: true,
        moduleId: selected?.manifest.id || fallback?.id, moduleVersion: selected?.version || fallback?.version, moduleChannel: selected?.channel || fallback?.channel,
        moduleApiVersion: selected ? String(selected.manifest.contractVersion) : fallback?.apiVersion,
        moduleDeveloper: selected?.author || fallback?.developer, moduleDiagnostics: recipient === activeId ? moduleDiagnostics : undefined,
      });
      if (refused) setComplaint(refused); else setSentText(clean);
    } finally { setSubmitting(false); }
  };

  /** Следующее обращение, не закрывая панель. */
  const another = () => { composer.reopen(); setQueued(null); setSentText(''); setComplaint(''); };

  /**
   * Забрать написанное файлом.
   *
   * Нужно ровно в одном случае: браузер отказал в хранилище, и черновик негде
   * держать. Обещать «сохранено» в этот момент нельзя, а текст уже написан —
   * пусть человек заберёт его себе. Работает и без ответа сервера: именно
   * тогда она и нужна.
   */
  const saveToFile = async () => {
    const draft = composer.draft || {
      id: 'без-сервера', deploymentId: '', userId, draftId: QUICK_DRAFT,
      updatedAt: Date.now(), state: 'EDITING' as const, fields: {}, attachments: [],
    };
    const blob = draftToFile({ ...draft, fields: { ...draft.fields, description: text.trim() } });
    reportSaveError(await saveBlob(`обращение-${new Date().toISOString().slice(0, 10)}.json`, blob));
  };

  const progress = progressOf(queued, composer.save);
  const busy = submitting || (!!queued && !progress.done);
  const noStorage = composer.save === 'quota' || composer.save === 'unavailable';
  const number = queued?.reportNumber || '';

  /**
   * Куда встать.
   *
   * Прямоугольник кнопки берётся как подсказка, а не как приказ: верхняя
   * панель оболочки прячется, когда мышь от неё далеко, и у спрятанной кнопки
   * координаты бывают какие угодно. Панель, уехавшая на середину экрана или за
   * его край, — это панель, которую человек не найдёт. Поэтому подсказка
   * зажимается в разумные пределы, а без неё панель встаёт в правый верхний
   * угол, где кнопка и живёт.
   */
  const room = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const rightLimit = Math.max(GUTTER, room - WIDTH - GUTTER);
  const top = Math.max(GUTTER, Math.min(anchor ? anchor.top : 40, 200));
  const right = Math.max(GUTTER, Math.min(anchor ? anchor.right : GUTTER, rightLimit));

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
      className="fx-pop !p-0 overflow-hidden"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-dark-border">
        <Bug className="w-4 h-4 text-rose-500" />
        <span className="text-base font-semibold text-slate-800 dark:text-slate-100">Сообщить о проблеме</span>
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
            {(modules.length > 0 || storeModule) && <label className="block text-xs text-slate-600 dark:text-slate-300">
              Адресат
              <select aria-label="Адресат" value={recipient} disabled={busy} onChange={(e) => setRecipient(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm text-slate-800 dark:text-slate-100">
                <option value="">Flux</option>
                {storeModule && <option value={storeModule.id}>{storeModule.name} · {storeModule.version} · {storeModule.developer}</option>}
                {modules.filter((m) => m.manifest.id !== storeModule?.id).map((m) => <option key={m.manifest.id} value={m.manifest.id}>{m.manifest.name} · {m.version} · {m.author}</option>)}
              </select>
            </label>}
            <label className="block">
              <span className="sr-only">Что случилось</span>
              <textarea autoFocus value={busy && !text ? sentText : text} rows={4} maxLength={LIMITS.description.max}
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
            {similarError && <p className="text-xs text-rose-600 dark:text-rose-400">{similarError}</p>}
            {similar.length > 0 && <div className="space-y-2 text-xs text-slate-700 dark:text-slate-300">
              <p>Похожие известные проблемы</p>
              {similar.map((one) => <div key={one.id} className="border-t border-slate-200 dark:border-slate-800 pt-2">
                <p>ОШ-{one.number} · {one.title}</p>
                {one.workaround && <p className="mt-1">Обход: {one.workaround}</p>}
                <button type="button" disabled={busy || !!affected} className="fx-btn mt-1" onClick={async () => {
                  setSubmitting(true); setComplaint('');
                  try { await markAffected(one.id); setAffected(one.id); }
                  catch (error: any) { setComplaint(error?.message || 'Не удалось отметить проблему'); }
                  finally { setSubmitting(false); }
                }}>{affected === one.id ? 'Отмечено' : 'У меня тоже'}</button>
              </div>)}
            </div>}
            {(complaint || composer.error) && <p className="text-xs text-rose-600 dark:text-rose-400">{complaint || composer.error}</p>}
          </>
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border-t border-slate-200 dark:border-dark-border">
        <span className="min-w-0 flex-1 text-2xs text-slate-500 dark:text-slate-400 truncate">
          {progress.done ? '' : (submitting && !progress.text ? 'Отправляем…' : progress.text)}
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
            <button type="button" onClick={another} className="fx-btn">
              Ещё одно
            </button>
            <button type="button" onClick={closeProblemPanel}
              className="fx-btn fx-btn-primary">
              Готово
            </button>
          </>
        ) : (
          <>
            {noStorage && (
              <button type="button" onClick={saveToFile} title="Сохранить написанное файлом"
                className="fx-btn">
                <FileDown className="w-3.5 h-3.5" /> Сохранить текст
              </button>
            )}
            <button type="button" onClick={() => void send()} disabled={busy}
              className="fx-btn fx-btn-primary">
              Отправить
            </button>
          </>
        )}
      </div>
    </div>
  );
}
