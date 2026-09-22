import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useInsightStore } from '../store/insightStore';
import { useEntityChanged } from '../lib/entityWatch';
import { readLastImport, forgetImport, type LastImport } from '../lib/lastImport';
import { fetchList } from '../lib/apiList';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import {
  RefreshCw, AlertTriangle, History, Check, Pencil, Eye, EyeOff, Settings, Network,
  ChevronRight, ChevronDown, Trash2, Tag as TagIcon, X, Plus, Boxes, Layers, Wind, ScanLine,
  Fan, Filter, Flame, Snowflake, Droplets, Recycle, Volume2, SlidersHorizontal, Box, Square,
  ArrowRight, LayoutGrid, List, Search, Save
} from 'lucide-react';
import DocImportWizard from '../components/DocImportWizard';
import ExchangeDialog from '../components/ExchangeDialog';
import { buildEquipmentExchange, equipmentColumns, type ExchangeComponent } from '../lib/equipmentExchange';
import { useModalStore } from '../store/modalStore';
import NoProject from '../components/NoProject';
import { useEscapeClose } from '../lib/useDismiss';

// Диалоги программы вместо системных окон Windows
const { openConfirm } = useModalStore.getState();

// ── Типы данных ──
interface Component {
  id: string; itemCode: string; name: string; equipType: string;
  specs?: string; overrides?: string; paramConflicts?: string;
  version: number; hasConflict: boolean; status: string;
  tags?: { id: string; identifier: string }[];
  // Состав: где позиция стоит и откуда взялась
  role?: string; parentElementId?: string | null;
  instanceNo?: number | null; instanceCount?: number | null;
  sourceOrder?: number | null; manual?: boolean;
}
// Тег в списке привязки: с занятостью (один тег — одно изделие)
interface PickerTag {
  id: string; identifier: string; department?: string; metadata?: string;
  componentElements?: { id: string; name: string; itemCode: string }[];
}
interface Monoblock { id: string; name: string; components: Component[]; }
interface SystemUnit { id: string; name: string; category: string; fileName?: string; monoblocks: Monoblock[]; }
interface Category { id: string; label: string; composite?: boolean; }

import { canDelete, deleteWarning, deletedNote } from '../lib/equipmentDelete';
import { normalizeSpecs, type SpecParam, type ParamConflict } from '../lib/specs';
import BlockCard from '../components/equipment/BlockCard';
import PositionTree, { blockLabel } from '../components/equipment/PositionTree';
import { rowsOfProject } from '../lib/equipmentRows';
import AddPositionDialog, { type AddPositionTarget } from '../components/equipment/AddPositionDialog';
import SaveViewDialog, { type ViewParam } from '../components/equipment/SaveViewDialog';

const api = (p: string) => `/api${p}`;

// ── Схема приточной установки: физический порядок секций по ходу воздуха ──
const SECTION_ORDER: Record<string, number> = {
  'ВОЗДУХОПРИЁМНЫЙ': 10, 'КЛАПАН': 20, 'ФИЛЬТР': 30, 'РЕКУПЕРАТОР': 40,
  'НАГРЕВАТЕЛЬ': 50, 'ОХЛАДИТЕЛЬ': 60, 'УВЛАЖНИТЕЛЬ': 70, 'ВЕНТИЛЯТОР': 80,
  'ШУМОГЛУШИТЕЛЬ': 90, 'КАМЕРА': 100, 'СЕКЦИЯ': 110, 'ЗАВЕСА': 120, 'ПРОЧЕЕ': 900,
};
const SECTION_ICON: Record<string, React.ComponentType<any>> = {
  'ВОЗДУХОПРИЁМНЫЙ': Wind, 'КЛАПАН': SlidersHorizontal, 'ФИЛЬТР': Filter, 'РЕКУПЕРАТОР': Recycle,
  'НАГРЕВАТЕЛЬ': Flame, 'ОХЛАДИТЕЛЬ': Snowflake, 'УВЛАЖНИТЕЛЬ': Droplets, 'ВЕНТИЛЯТОР': Fan,
  'ШУМОГЛУШИТЕЛЬ': Volume2, 'КАМЕРА': Box, 'СЕКЦИЯ': Square, 'ЗАВЕСА': Wind,
};
const sectionIcon = (t: string) => SECTION_ICON[t] || Square;
const SECTION_TINT: Record<string, string> = {
  'НАГРЕВАТЕЛЬ': 'text-orange-500', 'ОХЛАДИТЕЛЬ': 'text-sky-500', 'ВЕНТИЛЯТОР': 'text-emerald-500',
  'ФИЛЬТР': 'text-violet-500', 'УВЛАЖНИТЕЛЬ': 'text-cyan-500', 'РЕКУПЕРАТОР': 'text-teal-500',
};
const sectionTint = (t: string) => SECTION_TINT[t] || 'text-slate-500';

// Ключевые параметры для превью секции на схеме (первые непустые из specs,
// без повторов одного ключа — иначе две «Массы» подряд ничего не говорят)
function topSpecs(specs: string | undefined, n = 2): SpecParam[] {
  const g = normalizeSpecs(specs).groups;
  const out: SpecParam[] = [];
  const seen = new Set<string>();
  for (const grp of g) for (const p of (grp.params || [])) {
    const key = String(p?.key ?? '').trim().toLowerCase();
    if (p && String(p.value ?? '').trim() && !seen.has(key)) {
      seen.add(key);
      out.push(p);
      if (out.length >= n) return out;
    }
  }
  return out;
}

export default function Equipment() {
  const { activeProject, user } = useStore();
  const { addToast } = useToastStore();
  const isAdmin = user?.role === 'ADMIN';

  const [categories, setCategories] = useState<Category[]>([
    { id: 'AHU', label: 'Центральные кондиционеры', composite: true },
    { id: 'FAN', label: 'Радиальные вентиляторы' },
    { id: 'VALVE', label: 'Клапаны' },
    { id: 'CURTAIN', label: 'Воздушные завесы' },
  ]);
  const [activeCat, setActiveCat] = useState<string>('AHU');
  const [systems, setSystems] = useState<SystemUnit[]>([]);
  const [loading, setLoading] = useState(false);
  const [tags, setTags] = useState<PickerTag[]>([]);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [showAllParams, setShowAllParams] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [historyFor, setHistoryFor] = useState<Component | null>(null);
  const [historyData, setHistoryData] = useState<any[]>([]);
  const [tagPickerFor, setTagPickerFor] = useState<Component | null>(null);
  const [showDocImport, setShowDocImport] = useState(false);
  const [showExchange, setShowExchange] = useState(false);

  // Профиль видимости параметров по типу оборудования
  const [visibility, setVisibility] = useState<Record<string, string[]>>({}); // equipType -> ["g:группа","p:группа||ключ"]
  const [visMode, setVisMode] = useState<'admin' | 'self'>('admin');

  const pid = activeProject?.id || '';

  // ── Загрузка ──
  const loadCategories = useCallback(async () => {
    try {
      const r = await fetch(api('/equipment/categories')); const d = await r.json();
      if (d.categories) setCategories(d.categories);
    } catch (_) {}
  }, []);

  const loadSystems = useCallback(async () => {
    if (!pid) { setSystems([]); return; }
    setLoading(true);
    try {
      const r = await fetch(api(`/projects/${pid}/systems`)); const d = await r.json();
      setSystems(d.systems || []);
    } catch (_) { setSystems([]); }
    finally { setLoading(false); }
  }, [pid]);

  const loadTags = useCallback(async () => {
    if (!pid) return;
    try {
      const r = await fetch(api(`/projects/${pid}/tags`)); const d = await r.json();
      setTags(Array.isArray(d) ? d : (d.tags || []));
    } catch (_) {}
  }, [pid]);

  const loadVisibility = useCallback(async () => {
    if (!user) return;
    try {
      const [vis, mode] = await Promise.all([
        fetch(api(`/settings/equip_visibility?userId=${user.id}`)).then(r => r.json()),
        fetch(api(`/settings/equip_visibility_mode?userId=${user.id}`)).then(r => r.json()),
      ]);
      const m: 'admin' | 'self' = mode.user === 'self' ? 'self' : 'admin';
      setVisMode(m);
      const raw = m === 'self' && vis.user ? vis.user : vis.global;
      setVisibility(raw ? JSON.parse(raw) : {});
    } catch (_) { setVisibility({}); }
  }, [user]);

  useEffect(() => { loadCategories(); loadVisibility(); }, [loadCategories, loadVisibility]);
  useEffect(() => { loadSystems(); loadTags(); }, [loadSystems, loadTags]);

  // Сохранение профиля видимости (админ-для-всех или персонально)
  const persistVisibility = async (next: Record<string, string[]>) => {
    setVisibility(next);
    if (!user) return;
    const asGlobal = isAdmin && visMode === 'admin';
    await fetch(api('/settings/equip_visibility'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: asGlobal ? null : user.id, value: JSON.stringify(next) }),
    }).catch(() => {});
  };

  const switchVisMode = async (mode: 'admin' | 'self') => {
    setVisMode(mode);
    if (!user) return;
    await fetch(api('/settings/equip_visibility_mode'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user.id, value: mode }),
    }).catch(() => {});
    loadVisibility();
  };

  // ── Производные данные ──
  const catSystems = useMemo(() => systems.filter(s => s.category === activeCat), [systems, activeCat]);

  // Плоский список изделий для выгрузки: строка таблицы — одна единица
  // оборудования со своими тегами и характеристиками
  const exchangeItems = useMemo<ExchangeComponent[]>(
    () => rowsOfProject(systems as any, normalizeSpecs),
    [systems],
  );

  const exchangeScopes = useMemo(() => {
    const inCat = exchangeItems.filter(it => catSystems.some(s => s.name === it.systemName));
    const unit = selectedUnitId ? systems.find(s => s.id === selectedUnitId) : null;
    const list = [
      { id: 'category', label: `Категория «${categories.find(c => c.id === activeCat)?.label || activeCat}»`, count: inCat.length },
      { id: 'all', label: 'Всё оборудование проекта', count: exchangeItems.length },
    ];
    if (unit) list.unshift({ id: `unit:${unit.id}`, label: `Установка «${unit.name}»`, count: exchangeItems.filter(it => it.systemName === unit.name).length });
    // Первым предлагаем то, где строки есть: окно открывается на выбранном
    // сверху, и «не попала ни одна строка» вместо таблицы — плохое начало
    const nonEmpty = list.filter(x => x.count > 0);
    return nonEmpty.length ? [...nonEmpty, ...list.filter(x => x.count === 0)] : list;
  }, [exchangeItems, catSystems, systems, selectedUnitId, categories, activeCat]);

  const exchangeRows = (scopeId: string): ExchangeComponent[] => {
    if (scopeId === 'all') return exchangeItems;
    if (scopeId.startsWith('unit:')) {
      const unit = systems.find(s => s.id === scopeId.slice(5));
      return unit ? exchangeItems.filter(it => it.systemName === unit.name) : [];
    }
    return exchangeItems.filter(it => catSystems.some(s => s.name === it.systemName));
  };
  const catCount = useCallback((catId: string) => systems.filter(s => s.category === catId).length, [systems]);

  const allBlocks = useMemo(() => {
    const map: Record<string, { block: Component; unit: SystemUnit; mono: Monoblock }> = {};
    for (const s of systems) for (const mb of s.monoblocks) for (const c of mb.components) map[c.id] = { block: c, unit: s, mono: mb };
    return map;
  }, [systems]);

  const selected = selectedBlockId ? allBlocks[selectedBlockId] : null;
  const selectedUnit = useMemo(() => systems.find(s => s.id === selectedUnitId) || null, [systems, selectedUnitId]);

  // ── Фокус из ИИ-чата: открыть конкретный элемент и подсветить характеристику ──
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  useEffect(() => {
    if (!Object.keys(allBlocks).length) return;
    let payload: { componentId?: string; specKey?: string; ts?: number } | null = null;
    try { payload = JSON.parse(sessionStorage.getItem('flux_equip_focus') || 'null'); } catch (_) {}
    if (!payload?.componentId) return;
    // Просроченный фокус (старше минуты) не применяем
    if (!payload.ts || Date.now() - payload.ts > 60_000) { sessionStorage.removeItem('flux_equip_focus'); return; }
    const entry = allBlocks[payload.componentId];
    if (!entry) return; // элемент ещё не загружен или из другого проекта
    sessionStorage.removeItem('flux_equip_focus');
    setActiveCat(entry.unit.category);
    setExpanded(e => ({ ...e, [entry.unit.id]: true, [entry.mono.id]: true }));
    setSelectedUnitId(null);
    setSelectedBlockId(entry.block.id);
    setShowAllParams(false);
    if (payload.specKey) {
      setHighlightKey(payload.specKey);
      const t = setTimeout(() => setHighlightKey(null), 5000);
      return () => clearTimeout(t);
    }
  }, [allBlocks]);

  // ── Отмена ввоза расчёта ──
  // Массовая запись обязана отменяться (skill flux-data-safety §6). Сначала
  // показываем план — сколько вернём, сколько удалим и что обойдём стороной, —
  // и только по согласию человека применяем.
  const [undoable, setUndoable] = useState<LastImport | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  useEffect(() => { setUndoable(readLastImport(activeProject?.id || '')); }, [activeProject?.id, systems.length]);

  const undoImport = async () => {
    if (!undoable) return;
    setUndoBusy(true);
    try {
      const r = await fetch(`/api/equipment/import-undo/${encodeURIComponent(undoable.batchId)}`);
      const plan = await r.json();
      if (!r.ok) { addToast(plan.error || 'Не удалось построить план отмены', 'error'); return; }
      if (!plan.restore?.length && !plan.remove?.length) {
        addToast('Отменять нечего: данные после импорта уже изменились', 'info');
        forgetImport(activeProject?.id || ''); setUndoable(null);
        return;
      }
      const lines = [
        plan.restore.length ? `вернуть характеристики: ${plan.restore.length}` : '',
        plan.remove.length ? `удалить заведённое импортом: ${plan.remove.length}` : '',
        plan.skip.length ? `пропустить (правили после импорта): ${plan.skip.length}` : '',
      ].filter(Boolean).join('\n');
      const yes = await openConfirm('Отменить импорт расчёта?', `${lines}\n\nОтменить можно только один раз.`);
      if (!yes) return;
      const ar = await fetch('/api/equipment/import-undo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: undoable.batchId }),
      });
      const res = await ar.json();
      if (!ar.ok) { addToast(res.error || 'Не удалось отменить импорт', 'error'); return; }
      forgetImport(activeProject?.id || ''); setUndoable(null);
      await loadSystems();
      addToast(`Импорт отменён: вернули ${res.restored}, удалили ${res.removed}${res.skipped ? `, пропустили ${res.skipped}` : ''}`, 'success');
    } catch (e: any) {
      addToast('Не удалось отменить импорт', 'error');
    } finally { setUndoBusy(false); }
  };

  // ── Переход по ссылке: /equipment?element=… и ?system=… ──
  // Так сюда ведут проверка проекта, панель связей и общий поиск. Без этого
  // их ссылки открывали бы раздел «вообще», и элемент приходилось бы искать
  // руками — то есть ровно то, от чего связи и избавляют.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const elementId = searchParams.get('element');
    const systemId = searchParams.get('system');
    if (!elementId && !systemId) return;
    if (!Object.keys(allBlocks).length && !systems.length) return;  // данные ещё грузятся

    if (elementId) {
      const entry = allBlocks[elementId];
      if (!entry) return;   // ждём загрузки; если элемента нет вовсе — параметр снимется ниже
      setActiveCat(entry.unit.category);
      setExpanded(e => ({ ...e, [entry.unit.id]: true, [entry.mono.id]: true }));
      setSelectedUnitId(null);
      setSelectedBlockId(entry.block.id);
      setShowAllParams(false);
    } else if (systemId) {
      const unit = systems.find(x => x.id === systemId);
      if (!unit) return;
      setActiveCat(unit.category);
      setExpanded(e => ({ ...e, [unit.id]: true }));
      setSelectedBlockId(null);
      setSelectedUnitId(unit.id);
    }
    // Параметр гасим: иначе он сработает снова при любом возврате в раздел
    const next = new URLSearchParams(searchParams);
    next.delete('element'); next.delete('system');
    setSearchParams(next, { replace: true });
  }, [searchParams, allBlocks, systems]);

  const totalConflicts = useMemo(() =>
    catSystems.reduce((n, s) => n + s.monoblocks.reduce((m, mb) => m + mb.components.filter(c => c.hasConflict).length, 0), 0),
    [catSystems]);

  const toggle = (id: string) => setExpanded(e => ({ ...e, [id]: !e[id] }));

  // Позиция, внутрь которой заводят новую. Пусто — диалог закрыт
  const [addTo, setAddTo] = useState<AddPositionTarget | null>(null);
  // Карточка, с которой сохраняют шаблон вида. Пусто — диалог закрыт
  const [saveViewOf, setSaveViewOf] = useState<any | null>(null);

  /** Сохранить набор характеристик шаблоном вида — он появится в «Таблице». */
  const saveView = async (body: { name: string; scope: string; role: string; fields: ViewParam[] }): Promise<string> => {
    try {
      const res = await fetch(api('/equipment/view-templates'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return data?.error || 'Не удалось сохранить шаблон вида';
      addToast(`Шаблон вида «${body.name}» сохранён — он есть в «Таблице», полка «Шаблоны вида»`, 'success');
      return '';
    } catch (_) { return 'Сервер не ответил'; }
  };

  /**
   * Завести позицию руками.
   *
   * Отказ сервера показывается словами и в диалоге, а не всплывашкой: человек
   * стоит в форме, и исправлять написание тега ему прямо здесь.
   */
  const addPosition = async (body: { name: string; role: string; tag: string; params: { key: string; value: string; unit: string }[] }): Promise<string> => {
    try {
      const res = await fetch(api(`/equipment/component/${addTo?.id}/position`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return data?.error || 'Не удалось завести позицию';
      addToast(
        data?.parentTag ? `Позиция заведена, родитель тега — «${data.parentTag}»` : 'Позиция заведена',
        'success',
      );
      if (data?.warning) addToast(data.warning, 'info');
      loadSystems();
      return '';
    } catch (_) { return 'Сервер не ответил'; }
  };

  const isHidden = (equipType: string, token: string) => (visibility[equipType] || []).includes(token);
  const toggleHidden = (equipType: string, token: string) => {
    const cur = visibility[equipType] || [];
    const next = cur.includes(token) ? cur.filter(t => t !== token) : [...cur, token];
    persistVisibility({ ...visibility, [equipType]: next });
  };

  // ── Действия ──
  const resolveConflict = async (comp: Component, c: ParamConflict, action: 'accept' | 'manual', value?: string) => {
    const r = await fetch(api(`/equipment/component/${comp.id}/resolve`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: c.group, key: c.key, action, value }),
    });
    if (r.ok) { addToast(action === 'accept' ? 'Принято значение расчёта' : 'Сохранено вручную', 'success'); loadSystems(); }
  };

  const overrideParam = async (comp: Component, group: string, key: string, value: string) => {
    const r = await fetch(api(`/equipment/component/${comp.id}/override`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group, key, value }),
    });
    if (r.ok) { addToast('Параметр изменён', 'success'); loadSystems(); }
  };

  const openHistory = async (comp: Component) => {
    setHistoryFor(comp);
    // Сервер отдаёт { history: [...] }, а не голый массив: список достаём
    // разбором ответа, иначе .map по объекту уносит весь раздел
    const r = await fetch(api(`/components/${comp.id}/history`));
    setHistoryData(await fetchList(r, 'history'));
  };

  const linkTag = async (comp: Component, tagId: string) => {
    try {
      const r = await fetch(api(`/components/${comp.id}/tags/${tagId}`), { method: 'POST' });
      if (!r.ok) {
        // 409 = тег уже привязан к другому изделию (один тег — одно изделие)
        const d = await r.json().catch(() => ({}));
        addToast(d.error || 'Не удалось привязать тег', 'error');
        return;
      }
      addToast('Тег привязан', 'success');
    } catch (_) {
      addToast('Не удалось привязать тег', 'error');
    }
    setTagPickerFor(null); loadSystems(); loadTags();
  };
  const unlinkTag = async (comp: Component, tagId: string) => {
    await fetch(api(`/components/${comp.id}/tags/${tagId}`), { method: 'DELETE' }).catch(() => {});
    loadSystems(); loadTags();
  };

  const deleteUnit = async (unit: SystemUnit) => {
    if (!await openConfirm(`Удалить «${unit.name}»?`, 'Вместе с узлом удалится всё его оборудование. Действие необратимо.', { confirmLabel: 'Удалить', tone: 'danger' })) return;
    await fetch(api(`/systems/${unit.id}`), { method: 'DELETE' }).catch(() => {});
    addToast('Удалено', 'success'); setSelectedBlockId(null); loadSystems();
  };

  /** Убрать лишнюю позицию. Что предупредить и что сказать — в lib/equipmentDelete */
  const deleteComponent = async (c: Component) => {
    if (!await openConfirm(`Удалить «${blockLabel(c)}»?`, deleteWarning(c as any), { confirmLabel: 'Удалить', tone: 'danger' })) return;
    try {
      const res = await fetch(api(`/equipment/component/${c.id}`), { method: 'DELETE' });
      if (!res.ok) throw new Error('отказ сервера');
      if (selectedBlockId === c.id) setSelectedBlockId(null);
      addToast(deletedNote(c as any), 'success');
      loadSystems();
    } catch (_) { addToast('Не удалось удалить позицию', 'error'); }
  };

  const catIcon = (id: string) => id === 'FAN' ? <Wind className="w-4 h-4" /> : id === 'AHU' ? <Boxes className="w-4 h-4" /> : <Layers className="w-4 h-4" />;

  if (!activeProject) {
    return (
      <NoProject what="Оборудование" />
    );
  }

  return (
    <div className="h-full flex flex-col sheet text-slate-800 dark:text-slate-100">
      {undoable && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/25 border-b border-amber-200 dark:border-amber-900/40 text-xs text-amber-900 dark:text-amber-200">
          <RefreshCw className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1 min-w-0 truncate">
            Импорт расчёта от {new Date(undoable.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            {undoable.files > 1 ? ` · файлов: ${undoable.files}` : ''} — можно отменить
          </span>
          <button type="button" onClick={undoImport} disabled={undoBusy}
            className="shrink-0 px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-bold cursor-pointer disabled:opacity-50">
            {undoBusy ? 'Отменяю…' : 'Отменить импорт'}
          </button>
          <button type="button" onClick={() => { forgetImport(activeProject?.id || ''); setUndoable(null); }}
            title="Больше не предлагать" className="shrink-0 p-0.5 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40 cursor-pointer">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 flex overflow-x-auto">
      {/* КАТЕГОРИИ */}
      <div className="zone w-12 @[820px]:w-40 @[1060px]:w-56 shrink-0 flex flex-col overflow-hidden">
        <div className="px-2 @[820px]:px-3 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-center @[820px]:justify-between">
          <span className="hidden @[820px]:inline text-sm font-bold">Категории</span>
          <button type="button" onClick={() => setShowSettings(true)} className="p-1 text-slate-400 hover:text-emerald-600 cursor-pointer" title="Настройки оборудования"><Settings className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {categories.map(c => {
            const n = catCount(c.id);
            const act = c.id === activeCat;
            return (
              <button type="button" key={c.id} onClick={() => { setActiveCat(c.id); setSelectedBlockId(null); }}
                title={n > 0 ? `${c.label} · ${n}` : c.label}
                className={`w-full flex items-center justify-center @[820px]:justify-start gap-2 px-1.5 @[820px]:px-2.5 py-2 rounded-lg text-left text-xs font-semibold transition-colors cursor-pointer ${act ? 'bg-emerald-600 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'}`}>
                {catIcon(c.id)}
                <span className="hidden @[820px]:block flex-1 truncate">{c.label}</span>
                {n > 0 && <span className={`hidden @[820px]:inline text-2xs px-1.5 py-0.5 rounded-full ${act ? 'bg-white/20' : 'bg-slate-200 dark:bg-slate-700'}`}>{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="p-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
          <button type="button"
            data-tour="equipment-import-btn"
            onClick={() => setShowDocImport(true)}
            className="w-full flex items-center justify-center gap-1.5 px-1.5 @[820px]:px-2.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer transition-colors"
            title="Импорт из документов: распознать бланк, ведомость или страницу каталога — PDF, Excel, Word, XML"
          >
            <ScanLine className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden @[820px]:inline">Импорт из документов</span>
          </button>
          <button type="button"
            onClick={() => setShowExchange(true)}
            className="w-full flex items-center justify-center gap-1.5 px-1.5 @[820px]:px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:text-emerald-600 text-xs font-bold cursor-pointer transition-colors"
            title="Выгрузить оборудование в Excel: тег, установка, характеристики"
          >
            <ArrowRight className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden @[820px]:inline">Выгрузить в Excel</span>
          </button>
          <div className="hidden @[820px]:block text-2xs text-slate-400 text-center">
            PDF · Excel · Word · XML, или расчёт через «Проводник»
          </div>
        </div>
      </div>

      {showExchange && (
        <ExchangeDialog
          section="Оборудование"
          scopes={exchangeScopes}
          columns={equipmentColumns(exchangeItems)}
          build={(scopeId, cols) => buildEquipmentExchange(exchangeRows(scopeId), cols)}
          onClose={() => setShowExchange(false)}
        />
      )}

      {addTo && (
        <AddPositionDialog target={addTo} onClose={() => setAddTo(null)} onSubmit={addPosition} />
      )}

      {saveViewOf && (
        <SaveViewDialog
          role={saveViewOf.role || saveViewOf.equipType || 'ПРОЧЕЕ'}
          params={saveViewOf.params}
          preselected={saveViewOf.preselected}
          onClose={() => setSaveViewOf(null)}
          onSubmit={saveView}
        />
      )}

      {showDocImport && (
        <DocImportWizard
          projectId={pid}
          categories={categories}
          onClose={() => setShowDocImport(false)}
          onImported={() => { loadSystems(); }}
        />
      )}

      {/* ДЕРЕВО: состав отступом, порядок — по алфавиту тега */}
      <PositionTree
        title={categories.find(c => c.id === activeCat)?.label || activeCat}
        units={catSystems as any}
        loading={loading}
        conflicts={totalConflicts}
        expanded={expanded}
        selectedUnitId={selectedUnitId}
        selectedBlockId={selectedBlockId}
        onToggle={toggle}
        onPickUnit={(u) => { setSelectedUnitId(u.id); setSelectedBlockId(null); setExpanded(e => ({ ...e, [u.id]: true })); }}
        onPickBlock={(c) => { setSelectedBlockId(c.id); setSelectedUnitId(null); setShowAllParams(false); }}
        onReload={loadSystems}
        onDeleteUnit={(u) => deleteUnit(u as any)}
        onDeleteComponent={(c) => deleteComponent(c as any)}
        onAddPosition={(c) => setAddTo({ id: c.id, name: blockLabel(c as any), role: c.role })}
      />

      {/* КАРТОЧКА БЛОКА */}
      <div className="zone flex-1 min-w-[280px] overflow-hidden flex flex-col">
        {selected ? (
          <BlockCard
            comp={selected.block}
            unitName={selected.unit.name}
            showAllParams={showAllParams}
            setShowAllParams={setShowAllParams}
            isHidden={isHidden}
            toggleHidden={toggleHidden}
            onReload={loadSystems}
            onResolve={resolveConflict}
            onOverride={overrideParam}
            onHistory={() => openHistory(selected.block)}
            onSaveView={() => {
              const groups = normalizeSpecs(selected.block.specs).groups;
              const params = groups.flatMap((g: any) => (g.params || []).map((p: any) => ({ group: g.title, key: p.key, unit: p.unit || '' })));
              // Отмечено заранее то, что человек сейчас видит: профиль
              // видимости — это уже ответ на вопрос «какие поля нужны»
              const preselected = params
                .filter((p: any) => !isHidden(selected.block.equipType, `p:${p.group}||${p.key}`)
                  && !isHidden(selected.block.equipType, `g:${p.group}`))
                .map((p: any) => `${p.group}||${p.key}`);
              setSaveViewOf({ role: selected.block.role, equipType: selected.block.equipType, params, preselected });
            }}
            onPickTag={() => setTagPickerFor(selected.block)}
            onUnlinkTag={(tid: string) => unlinkTag(selected.block, tid)}
            blockLabel={blockLabel}
            onBackToUnit={selected.unit.category === 'AHU' || (selected.unit.monoblocks || []).some(mb => (mb.components || []).length > 1)
              ? () => { setSelectedUnitId(selected.unit.id); setSelectedBlockId(null); }
              : null}
            highlightKey={highlightKey}
          />
        ) : selectedUnit ? (
          <UnitSchematic
            unit={selectedUnit}
            blockLabel={blockLabel}
            onSelectBlock={(id: string) => { setSelectedBlockId(id); setSelectedUnitId(null); setShowAllParams(false); }}
            onPickTag={(comp: Component) => setTagPickerFor(comp)}
            onUnlinkTag={(comp: Component, tid: string) => unlinkTag(comp, tid)}
          />
        ) : (
          <div className="blank">
              <div className="blank-title">Ничего не выбрано</div>
              <div className="blank-text">Выберите установку в дереве слева — здесь появятся её схема, характеристики и связанные теги.</div>
            </div>
        )}
      </div>

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          categories={categories} setCategories={setCategories}
          isAdmin={isAdmin} visMode={visMode} switchVisMode={switchVisMode}
          addToast={addToast}
        />
      )}

      {historyFor && (
        <Modal title={`История: ${blockLabel(historyFor)} (v${historyFor.version})`} onClose={() => setHistoryFor(null)}>
          {historyData.length === 0 ? <p className="text-xs text-slate-400">Изменений ещё не было.</p> : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {historyData.map((h: any) => (
                <div key={h.id} className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs">
                  <div className="font-bold text-slate-500">v{h.version} · {new Date(h.changedAt).toLocaleString('ru-RU')}</div>
                  <div className="text-slate-400 mt-0.5">{h.changeType}</div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {tagPickerFor && (
        <TagPickerModal
          tags={tags}
          currentComponentId={tagPickerFor.id}
          onPick={(tagId) => linkTag(tagPickerFor, tagId)}
          onClose={() => setTagPickerFor(null)}
        />
      )}
      </div>
    </div>
  );
}

// ── Схема установки: кликабельный «чертёж» из секций ──
function UnitSchematic({ unit, blockLabel, onSelectBlock, onPickTag, onUnlinkTag }: {
  unit: SystemUnit;
  blockLabel: (c: Component) => string;
  onSelectBlock: (id: string) => void;
  onPickTag?: (comp: Component) => void;
  onUnlinkTag?: (comp: Component, tagId: string) => void;
}) {
  // Разбираем компоненты установки: общие параметры vs. секции (составные части)
  const { generalComp, monoGenerals, monoSections } = useMemo(() => {
    let generalComp: Component | null = null;
    const monoGenerals: Component[] = [];
    const monoSections: { mono: Monoblock; sections: Component[] }[] = [];
    for (const mb of unit.monoblocks || []) {
      const sections: Component[] = [];
      for (const c of mb.components || []) {
        if (c.itemCode === '__unit__') generalComp = c;
        else if (c.itemCode.endsWith('_общие')) monoGenerals.push(c);
        else sections.push(c);
      }
      if (sections.length) monoSections.push({ mono: mb, sections });
    }
    return { generalComp, monoGenerals, monoSections };
  }, [unit]);

  // Плоский список секций в порядке движения воздуха (для схемы-чертежа)
  const flowSections = useMemo(() => {
    const all: Component[] = [];
    monoSections.forEach(m => m.sections.forEach(s => all.push(s)));
    return all
      .map((c, idx) => ({ c, idx, ord: SECTION_ORDER[c.equipType] ?? 500 }))
      .sort((a, b) => (a.ord - b.ord) || (a.idx - b.idx))
      .map(x => x.c);
  }, [monoSections]);

  const generalSpecs = generalComp ? normalizeSpecs(generalComp.specs).groups : [];
  // Повторяющиеся ключи («Масса» в трёх группах) уточняем названием группы,
  // чтобы значения не выглядели противоречащими друг другу
  const generalParams = useMemo(() => {
    const flat = generalSpecs.flatMap(g =>
      (g.params || [])
        .filter(p => String(p.value ?? '').trim())
        .map(p => ({ ...p, groupTitle: g.title }))
    );
    const keyCount: Record<string, number> = {};
    for (const p of flat) {
      const k = String(p.key).trim().toLowerCase();
      keyCount[k] = (keyCount[k] || 0) + 1;
    }
    return flat.slice(0, 12).map(p => ({
      ...p,
      key: keyCount[String(p.key).trim().toLowerCase()] > 1 && p.groupTitle && p.groupTitle !== 'Параметры'
        ? `${p.key} · ${p.groupTitle}`
        : p.key,
    }));
  }, [generalComp?.specs]);
  const totalSections = flowSections.length;

  return (
    <>
      <div
        data-share-route="/equipment"
        data-share-focus={`unit:${unit.id}`}
        data-share-label={`Схема установки: ${unit.name}`}
        className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-2 py-0.5 rounded-md bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 text-2xs font-bold uppercase tracking-wider">Установка</span>
            {unit.fileName && <span className="text-2xs text-slate-400 font-mono truncate max-w-[220px]" title={unit.fileName}>{unit.fileName}</span>}
          </div>
          <h3 className="u-sel text-sm font-bold mt-1 min-w-0 flex items-center gap-1.5"><Boxes className="w-4 h-4 text-emerald-600 shrink-0" /><span className="flex-1 min-w-0 truncate">{unit.name}</span></h3>
          <p className="text-xs text-slate-400 mt-0.5">{totalSections} {totalSections === 1 ? 'секция' : totalSections >= 2 && totalSections <= 4 ? 'секции' : 'секций'} · нажмите на секцию, чтобы открыть её характеристики</p>
          {/* Тег на установку целиком (через компонент «Параметры установки») */}
          {generalComp && (
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              {(generalComp.tags || []).map((t: any) => (
                <span key={t.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/40 text-2xs text-emerald-700 dark:text-emerald-300">
                  <TagIcon className="w-2.5 h-2.5" /><span className="u-sel">{t.identifier}</span>
                  {onUnlinkTag && (
                    <button type="button" onClick={() => onUnlinkTag(generalComp!, t.id)} className="hover:text-rose-500 cursor-pointer" title="Отвязать тег от установки"><X className="w-2.5 h-2.5" /></button>
                  )}
                </span>
              ))}
              {onPickTag && (
                <button type="button"
                  onClick={() => onPickTag(generalComp!)}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-dashed border-slate-300 dark:border-slate-600 text-2xs text-slate-500 hover:border-emerald-400 hover:text-emerald-600 cursor-pointer"
                  title="Назначить тег всей установке"
                >
                  <Plus className="w-2.5 h-2.5" />тег установки
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Общие характеристики установки */}
        {generalParams.length > 0 && (
          <div>
            <div className="text-2xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">Общие характеристики установки</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 rounded-lg border border-slate-150 dark:border-slate-800 p-2.5">
              {generalParams.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-xs py-0.5 min-w-0">
                  <span className="u-sel text-slate-500 dark:text-slate-400 flex-1 min-w-0 truncate" title={p.key}>{p.key}</span>
                  <span className="u-sel font-semibold text-slate-800 dark:text-slate-100 shrink-0 text-right">{p.value}{p.unit ? <span className="text-slate-400 font-normal"> {p.unit}</span> : ''}</span>
                </div>
              ))}
            </div>
            {generalComp && (
              <button type="button" onClick={() => onSelectBlock(generalComp!.id)} className="mt-1.5 text-xs text-emerald-600 hover:text-emerald-700 font-semibold cursor-pointer">
                Все параметры установки →
              </button>
            )}
          </div>
        )}

        {/* Чертёж: секции по ходу воздуха */}
        {flowSections.length > 0 && (
          <div>
            <div className="text-2xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5"><LayoutGrid className="w-3 h-3" />Схема установки</div>
            <div className="flex items-stretch gap-1 overflow-x-auto pb-2 -mx-1 px-1">
              {flowSections.map((c, i) => {
                const Icon = sectionIcon(c.equipType);
                const tint = sectionTint(c.equipType);
                const preview = topSpecs(c.specs, 2);
                return (
                  <React.Fragment key={c.id}>
                    {i > 0 && <div className="flex items-center shrink-0 text-slate-300 dark:text-slate-500"><ArrowRight className="w-4 h-4" /></div>}
                    <button type="button"
                      onClick={() => onSelectBlock(c.id)}
                      title={`${blockLabel(c)} — открыть характеристики`}
                      className="group shrink-0 w-32 flex flex-col items-center text-center gap-1.5 p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 hover:border-emerald-400 hover:bg-emerald-50/60 dark:hover:bg-emerald-950/20 transition-colors cursor-pointer">
                      <span className={`w-9 h-9 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-center ${tint} group-hover:scale-105 transition-transform`}>
                        <Icon className="w-5 h-5" />
                      </span>
                      <span className="text-xs font-bold leading-tight line-clamp-2 text-slate-700 dark:text-slate-300">{blockLabel(c)}</span>
                      {preview.length > 0 && (
                        <div className="w-full space-y-0.5">
                          {preview.map((p, k) => (
                            <div key={k} className="text-2xs text-slate-400 leading-tight truncate">{p.value}{p.unit ? ` ${p.unit}` : ''}</div>
                          ))}
                        </div>
                      )}
                      {c.hasConflict && <span className="text-2xs font-bold text-rose-500">изменилось</span>}
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        )}

        {/* Список составных частей (сохраняем привычный список) */}
        <div>
          <div className="text-2xs font-bold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-1.5"><List className="w-3 h-3" />Составные части</div>
          {monoSections.length === 0 && monoGenerals.length === 0 ? (
            <p className="text-xs text-slate-400">У этой установки нет составных частей.</p>
          ) : (
            <div className="space-y-3">
              {monoSections.map(({ mono, sections }) => (
                <div key={mono.id}>
                  {mono.name !== '__unit__' && (
                    <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1 flex items-center gap-1.5"><Layers className="w-3 h-3" />{mono.name}</div>
                  )}
                  <div className="rounded-lg border border-slate-150 dark:border-slate-800 overflow-hidden divide-y divide-slate-100 dark:divide-slate-850">
                    {sections.map(c => {
                      const Icon = sectionIcon(c.equipType);
                      return (
                        <button type="button" key={c.id} onClick={() => onSelectBlock(c.id)} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-800/50 text-left cursor-pointer">
                          <Icon className={`w-3.5 h-3.5 shrink-0 ${sectionTint(c.equipType)}`} />
                          <span className="flex-1 min-w-0 truncate text-slate-700 dark:text-slate-300">{blockLabel(c)}</span>
                          {(c.tags?.length || 0) > 0 && <TagIcon className="w-3 h-3 text-emerald-500 shrink-0" />}
                          {c.hasConflict && <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />}
                          <ChevronRight className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {monoGenerals.map(c => (
                <button type="button" key={c.id} onClick={() => onSelectBlock(c.id)} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-lg border border-slate-150 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-left cursor-pointer">
                  <Layers className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                  <span className="flex-1 min-w-0 truncate text-slate-700 dark:text-slate-300">{blockLabel(c)}</span>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Карточка блока ──
// ── Выбор тега для привязки: поиск + занятость (один тег — одно изделие) ──
function TagPickerModal({ tags, currentComponentId, onPick, onClose }: {
  tags: PickerTag[];
  currentComponentId: string;
  onPick: (tagId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');

  const tagName = (t: PickerTag): string => {
    try { return t.metadata ? (JSON.parse(t.metadata).mainName || '') : ''; } catch { return ''; }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? tags.filter(t =>
          t.identifier.toLowerCase().includes(q) ||
          (t.department || '').toLowerCase().includes(q) ||
          tagName(t).toLowerCase().includes(q))
      : tags;
    // Свободные теги сверху, занятые — в конце списка
    return [...list].sort((a, b) => {
      const aBusy = (a.componentElements?.length || 0) > 0 ? 1 : 0;
      const bBusy = (b.componentElements?.length || 0) > 0 ? 1 : 0;
      if (aBusy !== bBusy) return aBusy - bBusy;
      return a.identifier.localeCompare(b.identifier, 'ru');
    });
  }, [tags, query]);

  return (
    <Modal title="Привязать тег" onClose={onClose}>
      <div className="relative mb-2">
        <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-slate-400" />
        <input
          autoFocus
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск: обозначение, наименование, отдел…"
          className="w-full pl-8 pr-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-xs focus:outline-none focus:border-emerald-500 text-slate-800 dark:text-slate-100"
        />
      </div>
      <p className="text-2xs text-slate-400 mb-2">Один тег — одно изделие: занятые теги показаны серым, сначала отвяжите их на текущем месте.</p>
      <div className="max-h-80 overflow-y-auto space-y-1">
        {tags.length === 0 ? (
          <p className="text-xs text-slate-400">В проекте нет тегов. Создайте их в разделе «Теги».</p>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-4">Ничего не найдено по запросу «{query}».</p>
        ) : filtered.map(t => {
          const holder = (t.componentElements || []).find(c => c.id !== currentComponentId);
          const linkedHere = (t.componentElements || []).some(c => c.id === currentComponentId);
          const busy = !!holder || linkedHere;
          const name = tagName(t);
          return (
            <button type="button"
              key={t.id}
              disabled={busy}
              onClick={() => onPick(t.id)}
              title={linkedHere ? 'Уже привязан к этому изделию' : holder ? `Занят: ${holder.name || holder.itemCode}` : 'Привязать'}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-xs ${busy
                ? 'opacity-45 cursor-not-allowed'
                : 'hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer'}`}
            >
              <TagIcon className={`w-3.5 h-3.5 shrink-0 ${busy ? 'text-slate-400' : 'text-emerald-500'}`} />
              <span className="font-mono font-bold shrink-0">{t.identifier}</span>
              {name && <span className="text-slate-400 truncate">{name}</span>}
              <span className="ml-auto flex items-center gap-1.5 shrink-0">
                {t.department && <span className="text-2xs text-slate-400">{t.department}</span>}
                {linkedHere && <span className="text-2xs font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/50 text-emerald-600">привязан</span>}
                {holder && <span className="text-2xs font-bold px-1.5 py-0.5 rounded-full bg-slate-200 dark:bg-slate-800 text-slate-500" title={`Занят: ${holder.name || holder.itemCode}`}>занят · {holder.name || holder.itemCode}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

// ── Универсальная модалка ──
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEscapeClose(true, onClose);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/55 backdrop-blur-md" onClick={onClose}>
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-2xl p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold">{title}</h3>
          <button type="button" title="Закрыть" onClick={onClose} className="p-1 text-slate-400 hover:text-rose-500 cursor-pointer"><X className="w-5 h-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Настройки оборудования ──
function SettingsModal({ onClose, categories, setCategories, isAdmin, visMode, switchVisMode, addToast }: any) {
  const [conflictMode, setConflictMode] = useState<'immediate' | 'wait'>('wait');
  const [newCat, setNewCat] = useState('');

  useEffect(() => {
    fetch(api('/settings/equip_conflict_mode')).then(r => r.json()).then(d => {
      if (d.global === 'immediate') setConflictMode('immediate');
    }).catch(() => {});
  }, []);

  const saveConflictMode = async (m: 'immediate' | 'wait') => {
    setConflictMode(m);
    await fetch(api('/settings/equip_conflict_mode'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: null, value: m }) }).catch(() => {});
  };

  const addCategory = async () => {
    const label = newCat.trim(); if (!label) return;
    const id = 'C' + Date.now();
    const next = [...categories, { id, label, composite: false }];
    setCategories(next); setNewCat('');
    await fetch(api('/equipment/categories'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categories: next }) }).catch(() => {});
    addToast('Категория добавлена', 'success');
  };
  const removeCategory = async (id: string) => {
    const next = categories.filter((c: Category) => c.id !== id);
    setCategories(next);
    await fetch(api('/equipment/categories'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categories: next }) }).catch(() => {});
  };

  return (
    <Modal title="Настройки оборудования" onClose={onClose}>
      <div className="space-y-5">
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Профиль видимости параметров</div>
          <div className="flex gap-2">
            <button type="button" disabled={!isAdmin} onClick={() => switchVisMode('admin')} className={`flex-1 py-2 rounded-lg border text-xs font-semibold cursor-pointer ${visMode === 'admin' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800'} ${!isAdmin ? 'opacity-50 cursor-not-allowed' : ''}`}>Админ (для всех)</button>
            <button type="button" onClick={() => switchVisMode('self')} className={`flex-1 py-2 rounded-lg border text-xs font-semibold cursor-pointer ${visMode === 'self' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800'}`}>Только для меня</button>
          </div>
          <p className="text-2xs text-slate-400 mt-1.5">Скрывать параметры удобно в карточке блока (значок «глаз» в режиме «показать все»). {visMode === 'admin' ? 'Сейчас изменения применяются ко всем.' : 'Сейчас изменения только для вас.'}</p>
        </div>

        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">При новой ревизии</div>
          <div className="flex gap-2">
            <button type="button" onClick={() => saveConflictMode('wait')} className={`flex-1 py-2 rounded-lg border text-xs font-semibold cursor-pointer ${conflictMode === 'wait' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800'}`}>Ждать решения (✓/✎)</button>
            <button type="button" onClick={() => saveConflictMode('immediate')} className={`flex-1 py-2 rounded-lg border text-xs font-semibold cursor-pointer ${conflictMode === 'immediate' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800'}`}>Изменять сразу</button>
          </div>
        </div>

        {isAdmin && (
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Категории оборудования</div>
            <div className="space-y-1 mb-2 max-h-40 overflow-y-auto">
              {categories.map((c: Category) => (
                <div key={c.id} className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-950 text-xs">
                  <span>{c.label}</span>
                  {!['AHU', 'FAN', 'VALVE', 'CURTAIN'].includes(c.id) && <button type="button" onClick={() => removeCategory(c.id)} className="text-slate-400 hover:text-rose-500 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>}
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="Новая категория…" className="flex-1 min-w-0 px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-xs" />
              <button type="button" onClick={addCategory} className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold cursor-pointer">Добавить</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
