/**
 * «Замечания и предложения» — раздел целиком.
 *
 * До него сотрудник, у которого что-то сломалось, мог сделать ровно одно:
 * написать в общий канал «Ошибки». Сообщение жило там обычной репликой — без
 * номера, состояния, исполнителя и ответа автору, и никто не знал, что с ним
 * стало. Здесь у обращения появляется судьба, и главное в разделе — не список,
 * а то, что автор видит, что с его обращением происходит.
 *
 * Слева свои обращения (и очередь — у тех, кто разбирает), справа карточка.
 * Опрос раз в пятнадцать секунд — страховка на случай потерянного толчка
 * сокета: у каждого сотрудника свой встроенный сервер, и толчок с чужого до
 * него не долетит.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Copy, FileDown, Inbox, ListChecks, Plus, RefreshCw } from 'lucide-react';
import { useStore } from '../store/store';
import { useFeedbackStore } from '../store/feedbackStore';
import { dataService } from '../services/dataService';
import {
  addComment, exportReport, getActions, getComments, getDuplicates, getEvents, getMeta,
  getReport, listReports, markRead, openAttachment, setPriority, transition, type Meta,
} from '../feedback/feedbackApi';
import FeedbackList, { type Row } from '../components/feedback/FeedbackList';
import FeedbackCard, { type Action, type Card } from '../components/feedback/FeedbackCard';
import FeedbackDiscussion, { type Comment, type Event } from '../components/feedback/FeedbackDiscussion';
import FeedbackComposer from '../components/feedback/FeedbackComposer';
import FeedbackSummary from '../components/feedback/FeedbackSummary';
import { reportNumber, type Status } from '../../feedback/contracts';

/** Как часто перечитывать открытый список при видимом окне. */
const POLL_MS = 15000;

export default function FeedbackScreen() {
  const me = useStore((s) => s.user);
  const revision = useFeedbackStore((s) => s.revision);
  const touched = useFeedbackStore((s) => s.touched);

  const [meta, setMeta] = useState<Meta | null>(null);
  const [scope, setScope] = useState<'mine' | 'queue' | 'summary'>('mine');
  const [rows, setRows] = useState<Row[]>([]);
  const [activeId, setActiveId] = useState('');
  const [card, setCard] = useState<Card | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [composing, setComposing] = useState(false);
  const [twins, setTwins] = useState<any[]>([]);
  const [exported, setExported] = useState('');

  const triage = !!meta?.rights?.triage;

  useEffect(() => {
    getMeta().then(setMeta).catch((e: any) => setFailure(e?.message || 'Сервер обращений не отвечает'));
    // Имена нужны, чтобы в обсуждении стояли люди, а не идентификаторы
    dataService.getUsers().then((list) => {
      const map: Record<string, string> = {};
      for (const one of list) map[one.id] = one.name || one.login || 'Сотрудник';
      setNames(map);
    }).catch(() => { /* без имён обсуждение читается хуже, но работает */ });
  }, []);

  const loadList = useCallback(async () => {
    if (scope === 'summary') return;
    try {
      const data = await listReports(scope === 'queue' ? 'scope=queue' : 'scope=mine');
      setRows((data || []) as Row[]);
      setFailure('');
    } catch (error: any) {
      setFailure(error?.message || 'Список не загрузился');
    }
  }, [scope]);

  const loadCard = useCallback(async (id: string) => {
    if (!id) { setCard(null); setActions([]); setComments([]); setEvents([]); return; }
    try {
      const [one, list, log, can] = await Promise.all([
        getReport(id), getComments(id), getEvents(id), getActions(id),
      ]);
      setCard(one as Card);
      setComments((list || []) as Comment[]);
      setEvents((log || []) as Event[]);
      setActions((can || []) as Action[]);
      setExported('');
      // Похожие ищем только тем, кто разбирает: автору чужие обращения не
      // показываются даже заголовком
      setTwins([]);
      if (triage) getDuplicates(id).then(setTwins).catch(() => setTwins([]));
    } catch (error: any) {
      setFailure(error?.message || 'Карточка не открылась');
    }
  }, [triage]);

  useEffect(() => { void loadList(); }, [loadList, revision]);
  useEffect(() => { void loadCard(activeId); }, [loadCard, activeId, revision]);

  // Страховка опросом: сокет ускоряет, но не отвечает за доставку
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadList();
      if (activeId) void loadCard(activeId);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [loadList, loadCard, activeId]);

  /** Открыли карточку — она перестаёт считаться непрочитанной. */
  const open = async (id: string) => {
    setActiveId(id);
    try {
      await markRead(id, { seenRevision: 0 });
      touched();
    } catch (_) { /* отметка не удалась — счётчик поправится опросом */ }
  };

  const act = async (to: Status, reason: string, clientRequestId: string) => {
    if (!card) return;
    setBusy(true);
    try {
      await transition(card.id, { to, reason, clientRequestId, expectedRevision: card.revision });
      await loadCard(card.id);
      touched();
    } catch (error: any) {
      // Разошлись ревизии — значит рядом работал другой обработчик. Ничего не
      // затираем: перечитываем карточку и показываем, что стало
      setFailure(error?.message || 'Изменить не удалось');
      await loadCard(card.id);
    } finally { setBusy(false); }
  };

  const priority = async (value: string, clientRequestId: string) => {
    if (!card) return;
    setBusy(true);
    try {
      await setPriority(card.id, { priority: value, clientRequestId, expectedRevision: card.revision });
      await loadCard(card.id);
    } catch (error: any) {
      setFailure(error?.message || 'Важность не изменилась');
      await loadCard(card.id);
    } finally { setBusy(false); }
  };

  const say = async (text: string, visibility: 'PUBLIC' | 'INTERNAL', clientRequestId: string) => {
    if (!card) return;
    setBusy(true);
    try {
      await addComment(card.id, { text, visibility, clientRequestId, expectedRevision: card.revision });
      await loadCard(card.id);
      touched();
    } catch (error: any) {
      setFailure(error?.message || 'Сообщение не отправилось');
      await loadCard(card.id);
    } finally { setBusy(false); }
  };

  // Обработчики формы — постоянные: форма подписывается на очередь отправки, и
  // новая стрелка на каждую отрисовку пересоздавала бы подписку без конца
  const closeComposer = useCallback(() => { setComposing(false); void loadList(); }, [loadList]);
  const afterSent = useCallback((id: string) => { setActiveId(id); touched(); }, [touched]);

  /** Выгрузка одной карточки: показываем текст, а не скачиваем молча. */
  const takeExport = useCallback(async () => {
    if (!card) return;
    try {
      const got = await exportReport(card.id);
      setExported(got?.markdown || '');
    } catch (error: any) {
      setFailure(error?.message || 'Выгрузка не собралась');
    }
  }, [card]);

  const tabs = useMemo(() => ([
    { id: 'mine' as const, name: 'Мои обращения', icon: Inbox },
    ...(triage ? [
      { id: 'queue' as const, name: 'Очередь разбора', icon: ListChecks },
      { id: 'summary' as const, name: 'Сводка', icon: BarChart3 },
    ] : []),
  ]), [triage]);

  return (
    <div className="h-full flex min-h-0">
      <div className="w-72 shrink-0 border-r border-slate-200 dark:border-dark-border flex flex-col min-h-0">
        <div className="p-2 space-y-2 border-b border-slate-200 dark:border-dark-border">
          <button type="button" onClick={() => setComposing(true)}
            className="w-full px-3 py-2 rounded-lg flex items-center justify-center gap-1.5 text-xs font-semibold
                       cursor-pointer bg-emerald-600 text-white hover:bg-emerald-700">
            <Plus className="w-3.5 h-3.5" /> Новое обращение
          </button>
          <div className="flex gap-1">
            {tabs.map((tab) => (
              <button key={tab.id} type="button" onClick={() => { setScope(tab.id); setActiveId(''); }}
                className={`flex-1 px-2 py-1.5 rounded-lg flex items-center justify-center gap-1.5 text-xs font-semibold cursor-pointer
                  ${scope === tab.id
                    ? 'bg-slate-100 dark:bg-slate-850 text-slate-800 dark:text-slate-100'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900'}`}>
                <tab.icon className="w-3.5 h-3.5" /> {tab.name}
              </button>
            ))}
            <button type="button" onClick={() => void loadList()} title="Перечитать"
              className="w-8 rounded-lg flex items-center justify-center cursor-pointer text-slate-500
                         hover:bg-slate-100 dark:hover:bg-slate-850">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0">
          {scope === 'summary'
            ? (
              <p className="p-3 text-xs text-slate-500 dark:text-slate-400">
                Сводка справа. Она про поток обращений целиком, а не про одну карточку.
              </p>
            )
            : <FeedbackList rows={rows} activeId={activeId} onPick={(id) => void open(id)} />}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto scrollbar-thin p-4 space-y-3">
        {failure && <p className="text-xs text-rose-600 dark:text-rose-400">{failure}</p>}
        {scope === 'summary' && <FeedbackSummary />}
        {scope !== 'summary' && !card && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Выберите обращение слева или заведите новое.
          </p>
        )}
        {scope !== 'summary' && card && (
          <>
            <FeedbackCard card={card} actions={actions} names={names} triage={triage} busy={busy}
              onAct={(to, reason, key) => void act(to, reason, key)}
              onPriority={(value, key) => void priority(value, key)}
              onOpenFile={(id, name, inline) => {
                openAttachment(id, name, inline).catch((error: any) =>
                  setFailure(error?.message || 'Вложение не открылось'));
              }} />
            {triage && twins.length > 0 && (
              <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-1.5">
                <div className="text-xs font-bold text-amber-800 dark:text-amber-300">Похоже на уже заведённое</div>
                {twins.map((one) => (
                  <button key={one.id} type="button" onClick={() => void open(one.id)}
                    className="w-full text-left text-xs text-slate-700 dark:text-slate-300 hover:underline cursor-pointer">
                    {reportNumber(one.number)} — {one.title}
                    <span className="text-2xs text-slate-500 dark:text-slate-400"> · {one.why}</span>
                  </button>
                ))}
                <p className="text-2xs text-slate-500 dark:text-slate-400">
                  Это предложение, а не решение: карточки сами не объединяются.
                </p>
              </div>
            )}

            <FeedbackDiscussion comments={comments} events={events} names={names}
              canInternal={triage} busy={busy}
              onSend={(text, visibility, key) => void say(text, visibility, key)} />

            <div className="space-y-2">
              <button type="button" onClick={() => void takeExport()}
                className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 bg-slate-100 dark:bg-slate-900
                           hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold
                           text-slate-700 dark:text-slate-300 cursor-pointer">
                <FileDown className="w-3.5 h-3.5" /> Экспорт для разработчика
              </button>
              {exported && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-2.5 space-y-2">
                  {/* Показываем ровно то, что скопируется: обещать «выгружено»
                      и отдать другое — худший вид сюрприза */}
                  <pre className="max-h-64 overflow-auto scrollbar-thin text-2xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words">
                    {exported}
                  </pre>
                  <button type="button" onClick={() => void navigator.clipboard?.writeText(exported)}
                    className="px-3 py-1.5 rounded-lg flex items-center gap-1.5 bg-emerald-600 text-white
                               hover:bg-emerald-700 text-xs font-semibold cursor-pointer">
                    <Copy className="w-3.5 h-3.5" /> Скопировать
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {composing && (
        <FeedbackComposer userId={me?.id || ''} appVersion={__APP_VERSION__}
          onClose={closeComposer} onSent={afterSent} />
      )}
    </div>
  );
}
