import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BookOpen, FilePlus2, HelpCircle, History, Home, Search, Send, X } from 'lucide-react';
import { HistoryPanel } from '../components/guide/HistoryPanel';
import { HandbookPane } from '../components/guide/HandbookPane';
import { ProjectSelector } from '../components/guide/ProjectSelector';
import { QuestionsPane } from '../components/guide/QuestionsPane';
import { allowEntitlement } from '../store/policyStore';
import { useWindowTitle } from '../lib/paneTitle';
import { useStore } from '../store/store';
import { useGuideStore } from '../guide/store';
import { search } from '../handbook/registry';

/** Единая оболочка Flux Guide: компактный режим у строки ввода, содержимое
 *  статьи и ответа вынесено в независимые компоненты для проверки логики. */

// ── Оболочка ──

export default function FluxGuide() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const mode = useGuideStore((s) => s.mode);
  const setMode = useGuideStore((s) => s.setMode);
  const draft = useGuideStore((s) => (mode === 'handbook' ? s.draftHandbook : s.draftQuestions));
  const setDraft = useGuideStore((s) => s.setDraft);
  const setNavigator = useGuideStore((s) => s.setNavigator);
  const user = useStore((s) => s.user);
  const activeProject = useStore((s) => s.activeProject);
  const messages = useGuideStore((s) => s.messages);
  const ask = useGuideStore((s) => s.ask);
  const asking = useGuideStore((s) => s.asking);
  const loadChats = useGuideStore((s) => s.loadChats);
  const startNewChat = useGuideStore((s) => s.startNewChat);
  const chatSaveState = useGuideStore((s) => s.chatSaveState);
  const chatSaveError = useGuideStore((s) => s.chatSaveError);
  const saveChat = useGuideStore((s) => s.saveChat);
  const [modeMenu, setModeMenu] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNavigator((path: string) => navigate(path));
  }, [navigate, setNavigator]);

  useEffect(() => {
    if (!user) return;
    useGuideStore.getState().setUserGetter(() => ({ id: user.id, name: user.name }));
    useGuideStore.getState().setActiveProjectGetter(() =>
      activeProject ? { id: activeProject.id, name: activeProject.name } : null);
  }, [user?.id, activeProject?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Режим входа: ?tab=questions | ?ask= — «Вопросы»; ?article= | ?for= — «Справочник».
  // Реагирует на смену адреса окна: F1 в уже открытый Guide должен показать
  // статью, а не оставлять «Вопросы» (ТЗ v3 §5)
  useEffect(() => {
    if (params.get('tab') === 'questions' || params.get('ask')) setMode('questions');
    else if (params.get('for') || params.get('article')) setMode('handbook');
  }, [params, setMode]);

  // ?ask= — вопрос запускается один раз при появлении в адресе
  const askParam = params.get('ask');
  useEffect(() => {
    if (!askParam) return;
    void ask(askParam);
    const next = new URLSearchParams(params);
    next.delete('ask');
    setParams(next, { replace: true });
  }, [askParam]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode === 'questions') void loadChats();
  }, [mode, messages.length, loadChats]);

  // Закрытие всплывающих панелей по клику мимо и по Escape (ТЗ §37.3)
  useEffect(() => {
    if (!modeMenu && !historyOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modeRef.current && !modeRef.current.contains(e.target as Node)) setModeMenu(false);
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setHistoryOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setModeMenu(false); setHistoryOpen(false); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [modeMenu, historyOpen]);

  useWindowTitle(`Flux Guide · ${mode === 'handbook' ? 'Справочник' : 'Вопросы'}${messages.length ? ` · ${messages.length}` : ''}`);

  const switchMode = (next: 'handbook' | 'questions') => {
    setMode(next);
    setModeMenu(false);
    const nextParams = new URLSearchParams(params);
    if (next === 'questions') nextParams.set('tab', 'questions');
    else nextParams.delete('tab');
    setParams(nextParams, { replace: true });
  };

  // Enter: в «Справочнике» открывает лучшую находку, в «Вопросах» отправляет запрос
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    if (mode === 'questions') {
      if (asking) return;
      setDraft('questions', '');
      void ask(text);
      return;
    }
    const hits = search(text, 1, allowEntitlement);
    if (hits.length) {
      const next = new URLSearchParams(params);
      next.set('article', hits[0].article.id);
      next.delete('for');
      setParams(next, { replace: true });
    }
  };

  return (
    <div id="flux-guide-root" className="@container h-full min-h-0 flex flex-col min-w-0">
      {/* Шапка: проект + режимные действия. Свернуть/закрыть — рамка окна Flux */}
      <div className="fx-head h-11 shrink-0 flex items-center gap-2 px-3 min-w-0">
        <BookOpen className="w-4 h-4 shrink-0 text-slate-500 dark:text-slate-400" />
        <span className="text-[15px] font-semibold text-slate-900 dark:text-white leading-5">Flux Guide</span>

        <ProjectSelector />

        {mode === 'handbook' ? (
          <button type="button" title="Домой" onClick={() => {
            const next = new URLSearchParams(params);
            next.set('article', 'start');
            next.delete('for');
            setParams(next, { replace: true });
          }}
            className="p-2 rounded-lg text-slate-500 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
            <Home className="w-4 h-4" />
          </button>
        ) : (
          <>
            <div ref={historyRef} className="relative">
              <button type="button" title="История вопросов" onClick={() => setHistoryOpen((v) => !v)}
                className={`p-2 rounded-lg cursor-pointer ${historyOpen ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850'}`}>
                <History className="w-4 h-4" />
              </button>
              {historyOpen && <HistoryPanel onClose={() => setHistoryOpen(false)} />}
            </div>
            <button type="button" title="Новый чат (текущая переписка останется в истории)"
              onClick={() => startNewChat()}
              className="p-2 rounded-lg text-slate-500 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
              <FilePlus2 className="w-4 h-4" />
            </button>
          </>
        )}
        <div className="flex-1" />
      </div>

      {/* Содержимое */}
      {mode === 'handbook'
        ? <HandbookPane params={params} setParams={setParams} query={draft} />
        : <QuestionsPane />}

      {/* Низ: широкая строка + маленькая кнопка режима + отправка (ТЗ v3 §3).
          Поля от краёв окна: строка и кнопки не прилипают к границе */}
      <div className="shrink-0 px-3 pt-2 pb-2 border-t border-slate-200 dark:border-slate-800 min-w-0">
        {mode === 'questions' && (
          <div className="text-2xs text-slate-400 dark:text-slate-500 pb-1 px-0.5">
            Спросите про Flux или данные проекта · Guide не придумывает ответов: только проверенные статьи и данные выбранного проекта
          </div>
        )}
        <div className="flex items-end gap-2 min-w-0">
          <div className="flex-1 min-w-0 relative">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(mode, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={mode === 'handbook' ? 'Поиск по статьям справочника…' : 'Спросите про Flux или данные проекта…'}
              aria-label={mode === 'handbook' ? 'Поиск по справочнику' : 'Строка вопроса Flux Guide'}
              className="w-full pl-9 pr-8 py-2 text-sm rounded-xl bg-slate-100 dark:bg-slate-850
                         border border-transparent focus:border-emerald-600 focus:bg-white dark:focus:bg-slate-900
                         outline-none text-slate-900 dark:text-white placeholder:text-slate-400"
            />
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
            {draft && (
              <button type="button" onClick={() => setDraft(mode, '')} title="Очистить"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Кнопка режима: только иконка текущего режима, меню открывается вверх */}
          <div ref={modeRef} className="relative shrink-0">
            <button type="button" onClick={() => setModeMenu((v) => !v)}
              title={mode === 'handbook' ? 'Режим: Справочник — переключить' : 'Режим: Вопросы — переключить'}
              aria-expanded={modeMenu}
              className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-850 hover:bg-slate-200 dark:hover:bg-slate-800
                         text-slate-600 dark:text-slate-300 cursor-pointer">
              {mode === 'handbook' ? <BookOpen className="w-4 h-4" /> : <HelpCircle className="w-4 h-4" />}
            </button>
            {modeMenu && (
              <div className="absolute bottom-full right-0 mb-1.5 z-30 w-52 rounded-xl border border-slate-200 dark:border-slate-700
                              bg-white dark:bg-slate-900 shadow-sm p-1">
                <button type="button" onClick={() => switchMode('handbook')}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer flex items-center gap-2 ${
                    mode === 'handbook' ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300' : 'hover:bg-slate-100 dark:hover:bg-slate-850 text-slate-700 dark:text-slate-300'
                  }`}>
                  <BookOpen className="w-3.5 h-3.5" /> Справочник · поиск по статьям
                </button>
                <button type="button" onClick={() => switchMode('questions')}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer flex items-center gap-2 ${
                    mode === 'questions' ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300' : 'hover:bg-slate-100 dark:hover:bg-slate-850 text-slate-700 dark:text-slate-300'
                  }`}>
                  <HelpCircle className="w-3.5 h-3.5" /> Вопросы · спросить своими словами
                </button>
              </div>
            )}
          </div>

          <button type="button" onClick={submit}
            disabled={!draft.trim() || (mode === 'questions' && asking)}
            className="shrink-0 px-3.5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white cursor-pointer transition-colors"
            title={mode === 'handbook' ? 'Открыть найденную статью (Enter)' : 'Отправить вопрос (Enter)'}>
            {mode === 'handbook' ? <Search className="w-4 h-4" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
        <div className="text-xs text-slate-400 dark:text-slate-500 mt-1.5 px-0.5 hidden @[560px]:block">
          Enter — {mode === 'handbook' ? 'открыть статью' : 'отправить вопрос'} · режим меняется кнопкой справа
        </div>
        {mode === 'questions' && messages.some((m) => m.role === 'user') && chatSaveState !== 'idle' && (
          <div className={`mt-1 text-xs ${chatSaveState === 'error' ? 'text-rose-700 dark:text-rose-300' : 'text-slate-400 dark:text-slate-500'}`} role={chatSaveState === 'error' ? 'alert' : 'status'}>
            {chatSaveState === 'saving' ? 'Сохраняю историю…' : chatSaveState === 'saved' ? 'История сохранена' : `История не сохранена: ${chatSaveError}`}
            {chatSaveState === 'error' && <button type="button" onClick={() => void saveChat()} className="ml-2 underline cursor-pointer">Повторить</button>}
          </div>
        )}
      </div>
    </div>
  );
}
