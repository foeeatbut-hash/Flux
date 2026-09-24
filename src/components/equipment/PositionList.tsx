import React from 'react';
import { Search, Tag as TagIcon, X } from 'lucide-react';
import { classById, classTitle, type Classified } from '../../../equipment/classes';
import {
  positionRows, filterRows, classCounts, groupRows, ORIGIN_TITLE,
  type GroupBy, type ListSystem,
} from '../../lib/positionList';

/**
 * Все позиции категории одной таблицей: тег, тип, вид, наименование,
 * родитель, установка, откуда.
 *
 * Дерево показывает состав — что внутри чего. Список отвечает на другой
 * вопрос: «покажи все приводы с их тегами». Отбор по типу — чипами со
 * счётчиками, «с тегом / без» — одним переключателем, поиск — по всем
 * столбцам сразу. Строка открывает карточку позиции.
 *
 * Выбор отбора и группировки помнится у человека (localStorage): это привычка
 * смотреть, а не свойство проекта.
 */

interface Props {
  systems: ListSystem[];
  types: Map<string, Classified>;
  onOpen: (componentId: string) => void;
  onClose: () => void;
}

const PREF = 'flux_position_list';
const readPref = (): { by: GroupBy; tagged: 'all' | 'with' | 'without' } => {
  try {
    const v = JSON.parse(localStorage.getItem(PREF) || '{}');
    return {
      by: v.by === 'unit' || v.by === 'none' ? v.by : 'class',
      tagged: v.tagged === 'with' || v.tagged === 'without' ? v.tagged : 'all',
    };
  } catch (_) { return { by: 'class', tagged: 'all' }; }
};

export default function PositionList({ systems, types, onOpen, onClose }: Props) {
  const [pref, setPref] = React.useState(readPref);
  const [classes, setClasses] = React.useState<string[]>([]);
  const [q, setQ] = React.useState('');

  React.useEffect(() => {
    try { localStorage.setItem(PREF, JSON.stringify(pref)); } catch (_) { /* приватный режим */ }
  }, [pref]);

  const rows = React.useMemo(() => positionRows(systems, types), [systems, types]);
  const counts = React.useMemo(() => classCounts(rows), [rows]);
  const shown = React.useMemo(
    () => filterRows(rows, { classes, tagged: pref.tagged, q }),
    [rows, classes, pref.tagged, q],
  );
  const groups = React.useMemo(() => groupRows(shown, pref.by), [shown, pref.by]);
  const tagged = rows.filter((r) => r.tag).length;

  const toggleClass = (cls: string) =>
    setClasses((cur) => (cur.includes(cls) ? cur.filter((c) => c !== cls) : [...cur, cls]));

  const seg = (on: boolean) => `px-2 py-1 text-2xs font-semibold rounded-md cursor-pointer ${on
    ? 'bg-emerald-600 text-white' : 'text-slate-500 hover:text-emerald-600'}`;

  return (
    <div className="h-full flex flex-col @container" data-position-list>
      <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <b className="text-sm font-semibold">Позиции списком</b>
          <span className="text-2xs text-slate-400 tabular-nums">{rows.length} строк · с тегом {tagged}</span>
          <span className="flex-1" />
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800" role="group" aria-label="Группировать">
            <button type="button" className={seg(pref.by === 'class')} onClick={() => setPref({ ...pref, by: 'class' })}>по типу</button>
            <button type="button" className={seg(pref.by === 'unit')} onClick={() => setPref({ ...pref, by: 'unit' })}>по установке</button>
            <button type="button" className={seg(pref.by === 'none')} onClick={() => setPref({ ...pref, by: 'none' })}>без групп</button>
          </div>
          <button type="button" onClick={onClose} aria-label="Закрыть список" title="Вернуться к карточке"
            className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 flex-1 min-w-[160px]">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Тег, название, установка…"
              className="flex-1 min-w-0 bg-transparent text-xs outline-none" />
          </label>
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800" role="group" aria-label="Тег">
            <button type="button" className={seg(pref.tagged === 'all')} onClick={() => setPref({ ...pref, tagged: 'all' })}>все</button>
            <button type="button" className={seg(pref.tagged === 'with')} onClick={() => setPref({ ...pref, tagged: 'with' })}>с тегом</button>
            <button type="button" className={seg(pref.tagged === 'without')} onClick={() => setPref({ ...pref, tagged: 'without' })}>без тега</button>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {counts.map((c) => {
            const on = classes.includes(c.cls);
            return (
              <button key={c.cls} type="button" onClick={() => toggleClass(c.cls)} aria-pressed={on}
                title={`${classById(c.cls).plural}: ${c.count}, с тегом ${c.tagged}`}
                className={`px-2 py-0.5 rounded-full text-2xs font-semibold border cursor-pointer ${on
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-emerald-400'}`}>
                {classById(c.cls).plural} <span className="opacity-70 tabular-nums">{c.count}</span>
              </button>
            );
          })}
          {classes.length > 0 && (
            <button type="button" onClick={() => setClasses([])} className="text-2xs text-slate-400 hover:text-emerald-600 cursor-pointer">все типы</button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {shown.length === 0 ? (
          <div className="blank">
            <div className="blank-title">Ничего не подходит</div>
            <div className="blank-text">Снимите часть отбора или очистите поиск.</div>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white dark:bg-slate-900 z-10">
              <tr className="text-left text-2xs text-slate-400">
                <th className="px-3 py-1.5">Тег</th>
                <th className="px-2 py-1.5">Тип</th>
                <th className="px-2 py-1.5 hidden @[640px]:table-cell">Вид</th>
                <th className="px-2 py-1.5">Наименование</th>
                <th className="px-2 py-1.5 hidden @[860px]:table-cell">Тег родителя</th>
                <th className="px-2 py-1.5 hidden @[860px]:table-cell">Установка</th>
                <th className="px-2 py-1.5 hidden @[860px]:table-cell">Откуда</th>
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.key || 'all'}>
                {g.title && (
                  <tr><td colSpan={7} className="px-3 pt-3 pb-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                    {g.title} <span className="text-slate-400 font-semibold tabular-nums">· {g.rows.length}</span>
                  </td></tr>
                )}
                {g.rows.map((r) => (
                  <tr key={`${r.id}:${r.tag}`} onClick={() => onOpen(r.id)}
                    className="border-t border-slate-100 dark:border-slate-850 hover:bg-emerald-50/60 dark:hover:bg-emerald-950/20 cursor-pointer">
                    <td className="px-3 py-1.5 align-top font-mono whitespace-nowrap">
                      {r.tag
                        ? <span className="inline-flex items-center gap-1 u-sel"><TagIcon className="w-3 h-3 text-emerald-500" />{r.tag}</span>
                        : <span className="text-slate-300 dark:text-slate-500">без тега</span>}
                    </td>
                    <td className="px-2 py-1.5 align-top">
                      <div className="whitespace-nowrap">{classTitle(r.cls)}</div>
                      {/* На узкой панели вид — под типом, а не отдельным столбцом */}
                      {r.kind && <div className="@[640px]:hidden text-2xs text-slate-400 break-words min-w-[5rem]">{r.kind}</div>}
                    </td>
                    <td className="px-2 py-1.5 align-top text-slate-500 dark:text-slate-400 hidden @[640px]:table-cell min-w-[6rem]">{r.kind}</td>
                    <td className="px-2 py-1.5 align-top min-w-[8rem]">
                      <div className="break-words line-clamp-2" title={r.label}>{r.label}</div>
                      {/* Узко: родитель, установка и «откуда» — строкой под наименованием,
                          иначе столбцы уводили наименование за край панели */}
                      <div className="@[860px]:hidden text-2xs text-slate-400 break-words">
                        {[
                          r.parentTag && r.parentTag !== r.tag ? `в ${r.parentTag}` : '',
                          r.unitName && r.unitName !== r.label && r.unitName !== r.parentTag ? r.unitName : '',
                          r.origin !== 'calc' ? ORIGIN_TITLE[r.origin] : '',
                        ].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 align-top font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap hidden @[860px]:table-cell">{r.parentTag}</td>
                    <td className="px-2 py-1.5 align-top hidden @[860px]:table-cell"><div className="max-w-[180px] break-words line-clamp-2" title={r.unitName}>{r.unitName}</div></td>
                    <td className={`px-2 py-1.5 align-top whitespace-nowrap hidden @[860px]:table-cell ${r.origin === 'calc' ? 'text-slate-400' : 'text-amber-600 dark:text-amber-400'}`}>
                      {ORIGIN_TITLE[r.origin]}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        )}
      </div>
    </div>
  );
}
