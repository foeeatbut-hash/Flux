import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Mail as MailIcon, Search, X, Settings2, Plus, AlertTriangle, RefreshCw,
  Archive, Trash2, MailOpen, Star, CheckSquare, Square, KeyRound,
} from 'lucide-react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useMailStore } from '../store/mailStore';
import { useStore } from '../store/store';
import { useRealTimeSync } from '../components/SocketProvider';
import MailSidebar from '../components/mail/MailSidebar';
import MailCompose, { type ComposeMode } from '../components/mail/MailCompose';
import MailSignatures from '../components/mail/MailSignatures';
import MailList from '../components/mail/MailList';
import MailThread from '../components/mail/MailThread';
import MailAccountForm from '../components/mail/MailAccountForm';
import type { MailAccount } from '../services/mailService';

/**
 * Раздел «Почта».
 *
 * Устройство повторяет Gmail: рельс папок, список переписок, чтение. Оформление
 * своё — цвета, шрифты и радиусы из системы Flux, чтобы раздел не выглядел
 * вставным куском рядом с остальными.
 *
 * Раздел живёт в панели рабочего стола, а не в окне, поэтому ширина меряется
 * запросами к контейнеру (@[...]), а не окном. В тесноте колонки уходят по
 * очереди: сначала подписи папок, потом кружки отправителей, потом чтение
 * ложится поверх списка.
 */

/** Горячие клавиши — те же буквы, что в Gmail: переучиваться не придётся. */
const HOTKEYS: Array<{ keys: string; what: string }> = [
  { keys: 'j / k', what: 'следующая и предыдущая переписка' },
  { keys: 'Enter', what: 'открыть' },
  { keys: 'u', what: 'назад к списку' },
  { keys: 'e', what: 'в архив' },
  { keys: '#', what: 'удалить' },
  { keys: 's', what: 'важное' },
  { keys: 'x', what: 'отметить' },
  { keys: '/', what: 'поиск' },
  { keys: 'g затем i', what: 'входящие' },
];

export default function Mail() {
  const user = useStore((s) => s.user);
  const {
    accounts, accountId, folders, folderId, threads, openKey, picked,
    query, filter, loading, syncing, error, keyIn,
    loadAccounts, chooseAccount, loadFolders, chooseFolder, loadThreads, sync,
    setQuery, setFilter, open, togglePick, pickAll, clearPicked,
    markSeen, markFlagged, moveTo, shared, claim, unreadByAccount, mayShared,
  } = useMailStore();

  const [form, setForm] = useState<{ open: boolean; account: MailAccount | null }>({ open: false, account: null });
  const [compose, setCompose] = useState<{ mode: ComposeMode; messageId?: string } | null>(null);
  const [signatures, setSignatures] = useState(false);
  const [draft, setDraft] = useState('');
  const [cursor, setCursor] = useState(0);
  const [showKeys, setShowKeys] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const routeLoc = useLocation();
  const rootRef = useRef<HTMLDivElement>(null);

  const account = accounts.find((a) => a.id === accountId) || null;
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);

  // ── Переход по ссылке: /mail?account=…&folder=…&thread=… ──
  // Так сюда ведёт панель связей («в каких письмах упомянут AHU-2») и общий
  // поиск. Ящик и папку в ссылке несём не для красоты: почта держит в памяти
  // только текущую папку и по одному ключу цепочки не знала бы, где её искать.
  const [searchParams, setSearchParams] = useSearchParams();
  const linkDoneRef = useRef('');
  useEffect(() => {
    const acc = searchParams.get('account');
    const fol = searchParams.get('folder');
    const thread = searchParams.get('thread');
    if (!thread || !acc) return;
    const sig = `${acc}|${fol}|${thread}`;
    if (linkDoneRef.current === sig) return;
    linkDoneRef.current = sig;
    (async () => {
      if (accountId !== acc) await chooseAccount(acc);
      if (fol) await chooseFolder(fol);
      open(thread);
      const next = new URLSearchParams(searchParams);
      next.delete('account'); next.delete('folder'); next.delete('thread');
      setSearchParams(next, { replace: true });
    })();
  }, [searchParams, accountId, chooseAccount, chooseFolder, open, setSearchParams]);

  // ── Письмо приходит само ───────────────────────────────────────────────────
  //
  // Сервер держит соединение с почтой открытым (IMAP IDLE) и сообщает о новом
  // письме сюда. Список обновляем только для открытого ящика: дёргать чужую
  // папку на каждое письмо в соседнем ящике незачем — счётчик там и так
  // пересчитается при переключении.
  const { socket } = useRealTimeSync();
  useEffect(() => {
    if (!socket) return;
    const onNew = (p: { accountId?: string }) => {
      if (!p?.accountId || p.accountId !== accountId) return;
      void loadFolders();
    };
    socket.on('mail:new', onNew);
    return () => { socket.off('mail:new', onNew); };
  }, [socket, accountId, loadFolders]);

  /**
   * /mail?q=<запрос> — открыть почту сразу с поиском.
   *
   * По такой ссылке сюда приводит помощник: «покажи письма про 20-PT-001» он
   * отвечает списком и кнопкой, которая открывает тот же поиск в самом
   * разделе. Параметр гасим сразу после подстановки, иначе возврат в раздел
   * стирал бы то, что человек успел набрать руками.
   */
  const askedRef = useRef('');
  useEffect(() => {
    const want = new URLSearchParams(routeLoc.search).get('q');
    if (!want || askedRef.current === want) return;
    askedRef.current = want;
    setDraft(want);
    setQuery(want);
    navigate('/mail', { replace: true });
  }, [routeLoc.search]); // eslint-disable-line react-hooks/exhaustive-deps

  // Поиск не дёргает сервер на каждую букву
  useEffect(() => {
    const t = setTimeout(() => { if (draft !== query) setQuery(draft); }, 350);
    return () => clearTimeout(t);
  }, [draft, query, setQuery]);

  const openThread = useMemo(() => threads.find((t) => t.threadKey === openKey) || null, [threads, openKey]);
  const pickedIds = useMemo(
    () => threads.filter((t) => picked.includes(t.threadKey)).flatMap((t) => t.ids),
    [threads, picked],
  );

  // ── Горячие клавиши ────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (typing) {
        // В поле ввода работает только Escape — вернуться из поиска
        if (e.key === 'Escape' && el === searchRef.current) { setDraft(''); el.blur(); }
        return;
      }
      // Раздел мог остаться смонтированным в скрытой панели — клавиши тогда
      // не наши: рабочий стол держит до четырёх разделов живыми разом
      if (!rootRef.current?.offsetParent) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const list = threads;
      const current = list[cursor];

      switch (e.key) {
        case '/': e.preventDefault(); searchRef.current?.focus(); return;
        case 'j': setCursor((c) => Math.min(list.length - 1, c + 1)); return;
        case 'k': setCursor((c) => Math.max(0, c - 1)); return;
        case 'Enter': if (current) { e.preventDefault(); open(current.threadKey); } return;
        case 'u': if (openKey) { e.preventDefault(); open(''); } return;
        case 'x': if (current) { e.preventDefault(); togglePick(current.threadKey); } return;
        case 's': if (current) { e.preventDefault(); void markFlagged(current.ids, !current.flagged); } return;
        case 'e': {
          const ids = pickedIds.length ? pickedIds : (openThread?.ids || current?.ids || []);
          if (ids.length) { e.preventDefault(); void moveTo(ids, 'ARCHIVE'); }
          return;
        }
        case '#': {
          const ids = pickedIds.length ? pickedIds : (openThread?.ids || current?.ids || []);
          if (ids.length) { e.preventDefault(); void moveTo(ids, 'TRASH'); }
          return;
        }
        case 'g': {
          // Пара g+i: ждём вторую клавишу — так же устроено в Gmail
          const second = (ev: KeyboardEvent) => {
            if (ev.key === 'i') {
              const inbox = folders.find((f) => f.kind === 'INBOX');
              if (inbox) void chooseFolder(inbox.id);
            }
            window.removeEventListener('keydown', second, true);
          };
          window.addEventListener('keydown', second, true);
          setTimeout(() => window.removeEventListener('keydown', second, true), 1200);
          return;
        }
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [threads, cursor, openKey, openThread, pickedIds, folders, open, togglePick, markFlagged, moveTo, chooseFolder]);

  // Курсор не должен уезжать за конец списка после удаления писем
  useEffect(() => { setCursor((c) => Math.min(c, Math.max(0, threads.length - 1))); }, [threads.length]);

  /**
   * Ящика ещё нет.
   *
   * Раньше здесь была карточка посреди пустого экрана, и человек не видел ни
   * устройства почты, ни того, что он получит. Теперь видно саму программу:
   * папки, поиск, место письма — всё на местах и ждёт писем. Так понятнее и
   * честнее: работать тут есть чем, не хватает только ящика.
   */
  if (!accounts.length) {
    return (
      <div ref={rootRef} className="h-full flex min-h-0 bg-white dark:bg-slate-900">
        <aside className="fx-side w-48 shrink-0 flex flex-col gap-0.5 p-2">
          {['Входящие', 'Отправленные', 'Черновики', 'Архив', 'Корзина'].map((f, i) => (
            <span key={f} aria-current={i === 0 || undefined}
              className={`fx-li cursor-default ${i === 0 ? '' : 'text-slate-400 dark:text-slate-500'}`}>
              <MailIcon /> {f}
            </span>
          ))}
          <span className="mt-auto fx-note px-2">
            Ящики подключаются в параметрах — там же общая почта компании.
          </span>
        </aside>

        <div className="flex-1 min-w-0 flex flex-col">
          <header className="fx-head shrink-0">
            <h2 className="fx-head-title">Входящие</h2>
          </header>

          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
            <MailIcon className="w-8 h-8 text-slate-300 dark:text-slate-700" />
            <p className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Ящик не подключён</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm leading-relaxed">
              Письма появятся здесь, как только вы добавите ящик. Всё остальное — папки, поиск,
              перевод писем, разбор сроков и встреч — уже работает и ждёт писем.
            </p>
            <button
              type="button"
              onClick={() => setForm({ open: true, account: null })}
              className="mt-1 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600
                         text-white text-sm font-semibold shadow-md cursor-pointer"
            >
              <Plus className="w-4 h-4" /> Добавить ящик
            </button>
          </div>
        </div>

        {form.open && (
          <MailAccountForm
            account={form.account}
            onClose={() => setForm({ open: false, account: null })}
            onSaved={() => { void loadAccounts(); }}
          />
        )}
      </div>
    );
  }

  const anyPicked = picked.length > 0;
  const allPicked = anyPicked && picked.length === threads.length;

  return (
    <div ref={rootRef} className="h-full flex flex-col min-h-0 bg-white dark:bg-slate-900">
      {/* ── Шапка ─────────────────────────────────────────────────────────── */}
      <header className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800">
        {/* Ящик выбирается в левой колонке — списком, а не выпадающим полем.
            Два места для одного и того же выбора сбивают: человек меняет ящик
            слева и не понимает, почему в шапке написано другое. Здесь остаётся
            только имя открытого ящика — как заголовок. */}
        <div className="flex items-center gap-2 min-w-0">
          <MailIcon className="w-5 h-5 shrink-0 text-emerald-700 dark:text-emerald-400" />
          <span className="flex flex-col min-w-0 max-w-[14rem] leading-tight">
            <span className="truncate text-sm font-semibold text-slate-900 dark:text-white">
              {account ? (account.label || (account.scope === 'SHARED' ? 'Общая почта' : account.email)) : 'Почта'}
            </span>
            {account?.label && (
              <span className="truncate text-2xs text-slate-500 dark:text-slate-400">{account.email}</span>
            )}
          </span>
          {account?.scope === 'SHARED' && (
            <span className="shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300">
              общая
            </span>
          )}
        </div>

        <div className="flex-1 min-w-[10rem] relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          <input
            ref={searchRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Поиск по письмам   /"
            aria-label="Поиск по письмам"
            className="w-full pl-8 pr-8 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
          {draft && (
            <button
              type="button" title="Очистить" aria-label="Очистить поиск"
              onClick={() => setDraft('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button" title="Горячие клавиши" aria-label="Горячие клавиши"
            onClick={() => setShowKeys((v) => !v)}
            className="hidden @[700px]:block p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 cursor-pointer"
          >
            <KeyRound className="w-4 h-4" />
          </button>
          <button
            type="button" title="Настройки ящика" aria-label="Настройки ящика"
            onClick={() => setForm({ open: true, account })}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 cursor-pointer"
          >
            <Settings2 className="w-4 h-4" />
          </button>
          <button
            type="button" title="Подключить ещё ящик" aria-label="Подключить ещё ящик"
            onClick={() => setForm({ open: true, account: null })}
            className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </header>

      {showKeys && (
        <div className="shrink-0 px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50">
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {HOTKEYS.map((h) => (
              <span key={h.keys} className="text-2xs text-slate-500 dark:text-slate-400">
                <kbd className="font-mono font-medium text-slate-700 dark:text-slate-300">{h.keys}</kbd> — {h.what}
              </span>
            ))}
          </div>
        </div>
      )}

      {(error || account?.lastError) && (
        <div className="shrink-0 flex items-start gap-2 px-3 py-2 border-b border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/30">
          <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400 mt-0.5" />
          <p className="flex-1 min-w-0 text-xs text-rose-700 dark:text-rose-300">{error || account?.lastError}</p>
          {/* Цель нажатия должна быть не меньше 24 px по высоте: голая ссылка
              давала 16 px, и попасть в неё было трудно */}
          <button
            type="button" onClick={() => void sync()}
            className="shrink-0 px-2 py-1 rounded-md text-xs font-semibold text-rose-700 hover:bg-rose-100 dark:text-rose-300 dark:hover:bg-rose-950/50 cursor-pointer"
          >
            Повторить
          </button>
        </div>
      )}

      {/* ── Полоса действий над отмеченными ────────────────────────────────── */}
      {anyPicked && (
        <div className="shrink-0 flex flex-wrap items-center gap-1 px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 bg-sky-50 dark:bg-sky-950/25">
          <button
            type="button" onClick={() => pickAll(!allPicked)}
            className="p-1.5 rounded-lg text-slate-600 hover:bg-white/70 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer"
            title={allPicked ? 'Снять всё' : 'Отметить всё'}
          >
            {allPicked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
          </button>
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 mr-1">
            Отмечено: {picked.length}
          </span>
          <button type="button" onClick={() => void markSeen(pickedIds, true)} title="Прочитано"
            className="p-1.5 rounded-lg text-slate-600 hover:bg-white/70 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer">
            <MailOpen className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => void markFlagged(pickedIds, true)} title="Важное"
            className="p-1.5 rounded-lg text-slate-600 hover:bg-white/70 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer">
            <Star className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => void moveTo(pickedIds, 'ARCHIVE')} title="В архив"
            className="p-1.5 rounded-lg text-slate-600 hover:bg-white/70 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer">
            <Archive className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => void moveTo(pickedIds, 'TRASH')} title="Удалить"
            className="p-1.5 rounded-lg text-slate-600 hover:bg-rose-100 hover:text-rose-700 dark:text-slate-300 dark:hover:bg-rose-950/40 cursor-pointer">
            <Trash2 className="w-4 h-4" />
          </button>
          <button type="button" onClick={clearPicked}
            className="ml-auto text-xs font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white cursor-pointer">
            Снять отметки
          </button>
        </div>
      )}

      {/* ── Три колонки ───────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex">
        <MailSidebar
          accounts={accounts}
          accountId={accountId}
          folders={folders}
          folderId={folderId}
          filter={filter}
          syncing={syncing}
          unreadByAccount={unreadByAccount}
          onChooseAccount={(id) => void chooseAccount(id)}
          onChooseFolder={(id) => void chooseFolder(id)}
          onFilter={setFilter}
          onSync={() => void sync()}
          onCompose={() => setCompose({ mode: 'NEW' })}
          onAddAccount={() => setForm({ open: true, account: null })}
          onSettings={() => setSignatures(true)}
        />

        {/* Список. В тесной панели чтение ложится поверх, и список прячем */}
        {/* Колонка списка объявлена контейнером: строка письма должна мерить
            своё место, а не всю панель. Иначе при открытом письме список
            сужается вдвое, а строка об этом не знает и режет тему до буквы. */}
        <div className={`@container flex-1 min-w-0 flex flex-col border-r border-slate-200 dark:border-slate-800
          ${openKey ? 'hidden @[1000px]:flex @[1000px]:max-w-[26rem]' : 'flex'}`}>
          <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-slate-100 dark:border-slate-850">
            <button
              type="button" onClick={() => pickAll(!allPicked)}
              title={allPicked ? 'Снять всё' : 'Отметить всё'} aria-label={allPicked ? 'Снять всё' : 'Отметить всё'}
              className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
            >
              {allPicked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
            </button>
            <span className="flex-1 min-w-0 truncate text-xs text-slate-500 dark:text-slate-400">
              {query
                ? `Найдено переписок: ${threads.length}`
                : `${folders.find((f) => f.id === folderId)?.name || 'Папка'} — ${threads.length}`}
            </span>
            {syncing && <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin text-emerald-600 dark:text-emerald-400" />}
          </div>

          <MailList
            threads={threads}
            picked={picked}
            openKey={openKey}
            myAddr={account?.email || ''}
            loading={loading}
            shared={shared}
            meId={user?.id || ''}
            onClaim={(t, on) => void claim(t.threadKey, on)}
            onOpen={open}
            onPick={togglePick}
            onStar={(t, on) => void markFlagged(t.ids, on)}
            onSeen={(t, on) => void markSeen(t.ids, on)}
            onArchive={(t) => void moveTo(t.ids, 'ARCHIVE')}
            onTrash={(t) => void moveTo(t.ids, 'TRASH')}
          />
        </div>

        {/* Чтение */}
        {openKey && openThread && (
          <MailThread
            accountId={accountId}
            threadKey={openKey}
            subject={openThread.subject}
            flagged={openThread.flagged}
            myAddr={account?.email || ''}
            dark={dark}
            onBack={() => open('')}
            onStar={(on) => void markFlagged(openThread.ids, on)}
            onArchive={() => void moveTo(openThread.ids, 'ARCHIVE')}
            onTrash={() => void moveTo(openThread.ids, 'TRASH')}
            onSeen={(ids) => void markSeen(ids, true)}
            onReply={(mode, messageId) => setCompose({ mode, messageId })}
            meId={user?.id || ''}
          />
        )}

        {/* Пусто справа — только когда места хватает на три колонки */}
        {!openKey && (
          <div className="hidden @[1000px]:flex flex-1 min-w-0 items-center justify-center bg-slate-50 dark:bg-slate-950">
            <div className="blank">
              <MailOpen className="w-12 h-12 text-slate-300 dark:text-slate-700 mb-3" />
              <p className="blank-title">Выберите письмо</p>
              <p className="blank-text">
                Переписка откроется здесь. Клавиши <kbd className="font-mono font-medium">j</kbd> и{' '}
                <kbd className="font-mono font-medium">k</kbd> листают список, <kbd className="font-mono font-medium">/</kbd> — поиск.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Где лежит ключ шифрования — это стоит знать до переноса программы */}
      {keyIn === 'file' && account && (
        <footer className="shrink-0 px-3 py-1 border-t border-slate-100 dark:border-slate-850">
          <p className="text-2xs text-slate-400 dark:text-slate-500">
            Пароль ящика зашифрован ключом в файле настроек. В сборке для Windows ключ хранит система.
          </p>
        </footer>
      )}

      {form.open && (
        <MailAccountForm
          account={form.account}
          mayShared={mayShared}
          onClose={() => setForm({ open: false, account: null })}
          onSaved={() => { void loadAccounts(); void loadThreads(); }}
        />
      )}

      {compose && account && (
        <MailCompose
          account={account}
          mode={compose.mode}
          messageId={compose.messageId}
          onClose={() => setCompose(null)}
          onSent={() => { void loadThreads(); }}
        />
      )}

      {signatures && (
        <MailSignatures accounts={accounts} onClose={() => setSignatures(false)} />
      )}
    </div>
  );
}
