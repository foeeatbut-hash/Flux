import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { useGuideStore } from '../../guide/store';
import { AnswerView } from './AnswerView';

// ── Режим «Вопросы» ──

export function QuestionsPane() {
  const messages = useGuideStore((s) => s.messages);
  const asking = useGuideStore((s) => s.asking);
  const setDraft = useGuideStore((s) => s.setDraft);
  const projectId = useGuideStore((s) => s.projectId);
  const projectName = useGuideStore((s) => s.projectName);
  const projects = useGuideStore((s) => s.projects);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, asking]);

  const starters = [
    { label: 'Сколько приточных установок в проекте?', query: 'сколько приточных установок' },
    { label: 'Найди тег 3700-B08-DW-002B', query: 'найди тег 3700-B08-DW-002B' },
    { label: 'Покажи позиции без тегов', query: 'покажи оборудование без тега' },
    { label: 'Какая ревизия у позиции?', query: 'какая ревизия у 3700-B08-DW-002B' },
    { label: 'Найди документы по тегу', query: 'есть ли файлы у тега 3700-B08-DW-002B' },
    { label: 'Как выгрузить характеристики в Excel?', query: 'как выгрузить характеристики в excel' },
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-thin flex flex-col gap-2.5 px-3 pb-2">
        {messages.length === 0 && (
          <div className="flex flex-col gap-2.5 pt-2">
            <div className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed max-w-[60ch]">
              {projectId
                ? <>Проект: <b>{projectName}</b>. Спросите про Flux или его данные — ответ соберётся из проверенных статей и адресных запросов к базе, без нейросети и без догадок.</>
                : <>Выберите проект в шапке и спросите про Flux или данные проекта. Ответ — из проверенных статей и адресных запросов к базе: без нейросети и без догадок. Если точного ответа нет, Guide так и скажет.</>}
            </div>
            <span className="text-2xs font-semibold text-slate-400 dark:text-slate-500">Что можно спросить</span>
            <div className="flex flex-col gap-1.5">
              {starters.map((s) => (
                <button key={s.label} type="button" onClick={() => setDraft('questions', s.query)}
                  className="text-left px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-800 hover:border-slate-400 dark:hover:border-slate-600 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          m.role === 'user' ? (
            <div key={m.id} className="self-end max-w-[85%] px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm break-words">{m.text}</div>
          ) : (
            <div key={m.id} className="max-w-full min-w-0"><AnswerView msg={m} /></div>
          )
        ))}
        {asking && (
          <div className="flex items-center gap-2 text-xs text-slate-400 px-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Проверяю справочник и данные проекта…
          </div>
        )}
      </div>
    </div>
  );
}

