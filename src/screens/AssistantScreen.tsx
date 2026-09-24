/**
 * Помощник окном.
 *
 * Помощник перестал быть панелью-приложением сбоку и стал программой: у него
 * есть окно, кнопка на панели задач, место на столе и доля экрана. Это не
 * украшение — так его можно поставить рядом с ведомостью и разговаривать про
 * неё, не закрывая её собой. В панели шириной 380 таблица ответа помещалась
 * тремя колонками из семи.
 *
 * Разговор тот же самый, что в панели (components/assistant/Chat): одно окно,
 * одна беседа. Два окна показывали бы одно и то же с двух сторон.
 *
 * Слева — история разговоров. Она есть только здесь: в панели «спросить на
 * секунду» списку прошлых бесед делать нечего, а окно как раз для того, чтобы
 * разобраться, — и разбираются чаще всего, вернувшись к тому, о чём уже
 * спрашивали.
 */
import React from 'react';
import { MessageCircleQuestion, Trash2, PanelLeft } from 'lucide-react';
import Chat from '../components/assistant/Chat';
import ChatHistory from '../components/assistant/ChatHistory';
import { useAssistantStore } from '../store/assistantStore';
import { useAssistantChatsStore } from '../store/assistantChatsStore';
import { useStore } from '../store/store';
import { useWindowTitle } from '../lib/paneTitle';

export default function AssistantScreen() {
  const messages = useAssistantStore((s) => s.messages);
  const clear = useAssistantStore((s) => s.clearTalk);
  const activeProject = useStore((s) => s.activeProject);
  const loadChats = useAssistantChatsStore((s) => s.load);
  const startNew = useAssistantChatsStore((s) => s.startNew);
  const [listOpen, setListOpen] = React.useState(true);

  // Разговоры привязаны к проекту: вернувшись к нему через неделю, человек
  // находит, о чём спрашивал именно здесь, а не пятьсот бесед по всем проектам
  React.useEffect(() => { void loadChats(activeProject?.id || ''); }, [activeProject?.id, loadChats]);

  // Ctrl+N — новый разговор, как в любой переписке. Прежний не пропадает:
  // сохранение уходит до того, как экран очистится
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'т')) {
        e.preventDefault();
        void startNew();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [startNew]);

  // Заголовок окна — о чём говорим: последний вопрос человека. Окно «Помощник»
  // среди пяти других окон не отвечает на вопрос «какое из них про что»
  const lastAsked = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].text;
    return '';
  }, [messages]);
  useWindowTitle(lastAsked ? `Помощник · ${lastAsked.slice(0, 40)}` : 'Помощник');

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-3 h-10 border-b border-slate-200 dark:border-slate-800">
        <button type="button" onClick={() => setListOpen((v) => !v)}
          title={listOpen ? 'Скрыть историю разговоров' : 'Показать историю разговоров'}
          className={`shrink-0 p-1 rounded-md cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-850
                      ${listOpen ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-400'}`}>
          <PanelLeft className="w-4 h-4" />
        </button>
        <MessageCircleQuestion className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" />
        <span className="text-xs font-medium text-slate-800 dark:text-slate-150">Помощник</span>
        <span className="text-2xs text-slate-400 dark:text-slate-500 truncate hidden @[560px]:inline">
          работает без сети: отвечает по данным этого проекта и по руководству
        </span>
        <span className="flex-1" />
        <button type="button" onClick={clear} title="Очистить то, что на экране. Разговор останется в истории слева"
          className="flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-semibold text-slate-500
                     hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer">
          <Trash2 className="w-3 h-3" /> Заново
        </button>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* История прячется на узкой панели: в 372 пикселя список и разговор
            рядом не встают, а разговор здесь важнее */}
        {listOpen && (
          <div className="shrink-0 w-56 hidden @[620px]:block">
            <ChatHistory />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <Chat />
        </div>
      </div>
    </div>
  );
}
