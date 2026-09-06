/**
 * Строка «Спросить или найти» — Ctrl+K.
 *
 * Одна строка вместо двух. Раньше Ctrl+K звал помощника, а Ctrl+Shift+F искал
 * по проекту, и выбирать между ними приходилось до того, как есть что выбирать:
 * «3700-K02» — это поиск, «покажи дубли» — вопрос, «открой почту» — команда, а
 * человек в этот момент думает не про способ, а про дело. Оба сочетания открывают
 * эту строку: привычка ни у кого не отобрана.
 *
 * Что показать на набранное, решает src/lib/commandBar.ts — там же это и
 * проверяется. Здесь только ввод, список и исполнение выбранной строки.
 */
import React from 'react';
import { useOverlay } from '../store/overlayStore';
import { useNavigate } from 'react-router-dom';
import {
  Search, CornerDownLeft, ArrowUp, ArrowDown, ShieldCheck, History, BookOpen,
  Bell, StickyNote, Monitor, AppWindow, MessageCircleQuestion, Slash, Languages, CalendarDays,
} from 'lucide-react';
import { useStore } from '../store/store';
import { can } from '../lib/permissions';
import { useInsightStore } from '../store/insightStore';
import { useAssistantStore } from '../store/assistantStore';
import { useWindowStore } from '../store/windowStore';
import { useToastStore } from '../store/toastStore';
import { useReminderStore } from '../store/reminderStore';
import { useTranslateStore } from '../store/translateStore';
import { useCalendarStore } from '../store/calendarStore';
import { SECTIONS } from '../workspace/sections';
import { fetchSearch, type SearchHit } from '../lib/insight';
import { search as searchHandbook } from '../handbook/registry';
import { suggest, whenLabel, type BarItem, type BarGroup } from '../lib/commandBar';
import { KindIcon } from './insight/parts';

const GROUP_TITLE: Record<BarGroup, string> = {
  команда: 'Команда',
  раздел: 'Программы',
  справка: 'Руководство',
  проект: 'В проекте',
  помощник: 'Помощник',
};

function ItemIcon({ icon }: { icon: string }) {
  const cls = 'w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400';
  switch (icon) {
    case 'open': return <AppWindow className={cls} />;
    case 'window': return <AppWindow className={cls} />;
    case 'search': return <Search className={cls} />;
    case 'book': return <BookOpen className={cls} />;
    case 'bell': return <Bell className={cls} />;
    case 'calendar': return <CalendarDays className={cls} />;
    case 'note': return <StickyNote className={cls} />;
    case 'translate': return <Languages className={cls} />;
    case 'desk': return <Monitor className={cls} />;
    case 'check': return <ShieldCheck className={cls} />;
    case 'history': return <History className={cls} />;
    case 'ask': return <MessageCircleQuestion className={cls} />;
    default: return <KindIcon kind={icon} />;
  }
}

export default function CommandBar() {
  const open = useInsightStore((s) => s.paletteOpen);
  // Пока это открыто, страница браузера уступает место: родной слой Chromium
  // выше любой разметки, и без этого панель оказалась бы под страницей
  useOverlay(open);
  const close = useInsightStore((s) => s.closePalette);
  const toggle = useInsightStore((s) => s.togglePalette);
  const openCheck = useInsightStore((s) => s.openCheck);
  const openChanges = useInsightStore((s) => s.openChanges);
  const activeProject = useStore((s) => s.activeProject);
  const user = useStore((s) => s.user);
  const askAssistant = useAssistantStore((s) => s.ask);
  const setAssistantOpen = useAssistantStore((s) => s.setOpen);
  const addToast = useToastStore((s) => s.addToast);
  const addReminder = useReminderStore((s) => s.add);
  const navigate = useNavigate();

  const [q, setQ] = React.useState('');
  const [hits, setHits] = React.useState<SearchHit[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [cursor, setCursor] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  /**
   * Оба сочетания открывают строку. Ловим по коду клавиши, а не по букве: на
   * русской раскладке Ctrl+K даёт «л», и проверка по символу не срабатывала бы
   * ровно там, где программой и пользуются.
   */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      if (e.code === 'KeyK' || (e.shiftKey && e.code === 'KeyF')) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  React.useEffect(() => {
    if (!open) return;
    setQ(''); setHits([]); setCursor(0);
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  // Запрос к серверу уходит с задержкой: иначе на каждое нажатие уходил бы срез
  // проекта. Команды и разделы при этом отвечают сразу — они известны на месте
  React.useEffect(() => {
    if (!open) return;
    const text = q.trim();
    if (text.length < 2 || text.startsWith('/')) { setHits([]); setBusy(false); return; }
    setBusy(true);
    const t = setTimeout(() => {
      fetchSearch(text, activeProject?.id).then((h) => { setHits(h); setBusy(false); });
    }, 220);
    return () => clearTimeout(t);
  }, [q, open, activeProject?.id]);

  const sections = React.useMemo(
    // Разделы, закрытые правом, не находятся и поиском: иначе строка команд
    // предлагала бы то, что не откроется
    () => SECTIONS.filter((s) => (!s.adminOnly || user?.role === 'ADMIN')
      && (!s.feature || user?.role === 'ADMIN' || can(user as any, s.feature)))
      .map((s) => ({ path: s.path, title: s.title, multi: s.multi })),
    [user?.role],
  );

  // Подпись открытого окна: помощник ответит с оглядкой на него, и сказать об
  // этом надо до нажатия, а не после
  const context = useWindowStore((s) => {
    const shown = s.windows.filter((w) => !w.minimized && w.desk === s.desk);
    if (!shown.length) return undefined;
    const top = shown.reduce((a, b) => (b.z > a.z ? b : a));
    return s.titles[top.id] || undefined;
  });

  const items = React.useMemo(() => {
    const text = q.trim();
    const forHandbook = text.startsWith('/справка ') ? text.slice(9) : text;
    const articles = forHandbook.length >= 2
      ? searchHandbook(forHandbook, 6).map((h) => ({ id: h.article.id, title: h.article.title, hint: h.excerpt }))
      : [];
    return suggest(text, { sections, articles, hits, context });
  }, [q, sections, hits, context]);

  React.useEffect(() => { setCursor(0); }, [q, hits.length]);
  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const run = (it: BarItem) => {
    const r = it.run;
    switch (r.kind) {
      case 'fill':
        setQ(r.text);
        setTimeout(() => inputRef.current?.focus(), 0);
        return;
      case 'navigate': close(); navigate(r.route); return;
      case 'newWindow':
        close();
        useWindowStore.getState().openAnother(r.route);
        return;
      case 'handbook': close(); navigate(`/handbook?article=${encodeURIComponent(r.articleId)}`); return;
      case 'ask': close(); setAssistantOpen(true); askAssistant(r.query); return;
      case 'check': close(); openCheck(); return;
      case 'changes': close(); openChanges(); return;
      case 'note': close(); navigate(`/notes?new=${encodeURIComponent(r.text || 'Новая заметка')}`); return;
      case 'translate': {
        // Строка отдаёт текст Переводчику, а не переводит сама: перевод нужен
        // рядом с правкой, происхождением и памятью, а в одну строку это не влезет
        close();
        useTranslateStore.getState().setPending(r.text);
        useWindowStore.getState().open('/translate');
        return;
      }
      case 'desk': close(); useWindowStore.getState().goToDesk(r.index); return;
      case 'remind': {
        close();
        addReminder({ at: r.at, text: r.text, href: window.location.hash.replace(/^#/, '') });
        addToast(`Напомню ${whenLabel(r.at)}: ${r.text}`, 'success');
        return;
      }
      case 'meeting': {
        // Окно события открывает сам Календарь: заводить встречу молча, одной
        // строкой, нельзя — участников и ссылку человек ещё не назвал
        close();
        useCalendarStore.getState().setDraft({
          kind: 'meeting', title: r.title || 'Встреча',
          startsAt: r.at, endsAt: r.at + 30 * 60000,
          remindMin: 5, visibility: 'project', source: 'assistant',
        });
        useWindowStore.getState().open('/calendar');
        return;
      }
      default: close();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, items.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); return; }
    if (e.key === 'Tab' && items[cursor]) {
      // Tab дописывает выбранное в строку — как в командной строке системы
      e.preventDefault();
      const it = items[cursor];
      if (it.run.kind === 'fill') run(it);
      return;
    }
    if (e.key === 'Enter' && items[cursor]) { e.preventDefault(); run(items[cursor]); }
  };

  if (!open) return null;

  let lastGroup: BarGroup | null = null;

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center pt-[12vh] px-4">
      <button type="button" aria-label="Закрыть строку" onClick={close}
        className="absolute inset-0 bg-slate-950/30 dark:bg-slate-950/55 cursor-default" />

      <div role="dialog" aria-label="Спросить или найти"
        className="relative w-full max-w-xl bg-white dark:bg-slate-900 rounded-2xl border border-slate-200
                   dark:border-slate-800 shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-slate-100 dark:border-slate-850">
          {q.trim().startsWith('/')
            ? <Slash className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            : <Search className="w-4 h-4 text-slate-400 shrink-0" />}
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Спросить, найти или скомандовать — / для команд"
            className="flex-1 bg-transparent text-sm text-slate-800 dark:text-white placeholder:text-slate-400 focus:outline-none"
          />
          {busy && <span className="w-3 h-3 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin shrink-0" />}
        </div>

        {context && (
          <div className="px-4 py-1.5 text-2xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-950
                          border-b border-slate-100 dark:border-slate-850 truncate">
            Открыто: <span className="font-semibold text-slate-700 dark:text-slate-300">{context}</span> — помощник это учтёт
          </div>
        )}

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-slate-400">
              {q.trim().length < 2 ? 'Наберите хотя бы две буквы' : 'Ничего не нашлось в этом проекте'}
            </p>
          ) : items.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <React.Fragment key={it.key}>
                {head && (
                  <div className="px-3 pt-2 pb-1 text-2xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                    {GROUP_TITLE[head]}
                  </div>
                )}
                <button
                  data-idx={i}
                  type="button"
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => run(it)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-left cursor-pointer ${
                    i === cursor ? 'bg-emerald-50 dark:bg-emerald-950/30' : ''
                  }`}
                >
                  <ItemIcon icon={it.icon} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-slate-800 dark:text-slate-150 truncate">{it.title}</span>
                    <span className="block text-2xs text-slate-500 dark:text-slate-400 truncate">{it.subtitle}</span>
                  </span>
                </button>
              </React.Fragment>
            );
          })}
        </div>

        <div className="flex items-center gap-3 px-4 py-2 border-t border-slate-100 dark:border-slate-850 text-2xs text-slate-400">
          <span className="flex items-center gap-1"><ArrowUp className="w-3 h-3" /><ArrowDown className="w-3 h-3" /> выбор</span>
          <span className="flex items-center gap-1"><CornerDownLeft className="w-3 h-3" /> сделать</span>
          <span className="flex items-center gap-1"><Slash className="w-3 h-3" /> команды</span>
          <div className="flex-1" />
          <span>Esc — закрыть</span>
        </div>
      </div>
    </div>
  );
}
