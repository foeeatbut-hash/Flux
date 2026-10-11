/**
 * Flux Office — вкладка Flux и правая панель (ТЗ Flux Office §3, §4, §10).
 * Встраивается в OfficeHost рядом с существующей лентой Word/Excel.
 * Правая панель: Выборка → Поля и шапка → Обновление.
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Settings, Cog, Tag as TagIcon, Briefcase, Workflow, Languages, Database,
  RefreshCw, Save, Search, ChevronLeft, ChevronRight, Plus, Play, Check, X,
} from 'lucide-react';
import { fetchProjectData, FLUX_FIELDS, evaluateArithmetic, type FluxSource, type FluxRow, type FluxField } from './fluxData';
import { FluxFieldEditor, type FieldPart } from './FluxFieldEditor';
import { useStore } from '../../store/store';

// ── Типы ──

export interface HeaderColumn {
  title: string;
  parts: FieldPart[];
  union?: boolean;
}

export interface FluxOfficeState {
  columns: HeaderColumn[];
  filled: boolean;
  revision: string;
  docRevision: string;
  source: FluxSource;
  editorType: 'excel' | 'word';
}

interface Props {
  editorType: 'excel' | 'word';
  onInsertIntoDocument?: (html: string) => void;
  onFillTable: (data: { headers: string[]; rows: string[][] }) => void;
  children?: React.ReactNode;
}

type PanelTab = 'scope' | 'fields' | 'update';

// ── Компонент ──

export function FluxOfficePanel({ editorType, onFillTable }: Props) {
  const activeProject = useStore((s) => s.activeProject);
  const projectId = activeProject?.id || '';
  const projectName = activeProject?.name || '';

  const [fluxTab, setFluxTab] = useState<'data' | 'translate'>('data');
  const [panelTab, setPanelTab] = useState<PanelTab>('scope');
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(580);
  const [source, setSource] = useState<FluxSource>('equipment');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'tag' | 'type'>('tag');
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const [data, setData] = useState<FluxRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [columns, setColumns] = useState<HeaderColumn[]>([]);
  const [armedField, setArmedField] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [filled, setFilled] = useState(false);
  const [revision, setRevision] = useState('R15');
  const [docRevision, setDocRevision] = useState('R1 · черновик');

  // ── Загрузка данных проекта ──
  useEffect(() => {
    if (!projectId || !panelOpen) return;
    setLoading(true); setError('');
    fetchProjectData(projectId, { type: typeFilter.size === 1 ? [...typeFilter][0] : undefined, search })
      .then((d) => { setData(d.rows); setTotal(d.total); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectId, search, typeFilter, panelOpen]);

  // ── Фильтрация и сортировка ──
  const filtered = useMemo(() => {
    let rows = [...data];
    if (typeFilter.size) rows = rows.filter((r) => typeFilter.has(r.type));
    if (search) rows = rows.filter((r) => `${r.tag} ${r.name}`.toLowerCase().includes(search.toLowerCase()));
    if (sort === 'type') rows.sort((a, b) => String(a.type || '').localeCompare(String(b.type || ''), 'ru'));
    else rows.sort((a, b) => String(a.tag || '').localeCompare(String(b.tag || ''), 'ru'));
    return rows;
  }, [data, typeFilter, search, sort]);

  const allTypes = useMemo(() => [...new Set(data.map((r) => r.type))], [data]);

  // ── Выбор поля справа → клик по ячейке шапки → вставка метки ──
  const armField = (key: string) => {
    setArmedField((prev) => (prev === key ? null : key));
  };

  const insertFieldIntoColumn = (colIndex: number, fieldKey: string) => {
    const field = FLUX_FIELDS.find((f) => f.key === fieldKey);
    if (!field) return;
    setColumns((prev) => {
      const next = [...prev];
      const col = { ...next[colIndex] };
      col.parts = [...(col.parts || []), { type: 'field', fieldKey, fieldLabel: field.label }, { type: 'text', value: '' }];
      next[colIndex] = col;
      return next;
    });
  };

  const addColumn = () => {
    setColumns((prev) => [...prev, { title: `Столбец ${prev.length + 1}`, parts: [{ type: 'text', value: '' }] }]);
  };

  const removeColumn = (index: number) => {
    setColumns((prev) => prev.filter((_, i) => i !== index));
  };

  // ── Арифметика ──
  const insertOperator = (op: string) => {
    if (selected.length !== 1) return;
    setColumns((prev) => {
      const next = [...prev];
      const col = { ...next[selected[0]] };
      col.parts = [...(col.parts || []), { type: 'text', value: ` ${op} ` }];
      next[selected[0]] = col;
      return next;
    });
  };

  // ── Объединение (ТЗ Flux Office §8) ──
  const mergeSelected = () => {
    if (selected.length !== 2 || selected[1] !== selected[0] + 1) return;
    setColumns((prev) => {
      const next = [...prev];
      const left = { ...next[selected[0]] };
      const right = next[selected[1]];
      const leftFields = (left.parts || []).filter((p) => p.type === 'field').map((p) => p.fieldKey!);
      const rightFields = (right.parts || []).filter((p) => p.type === 'field').map((p) => p.fieldKey!);
      const allFields = [...new Set([...leftFields, ...rightFields])];
      left.parts = allFields.map((k) => {
        const f = FLUX_FIELDS.find((f) => f.key === k);
        return { type: 'field' as const, fieldKey: k, fieldLabel: f?.label || k };
      });
      left.union = true;
      next[selected[0]] = left;
      return next.filter((_, i) => i !== selected[1]);
    });
    setSelected([selected[0]]);
  };

  // ── Заполнить таблицу ──
  const fill = () => {
    const headers = columns.map((c) => c.title);
    const tableRows = filtered.map((row) =>
      columns.map((col) => {
        const fieldParts = (col.parts || []).filter((p) => p.type === 'field');
        if (!fieldParts.length) return '';
        // Простая арифметика
        if (fieldParts.length >= 2) {
          const allNumeric = fieldParts.every((p) => {
            const f = FLUX_FIELDS.find((f) => f.key === p.fieldKey);
            return f?.kind === 'number';
          });
          if (allNumeric) {
            const opMatch = (col.parts || []).find((p) => p.type === 'text' && /^[+\-×÷*/]$/.test(p.value?.trim() || ''));
            if (opMatch) {
              const values: (number | null)[] = fieldParts.map((p) => {
                const v = row.values[p.fieldKey!];
                return typeof v === 'number' ? v : null;
              });
              const ops: string[] = (col.parts || []).filter((p) => p.type === 'text' && /^[+\-×÷*/]$/.test(p.value?.trim() || '')).map((p) => p.value!.trim());
              const result = evaluateArithmetic(ops, values);
              return result.value;
            }
          }
        }
        // Одиночная метка или текстовая комбинация
        return fieldParts.map((p) => {
          const v = row.values[p.fieldKey!];
          return v === null || v === undefined ? '—' : String(v);
        }).join(' ');
      }),
    );
    onFillTable({ headers, rows: tableRows });
    setFilled(true);
    setDocRevision('R1 · черновик');
  };

  // ── Обновить данные ──
  const update = () => {
    if (!filled) return;
    setDocRevision((prev) => {
      const m = prev.match(/R(\d+)/);
      const n = m ? parseInt(m[1]) + 1 : 2;
      return `R${n} · черновик`;
    });
  };

  const gripDrag = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const startW = panelWidth;
    const move = (ev: PointerEvent) => {
      setPanelWidth(Math.max(400, Math.min(850, startW + startX - ev.clientX)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="flex-1 flex min-h-0 min-w-0">
      {/* Документ */}
      <div className="flex-1 min-w-0 flex flex-col">{/* slot: документ — рендерит родитель */}</div>

      {/* Правая панель */}
      {panelOpen && (
        <div
          className="shrink-0 border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col relative"
          style={{ width: panelWidth, minWidth: 400, maxWidth: 850 }}
        >
          {/* Drag-ручка */}
          <div className="absolute left-[-5px] top-0 bottom-0 w-[9px] cursor-col-resize z-10 hover:bg-emerald-100/50 dark:hover:bg-emerald-900/30"
            onPointerDown={gripDrag} title="Потяните для изменения ширины" />

          {/* Шапка панели */}
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Данные проекта</h3>
            <button type="button" onClick={() => setPanelOpen(false)}
              className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Вкладки панели */}
          <div className="flex border-b border-slate-200 dark:border-slate-800 shrink-0">
            {([['scope', '1. Выборка'], ['fields', '2. Поля и шапка'], ['update', '3. Обновление']] as Array<[PanelTab, string]>).map(([tab, label]) => (
              <button key={tab} type="button" onClick={() => setPanelTab(tab)}
                className={`flex-1 px-3 py-2 text-xs font-semibold border-b-2 cursor-pointer transition-colors ${
                  panelTab === tab
                    ? 'border-emerald-600 text-emerald-700 dark:text-emerald-300 font-semibold'
                    : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                }`}>
                {label}
              </button>
            ))}
          </div>

          {/* Скролл панели */}
          <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-3 min-h-0">
            {/* ── Вкладка «Выборка» ── */}
            {panelTab === 'scope' && (
              <div className="flex flex-col gap-4">
                <div>
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 block mb-2">Проект</span>
                  <span className="text-sm text-slate-800 dark:text-slate-200 font-medium">{projectName || 'Не выбран'}</span>
                </div>
                <div>
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 block mb-2">Типы оборудования</span>
                  <div className="flex flex-wrap gap-1.5">
                    {allTypes.map((t) => (
                      <label key={t} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs cursor-pointer ${
                        typeFilter.has(t) ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30' : 'border-slate-200 dark:border-slate-700'
                      }`}>
                        <input type="checkbox" checked={typeFilter.has(t)} className="accent-emerald-600"
                          onChange={() => setTypeFilter((prev) => {
                            const next = new Set(prev);
                            next.has(t) ? next.delete(t) : next.add(t);
                            return next;
                          })} />
                        {t}
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                    <input value={search} onChange={(e) => setSearch(e.target.value)}
                      placeholder="Поиск по тегу / наименованию"
                      className="w-full pl-8 pr-2 py-1.5 text-xs rounded-lg bg-slate-100 dark:bg-slate-850 outline-none focus:border-emerald-600 border border-transparent text-slate-900 dark:text-white" />
                  </div>
                </div>
                <div>
                  <span className="text-xs font-semibold text-slate-500 block mb-1.5">Сортировка</span>
                  <select value={sort} onChange={(e) => setSort(e.target.value as 'tag' | 'type')}
                    className="w-full py-1.5 px-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200">
                    <option value="tag">По тегу</option>
                    <option value="type">По типу</option>
                  </select>
                </div>
                <div className="text-xs text-emerald-700 dark:text-emerald-300 font-semibold">
                  Будет выбрано {filtered.length} позиций {loading && '(загрузка…)'}
                </div>
                {error && <div className="text-xs text-rose-600">{error}</div>}
                {/* Предпросмотр первых строк */}
                {filtered.length > 0 && (
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-xs">
                      <thead><tr className="bg-slate-50 dark:bg-slate-850">
                        <th className="text-left px-2 py-1 text-slate-400 font-medium">Тег</th>
                        <th className="text-left px-2 py-1 text-slate-400 font-medium">Наименование</th>
                        <th className="text-left px-2 py-1 text-slate-400 font-medium">Система</th>
                      </tr></thead>
                      <tbody>
                        {filtered.slice(0, 5).map((r, i) => (
                          <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                            <td className="px-2 py-1 font-mono text-2xs">{r.tag || '—'}</td>
                            <td className="px-2 py-1 truncate max-w-[120px]">{r.name}</td>
                            <td className="px-2 py-1 text-2xs text-slate-500">{r.systemName}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* ── Вкладка «Поля и шапка» ── */}
            {panelTab === 'fields' && (
              <div className="flex flex-col gap-4">
                <div>
                  <span className="text-xs font-semibold text-slate-500 block mb-2">Источник данных</span>
                  <div className="flex flex-wrap gap-1">
                    {(['equipment', 'tags', 'management', 'e3'] as FluxSource[]).map((s) => (
                      <button key={s} type="button" onClick={() => setSource(s)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium border cursor-pointer ${
                          source === s ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-400 text-emerald-700 dark:text-emerald-300' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-emerald-400'
                        }`}>
                        {{ equipment: 'Оборудование', tags: 'Теги', management: 'Менеджмент', e3: 'E3Flux' }[s]}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <input value={search} onChange={(e) => setSearch(e.target.value)}
                    placeholder="Найти параметр..."
                    className="w-full py-1.5 px-2 text-xs rounded-lg bg-slate-100 dark:bg-slate-850 outline-none focus:border-emerald-600 border border-transparent text-slate-900 dark:text-white" />
                </div>
                <div className="flex flex-col gap-1">
                  {FLUX_FIELDS.filter((f) => f.source === source).map((f) => (
                    <div key={f.key}
                      onClick={() => armField(f.key)}
                      className={`flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer border min-h-[42px] ${
                        armedField === f.key
                          ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20'
                          : 'border-slate-200 dark:border-slate-800 hover:border-emerald-300 hover:bg-emerald-50/30 dark:hover:bg-emerald-950/10'
                      }`}>
                      <div className="min-w-0">
                        <span className="block text-xs font-medium text-slate-800 dark:text-slate-200 truncate">{f.label}</span>
                        <span className="block text-2xs text-slate-400">{f.kind === 'number' ? 'Число' : 'Текст'}{f.unit ? ` · ${f.unit}` : ''}</span>
                      </div>
                      <button type="button" onClick={(e) => { e.stopPropagation(); armField(f.key); }}
                        className="shrink-0 w-7 h-7 rounded-md border border-emerald-300 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 cursor-pointer text-sm flex items-center justify-center"
                        title="Выбрать параметр">+
                      </button>
                    </div>
                  ))}
                </div>
                {armedField && (
                  <div className="px-3 py-2 bg-emerald-50 dark:bg-emerald-950/20 rounded-lg text-xs text-emerald-700 dark:text-emerald-300">
                    Выбран параметр «{FLUX_FIELDS.find((f) => f.key === armedField)?.label}». Кликните по ячейке шапки слева.
                  </div>
                )}
              </div>
            )}

            {/* ── Вкладка «Обновление» ── */}
            {panelTab === 'update' && (
              <div className="flex flex-col gap-3">
                <div>
                  <span className="text-xs font-semibold text-slate-500 block mb-1">Ревизия данных</span>
                  <select value={revision} onChange={(e) => setRevision(e.target.value)}
                    className="w-full py-1.5 px-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200">
                    <option value="R15">R15</option>
                    <option value="R16">R16</option>
                  </select>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Документ: {docRevision}
                </div>
                <button type="button" onClick={update} disabled={!filled}
                  className="w-full py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-semibold cursor-pointer flex items-center justify-center gap-2">
                  <RefreshCw className="w-4 h-4" /> Обновить данные
                </button>
                <div className="text-2xs text-slate-400">Данные обновляются из выбранной ревизии. Предыдущий выпуск остаётся неизменным.</div>
              </div>
            )}
          </div>

          {/* Нижняя кнопка */}
          <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 shrink-0">
            <button type="button" onClick={fill} disabled={filtered.length === 0}
              className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-semibold cursor-pointer flex items-center justify-center gap-2">
              <Play className="w-4 h-4" /> Заполнить таблицу
            </button>
            <div className="text-2xs text-slate-400 mt-1.5 text-center">
              {filled ? `Данные: ${revision} · ${filtered.length} строк · ${docRevision}` : `Выбрано полей: ${columns.reduce((n, c) => n + (c.parts || []).filter((p) => p.type === 'field').length, 0)}`}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
