import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { History, Copy, ArrowRight, Link2 } from 'lucide-react';
import { useStore } from '../../store/store';
import { useInsightStore } from '../../store/insightStore';
import { useToastStore } from '../../store/toastStore';
import { fetchChanges, shortDate, EMPTY_CHANGES, type ChangeList } from '../../lib/insight';
import { copyAsTable } from '../../lib/copyTable';
import { KindIcon, Empty, Skeleton } from './parts';

/**
 * Лист изменений: что поменялось в оборудовании за период.
 *
 * Показываем «было → стало» по каждой характеристике, а не «элемент изменён»:
 * такой лист инженеры и так собирают руками в Ворде перед выпуском ревизии, и
 * именно пары значений в нём главное.
 *
 * Записи без единого изменённого значения сюда не доходят — их отсекает сервер:
 * в истории остаются сохранения, где поменялось что-то служебное, и в листе они
 * выглядели бы пустыми строками.
 */

const PERIODS: { days: number; label: string }[] = [
  { days: 1, label: 'Сутки' },
  { days: 7, label: 'Неделя' },
  { days: 14, label: '2 недели' },
  { days: 30, label: 'Месяц' },
  { days: 90, label: '3 месяца' },
];

export default function ChangeListView() {
  const { activeProject } = useStore();
  const { openWhere, close } = useInsightStore();
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const [days, setDays] = useState(14);
  const [data, setData] = useState<ChangeList>(EMPTY_CHANGES);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchChanges(activeProject?.id, days).then(r => { if (alive) { setData(r); setLoading(false); } });
    return () => { alive = false; };
  }, [activeProject?.id, days]);

  const copyAll = () => {
    const rows = data.entries.flatMap(e => e.changes.length
      ? e.changes.map(c => ({
        Дата: shortDate(e.at), Элемент: e.itemCode, Где: e.where,
        Группа: c.group, Характеристика: c.key,
        Было: c.kind === 'added' ? '—' : c.was,
        Стало: c.kind === 'removed' ? '—' : c.now,
      }))
      : [{ Дата: shortDate(e.at), Элемент: e.itemCode, Где: e.where, Группа: '', Характеристика: e.changeType, Было: '', Стало: '' }]);
    if (!rows.length) { addToast('Копировать нечего — изменений нет', 'info'); return; }
    copyAsTable(rows).then(ok => addToast(
      ok ? `Скопировано строк: ${rows.length} — вставьте в лист изменений` : 'Не удалось скопировать',
      ok ? 'success' : 'error',
    ));
  };

  return (
    <div className="pb-4">
      {/* Период */}
      <div className="flex items-center gap-1 px-3 py-2.5 flex-wrap">
        {PERIODS.map(p => (
          <button
            key={p.days}
            type="button"
            onClick={() => setDays(p.days)}
            className={`px-2 py-1 rounded-lg text-2xs font-semibold cursor-pointer transition-colors ${
              days === p.days
                ? 'bg-emerald-600 text-white'
                : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            {p.label}
          </button>
        ))}
        <div className="flex-1" />
        <button type="button" onClick={copyAll} title="Скопировать лист изменений"
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
          <Copy className="w-3.5 h-3.5" />
        </button>
      </div>

      {loading ? <Skeleton rows={6} /> : data.entries.length === 0 ? (
        <Empty
          icon={<History className="w-5 h-5" />}
          title="Изменений нет"
          hint="За выбранный период характеристики оборудования никто не менял. Возьмите период побольше — или это и есть хорошая новость."
        />
      ) : (
        <div className="px-2 space-y-2">
          {data.entries.map(e => (
            <article key={e.id} className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
              <header className="flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-850">
                <KindIcon kind="element" />
                <button
                  type="button"
                  onClick={() => { if (e.route) { navigate(e.route); close(); } }}
                  className="fx-btn fx-btn-quiet"
                >
                  {e.itemCode}
                </button>
                <span className="text-2xs text-slate-400 truncate">{e.where}</span>
                <div className="flex-1" />
                <span className="text-2xs text-slate-400 tabular-nums shrink-0">{shortDate(e.at)}</span>
                {e.elementId && (
                  <button
                    type="button"
                    title="Связи этого элемента"
                    onClick={() => openWhere('element', e.elementId, true)}
                    className="shrink-0 p-1 rounded-lg text-slate-300 dark:text-slate-455
                               hover:text-emerald-600 dark:hover:text-emerald-400
                               hover:bg-emerald-50 dark:hover:bg-emerald-950/30 cursor-pointer"
                  >
                    <Link2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </header>

              {e.changes.length === 0 ? (
                <p className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">Элемент {e.changeType}</p>
              ) : (
                <table className="w-full text-xs">
                  <tbody>
                    {e.changes.map((c, i) => (
                      <tr key={i} className="border-t border-slate-100 dark:border-slate-850">
                        <td className="px-3 py-1.5 align-top text-slate-500 dark:text-slate-400 w-2/5">
                          <span className="block truncate">{c.key}</span>
                          {c.group && <span className="block text-2xs text-slate-400 dark:text-slate-500 truncate">{c.group}</span>}
                        </td>
                        <td className="px-1 py-1.5 align-top text-right text-slate-500 dark:text-slate-400 tabular-nums">
                          {c.kind === 'added' ? <span className="text-slate-300 dark:text-slate-455">—</span> : <span className="line-through">{c.was || '—'}</span>}
                        </td>
                        <td className="px-1 py-1.5 align-top w-5 text-slate-300 dark:text-slate-455">
                          <ArrowRight className="w-3 h-3" />
                        </td>
                        <td className="px-3 py-1.5 align-top font-semibold text-sky-700 dark:text-sky-400 tabular-nums">
                          {c.kind === 'removed' ? <span className="text-slate-300 dark:text-slate-455">удалено</span> : (c.now || '—')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
