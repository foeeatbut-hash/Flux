/**
 * Кого позвать в группу.
 *
 * Список — обычные сотрудники программы, и это единственное место, где
 * платформа их показывает. Ничего про их доступ к играм здесь не сказано и
 * сказано быть не может: пометка «не играет» рассказала бы про чужие права
 * ровно то, что от человека скрыто. Сервер сам откажет, если звать некого, и
 * откажет словами.
 *
 * Ищем по имени и по табельному: в отделе бывают однофамильцы, и по одному
 * имени выбрать нельзя.
 */
import React from 'react';
import { Search, UserPlus, X } from 'lucide-react';
import { Empty } from './states';

export interface Candidate {
  id: string;
  name: string;
  symbol: string;
}

export default function InvitePicker({ people, busy, onPick, onClose }: {
  people: Candidate[];
  busy: boolean;
  onPick: (userId: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  const found = React.useMemo(() => {
    const text = q.trim().toLowerCase();
    if (!text) return people.slice(0, 40);
    return people
      .filter((p) => p.name.toLowerCase().includes(text) || p.symbol.toLowerCase().includes(text))
      .slice(0, 40);
  }, [people, q]);

  return (
    <section className="flex-1 min-h-0 flex flex-col">
      <header className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800">
        <Search className="w-4 h-4 shrink-0 text-slate-400 dark:text-slate-500" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Имя или табельный"
          className="flex-1 min-w-0 bg-transparent text-sm text-slate-800 dark:text-white
                     placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={onClose}
          title="Закрыть"
          className="shrink-0 p-1 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-850
                     cursor-pointer transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-2 space-y-1">
        {!found.length && (
          <Empty
            icon={<Search className="w-5 h-5" />}
            title="Никого не нашлось"
            hint="Поищите по фамилии или по табельному номеру."
          />
        )}
        {found.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={busy}
            onClick={() => onPick(p.id)}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-left
                       hover:bg-slate-50 dark:hover:bg-slate-850 disabled:opacity-50
                       cursor-pointer transition-colors"
          >
            <UserPlus className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold text-slate-800 dark:text-slate-150 truncate">{p.name}</span>
              <span className="block text-2xs text-slate-400 dark:text-slate-500 truncate">{p.symbol}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
