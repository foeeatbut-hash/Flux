import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import VdrPanel from './VdrPanel';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import { dataService } from '../services/dataService';
import {
  Briefcase, Search, RefreshCw, Database, AlertTriangle, X, ChevronDown, ChevronUp,
  ChevronRight, Filter, List, FolderTree, Settings2, CheckSquare, Download
} from 'lucide-react';
import CustomSelect from '../components/CustomSelect';
import {
  ProcurementStage, StageTemplate, loadProcurementStages, loadStageTemplates,
  resolveTemplate, stageIcon, stageColor, DEFAULT_TEMPLATE_ID
} from '../lib/procurementStages';
import { countOf } from '../lib/plural';
import { useVirtualizer } from '@tanstack/react-virtual';
import NoProject from '../components/NoProject';

// ── Раздел «Менеджмент» ────────────────────────────────────────────────────────
// Оболочка над той же базой тегов под задачи менеджеров по закупкам.
// Этапы закупки настраиваются в «Настройки → Менеджмент» (название/значок/цвет),
// там же создаются шаблоны этапов с правилами применения (класс, тип
// оборудования, обозначение) — каждая позиция получает свой набор этапов.
// Отметки этапов хранятся в metadata тега: procurement.stage + stageLog.

interface ProcurementInfo {
  stage?: string;
  stageLog?: Record<string, { at: string; by: string }>;
  templateId?: string; // назначенный вручную шаблон этапов ('' = автоматически)
  // Старый формат (v0.21.0) — переносится в stageLog при чтении
  orderedAt?: string; orderedBy?: string;
  approvedAt?: string; approvedBy?: string;
  purchasedAt?: string; purchasedBy?: string;
  supplier?: string;
  qty?: string;
  note?: string;
}

const ACTUALITY_LABELS: Record<string, { label: string; cls: string }> = {
  actual: { label: 'Актуально', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' },
  warning: { label: 'Проверить', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20' },
  critical: { label: 'Критично', cls: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20' },
  info: { label: 'В работе', cls: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20' },
  draft: { label: 'Устарело', cls: 'bg-slate-500/10 text-slate-500 dark:text-slate-400 border-slate-500/20' },
};

function parseMeta(tag: any): any {
  // Кэш на объекте тега: JSON.parse для сотен позиций на каждый рендер — источник лагов
  if (tag.__procMeta) return tag.__procMeta;
  try {
    const meta = tag.metadata ? (typeof tag.metadata === 'string' ? JSON.parse(tag.metadata) : tag.metadata) : {};
    tag.__procMeta = meta;
    return meta;
  } catch {
    tag.__procMeta = {};
    return {};
  }
}

function tagActuality(meta: any): string {
  const descriptions = Array.isArray(meta?.descriptions) ? meta.descriptions : [];
  if (descriptions.length === 0) return 'draft';
  if (descriptions.some((d: any) => d.status === 'critical')) return 'critical';
  if (descriptions.some((d: any) => d.status === 'warning')) return 'warning';
  if (descriptions.some((d: any) => d.status === 'info')) return 'info';
  if (descriptions.some((d: any) => d.status === 'actual')) return 'actual';
  return 'draft';
}

// Перенос отметок старого формата (orderedAt/approvedAt/purchasedAt) в stageLog
function normalizeProc(proc: ProcurementInfo): ProcurementInfo {
  const out: ProcurementInfo = { ...proc, stageLog: { ...(proc.stageLog || {}) } };
  if (proc.orderedAt && !out.stageLog!['ordered']) out.stageLog!['ordered'] = { at: proc.orderedAt, by: proc.orderedBy || '' };
  if (proc.approvedAt && !out.stageLog!['approved']) out.stageLog!['approved'] = { at: proc.approvedAt, by: proc.approvedBy || '' };
  if (proc.purchasedAt && !out.stageLog!['purchased']) out.stageLog!['purchased'] = { at: proc.purchasedAt, by: proc.purchasedBy || '' };
  return out;
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

interface Row {
  tag: any;
  meta: any;
  proc: ProcurementInfo;
  stages: ProcurementStage[];     // этапы позиции (стандартные или шаблонные)
  template: StageTemplate | null; // применённый шаблон (null = стандартный)
  stageIdx: number;
  actuality: string;
  isDup: boolean;
  name: string;
  qtyNum: number;
}

// Раздел «Менеджмент»: вкладки Закупки | ВДР (реестр документации)
export default function ProcurementManagement() {
  const [searchParams, setSearchParams] = useSearchParams();
  // deep-link: /management?vdr=… или ?tab=vdr открывает вкладку ВДР
  const tab = searchParams.get('tab') === 'vdr' || searchParams.get('vdr') ? 'vdr' : 'procurement';
  const setTab = (t: 'procurement' | 'vdr') => {
    const next = new URLSearchParams(searchParams);
    if (t === 'vdr') next.set('tab', 'vdr');
    else { next.delete('tab'); next.delete('vdr'); next.delete('item'); }
    setSearchParams(next, { replace: true });
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        {([['procurement', 'Закупки'], ['vdr', 'ВДР']] as const).map(([id, label]) => (
          <button type="button" key={id} onClick={() => setTab(id)}
            /* Выбранное во всей программе зелёное. Здесь стояла почти чёрная
               заливка — единственная такая на все разделы: рядом с зелёными
               кнопками она читалась как чужая, а не как «выбрано». */
            className={`px-4 py-1.5 rounded-lg text-xs font-bold border cursor-pointer transition-ui ${tab === id
              ? 'bg-emerald-600 text-white border-emerald-600 dark:bg-emerald-500 dark:border-emerald-500'
              : 'bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:border-slate-400'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'vdr' ? <VdrPanel /> : <ProcurementTab />}
    </div>
  );
}

function ProcurementTab() {
  const { activeProject, user } = useStore();
  const { addToast } = useToastStore();
  const navigate = useNavigate();

  const [tags, setTags] = useState<any[]>([]);
  const [stages, setStages] = useState<ProcurementStage[]>([]);
  const [templates, setTemplates] = useState<StageTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [search, setSearch] = useState('');
  // Дебаунс поиска: фильтрация и сортировка всех строк на каждый символ фризили ввод
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(t);
  }, [search]);
  // Порционный рендер: DOM из тысяч строк тормозил прокрутку — рисуем частями
  // Виртуализация списка позиций: на реальном проекте их тысячи, а раньше
  // экран рисовал их все подряд (около 70 узлов разметки на строку) и
  // прокрутка проседала. Рисуем только то, что видно.
  const tableRef = useRef<HTMLTableElement>(null);
  // Элемент прокрутки держим в состоянии, а не в ref: виртуализатору нужен
  // повторный расчёт после того, как контейнер найден.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [deptFilter, setDeptFilter] = useState<string>('');
  const [onlyDuplicates, setOnlyDuplicates] = useState(false);
  const [onlyCritical, setOnlyCritical] = useState(false);
  const [onlyStuck, setOnlyStuck] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'tree'>('list');
  const [sortKey, setSortKey] = useState<'identifier' | 'stage' | 'lastDate' | 'brand' | 'qty'>('identifier');
  const [sortAsc, setSortAsc] = useState(true);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedTree, setExpandedTree] = useState<Record<string, boolean>>({});

  const loadAll = useCallback(async () => {
    if (!activeProject) return;
    setIsLoading(true);
    try {
      const [data, loadedStages, loadedTemplates] = await Promise.all([
        dataService.getTags(activeProject.id),
        loadProcurementStages(),
        loadStageTemplates()
      ]);
      const tagsList = data.tags || [];
      setTags(tagsList);
      setStages(loadedStages);
      setTemplates(loadedTemplates);
      const liveIds = new Set(tagsList.map((t: any) => t.id));
      setSelectedIds(prev => new Set(Array.from(prev).filter(id => liveIds.has(id))));
    } catch (err) {
      console.error('Failed to load procurement data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [activeProject?.id]); // по идентификатору, а не по объекту: иначе перезапрос при каждой смене ссылки

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const duplicateCodes = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tags) {
      const code = (t.identifier || '').trim();
      if (code) counts[code] = (counts[code] || 0) + 1;
    }
    return new Set(Object.keys(counts).filter(c => counts[c] > 1));
  }, [tags]);

  const departments = useMemo(() => {
    const set = new Set<string>();
    for (const t of tags) if (t.department) set.add(t.department);
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ru'));
  }, [tags]);

  // Строки: тег + распарсенные закупочные данные. Набор этапов у каждой позиции
  // свой: подбирается шаблон по правилам (обозначение/тип/категория/отдел)
  // либо назначенный вручную (proc.templateId), иначе — стандартные этапы.
  const rows = useMemo<Row[]>(() => {
    return tags.map(t => {
      const meta = parseMeta(t);
      const proc = normalizeProc(meta.procurement || {});
      const links = Array.isArray(t.componentElements) ? t.componentElements : [];
      const template = resolveTemplate({
        identifier: t.identifier || '',
        department: t.department || '',
        equipTypes: links.map((c: any) => String(c.equipType || '')).filter(Boolean),
        categories: links.map((c: any) => String(c?.monoblock?.system?.category || '')).filter(Boolean),
        explicitTemplateId: proc.templateId,
      }, templates);
      const rowStages = template ? template.stages : stages;
      let stageIdx = proc.stage ? rowStages.findIndex(s => s.id === proc.stage) : 0;
      if (stageIdx < 0) stageIdx = 0; // этап удалили из настроек — позиция на первом
      return {
        tag: t,
        meta,
        proc,
        stages: rowStages,
        template,
        stageIdx,
        actuality: tagActuality(meta),
        isDup: duplicateCodes.has((t.identifier || '').trim()),
        name: meta.mainName || '',
        qtyNum: parseFloat(String(proc.qty || '').replace(',', '.')) || 0,
      };
    });
  }, [tags, duplicateCodes, stages, templates]);

  const rowsById = useMemo(() => {
    const m: Record<string, Row> = {};
    for (const r of rows) m[r.tag.id] = r;
    return m;
  }, [rows]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) {
      const id = r.stages[r.stageIdx]?.id;
      if (id) c[id] = (c[id] || 0) + 1;
    }
    return c;
  }, [rows]);

  // Карточки-счётчики: стандартные этапы + этапы шаблонов, на которых есть позиции
  const stageCards = useMemo(() => {
    const cards: Array<{ stage: ProcurementStage; templateName?: string }> = stages.map(s => ({ stage: s }));
    for (const t of templates) {
      for (const s of t.stages) {
        if ((counts[s.id] || 0) > 0) cards.push({ stage: s, templateName: t.name });
      }
    }
    return cards;
  }, [stages, templates, counts]);

  // ── «Зависшие» позиции ──────────────────────────────────────────────────────
  // Закупка ломается не там, где что-то отменили, а там, где ничего не
  // происходит: позицию завели и забыли. Считаем, сколько дней позиция стоит
  // на текущем этапе, и отдельно показываем те, что стоят слишком долго.
  // Позиция на последнем этапе не «зависла» — она закрыта.
  const stuckAfterDays = 14;
  const daysAtStage = useCallback((r: Row): number => {
    const cur = r.stages[r.stageIdx];
    const rec = cur ? r.proc.stageLog?.[cur.id] : null;
    const at = rec?.at || r.tag.createdAt;
    const ms = at ? new Date(at).getTime() : 0;
    if (!ms) return 0;
    return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
  }, []);
  const isStuck = useCallback((r: Row): boolean =>
    r.stageIdx < r.stages.length - 1 && daysAtStage(r) >= stuckAfterDays, [daysAtStage]);
  const stuckCount = useMemo(() => rows.filter(isStuck).length, [rows, isStuck]);

  const rowMatchesFilters = useCallback((r: Row): boolean => {
    if (stageFilter !== 'all' && r.stages[r.stageIdx]?.id !== stageFilter) return false;
    if (deptFilter && r.tag.department !== deptFilter) return false;
    if (onlyDuplicates && !r.isDup) return false;
    if (onlyCritical && r.actuality !== 'critical' && r.actuality !== 'warning') return false;
    if (onlyStuck && !isStuck(r)) return false; // eslint-disable-line
    const q = debouncedSearch.trim().toLowerCase();
    if (q) {
      const hit = (r.tag.identifier || '').toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        (r.tag.brand || '').toLowerCase().includes(q) ||
        (r.proc.supplier || '').toLowerCase().includes(q) ||
        (r.proc.note || '').toLowerCase().includes(q);
      if (!hit) return false;
    }
    return true;
  }, [stageFilter, deptFilter, onlyDuplicates, onlyCritical, onlyStuck, isStuck, debouncedSearch]);

  // Смена фильтров возвращает прокрутку списка к началу
  useEffect(() => {
    scrollEl?.scrollTo({ top: 0 });
  }, [stageFilter, deptFilter, onlyDuplicates, onlyCritical, onlyStuck, debouncedSearch, viewMode]);

  const lastDateOf = (r: Row): number => {
    let max = new Date(r.tag.createdAt || 0).getTime();
    for (const s of r.stages) {
      const rec = r.proc.stageLog?.[s.id];
      if (rec?.at) max = Math.max(max, new Date(rec.at).getTime());
    }
    return max;
  };

  const filtered = useMemo(() => {
    const list = rows.filter(rowMatchesFilters);
    const dir = sortAsc ? 1 : -1;
    return [...list].sort((a, b) => {
      if (sortKey === 'identifier') return dir * (a.tag.identifier || '').localeCompare(b.tag.identifier || '', 'ru');
      if (sortKey === 'brand') return dir * (a.tag.brand || '').localeCompare(b.tag.brand || '', 'ru');
      if (sortKey === 'stage') return dir * (a.stageIdx - b.stageIdx);
      if (sortKey === 'qty') return dir * (a.qtyNum - b.qtyNum);
      return dir * (lastDateOf(a) - lastDateOf(b));
    });
  }, [rows, rowMatchesFilters, sortKey, sortAsc]);

  // ── Дерево: родитель → дочерние (по связям тегов на холсте) ────────────────
  const tree = useMemo(() => {
    if (viewMode !== 'tree') return [];
    const idSet = new Set(tags.map(t => t.id));
    const childrenMap: Record<string, string[]> = {};
    const hasParent: Record<string, boolean> = {};
    for (const t of tags) {
      const meta = parseMeta(t);
      const kids = (Array.isArray(meta.connections) ? meta.connections : []).filter((id: string) => idSet.has(id));
      childrenMap[t.id] = kids;
      kids.forEach((k: string) => { hasParent[k] = true; });
    }
    const visible = new Set<string>();
    // Узел показываем, если он или любой его потомок проходит фильтры
    const passes = (id: string, seen: Set<string>): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      const row = rowsById[id];
      let ok = row ? rowMatchesFilters(row) : false;
      for (const k of (childrenMap[id] || [])) {
        if (passes(k, seen)) ok = true;
      }
      if (ok) visible.add(id);
      return ok;
    };
    const roots = tags.filter(t => !hasParent[t.id]);
    for (const r of roots) passes(r.id, new Set());
    return roots
      .filter(r => visible.has(r.id))
      .sort((a, b) => (a.identifier || '').localeCompare(b.identifier || '', 'ru'))
      .map(r => ({ id: r.id, childrenMap, visible }));
  }, [viewMode, tags, rowsById, rowMatchesFilters]);

  // ── Сохранение и смена этапов ───────────────────────────────────────────────
  const saveProc = async (tag: any, meta: any, proc: ProcurementInfo) => {
    const newMeta = { ...meta, procurement: proc };
    setTags(prev => prev.map(t => t.id === tag.id ? { ...t, metadata: JSON.stringify(newMeta), parsedMetadata: undefined, __procMeta: undefined } : t));
    try {
      await fetch(`/api/tags/${tag.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: JSON.stringify(newMeta) })
      });
    } catch (err) {
      console.error('Failed to save procurement info:', err);
      addToast('Не удалось сохранить изменения', 'error');
    }
  };

  // Установка этапа одной позиции (с датами промежуточных этапов).
  // Работает по набору этапов самой позиции (стандартному или шаблонному).
  const applyStage = (row: Row, targetIdx: number): ProcurementInfo => {
    const now = new Date().toISOString();
    const who = user?.name || 'Пользователь';
    const proc = normalizeProc(row.proc);
    const log = { ...(proc.stageLog || {}) };
    for (let i = 1; i < row.stages.length; i++) {
      const sid = row.stages[i].id;
      if (i <= targetIdx) {
        if (!log[sid]) log[sid] = { at: now, by: who };
      } else {
        delete log[sid];
      }
    }
    // Старые поля больше не используем — вычищаем, чтобы не было двух источников
    delete proc.orderedAt; delete proc.orderedBy;
    delete proc.approvedAt; delete proc.approvedBy;
    delete proc.purchasedAt; delete proc.purchasedBy;
    proc.stageLog = log;
    proc.stage = row.stages[targetIdx]?.id;
    return proc;
  };

  const setStage = async (row: Row, targetIdx: number) => {
    // Повторный клик по текущему этапу — откат на шаг назад
    const finalIdx = (targetIdx === row.stageIdx && targetIdx > 0) ? targetIdx - 1 : targetIdx;
    await saveProc(row.tag, row.meta, applyStage(row, finalIdx));
    if (finalIdx !== row.stageIdx) {
      addToast(`«${row.tag.identifier}»: этап «${row.stages[finalIdx]?.label}»`, finalIdx > row.stageIdx ? 'success' : 'info');
    }
  };

  // Массовая установка этапа всем выбранным — одним запросом
  // (последовательные PUT по каждой позиции заметно фризили интерфейс).
  // Этап применяется по НОМЕРУ в наборе этапов каждой позиции — так массовое
  // действие корректно работает и при выборе позиций с разными шаблонами.
  const setStageBulk = async (targetIdx: number) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const updates: { id: string; metadata: string }[] = [];
    for (const id of ids) {
      const row = rowsById[id];
      if (!row) continue;
      const idx = Math.min(targetIdx, row.stages.length - 1);
      const newMeta = { ...row.meta, procurement: applyStage(row, idx) };
      updates.push({ id, metadata: JSON.stringify(newMeta) });
    }
    // Мгновенное локальное обновление
    const metaById = new Map(updates.map(u => [u.id, u.metadata]));
    setTags(prev => prev.map(t => metaById.has(t.id)
      ? { ...t, metadata: metaById.get(t.id), parsedMetadata: undefined, __procMeta: undefined }
      : t));
    try {
      const res = await fetch('/api/tags/bulk-metadata', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      if (!res.ok) throw new Error('bulk update failed');
      addToast(`Этап установлен для позиций: ${updates.length}`, 'success');
    } catch (err) {
      console.error('Bulk stage update failed:', err);
      addToast('Не удалось сохранить массовое изменение — обновите страницу', 'error');
      loadAll();
    }
  };

  // Массовое назначение шаблона этапов выбранным позициям ('' = автоматически)
  const setTemplateBulk = async (templateId: string) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const updates: { id: string; metadata: string }[] = [];
    for (const id of ids) {
      const row = rowsById[id];
      if (!row) continue;
      const proc = normalizeProc(row.proc);
      if (templateId) proc.templateId = templateId;
      else delete proc.templateId;
      updates.push({ id, metadata: JSON.stringify({ ...row.meta, procurement: proc }) });
    }
    const metaById = new Map(updates.map(u => [u.id, u.metadata]));
    setTags(prev => prev.map(t => metaById.has(t.id)
      ? { ...t, metadata: metaById.get(t.id), parsedMetadata: undefined, __procMeta: undefined }
      : t));
    try {
      const res = await fetch('/api/tags/bulk-metadata', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      if (!res.ok) throw new Error('bulk template failed');
      const name = templateId === DEFAULT_TEMPLATE_ID ? 'Стандартный'
        : templateId === '' ? 'Автоматически (по правилам)'
        : (templates.find(t => t.id === templateId)?.name || templateId);
      addToast(`Шаблон этапов «${name}» назначен позициям: ${updates.length}`, 'success');
    } catch (err) {
      console.error('Bulk template update failed:', err);
      addToast('Не удалось назначить шаблон — обновите страницу', 'error');
      loadAll();
    }
  };

  // Кнопки массовой установки этапов: если у всех выбранных один набор этапов —
  // показываем его; иначе обобщённые кнопки по номерам
  const bulkStages = useMemo<ProcurementStage[] | null>(() => {
    const sel = Array.from(selectedIds).map(id => rowsById[id]).filter(Boolean) as Row[];
    if (sel.length === 0) return stages;
    const first = sel[0].stages;
    const key = (l: ProcurementStage[]) => l.map(s => s.id).join('|');
    return sel.every(r => key(r.stages) === key(first)) ? first : null;
  }, [selectedIds, rowsById, stages]);

  const saveField = async (row: Row, field: 'supplier' | 'qty' | 'note', value: string) => {
    await saveProc(row.tag, row.meta, { ...normalizeProc(row.proc), [field]: value });
  };

  const toggleSort = (key: typeof sortKey) => {
    if (sortKey === key) setSortAsc(v => !v);
    else { setSortKey(key); setSortAsc(true); }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Выгрузка в Excel того, что человек видит: фильтры, поиск и порядок
  // уже применены. Выгружать «всё подряд» бесполезно — отчёт всегда
  // делается по срезу.
  const exportToExcel = async () => {
    if (!filtered.length) { addToast('Нечего выгружать: под фильтры не попала ни одна позиция', 'info'); return; }
    const XLSX = await import('xlsx');
    const rows = filtered.map((r) => {
      const cur = r.stages[r.stageIdx];
      const rec = cur ? r.proc.stageLog?.[cur.id] : null;
      return {
        'Позиция': r.tag.identifier || '',
        'Наименование': r.name || '',
        'Марка': r.tag.brand || '',
        'Отдел': r.tag.department || '',
        'Этап закупки': cur?.label || '',
        'Дата этапа': rec?.at ? fmtDate(rec.at) : '',
        'Кто отметил': rec?.by || '',
        'Дней на этапе': daysAtStage(r),
        'Поставщик': r.proc.supplier || '',
        'Количество': r.proc.qty || '',
        'Примечание': r.proc.note || '',
      };
    });
    const sheet = XLSX.utils.json_to_sheet(rows);
    // Ширины колонок: без них выгрузка открывается «лесенкой» из решёток.
    (sheet as any)['!cols'] = [
      { wch: 16 }, { wch: 32 }, { wch: 16 }, { wch: 10 }, { wch: 16 },
      { wch: 12 }, { wch: 20 }, { wch: 13 }, { wch: 20 }, { wch: 12 }, { wch: 40 },
    ];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Закупки');
    const stamp = new Date().toISOString().slice(0, 10);
    const projectPart = String(activeProject?.name || 'проект').replace(/[\\/:*?"<>|]/g, '-').slice(0, 40);
    XLSX.writeFile(book, `Закупки — ${projectPart} — ${stamp}.xlsx`);
    addToast(`Выгружено строк: ${filtered.length}`, 'success');
  };

  const allVisibleSelected = filtered.length > 0 && filtered.every(r => selectedIds.has(r.tag.id));

  // Прокручивается не сама таблица, а контейнер раздела рабочего стола
  useEffect(() => {
    const el = (tableRef.current?.closest('.overflow-y-auto') as HTMLElement) || null;
    setScrollEl((prev) => (prev === el ? prev : el));
  }, [viewMode, filtered.length]);

  const rowVirtualizer = useVirtualizer({
    count: viewMode === 'list' ? filtered.length : 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => 100,
    overscan: 4,
    // Реальная высота строки зависит от содержимого: измеряем, иначе
    // виртуализатор постоянно пересчитывает раскладку при прокрутке.
    measureElement: (el) => el.getBoundingClientRect().height,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  if (!activeProject) {
    return (
      <NoProject what="Закупки" />
    );
  }

  // ── Строка позиции (общая для списка и дерева) ──────────────────────────────
  const renderRow = (row: Row, treeLevel: number | null, treeHasChildren?: boolean, treeExpanded?: boolean, onTreeToggle?: () => void, measureRef?: (el: HTMLElement | null) => void, vIndex?: number) => {
    const act = ACTUALITY_LABELS[row.actuality] || ACTUALITY_LABELS.draft;
    const isSelected = selectedIds.has(row.tag.id);
    return (
      <tr
        key={row.tag.id}
        ref={measureRef}
        data-index={vIndex}
        data-share-route="/management"
        data-share-focus={`ptag:${row.tag.id}`}
        data-share-label={row.tag.identifier}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            toggleSelect(row.tag.id);
          }
        }}
        className={`border-b border-slate-100 dark:border-slate-900 transition-colors ${
          isSelected
            ? 'bg-emerald-50 dark:bg-emerald-950/30'
            : row.isDup
              ? 'bg-rose-50/40 dark:bg-rose-950/10 hover:bg-rose-50/70 dark:hover:bg-rose-950/20'
              : 'hover:bg-slate-50/60 dark:hover:bg-slate-900/40'
        }`}
      >
        {/* Галочка мультивыбора */}
        <td className="flux-cell align-top w-8">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => toggleSelect(row.tag.id)}
            onClick={(e) => e.stopPropagation()}
            className="accent-emerald-500 cursor-pointer"
            title="Выбрать для массовых действий (или Ctrl+клик по строке)"
          />
        </td>

        {/* Позиция */}
        <td className="flux-cell align-top">
          <div className="flex items-center gap-1.5" style={treeLevel !== null ? { paddingLeft: `${treeLevel * 22}px` } : undefined}>
            {treeLevel !== null && (
              treeHasChildren ? (
                <button type="button"
                  onClick={(e) => { e.stopPropagation(); onTreeToggle && onTreeToggle(); }}
                  className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer shrink-0"
                  title={treeExpanded ? 'Свернуть дочерние' : 'Развернуть дочерние'}
                >
                  {treeExpanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500" />}
                </button>
              ) : <span className="w-4.5 inline-block shrink-0" style={{ width: 18 }} />
            )}
            <span className="font-mono font-bold text-xs text-slate-900 dark:text-white select-all">{row.tag.identifier}</span>
            {row.isDup && (
              <span className="text-2xs font-bold px-1.5 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60" title="Дубликат кода тега">дубль</span>
            )}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 max-w-[220px] truncate" title={row.name} style={treeLevel !== null ? { paddingLeft: `${treeLevel * 22 + 18}px` } : undefined}>
            {row.name || <span className="italic opacity-60">Без наименования</span>}
          </div>
          <div className="text-2xs text-slate-400 font-mono mt-0.5" style={treeLevel !== null ? { paddingLeft: `${treeLevel * 22 + 18}px` } : undefined}>
            {row.tag.department || '—'} · добавлен {fmtDate(row.tag.createdAt)}
          </div>
        </td>

        {/* Марка */}
        <td className="flux-cell hidden @[740px]:table-cell align-top">
          {row.tag.brand ? (
            <span className="font-mono text-xs font-semibold px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 inline-block max-w-[150px] truncate" title={row.tag.brand}>
              {row.tag.brand}
            </span>
          ) : <span className="text-xs text-slate-400 italic">—</span>}
        </td>

        {/* Актуальность */}
        <td className="flux-cell hidden @[860px]:table-cell align-top">
          <span className={`inline-flex items-center gap-1 text-2xs font-bold px-2 py-1 rounded-full border ${act.cls}`}>
            {(row.actuality === 'critical' || row.actuality === 'warning') && <AlertTriangle className="w-3 h-3" />}
            {act.label}
          </span>
        </td>

        {/* Этап закупки: степпер по этапам позиции (стандартным или шаблонным) */}
        <td className="flux-cell align-top">
          <div className="flex items-center gap-0.5 flex-wrap">
            {row.stages.map((s, idx) => {
              const Icon = stageIcon(s.icon);
              const c = stageColor(s.color);
              const reached = idx <= row.stageIdx;
              return (
                <React.Fragment key={s.id}>
                  {idx > 0 && <div className={`w-3 h-0.5 ${idx <= row.stageIdx ? 'bg-emerald-400' : 'bg-slate-200 dark:bg-slate-800'}`} />}
                  <button type="button"
                    onClick={(e) => { e.stopPropagation(); setStage(row, idx); }}
                    title={`${s.label}${idx === row.stageIdx && idx > 0 ? ' (клик — откат на шаг назад)' : ''}`}
                    className={`w-7 h-7 rounded-full border flex items-center justify-center transition-ui cursor-pointer ${
                      reached
                        ? `${c.bg} ${c.border} ${c.color} ${idx === row.stageIdx ? 'ring-2 ring-offset-1 dark:ring-offset-slate-950 ring-current scale-110' : ''}`
                        : 'bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-400 dark:text-slate-455 hover:border-slate-400'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </button>
                </React.Fragment>
              );
            })}
          </div>
          <div className="text-2xs font-bold mt-1 text-slate-500 dark:text-slate-400">
            {row.stages[row.stageIdx]?.label || '—'}
            {/* Сколько дней позиция стоит на этом этапе — видно сразу, без
                разбора дат: именно это и есть настоящая проблема закупки. */}
            {isStuck(row) && (
              <span
                className="ml-1.5 px-1.5 py-px rounded-full bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-900/50 font-bold normal-case"
                title={`Позиция стоит на этапе «${row.stages[row.stageIdx]?.label}» уже ${daysAtStage(row)} дн. — движения нет`}
              >
                {daysAtStage(row)} дн.
              </span>
            )}
            {row.template && (
              <span
                className="ml-1.5 px-1.5 py-px rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-500 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900/50 font-semibold normal-case"
                title={row.proc.templateId ? 'Шаблон назначен вручную' : 'Шаблон применён по правилам'}
              >
                {row.template.name}
              </span>
            )}
          </div>
        </td>

        {/* Даты этапов */}
        <td className="flux-cell hidden @[980px]:table-cell align-top">
          <div className="text-2xs font-mono text-slate-500 dark:text-slate-400 space-y-0.5 leading-tight">
            {row.stages.slice(1).map(s => {
              const rec = row.proc.stageLog?.[s.id];
              const c = stageColor(s.color);
              return (
                <div key={s.id} title={rec?.by ? `Отметил: ${rec.by}` : ''}>
                  {s.label.toLowerCase()}: <strong className={rec?.at ? c.color : ''}>{fmtDate(rec?.at)}</strong>
                </div>
              );
            })}
          </div>
        </td>

        {/* Поставщик и количество */}
        <td className="flux-cell align-top">
          <input
            type="text"
            defaultValue={row.proc.supplier || ''}
            placeholder="Поставщик…"
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => { if (e.target.value !== (row.proc.supplier || '')) saveField(row, 'supplier', e.target.value); }}
            className="w-32 px-2 py-1 mb-1 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded text-xs focus:outline-none focus:border-emerald-400 text-slate-800 dark:text-slate-100 block"
          />
          <input
            type="text"
            defaultValue={row.proc.qty || ''}
            placeholder="Кол-во…"
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => { if (e.target.value !== (row.proc.qty || '')) saveField(row, 'qty', e.target.value); }}
            className="w-32 px-2 py-1 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded text-xs focus:outline-none focus:border-emerald-400 text-slate-800 dark:text-slate-100 block"
          />
        </td>

        {/* Примечание */}
        <td className="flux-cell hidden @[1100px]:table-cell align-top min-w-[180px]">
          {editingNoteId === row.tag.id ? (
            <textarea
              autoFocus
              defaultValue={row.proc.note || ''}
              rows={2}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                if (e.target.value !== (row.proc.note || '')) saveField(row, 'note', e.target.value);
                setEditingNoteId(null);
              }}
              className="w-full px-2 py-1 bg-white dark:bg-slate-900 border border-emerald-300 dark:border-emerald-700 rounded text-xs focus:outline-none text-slate-800 dark:text-slate-100"
            />
          ) : (
            <button type="button"
              onClick={(e) => { e.stopPropagation(); setEditingNoteId(row.tag.id); }}
              className="text-xs text-left text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 cursor-text w-full min-h-[24px]"
              title="Нажмите, чтобы изменить примечание"
            >
              {row.proc.note || <span className="italic opacity-50">добавить примечание…</span>}
            </button>
          )}
        </td>
      </tr>
    );
  };

  // Рекурсивный рендер дерева в строки таблицы
  const renderTreeRows = (id: string, childrenMap: Record<string, string[]>, visible: Set<string>, level: number, seen: Set<string>): React.ReactNode[] => {
    if (seen.has(id) || !visible.has(id)) return [];
    seen.add(id);
    const row = rowsById[id];
    if (!row) return [];
    const kids = (childrenMap[id] || []).filter(k => visible.has(k) && !seen.has(k));
    const expanded = expandedTree[id] !== false; // по умолчанию раскрыто
    const out: React.ReactNode[] = [
      renderRow(row, level, kids.length > 0, expanded, () => setExpandedTree(prev => ({ ...prev, [id]: !(prev[id] !== false) })))
    ];
    if (expanded) {
      for (const k of kids) out.push(...renderTreeRows(k, childrenMap, visible, level + 1, seen));
    }
    return out;
  };

  // Без входной анимации: на большом списке она добавляла заметный фриз при открытии раздела
  return (
    <div className="flex flex-col gap-3 text-slate-800 dark:text-slate-100">
      {/* Заголовок */}
      <div className="flex flex-col @[820px]:flex-row @[820px]:items-center @[820px]:justify-between gap-3 p-3 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-xl shadow-xs">
        <div className="min-w-0">
          <div className="graf">Менеджмент</div>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-white">Закупки</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-start @[820px]:self-auto">
          <div className="flex flex-wrap bg-slate-100 dark:bg-slate-900 p-0.5 rounded-lg border border-slate-200/60 dark:border-slate-800">
            <button type="button"
              onClick={() => setViewMode('list')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold cursor-pointer ${viewMode === 'list' ? 'bg-white dark:bg-slate-800 text-emerald-700 dark:text-emerald-300 shadow-xs' : 'text-slate-500'}`}
            >
              <List className="w-3.5 h-3.5" /> Список
            </button>
            <button type="button"
              onClick={() => setViewMode('tree')}
              title="Группировка: родительский тег → дочерние"
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold cursor-pointer ${viewMode === 'tree' ? 'bg-white dark:bg-slate-800 text-emerald-700 dark:text-emerald-300 shadow-xs' : 'text-slate-500'}`}
            >
              <FolderTree className="w-3.5 h-3.5" /> Дерево
            </button>
          </div>
          <button type="button"
            onClick={() => navigate('/settings?section=management')}
            title="Настроить этапы закупки"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer"
          >
            <Settings2 className="w-3.5 h-3.5" /> Этапы
          </button>
          <button type="button"
            onClick={exportToExcel}
            title="Выгрузить то, что сейчас на экране: с учётом фильтров, поиска и порядка"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-bold cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" /> В Excel
          </button>
          <button type="button"
            onClick={loadAll}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} /> Обновить
          </button>
        </div>
      </div>

      {/* Счётчики этапов: клик — фильтр.
          Было пять плиток с крупной цифрой и цветным значком — вид,
          одинаковый для любой панели показателей и ничего не говорящий
          о закупке. Теперь это одна строка граф, как в ведомости:
          счётчики читаются слева направо в порядке движения позиции,
          цвет остался только у выбранной графы. */}
      <div className="tally overflow-x-auto rule-t">
        <button type="button"
          onClick={() => setStageFilter('all')}
          aria-pressed={stageFilter === 'all'}
          className="tally-item cursor-pointer"
        >
          <span className="tally-num">{rows.length}</span>
          <span className="tally-lab">Все позиции</span>
        </button>
        {stageCards.map(({ stage: s, templateName }) => {
          const active = stageFilter === s.id;
          return (
            <button type="button"
              key={s.id}
              onClick={() => setStageFilter(active ? 'all' : s.id)}
              aria-pressed={active}
              title={templateName ? `Этап шаблона «${templateName}»` : undefined}
              className="tally-item cursor-pointer"
            >
              <span className="tally-num">{counts[s.id] || 0}</span>
              <span className="tally-lab truncate">{s.label}</span>
            </button>
          );
        })}
      </div>

      {/* Поиск и фильтры */}
      <div className="flex flex-wrap items-center gap-2 p-3 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-xl shadow-xs">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-2.5 top-2 text-slate-400" />
          <input
            type="search"
            placeholder="Поиск: тег, наименование, марка, поставщик, примечание…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/20 text-slate-800 dark:text-slate-100"
          />
        </div>
        <div className="w-44">
          <CustomSelect
            value={deptFilter}
            onChange={setDeptFilter}
            placeholder="Все отделы"
            options={[{ value: '', label: 'Все отделы' }, ...departments.map(d => ({ value: d, label: d }))]}
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer select-none px-2 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900">
          <input type="checkbox" checked={onlyDuplicates} onChange={(e) => setOnlyDuplicates(e.target.checked)} className="accent-rose-500" />
          Только дубли
        </label>
        <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 cursor-pointer select-none px-2 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900">
          <input type="checkbox" checked={onlyCritical} onChange={(e) => setOnlyCritical(e.target.checked)} className="accent-amber-500" />
          Требуют внимания
        </label>
        <label
          className={`flex items-center gap-1.5 text-xs font-semibold cursor-pointer select-none px-2 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900 ${
            stuckCount > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-slate-600 dark:text-slate-300'}`}
          title={`Позиции, которые стоят на одном этапе дольше ${stuckAfterDays} дней и ещё не закрыты`}
        >
          <input type="checkbox" checked={onlyStuck} onChange={(e) => setOnlyStuck(e.target.checked)} className="accent-amber-500" />
          Зависшие
          {stuckCount > 0 && (
            <span className="px-1.5 py-px rounded-full bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 text-2xs font-bold">{stuckCount}</span>
          )}
        </label>
        <span className="text-xs text-slate-400 flex items-center gap-1"><Filter className="w-3.5 h-3.5" /> Показано: {filtered.length}</span>
      </div>

      {/* Панель массовых действий */}
      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 rounded-xl">
          <span className="text-xs font-bold text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
            <CheckSquare className="w-4 h-4" /> Выбрано: {selectedIds.size}
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400">Установить этап:</span>
          {(bulkStages || stages).map((s, idx) => {
            const Icon = stageIcon(s.icon);
            const c = stageColor(s.color);
            return (
              <button type="button"
                key={s.id}
                onClick={() => setStageBulk(idx)}
                title={bulkStages ? s.label : `Этап №${idx + 1} в наборе каждой позиции`}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer transition-ui hover:scale-105 ${c.bg} ${c.border} ${c.color}`}
              >
                <Icon className="w-3.5 h-3.5" /> {bulkStages ? s.label : `№${idx + 1} ${s.label}`}
              </button>
            );
          })}
          {!bulkStages && (
            <span className="text-2xs text-slate-400" title="У выбранных позиций разные шаблоны — этап применяется по номеру в наборе каждой позиции">
              (разные шаблоны — по номеру этапа)
            </span>
          )}
          {templates.length > 0 && (
            <div className="w-56">
              <CustomSelect
                value=""
                onChange={(v) => { if (v) setTemplateBulk(v === '__auto__' ? '' : v); }}
                placeholder="Шаблон этапов…"
                options={[
                  { value: '__auto__', label: 'Автоматически (по правилам)' },
                  { value: DEFAULT_TEMPLATE_ID, label: 'Стандартные этапы' },
                  ...templates.map(t => ({ value: t.id, label: t.name })),
                ]}
              />
            </div>
          )}
          <button type="button"
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto p-1.5 rounded-lg hover:bg-white/60 dark:hover:bg-slate-900 text-slate-400 cursor-pointer"
            title="Снять выделение"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Таблица позиций */}
      <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-xl shadow-xs overflow-x-auto">
        <table ref={tableRef} className="w-full text-left border-collapse">
          <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-850">
            <tr>
              <th className="flux-cell w-8">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={() => {
                    if (allVisibleSelected) setSelectedIds(new Set());
                    else setSelectedIds(new Set(filtered.map(r => r.tag.id)));
                  }}
                  className="accent-emerald-500 cursor-pointer"
                  title="Выбрать все показанные"
                />
              </th>
              <th className="flux-cell cursor-pointer hover:text-slate-800 dark:hover:text-white select-none" onClick={() => toggleSort('identifier')}>
                Позиция {sortKey === 'identifier' && (sortAsc ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />)}
              </th>
              <th className="flux-cell hidden @[740px]:table-cell cursor-pointer hover:text-slate-800 dark:hover:text-white select-none" onClick={() => toggleSort('brand')}>
                Марка {sortKey === 'brand' && (sortAsc ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />)}
              </th>
              <th className="flux-cell hidden @[860px]:table-cell">Актуальность</th>
              <th className="flux-cell cursor-pointer hover:text-slate-800 dark:hover:text-white select-none" onClick={() => toggleSort('stage')}>
                Этап закупки {sortKey === 'stage' && (sortAsc ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />)}
              </th>
              <th className="flux-cell hidden @[980px]:table-cell cursor-pointer hover:text-slate-800 dark:hover:text-white select-none" onClick={() => toggleSort('lastDate')}>
                Даты этапов {sortKey === 'lastDate' && (sortAsc ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />)}
              </th>
              <th className="flux-cell cursor-pointer hover:text-slate-800 dark:hover:text-white select-none" onClick={() => toggleSort('qty')}>
                Поставщик / Кол-во {sortKey === 'qty' && (sortAsc ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />)}
              </th>
              <th className="flux-cell hidden @[1100px]:table-cell">Примечание</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && filtered.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-16 text-slate-400 text-sm">
                <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" /> Загрузка позиций…
              </td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={8} className="p-0">
                <div className="blank">
                  <div className="blank-title">{rows.length === 0 ? 'В проекте нет позиций' : 'Ничего не найдено'}</div>
                  <div className="blank-text">
                    {rows.length === 0
                      ? 'Позиции появятся, когда в проекте будут теги с оборудованием.'
                      : 'Ни одна позиция не подходит под заданные фильтры. Снимите часть условий или очистите поиск.'}
                  </div>
                  {rows.length === 0 ? (
                    <button type="button" onClick={() => navigate('/registry')}
                      className="mt-2 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium cursor-pointer transition-colors">
                      Перейти к тегам
                    </button>
                  ) : (
                    <button type="button" onClick={() => { setSearch(''); setStageFilter('all'); }}
                      className="mt-2 px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 text-xs font-medium cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors">
                      Сбросить фильтры
                    </button>
                  )}
                </div>
              </td></tr>
            ) : viewMode === 'list' ? (
              <>
                {virtualRows.length > 0 && virtualRows[0].start > 0 && (
                  <tr style={{ height: virtualRows[0].start, border: 'none' }} aria-hidden="true"><td colSpan={8} className="p-0" /></tr>
                )}
                {virtualRows.map((v) => (
                  <React.Fragment key={filtered[v.index].tag.id}>
                    {renderRow(filtered[v.index], null, undefined, undefined, undefined, rowVirtualizer.measureElement, v.index)}
                  </React.Fragment>
                ))}
                {virtualRows.length > 0 && (
                  <tr style={{ height: Math.max(0, rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end), border: 'none' }} aria-hidden="true"><td colSpan={8} className="p-0" /></tr>
                )}
              </>
            ) : (
              tree.flatMap(({ id, childrenMap, visible }) => renderTreeRows(id, childrenMap, visible, 0, new Set()))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
