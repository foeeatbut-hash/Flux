/**
 * Память переводов списком.
 *
 * Смотреть сюда каждый день незачем — память работает сама. Список нужен для
 * двух случаев: найти, откуда взялся спорный перевод, и убрать ошибочную пару,
 * которая теперь тиражируется в каждый новый документ.
 *
 * Править строку прямо здесь нельзя намеренно: перевод правится там, где он
 * виден в работе — в сверке документа или в письме, — и оттуда же ложится
 * обратно. Правка в отрыве от текста и есть то, из-за чего в чужих памятях
 * заводятся строки, которых никто не может объяснить.
 */
import React from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslateStore } from '../../store/translateStore';
import { normKey } from '../../translate/segment';

const ORIGIN: Record<string, string> = {
  hand: 'вручную', doc: 'из документа', mail: 'из письма', vdr: 'из ВДР', pack: 'из файла',
};

export default function MemoryTable() {
  const memory = useTranslateStore((s) => s.memory);
  const removeMemory = useTranslateStore((s) => s.removeMemory);
  const [q, setQ] = React.useState('');

  const shown = React.useMemo(() => {
    const key = normKey(q);
    const list = key ? memory.filter((m) => normKey(m.src).includes(key) || normKey(m.dst).includes(key)) : memory;
    return list.slice(0, 500);
  }, [memory, q]);

  const cell = 'px-2 py-1.5 text-xs text-slate-700 dark:text-slate-300 align-top';

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти в памяти"
          className="max-w-64 w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800
                     rounded-md px-2 py-1 text-xs text-slate-800 dark:text-slate-150 outline-none focus:border-emerald-400" />
        <span className="text-2xs text-slate-400 dark:text-slate-500">
          {memory.length ? `строк: ${memory.length}` : 'память пуста — она наполняется по мере работы'}
        </span>
        {shown.length === 500 && (
          <span className="text-2xs text-amber-600 dark:text-amber-400">показаны первые 500</span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto scrollbar-thin">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900 z-10">
            <tr className="text-2xs uppercase tracking-wide text-slate-400 dark:text-slate-500">
              <th className="px-2 py-1.5 text-left font-semibold">Исходник</th>
              <th className="px-2 py-1.5 text-left font-semibold">Перевод</th>
              <th className="px-2 py-1.5 text-left font-semibold hidden @[560px]:table-cell">Откуда</th>
              <th className="px-2 py-1.5 w-10" />
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr key={m.id} className="border-b border-slate-100 dark:border-slate-850 hover:bg-slate-50 dark:hover:bg-slate-900/60">
                <td className={cell}>{m.src}</td>
                <td className={cell}>{m.dst}</td>
                <td className={`${cell} hidden @[560px]:table-cell text-slate-400 dark:text-slate-500`}>
                  {ORIGIN[m.origin] || m.origin} · {m.fromLang}→{m.toLang}
                </td>
                <td className={cell}>
                  <button type="button" onClick={() => removeMemory(m.id)} title="Убрать пару из памяти"
                    className="p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50
                               dark:hover:bg-rose-950/40 cursor-pointer">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && (
          <div className="p-6 text-center text-2xs text-slate-400 dark:text-slate-500">
            {memory.length
              ? 'Ничего не нашлось.'
              : 'Каждая подтверждённая строка ложится сюда и переводит следующий документ сама.'}
          </div>
        )}
      </div>
    </div>
  );
}
