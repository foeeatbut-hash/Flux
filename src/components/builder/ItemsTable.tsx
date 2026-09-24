/**
 * Ведомость позиций: таблица, отбор, групповые действия.
 *
 * Строка — это тег(и), количество и изделие из Каталога. Цвет строки говорит,
 * что с ней: подобрано уверенно, стоит проверить, или есть ошибка каталога.
 * Групповые действия работают над выделенным: подобрать заново, разбить по
 * тегам, объединить, задать параметр всем сразу, удалить.
 */
import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckSquare, Merge, Search, Split, Square, Trash2, Wand2, SlidersHorizontal, ClipboardPaste } from 'lucide-react';
import type { Catalog } from '../../../catalog/model';
import { textOf, withDefaults, num } from '../../../catalog/model';
import type { SelectionItemData } from '../../../catalog/selection';
import type { ListProblem } from '../../../catalog/checks';
import { buildDesignation } from '../../../catalog/designation';
import { Btn, Chip, Confidence, Empty, Seg, Select } from '../catalog/ui';

type GroupBy = 'none' | 'family' | 'system' | 'status';
type Filter = 'all' | 'errors' | 'unmatched' | 'doubt';

export interface TableActions {
  onOpen: (id: string) => void;
  onRematch: (ids: string[]) => void;
  onSplit: (ids: string[]) => void;
  onMerge: (ids: string[]) => void;
  onRemove: (ids: string[]) => void;
  onBulkSet: (ids: string[], key: string, value: string) => void;
  onPaste: (text: string) => void;
}

const STATUS: Record<string, string> = { draft: 'черновик', matched: 'подобрано', checked: 'проверено', issued: 'выпущено' };

export default function ItemsTable({ catalog, items, problems, openId, actions }: {
  catalog: Catalog; items: SelectionItemData[]; problems: ListProblem[]; openId?: string; actions: TableActions;
}) {
  const [q, setQ] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('family');
  const [filter, setFilter] = useState<Filter>('all');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkKey, setBulkKey] = useState('');
  const [bulkVal, setBulkVal] = useState('');
  const fam = useMemo(() => new Map(catalog.families.map((f) => [f.id, f])), [catalog]);
  const probBy = useMemo(() => {
    const m = new Map<string, ListProblem[]>();
    for (const p of problems) if (p.itemId) m.set(p.itemId, [...(m.get(p.itemId) || []), p]);
    return m;
  }, [problems]);

  const shown = useMemo(() => {
    const low = q.trim().toLowerCase();
    return items.filter((it) => {
      const probs = probBy.get(it.id) || [];
      if (filter === 'errors' && !probs.some((p) => p.level === 'error')) return false;
      if (filter === 'unmatched' && it.familyId) return false;
      if (filter === 'doubt' && !(it.match && it.match.confidence < 0.7)) return false;
      if (!low) return true;
      const f = it.familyId ? fam.get(it.familyId) : undefined;
      return [it.tags.join(' '), it.designation, f?.code || '', it.sourceText || '', it.notes || ''].some((s) => s.toLowerCase().includes(low));
    });
  }, [items, q, filter, probBy, fam]);

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: '', title: '', rows: shown }];
    const m = new Map<string, SelectionItemData[]>();
    for (const it of shown) {
      const f = it.familyId ? fam.get(it.familyId) : undefined;
      const key = groupBy === 'family' ? (f?.code || 'Не подобрано')
        : groupBy === 'system' ? (it.tags[0]?.split('-')[1] || 'Без системы')
          : STATUS[it.status] || it.status;
      m.set(key, [...(m.get(key) || []), it]);
    }
    return [...m.entries()].map(([key, rows]) => ({ key, title: key, rows }));
  }, [shown, groupBy, fam]);

  const selIds = [...sel].filter((id) => items.some((i) => i.id === id));
  const toggle = (id: string) => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setSel(n); };
  const allOn = shown.length > 0 && shown.every((it) => sel.has(it.id));

  // Параметры, общие для всех выделенных, — только их можно задать разом
  const selFamilies = [...new Set(selIds.map((id) => items.find((i) => i.id === id)?.familyId).filter(Boolean))];
  const bulkFamily = selFamilies.length === 1 ? fam.get(selFamilies[0] as string) : undefined;
  const bulkParams = bulkFamily ? bulkFamily.params.filter((p) => p.kind === 'choice') : [];
  const bulkParam = bulkParams.find((p) => p.key === bulkKey);

  const errors = problems.filter((p) => p.level === 'error').length;
  const qty = items.reduce((a, b) => a + (b.qty || 0), 0);

  return (
    // Свой контейнер: колонки прячутся по ширине самой таблицы, а не окна —
    // с открытой карточкой позиции таблице достаётся половина, и колонка
    // «Подбор» уходила за край
    <div className="flex flex-col min-h-0 h-full @container"
      onPaste={(e) => {
        // Вставка из Excel: строки с табуляцией — новые позиции. В поле ввода
        // вставка своя, её не перехватываем
        const t = e.target as HTMLElement;
        if (t.closest('input,textarea,select')) return;
        const text = e.clipboardData.getData('text/plain');
        if (text && /\t|\n/.test(text)) { e.preventDefault(); actions.onPaste(text); }
      }}>
      <div className="flex items-center gap-2 flex-wrap pb-2">
        <label className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 flex-1 min-w-[160px]">
          <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Тег, обозначение, описание…" className="flex-1 min-w-0 bg-transparent text-xs outline-none" />
        </label>
        <Seg label="Отбор" value={filter} onChange={setFilter} options={[
          { value: 'all', label: `все ${items.length}` },
          { value: 'errors', label: `ошибки ${new Set(problems.filter((p) => p.level === 'error' && p.itemId).map((p) => p.itemId)).size}` },
          { value: 'unmatched', label: `без изделия ${items.filter((i) => !i.familyId).length}` },
          { value: 'doubt', label: `проверить ${items.filter((i) => i.match && i.match.confidence < 0.7).length}` },
        ]} />
        <Seg label="Группировать" value={groupBy} onChange={setGroupBy} options={[
          { value: 'family', label: 'по семейству' }, { value: 'system', label: 'по системе' }, { value: 'status', label: 'по статусу' }, { value: 'none', label: 'без групп' },
        ]} />
      </div>

      {selIds.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mb-2 px-2 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900">
          <b className="text-2xs text-emerald-800 dark:text-emerald-300 tabular-nums">Выделено {selIds.length}</b>
          <Btn onClick={() => actions.onRematch(selIds)} title="Подобрать заново по исходному описанию"><Wand2 className="w-3.5 h-3.5" /> Подобрать заново</Btn>
          <Btn onClick={() => actions.onSplit(selIds)} title="Каждый тег — отдельной строкой"><Split className="w-3.5 h-3.5" /> Разбить по тегам</Btn>
          <Btn onClick={() => actions.onMerge(selIds)} disabled={selIds.length < 2} title="Одинаковые изделия — одной строкой"><Merge className="w-3.5 h-3.5" /> Объединить</Btn>
          {bulkFamily && (
            <span className="inline-flex items-center gap-1">
              <SlidersHorizontal className="w-3.5 h-3.5 text-slate-400" />
              <Select value={bulkKey} onChange={(v) => { setBulkKey(v); setBulkVal(''); }} className="!w-auto"
                options={[{ value: '', label: 'Задать всем…' }, ...bulkParams.map((p) => ({ value: p.key, label: textOf(p.label) }))]} />
              {bulkParam && (
                <Select value={bulkVal} onChange={setBulkVal} className="!w-auto font-mono"
                  options={[{ value: '', label: '— код —' }, ...(bulkParam.values || []).map((v) => ({ value: v.code, label: `${v.code || '(нет)'} — ${textOf(v.label)}` }))]} />
              )}
              {bulkParam && bulkVal !== '' && <Btn tone="primary" onClick={() => { actions.onBulkSet(selIds, bulkKey, bulkVal); setBulkKey(''); setBulkVal(''); }}>Применить</Btn>}
            </span>
          )}
          <span className="flex-1" />
          <Btn tone="danger" onClick={() => { actions.onRemove(selIds); setSel(new Set()); }}><Trash2 className="w-3.5 h-3.5" /> Удалить</Btn>
          <Btn tone="ghost" onClick={() => setSel(new Set())}>Снять выделение</Btn>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
        {!items.length ? (
          <Empty title="Ведомость пуста" text="Импортируйте MTO или спецификацию, подберите изделие по описанию или вставьте строки из Excel (Ctrl+V): тег, описание, количество.">
            <span className="inline-flex items-center gap-1 text-2xs text-slate-400"><ClipboardPaste className="w-3.5 h-3.5" /> Вставка работает прямо в эту область</span>
          </Empty>
        ) : !shown.length ? (
          <Empty title="Ничего не подходит" text="Снимите отбор или очистите поиск." />
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white dark:bg-slate-900 z-10">
              <tr className="text-left text-2xs uppercase tracking-wide text-slate-400">
                <th className="px-2 py-1.5 w-7">
                  <button type="button" aria-label="Выделить все" onClick={() => setSel(allOn ? new Set() : new Set(shown.map((i) => i.id)))} className="cursor-pointer">
                    {allOn ? <CheckSquare className="w-3.5 h-3.5 text-emerald-600" /> : <Square className="w-3.5 h-3.5" />}
                  </button>
                </th>
                <th className="px-2 py-1.5 font-bold">Теги</th>
                <th className="px-2 py-1.5 font-bold text-right">Кол.</th>
                <th className="px-2 py-1.5 font-bold">Изделие</th>
                <th className="px-2 py-1.5 font-bold hidden @[640px]:table-cell">Размер</th>
                <th className="px-2 py-1.5 font-bold hidden @[520px]:table-cell">Подбор</th>
                <th className="px-2 py-1.5 font-bold hidden @[900px]:table-cell">Источник</th>
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.key || 'all'}>
                {g.title && (
                  <tr><td colSpan={7} className="px-2 pt-3 pb-1 text-2xs font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                    {g.title} <span className="text-slate-400 font-semibold tabular-nums">· {g.rows.length} поз. · {g.rows.reduce((a, b) => a + (b.qty || 0), 0)} шт.</span>
                  </td></tr>
                )}
                {g.rows.map((it) => {
                  const f = it.familyId ? fam.get(it.familyId) : undefined;
                  const probs = probBy.get(it.id) || [];
                  const err = probs.some((p) => p.level === 'error');
                  const warn = !err && probs.some((p) => p.level === 'warning' && p.code !== 'family-partial');
                  const v = f ? withDefaults(f, it.values) : it.values;
                  const design = it.designation || (f ? buildDesignation(f, it.values).text : '');
                  return (
                    <tr key={it.id} onClick={() => actions.onOpen(it.id)}
                      className={`border-t border-slate-100 dark:border-slate-850 cursor-pointer ${openId === it.id ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'}`}>
                      <td className="px-2 py-1.5 align-top" onClick={(e) => { e.stopPropagation(); toggle(it.id); }}>
                        {sel.has(it.id) ? <CheckSquare className="w-3.5 h-3.5 text-emerald-600" /> : <Square className="w-3.5 h-3.5 text-slate-300 dark:text-slate-500" />}
                      </td>
                      <td className="px-2 py-1.5 align-top font-mono whitespace-nowrap">
                        {it.tags.length ? it.tags.slice(0, 3).map((t) => <div key={t} className="u-sel">{t}</div>) : <span className="text-slate-300 dark:text-slate-500">без тега</span>}
                        {it.tags.length > 3 && <div className="text-2xs text-slate-400">ещё {it.tags.length - 3}</div>}
                      </td>
                      <td className="px-2 py-1.5 align-top text-right tabular-nums">{it.qty}</td>
                      <td className="px-2 py-1.5 align-top min-w-[12rem]">
                        <div className="flex items-center gap-1.5">
                          {err && <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0" />}
                          {warn && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                          <b className="font-mono">{f?.code || '—'}</b>
                          <span className="text-2xs text-slate-400">{STATUS[it.status]}</span>
                        </div>
                        <div className="font-mono text-2xs text-slate-500 dark:text-slate-400 break-all">{design || 'изделие не подобрано'}</div>
                        {probs.filter((p) => p.code !== 'family-partial').slice(0, 2).map((p, i) => (
                          <div key={i} className={`text-2xs ${p.level === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-700 dark:text-amber-400'}`}>{p.text}</div>
                        ))}
                      </td>
                      <td className="px-2 py-1.5 align-top whitespace-nowrap tabular-nums hidden @[640px]:table-cell">
                        {num(v.D) ? `Ø${num(v.D)}` : num(v.W) || num(v.H) ? `${num(v.W)}×${num(v.H)}` : '—'}
                      </td>
                      <td className="px-2 py-1.5 align-top hidden @[520px]:table-cell"><Confidence value={it.match?.confidence} /></td>
                      <td className="px-2 py-1.5 align-top hidden @[900px]:table-cell max-w-[260px]">
                        <div className="text-2xs text-slate-500 dark:text-slate-400 line-clamp-2" title={it.sourceText}>{it.sourceText || '—'}</div>
                        {it.sourceRef?.row ? <Chip>стр. {it.sourceRef.row}{it.sourceRef.file ? ` · ${it.sourceRef.file}` : ''}</Chip> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        )}
      </div>
      <div className="pt-1.5 text-2xs text-slate-400 tabular-nums flex gap-3 flex-wrap">
        <span>{items.length} поз.</span><span>{qty} шт.</span>
        {errors > 0 && <span className="text-rose-600 dark:text-rose-400">{errors} ошиб.</span>}
        <span className="flex-1" />
        <span>Ctrl+V — вставить строки из Excel · Ctrl+Z — отменить действие</span>
      </div>
    </div>
  );
}
