/**
 * Список разговоров с помощником — слева в его окне.
 *
 * Разговоры разложены по дням, а не сплошным списком: человек помнит «на
 * прошлой неделе спрашивал», а не имя разговора. По той же причине под именем
 * стоит начало ответа: два вопроса «покажи дубли», заданные в разные дни,
 * иначе неразличимы.
 *
 * Строка «Разговоры видите только вы» стоит на виду не для красоты. Пока о
 * личном не сказано прямо, спрашивают с оглядкой — а помощник, которому не
 * задают вопросов, бесполезен.
 */
import React from 'react';
import { Plus, Search, Trash2, Lock } from 'lucide-react';
import { useAssistantChatsStore } from '../../store/assistantChatsStore';
import { groupByDay } from '../../lib/assistantChats';

export default function ChatHistory({ onPick }: { onPick?: () => void }) {
  const chats = useAssistantChatsStore((s) => s.chats);
  const activeId = useAssistantChatsStore((s) => s.activeId);
  const q = useAssistantChatsStore((s) => s.q);
  // Находки сервера выбираем отдельно: без этого список не перерисуется, когда
  // придёт ответ поиска по всем репликам
  const found = useAssistantChatsStore((s) => s.found);
  const error = useAssistantChatsStore((s) => s.error);
  const setQuery = useAssistantChatsStore((s) => s.setQuery);
  const open = useAssistantChatsStore((s) => s.open);
  const startNew = useAssistantChatsStore((s) => s.startNew);
  const remove = useAssistantChatsStore((s) => s.remove);
  const visible = useAssistantChatsStore((s) => s.visible);

  const groups = React.useMemo(() => groupByDay(visible()), [chats, found, q, visible]);

  return (
    <div className="h-full min-h-0 flex flex-col bg-slate-50/70 dark:bg-slate-950/50
                    border-r border-slate-200 dark:border-slate-800">
      <div className="shrink-0 p-2 space-y-2">
        <button
          type="button"
          onClick={() => { void startNew(); onPick?.(); }}
          title="Новый разговор (Ctrl+N). Прежний остаётся в списке"
          className="w-full flex items-center justify-center gap-1.5 h-8 rounded-lg text-2xs font-bold
                     bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" /> Новый разговор
        </button>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Найти в разговорах"
            aria-label="Поиск по разговорам"
            className="w-full h-7 pl-7 pr-2 rounded-lg text-2xs bg-white dark:bg-slate-900
                       border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-150
                       placeholder:text-slate-400 focus:outline-none focus:border-emerald-500"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {error && (
          <p className="px-1 py-2 text-2xs text-amber-600 dark:text-amber-400">{error}</p>
        )}
        {!groups.length && !error && (
          <p className="px-1 py-3 text-2xs text-slate-400 dark:text-slate-500 leading-snug">
            {q ? 'Ничего не нашлось. Ищется по всем репликам, не только по названию.'
              : 'Разговоров пока нет. Спросите что-нибудь — и он появится здесь.'}
          </p>
        )}
        {groups.map((g) => (
          <div key={g.label} className="mb-2">
            <p className="px-1 py-1 text-2xs font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              {g.label}
            </p>
            {g.chats.map((c) => (
              <div
                key={c.id}
                className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 cursor-pointer
                            ${c.id === activeId
                    ? 'bg-emerald-50 dark:bg-emerald-950/40 ring-1 ring-emerald-500/40'
                    : 'hover:bg-slate-200/60 dark:hover:bg-slate-850'}`}
                onClick={() => { void open(c.id); onPick?.(); }}
              >
                <span className="flex-1 min-w-0">
                  <span className={`block text-2xs font-semibold truncate ${c.id === activeId
                    ? 'text-emerald-800 dark:text-emerald-200' : 'text-slate-700 dark:text-slate-150'}`}>
                    {c.title || 'Разговор'}
                  </span>
                  {c.preview && (
                    <span className="block text-2xs text-slate-400 dark:text-slate-500 truncate">{c.preview}</span>
                  )}
                </span>
                <button
                  type="button"
                  title="Удалить разговор"
                  onClick={(e) => { e.stopPropagation(); void remove(c.id); }}
                  className="shrink-0 p-1 rounded-md text-slate-400 opacity-0 group-hover:opacity-100
                             hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>

      <p className="shrink-0 flex items-start gap-1 px-3 py-2 border-t border-slate-200 dark:border-slate-800
                    text-2xs leading-snug text-slate-500 dark:text-slate-400">
        <Lock className="w-3 h-3 mt-px shrink-0" />
        Разговоры видите только вы — администратор тоже нет.
      </p>
    </div>
  );
}
