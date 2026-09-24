import React from 'react';
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, RotateCcw, Search, X } from 'lucide-react';
import { classById, classOrder } from '../../../equipment/classes';
import {
  arrange, catalogOf, hideEmpty, isHiddenIn, moveTo, orderOf, resetClass, showAll, step, toggleIn, viewOf,
  groupToken, paramToken, type CategoryView, type ViewGroup,
} from '../../lib/categoryView';

/**
 * «Вид категории»: какие параметры показывать у каждого типа — сразу для всех
 * позиций категории, а не по одной карточке.
 *
 * Слева — типы, которые в категории есть, со счётчиками. Справа — ВСЕ
 * параметры выбранного типа по всем его позициям, с подписью «есть у 3 из 4»:
 * человек видит и то, чего нет в открытой карточке. Галочка — показывать,
 * перетаскивание или стрелки — порядок, поиск — по названию параметра.
 *
 * Правила (порядок, «скрыть пустые», перенос старых скрытий) — в
 * `lib/categoryView`, здесь только показ и черновик до «Сохранить».
 */

export interface ViewPosition { id: string; cls: string; groups: ViewGroup[] }

interface Props {
  categoryLabel: string;
  positions: ViewPosition[];
  view: CategoryView;
  /** Прежние скрытия типа по equipType — пока у типа нет своего вида */
  legacyOf: (cls: string) => string[];
  /** С какого типа открыть: тип открытой карточки */
  initialClass?: string;
  isAdmin: boolean;
  visMode: 'admin' | 'self';
  onSwitchMode: (mode: 'admin' | 'self') => void;
  onSave: (next: CategoryView) => void | Promise<void>;
  onClose: () => void;
}

type Drag = { kind: 'group'; id: string } | { kind: 'param'; group: string; id: string } | null;

export default function CategoryViewDialog(p: Props) {
  const classes = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const x of p.positions) m.set(x.cls, (m.get(x.cls) || 0) + 1);
    return [...m.entries()].sort((a, b) => classOrder(a[0]) - classOrder(b[0]));
  }, [p.positions]);
  const [cls, setCls] = React.useState<string>(
    p.initialClass && classes.some(([c]) => c === p.initialClass) ? p.initialClass : (classes[0]?.[0] || ''),
  );
  const [draft, setDraft] = React.useState<CategoryView>(p.view);
  const [q, setQ] = React.useState('');
  const [drag, setDrag] = React.useState<Drag>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') p.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p]);

  const legacy = p.legacyOf(cls);
  const cv = viewOf(draft, cls, legacy);
  const catalog = React.useMemo(() => catalogOf(p.positions.filter((x) => x.cls === cls)), [p.positions, cls]);
  const arranged = arrange(catalog.groups.map((g) => ({ title: g.title, params: g.params })), cv) as typeof catalog.groups;
  const needle = q.trim().toLowerCase();
  const shown = arranged
    .map((g) => ({ ...g, params: needle && !g.title.toLowerCase().includes(needle) ? g.params.filter((x) => x.key.toLowerCase().includes(needle)) : g.params }))
    .filter((g) => g.params.length || (needle && g.title.toLowerCase().includes(needle)));

  const toggle = (token: string) => setDraft((d) => toggleIn(d, cls, token, legacy));
  // Порядок пишется целиком: иначе перенос одного параметра перемешал бы соседей
  const reorder = (next: ViewGroup[]) => setDraft((d) => ({ ...d, [cls]: { ...viewOf(d, cls, legacy), ...orderOf(next) } }));
  const moveGroup = (from: string, to: string) => {
    const titles = moveTo(arranged.map((g) => g.title), from, to);
    reorder(titles.map((t) => arranged.find((g) => g.title === t)!));
  };
  const stepGroup = (title: string, dir: -1 | 1) => {
    const titles = step(arranged.map((g) => g.title), title, dir);
    reorder(titles.map((t) => arranged.find((g) => g.title === t)!));
  };
  const moveParam = (group: string, reorderKeys: (keys: string[]) => string[]) => {
    reorder(arranged.map((g) => (g.title !== group ? g : {
      ...g, params: reorderKeys(g.params.map((x) => x.key)).map((k) => g.params.find((x) => x.key === k)!),
    })));
  };

  const save = async () => {
    setBusy(true);
    try { await p.onSave(draft); p.onClose(); } finally { setBusy(false); }
  };

  const hiddenCount = cv.hidden.length;
  const btn = 'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-2xs font-semibold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-emerald-400 hover:text-emerald-600 cursor-pointer';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/55" onMouseDown={p.onClose}>
      <div role="dialog" aria-label="Вид категории" onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-4xl h-[min(640px,90vh)] flex flex-col rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
          <Eye className="w-4 h-4 text-emerald-600" />
          <b className="text-sm">Вид категории · {p.categoryLabel}</b>
          <span className="text-2xs text-slate-400">какие параметры показывать у каждого типа и в каком порядке</span>
          <span className="flex-1" />
          <button type="button" onClick={p.onClose} aria-label="Закрыть" className="p-1 text-slate-400 hover:text-slate-600 cursor-pointer"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 min-h-0 flex">
          <div className="w-52 shrink-0 border-r border-slate-100 dark:border-slate-800 overflow-y-auto p-2 space-y-0.5">
            {classes.length === 0 && <div className="text-2xs text-slate-400 p-2">В категории пока нет позиций.</div>}
            {classes.map(([c, n]) => (
              <button key={c} type="button" onClick={() => { setCls(c); setQ(''); }}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs cursor-pointer ${c === cls ? 'bg-emerald-600 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
                <span className="flex-1 truncate">{classById(c).plural}</span>
                <span className={`text-2xs tabular-nums ${c === cls ? 'text-white/80' : 'text-slate-400'}`}>{n}</span>
                {draft[c] && <span className={`w-1.5 h-1.5 rounded-full ${c === cls ? 'bg-white' : 'bg-emerald-500'}`} title="У типа свой вид" />}
              </button>
            ))}
          </div>

          <div className="flex-1 min-w-0 flex flex-col">
            <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center gap-1.5 flex-wrap">
              <label className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 flex-1 min-w-[160px]">
                <Search className="w-3.5 h-3.5 text-slate-400" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Параметр…" className="flex-1 min-w-0 bg-transparent text-xs outline-none" />
              </label>
              <button type="button" className={btn} onClick={() => setDraft((d) => showAll(d, cls, legacy))}><Eye className="w-3 h-3" />показать все</button>
              <button type="button" className={btn} onClick={() => setDraft((d) => hideEmpty(d, cls, catalog, legacy))}><EyeOff className="w-3 h-3" />скрыть пустые</button>
              <button type="button" className={btn} onClick={() => setDraft((d) => resetClass(d, cls))}><RotateCcw className="w-3 h-3" />сбросить</button>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {shown.length === 0 && <div className="text-xs text-slate-400 text-center py-6">{needle ? 'Ничего не найдено' : 'У позиций этого типа нет параметров.'}</div>}
              {shown.map((g) => {
                const gHidden = isHiddenIn(cv, groupToken(g.title));
                return (
                  <div key={g.title}
                    onDragOver={(e) => { if (drag?.kind === 'group') e.preventDefault(); }}
                    onDrop={() => { if (drag?.kind === 'group') moveGroup(drag.id, g.title); setDrag(null); }}
                    className={`rounded-xl border ${gHidden ? 'border-dashed border-slate-200 dark:border-slate-700 opacity-60' : 'border-slate-150 dark:border-slate-800'}`}>
                    <div draggable={!needle} onDragStart={() => setDrag({ kind: 'group', id: g.title })} onDragEnd={() => setDrag(null)}
                      className="flex items-center gap-1.5 px-2 py-1.5 bg-slate-50 dark:bg-slate-850/60 rounded-t-xl">
                      <GripVertical className="w-3.5 h-3.5 text-slate-300 cursor-grab shrink-0" aria-hidden />
                      <input type="checkbox" checked={!gHidden} onChange={() => toggle(groupToken(g.title))} aria-label={`Показывать раздел ${g.title}`} className="accent-emerald-600" />
                      <b className="text-2xs text-slate-500 dark:text-slate-400 flex-1 truncate">{g.title}</b>
                      <button type="button" onClick={() => stepGroup(g.title, -1)} aria-label="Раздел выше" className="p-0.5 text-slate-400 hover:text-emerald-600 cursor-pointer"><ArrowUp className="w-3 h-3" /></button>
                      <button type="button" onClick={() => stepGroup(g.title, 1)} aria-label="Раздел ниже" className="p-0.5 text-slate-400 hover:text-emerald-600 cursor-pointer"><ArrowDown className="w-3 h-3" /></button>
                    </div>
                    <div className="divide-y divide-slate-100 dark:divide-slate-850">
                      {g.params.map((x) => {
                        const token = paramToken(g.title, x.key);
                        const hidden = isHiddenIn(cv, token);
                        return (
                          <div key={x.key} draggable={!needle}
                            onDragStart={(e) => { e.stopPropagation(); setDrag({ kind: 'param', group: g.title, id: x.key }); }}
                            onDragEnd={() => setDrag(null)}
                            onDragOver={(e) => { if (drag?.kind === 'param' && drag.group === g.title) { e.preventDefault(); e.stopPropagation(); } }}
                            onDrop={(e) => {
                              if (drag?.kind !== 'param' || drag.group !== g.title) return;
                              e.stopPropagation();
                              const from = drag.id;
                              moveParam(g.title, (keys) => moveTo(keys, from, x.key));
                              setDrag(null);
                            }}
                            className={`flex items-center gap-1.5 px-2 py-1 text-xs ${hidden ? 'opacity-50' : ''}`}>
                            <GripVertical className="w-3 h-3 text-slate-300 cursor-grab shrink-0" aria-hidden />
                            <input type="checkbox" checked={!hidden} onChange={() => toggle(token)} aria-label={`Показывать ${x.key}`} className="accent-emerald-600" />
                            <span className="flex-1 min-w-0 truncate">{x.key}{x.unit ? <span className="text-slate-400">, {x.unit}</span> : null}</span>
                            <span className={`text-2xs tabular-nums shrink-0 ${x.filled ? 'text-slate-400' : 'text-amber-600 dark:text-amber-400'}`}
                              title="У скольких позиций типа параметр заполнен">
                              есть у {x.filled} из {catalog.total}
                            </span>
                            <button type="button" onClick={() => moveParam(g.title, (keys) => step(keys, x.key, -1))} aria-label="Выше" className="p-0.5 text-slate-400 hover:text-emerald-600 cursor-pointer"><ArrowUp className="w-3 h-3" /></button>
                            <button type="button" onClick={() => moveParam(g.title, (keys) => step(keys, x.key, 1))} aria-label="Ниже" className="p-0.5 text-slate-400 hover:text-emerald-600 cursor-pointer"><ArrowDown className="w-3 h-3" /></button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2 flex-wrap">
          <span className="text-2xs text-slate-400">{cls ? `${classById(cls).plural}: скрыто ${hiddenCount}` : ''}</span>
          <span className="flex-1" />
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800" role="group" aria-label="Для кого вид">
            {p.isAdmin && (
              <button type="button" onClick={() => p.onSwitchMode('admin')}
                className={`px-2 py-1 text-2xs font-bold rounded-md cursor-pointer ${p.visMode === 'admin' ? 'bg-emerald-600 text-white' : 'text-slate-500'}`}>для всех</button>
            )}
            <button type="button" onClick={() => p.onSwitchMode('self')}
              className={`px-2 py-1 text-2xs font-bold rounded-md cursor-pointer ${p.visMode === 'self' || !p.isAdmin ? 'bg-emerald-600 text-white' : 'text-slate-500'}`}>только для меня</button>
          </div>
          <button type="button" onClick={p.onClose} className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer">Отмена</button>
          <button type="button" onClick={save} disabled={busy}
            className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600 text-white font-semibold cursor-pointer disabled:opacity-50">
            {busy ? 'Сохраняю…' : 'Сохранить вид'}
          </button>
        </div>
      </div>
    </div>
  );
}
