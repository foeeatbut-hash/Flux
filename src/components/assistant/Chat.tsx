/**
 * Разговор с помощником — одно и то же и в панели, и в окне.
 *
 * Помощник стал программой оболочки: у него есть окно, кнопка на панели задач и
 * место на столе. Панель справа при этом никуда не делась — она нужна там, где
 * окон нет вовсе (панельная оболочка) и когда спросить надо на секунду. Чтобы
 * эти два вида не разошлись, тело разговора одно, а разное — только рама.
 *
 * Разговор один на программу: два окна помощника показывали бы одну и ту же
 * беседу с двух сторон, и человек не смог бы объяснить себе, чем они
 * отличаются.
 */
import React from 'react';
import {
  Send, X, FileSpreadsheet, FileText, Play, HelpCircle, Loader2, GraduationCap,
  MessageCircleQuestion, Info, Pencil, MapPin, Tag as TagIcon, Paperclip, StickyNote, Link2,
} from 'lucide-react';
import { useAssistantStore, AssistantMessage, AssistantAction } from '../../store/assistantStore';
import { getSection } from '../../assistant/sections';
import { allowEntitlement } from '../../store/policyStore';
import { useWindowStore } from '../../store/windowStore';
import { useToastStore } from '../../store/toastStore';
import { useInsightStore } from '../../store/insightStore';
import { useReminderStore } from '../../store/reminderStore';
import { parseSlash, whenLabel, parseWhen } from '../../lib/commandBar';
import { ASSISTANT_MODES, modeLabel, modePlaceholder } from '../../lib/assistantModes';

function actionIcon(kind: AssistantAction['kind']) {
  switch (kind) {
    case 'export-excel': return <FileSpreadsheet className="w-3.5 h-3.5" />;
    case 'export-word': return <FileText className="w-3.5 h-3.5" />;
    case 'tour': return <Play className="w-3.5 h-3.5" />;
    case 'ask': return <MessageCircleQuestion className="w-3.5 h-3.5" />;
    case 'prompt-rename-tag': return <Pencil className="w-3.5 h-3.5" />;
    case 'focus-tag': case 'find-duplicates': return <MapPin className="w-3.5 h-3.5" />;
    case 'create-note': return <StickyNote className="w-3.5 h-3.5" />;
    case 'where-used': return <Link2 className="w-3.5 h-3.5" />;
    case 'cancel-input': return <X className="w-3.5 h-3.5" />;
    default: return <HelpCircle className="w-3.5 h-3.5" />;
  }
}

function ActionChip({ a }: { a: AssistantAction }) {
  const runAction = useAssistantStore((s) => s.runAction);
  const openWhere = useInsightStore((s) => s.openWhere);
  const danger = a.danger || a.kind === 'cancel-input';
  // «Где используется» показывает панель связей — ту же, что открывается из
  // поиска. Хранилище помощника про эту панель не знает и знать не должно:
  // состояние не тянет за собой интерфейс
  const run = () => {
    if (a.kind === 'where-used' && a.usageKind && a.usageId) { openWhere(a.usageKind as any, a.usageId); return; }
    runAction(a);
  };
  return (
    <button type="button"
      onClick={run}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 border rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
        danger
          ? 'bg-slate-500/10 hover:bg-slate-500/20 text-slate-500 dark:text-slate-400 border-slate-400/30'
          : 'bg-emerald-600/15 hover:bg-emerald-600/25 text-emerald-700 dark:text-emerald-300 border-emerald-600/30'
      }`}
    >
      {actionIcon(a.kind)}
      <span>{a.label}</span>
    </button>
  );
}

/** Интерактивный список: карточки с действиями у каждого элемента */
function InteractiveList({ items }: { items: NonNullable<AssistantMessage['list']> }) {
  const shown = items.slice(0, 60);
  return (
    <div className="mt-2 space-y-1.5">
      {shown.map((it) => (
        <div key={it.id} className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
          <div className="flex items-center gap-1.5 min-w-0">
            <TagIcon className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
            <span className="font-mono font-bold text-xs text-slate-800 dark:text-slate-100 truncate">{it.title}</span>
            {it.badge && (
              <span className="shrink-0 text-2xs font-bold px-1.5 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950/50
                               text-rose-600 dark:text-rose-300">{it.badge}</span>
            )}
          </div>
          {it.subtitle && <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 pl-5 truncate">{it.subtitle}</div>}
          <div className="flex flex-wrap gap-1.5 mt-1.5 pl-5">
            {it.actions.map((a, i) => <ActionChip key={i} a={a} />)}
          </div>
        </div>
      ))}
      {items.length > shown.length && (
        <div className="text-2xs text-slate-400 px-1">Показано {shown.length} из {items.length}.</div>
      )}
    </div>
  );
}

function DataTable({ table }: { table: NonNullable<AssistantMessage['table']> }) {
  const shown = table.rows.slice(0, 50);
  return (
    <div className="mt-2 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
      <div className="max-h-60 overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0">
            <tr className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
              {table.columns.map((c, i) => (
                <th key={i} className="px-2 py-1.5 text-left font-bold border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, ri) => (
              <tr key={ri} className="odd:bg-white even:bg-slate-50 dark:odd:bg-slate-900 dark:even:bg-slate-950">
                {row.map((cell, ci) => (
                  <td key={ci} className="px-2 py-1 text-slate-700 dark:text-slate-300 border-b border-slate-100 dark:border-slate-800 align-top">
                    {String(cell ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length > shown.length && (
        <div className="px-2 py-1 text-2xs text-slate-400 bg-slate-50 dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800">
          Показано {shown.length} из {table.rows.length}. Выгрузите в Excel, чтобы увидеть всё.
        </div>
      )}
    </div>
  );
}

export default function Chat({ compact }: { compact?: boolean }) {
  const messages = useAssistantStore((s) => s.messages);
  const loading = useAssistantStore((s) => s.loading);
  const ask = useAssistantStore((s) => s.ask);
  const demoMode = useAssistantStore((s) => s.demoMode);
  const toggleDemoMode = useAssistantStore((s) => s.toggleDemoMode);
  const currentRoute = useAssistantStore((s) => s.currentRoute);
  const runSuggestion = useAssistantStore((s) => s.runSuggestion);
  const describeCurrentSection = useAssistantStore((s) => s.describeCurrentSection);
  const pendingInput = useAssistantStore((s) => s.pendingInput);
  const attached = useAssistantStore((s) => s.attached);
  const attach = useAssistantStore((s) => s.attach);
  const askAbout = useAssistantStore((s) => s.askAbout);
  const addToast = useToastStore((s) => s.addToast);
  const addReminder = useReminderStore((s) => s.add);

  const section = getSection(currentRoute, allowEntitlement);

  // Что открыто сейчас: помощник смотрит на верхнее окно того же стола и
  // предлагает разговор про него. Раньше он знал только адрес панели — в
  // оконной оболочке это значило «ничего»
  const topTitle = useWindowStore((s) => {
    // Сам помощник в счёт не идёт: «открыто сейчас: Помощник» — это ответ на
    // вопрос, которого никто не задавал
    const shown = s.windows.filter((w) => !w.minimized && w.desk === s.desk && w.path !== '/assistant');
    if (!shown.length) return '';
    const top = shown.reduce((a, b) => (b.z > a.z ? b : a));
    return s.titles[top.id] || '';
  });

  const [input, setInput] = React.useState('');
  /** Открыт ли список режимов над кнопкой */
  const [modesOpen, setModesOpen] = React.useState(false);
  const [dropping, setDropping] = React.useState(false);
  const messagesRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const historyRef = React.useRef<string[]>([]);
  const [histIdx, setHistIdx] = React.useState(-1);

  React.useEffect(() => {
    // Прокручиваем ТОЛЬКО контейнер сообщений: scrollIntoView уводил вверх
    // весь интерфейс вместе с разделом
    if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [messages, loading]);

  React.useEffect(() => { if (pendingInput) setTimeout(() => inputRef.current?.focus(), 60); }, [pendingInput]);

  const send = (text: string) => {
    const clean = text.trim();
    if (!clean || loading) return;
    historyRef.current = [clean, ...historyRef.current.filter((h) => h !== clean)].slice(0, 50);
    setHistIdx(-1);
    setInput('');

    // Команды со слэша понимает и разговор: раз они есть в строке оболочки,
    // требовать закрыть окно и нажать Ctrl+K ради «/напомни» было бы издевательством
    const slash = parseSlash(clean);
    if (slash && slash.cmd.name === 'напомни') {
      const when = parseWhen(slash.rest);
      if (when.at && when.rest) {
        addReminder({ at: when.at, text: when.rest, href: window.location.hash.replace(/^#/, '') });
        addToast(`Напомню ${whenLabel(when.at)}: ${when.rest}`, 'success');
        return;
      }
      addToast('Не понял, когда напомнить. Например: /напомни завтра в 9 позвонить поставщику', 'info');
      return;
    }
    ask(clean);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' && historyRef.current.length > 0) {
      if (input === '' || histIdx >= 0) {
        e.preventDefault();
        const next = Math.min(histIdx + 1, historyRef.current.length - 1);
        setHistIdx(next);
        setInput(historyRef.current[next]);
      }
    } else if (e.key === 'ArrowDown' && histIdx >= 0) {
      e.preventDefault();
      const next = histIdx - 1;
      setHistIdx(next);
      setInput(next < 0 ? '' : historyRef.current[next]);
    }
  };

  /**
   * В разговор можно бросить файл — со стола или из Проводника. Это самый
   * короткий способ спросить «что это и где оно ещё используется»: объяснять
   * словами, какой именно из трёх чертежей имеется в виду, дольше, чем
   * дотащить его значок.
   */
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
      if (data?.type === 'app_items' && Array.isArray(data.ids) && data.ids[0]) askAbout(String(data.ids[0]));
    } catch (_) { /* принесли не наше — молча ничего не делаем */ }
  };

  return (
    <div className="h-full flex flex-col min-h-0"
      onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <div ref={messagesRef} className={`flex-1 overflow-y-auto scrollbar-thin p-3 space-y-3 ${
        dropping ? 'ring-2 ring-inset ring-emerald-500 rounded-xl' : ''
      }`}>
        {messages.map((m, mi) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`${compact ? 'max-w-[90%]' : 'max-w-[720px] w-full'} ${m.role === 'user' ? 'order-2' : ''}`}>
              <div className={`p-2.5 rounded-xl text-xs leading-relaxed whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'bg-emerald-600 text-white rounded-tr-none'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 rounded-tl-none'
              }`}>
                {m.text}
              </div>
              {m.list ? <InteractiveList items={m.list} /> : m.table && <DataTable table={m.table} />}
              {m.role === 'assistant' && !!m.actions?.length && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {m.actions.map((a, i) => <ActionChip key={i} a={a} />)}
                </div>
              )}
              {/* Ответ можно унести с собой: в Блокноте он останется и после
                  того, как разговор забудется */}
              {/* Приветствие уносить с собой незачем — оно и так всегда тут */}
              {m.role === 'assistant' && mi > 0 && m.text.length > 120 && (
                <button type="button"
                  onClick={() => useAssistantStore.getState().runAction({
                    label: 'В Блокнот', kind: 'create-note', noteTitle: m.text.slice(0, 4000),
                  })}
                  className="mt-1.5 flex items-center gap-1 text-2xs font-semibold text-slate-400
                             hover:text-emerald-700 dark:hover:text-emerald-400 cursor-pointer">
                  <StickyNote className="w-3 h-3" /> Сохранить в Блокнот
                </button>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex items-center gap-2 text-xs text-slate-400 pl-1">
            <Loader2 className="w-4 h-4 animate-spin text-emerald-500" />
            <span>Обрабатываю запрос…</span>
          </div>
        )}
        {dropping && (
          <div className="text-2xs text-emerald-700 dark:text-emerald-400 font-semibold px-1">
            Отпустите — расскажу про этот файл и где он используется
          </div>
        )}
      </div>

      {/* Что сейчас открыто: скрепка. Её видно до вопроса, а не после ответа */}
      {(attached || topTitle) && (
        <div className="px-3 py-1.5 shrink-0 flex items-center gap-1.5 border-t border-slate-100 dark:border-slate-850
                        text-2xs text-slate-500 dark:text-slate-400">
          <Paperclip className="w-3 h-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="truncate flex-1">
            {attached ? attached.title : topTitle}
            <span className="text-slate-400 dark:text-slate-500"> — {attached ? 'прикреплено к разговору' : 'открыто сейчас'}</span>
          </span>
          {attached && (
            <>
              <button type="button" onClick={() => askAbout(attached.id)}
                title="Карточка связей"
                className="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
                <Link2 className="w-3 h-3" />
              </button>
              <button type="button" onClick={() => attach(null)} title="Открепить"
                className="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
                <X className="w-3 h-3" />
              </button>
            </>
          )}
        </div>
      )}

      {/* Подсказки раздела и туры — только в режиме «Демонстрация» */}
      {section && demoMode && (
        <div className="px-3 pt-2 pb-1 border-t border-slate-100 dark:border-slate-850 shrink-0">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-2xs font-bold text-slate-400 dark:text-slate-500 flex items-center gap-1">
              <Info className="w-3 h-3" /> {section.emoji} Раздел: {section.title}
            </span>
            <button type="button" onClick={() => describeCurrentSection()}
              className="text-2xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer">
              Подробнее
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {section.suggestions.map((s, i) => (
              <button type="button" key={i} onClick={() => runSuggestion(s)}
                className="flex items-center gap-1 px-2 py-1 bg-slate-100 dark:bg-slate-800 hover:bg-emerald-600/15
                           hover:text-emerald-700 dark:hover:text-emerald-300 text-slate-600 dark:text-slate-300
                           rounded-full text-xs font-medium cursor-pointer transition-colors">
                {s.kind === 'tour' ? <Play className="w-3 h-3" /> : <MessageCircleQuestion className="w-3 h-3" />}
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Режим — кнопкой, а не переключателем во всю ширину. «Демонстрация»
          перестала быть главной настройкой экрана и стала одним из режимов;
          список — в src/lib/assistantModes.ts, чтобы третий режим менял одну
          строку, а не разметку панели */}
      <div className="px-3 pt-1 pb-0.5 shrink-0 relative">
        <button type="button" onClick={() => setModesOpen((v) => !v)}
          title="Как отвечать: словами или показом по шагам"
          className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-2xs font-semibold cursor-pointer transition-colors ${
            demoMode
              ? 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-300'
              : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850'
          }`}
        >
          <GraduationCap className="w-3.5 h-3.5" />
          {modeLabel(demoMode ? 'demo' : 'normal')}
        </button>

        {modesOpen && (
          <>
            {/* Панелька встаёт НАД кнопкой: под ней поле ввода, и список,
                выпавший вниз, закрывал бы то, ради чего его открыли */}
            <div className="fixed inset-0 z-10" onClick={() => setModesOpen(false)} />
            <div className="absolute bottom-full left-3 mb-1 z-20 w-64 rounded-xl border border-slate-200
                            dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl overflow-hidden">
              {ASSISTANT_MODES.map((m) => {
                const active = (m.id === 'demo') === !!demoMode;
                return (
                  <button key={m.id} type="button"
                    onClick={() => { if ((m.id === 'demo') !== !!demoMode) toggleDemoMode(); setModesOpen(false); }}
                    className={`w-full text-left px-3 py-2 cursor-pointer transition-colors ${
                      active ? 'bg-emerald-50 dark:bg-emerald-950/40' : 'hover:bg-slate-50 dark:hover:bg-slate-850'
                    }`}
                  >
                    <div className={`text-xs font-bold ${active ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-800 dark:text-white'}`}>
                      {m.label}
                    </div>
                    <div className="text-2xs text-slate-500 dark:text-slate-400 leading-snug">{m.hint}</div>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); send(input); }}
        className="px-3 pb-3 shrink-0 flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => { setInput(e.target.value); setHistIdx(-1); }}
          onKeyDown={onKeyDown}
          placeholder={pendingInput?.kind === 'rename-tag'
            ? `Новый код для «${pendingInput.oldCode}»…`
            : modePlaceholder(demoMode ? 'demo' : 'normal')}
          className={`flex-1 px-3 py-2 bg-slate-50 dark:bg-slate-950 border rounded-lg text-xs text-slate-800
                      dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 transition-ui ${
            pendingInput ? 'border-amber-400/60 focus:ring-amber-400/30 focus:border-amber-400'
              : demoMode ? 'border-emerald-500/50 focus:ring-emerald-500/30 focus:border-emerald-500'
                : 'border-slate-200 dark:border-slate-800 focus:ring-emerald-500/30 focus:border-emerald-500'
          }`}
        />
        <button type="submit" disabled={loading || !input.trim()} title="Отправить"
          className="p-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-lg cursor-pointer transition-colors shrink-0">
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
}
