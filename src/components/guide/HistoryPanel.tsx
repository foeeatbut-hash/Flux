import { useEffect, useState } from 'react';
import { Archive, RotateCcw, Search } from 'lucide-react';
import { useGuideStore } from '../../guide/store';

// ── История вопросов (серверное хранение, ТЗ v3 §4) ──

export function HistoryPanel({ onClose }: { onClose: () => void }) {
  const chats = useGuideStore((s) => s.chats);
  const archivedChats = useGuideStore((s) => s.archivedChats);
  const historyArchived = useGuideStore((s) => s.historyArchived);
  const historyError = useGuideStore((s) => s.historyError);
  const loadChats = useGuideStore((s) => s.loadChats);
  const openChat = useGuideStore((s) => s.openChat);
  const archiveChat = useGuideStore((s) => s.archiveChat);
  const restoreChat = useGuideStore((s) => s.restoreChat);
  const setHistoryArchived = useGuideStore((s) => s.setHistoryArchived);
  const [q, setQ] = useState('');

  useEffect(() => { void loadChats(historyArchived); }, [historyArchived, loadChats]);

  const rows = historyArchived ? archivedChats : chats;
  const filtered = rows.filter((c) => !q || `${c.title} ${c.preview}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="absolute left-0 top-full mt-1.5 z-30 w-[340px] max-w-[92vw] rounded-xl border border-slate-200 dark:border-slate-700
                    bg-white dark:bg-slate-900 shadow-sm p-2 flex flex-col gap-1.5">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
        <input autoFocus type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по вопросам"
          className="w-full pl-8 pr-2 py-1.5 text-sm rounded-lg bg-slate-100 dark:bg-slate-850 outline-none
                     focus:border-emerald-600 border border-transparent text-slate-900 dark:text-white" />
      </div>
      <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800 px-1">
        {(['active', 'archived'] as const).map((tab) => {
          const selected = (tab === 'archived') === historyArchived;
          return <button key={tab} type="button" onClick={() => setHistoryArchived(tab === 'archived')}
            aria-pressed={selected}
            className={`px-2.5 py-1.5 text-xs cursor-pointer border-b-2 ${selected ? 'border-emerald-600 text-slate-900 dark:text-white font-medium' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}>
            {tab === 'active' ? 'История' : 'Архив'}
          </button>;
        })}
      </div>
      {historyError && <div role="alert" className="px-2 py-1 text-xs text-rose-700 dark:text-rose-300">{historyError}</div>}
      <div className="max-h-72 overflow-y-auto scrollbar-thin flex flex-col gap-0.5">
        {filtered.length === 0 && <div className="text-xs text-slate-400 px-2 py-2">{historyArchived ? 'В архиве пока пусто.' : 'Сохранённых вопросов пока нет — история появляется после первого вопроса.'}</div>}
        {filtered.map((c) => (
          <div key={c.id} className="group flex items-center gap-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-850 min-w-0">
            <button type="button" disabled={historyArchived} onClick={() => { void openChat(c.id); onClose(); }}
              className="flex-1 min-w-0 text-left px-2.5 py-1.5 cursor-pointer">
              <span className="block text-xs font-semibold text-slate-800 dark:text-dark-text-main truncate">{c.title}</span>
              <span className="block text-2xs text-slate-400 truncate">{c.preview || ' '}</span>
              <span className="block text-2xs text-slate-400">{new Date(c.updatedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            </button>
            <button type="button" title={historyArchived ? 'Восстановить разговор' : 'В архив'}
              onClick={() => { void (historyArchived ? restoreChat(c.id) : archiveChat(c.id)); }}
              className="p-1.5 mr-1 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer">
              {historyArchived ? <RotateCcw className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

