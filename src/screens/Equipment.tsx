import { SectionHead, Btn, IconBtn, Dialog } from '../components/ui';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useInsightStore } from '../store/insightStore';
import { useEntityChanged } from '../lib/entityWatch';
import { readLastImport, forgetImport, type LastImport } from '../lib/lastImport';
import { fetchList } from '../lib/apiList';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import { RefreshCw, AlertTriangle, History, Check, Pencil, Eye, EyeOff, Settings, Network, ChevronRight, ChevronDown, Trash2, Tag as TagIcon, X, Plus, Boxes, Layers, Wind, ScanLine, Fan, Filter, Flame, Snowflake, Droplets, Recycle, Volume2, SlidersHorizontal, Box, Square, ArrowRight, LayoutGrid, List, Search, Save, Download } from 'lucide-react';
import DocImportWizard from '../components/DocImportWizard';
import UnitSchematic from '../components/equipment/UnitSchematic';
import { useModalStore } from '../store/modalStore';
import NoProject from '../components/NoProject';
import { useEscapeClose } from '../lib/useDismiss';
import { hasAdminRole } from '../lib/permissions';

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
  sourceKind?: string | null; equipClass?: string | null; equipKind?: string | null;
}
interface Monoblock { id: string; name: string; components: Component[]; }
interface SystemUnit { id: string; name: string; category: string; fileName?: string; monoblocks: Monoblock[]; }
interface Category { id: string; label: string; composite?: boolean; }

import { canDelete, deleteWarning, deletedNote } from '../lib/equipmentDelete';
import { normalizeSpecs, type SpecParam, type ParamConflict } from '../lib/specs';
import BlockCard from '../components/equipment/BlockCard';
import PositionTree, { blockLabel, type TreeMode } from '../components/equipment/PositionTree';
import PositionList from '../components/equipment/PositionList';
import { classifyAll, classTitle } from '../../equipment/classes';
import { compareTags } from '../../equipment/notes';
import { compositionView } from '../lib/cardComposition';
import CategoryViewDialog from '../components/equipment/CategoryViewDialog';
import { useCategoryView } from '../components/equipment/useCategoryView';
import { arrange, isHiddenIn, toggleIn, viewOf } from '../lib/categoryView';
import AddPositionDialog, { type AddPositionTarget, type AddPositionBody } from '../components/equipment/AddPositionDialog';
import TagPickerModal, { type PickerTag } from '../components/equipment/TagPickerModal';
import { compositionOf } from '../../equipment/composition';
import SaveViewDialog, { type ViewParam } from '../components/equipment/SaveViewDialog';
import ImportOperations, { type OperationBatch } from '../components/equipment/ImportOperations';

import { useShallow } from 'zustand/react/shallow';
const api = (p: string) => `/api${p}`;

export default function Equipment() {
  const { activeProject, user } = useStore(useShallow((s: ReturnType<typeof useStore.getState>) => ({ activeProject: s.activeProject, user: s.user })));
  const { addToast } = useToastStore();
  const isAdmin = hasAdminRole(user as any);

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
  const navigate = useNavigate();

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
      const r = await fetch(api(`/projects/${pid}/systems?removed=1`)); const d = await r.json();
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

  // Прежний профиль видимости только читается: писать в него больше нечему — вид
  // теперь живёт на категорию и тип (useCategoryView), а старое переезжает туда
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
  // Установки категории — по алфавиту тега, естественно: B01 раньше B05, а
  // «001B» после «001A». Раньше шли в порядке ввоза, и найти нужную было нельзя
  // Снятые позиции (пропали из расчёта или заменены) скрыты, пока не включён
  // переключатель: действующее оборудование не должно тонуть в снятом
  const [showRemoved, setShowRemoved] = useState(() => {
    try { return localStorage.getItem('flux_equip_removed') === '1'; } catch (_) { return false; }
  });
  const chooseShowRemoved = (v: boolean) => {
    setShowRemoved(v);
    try { localStorage.setItem('flux_equip_removed', v ? '1' : '0'); } catch (_) { /* приватный режим */ }
  };
  const inCat = useMemo(() => systems.filter(s => s.category === activeCat), [systems, activeCat]);
  const removedCount = useMemo(() => inCat.reduce((n, s) => n + s.monoblocks.reduce((m, mb) => m + mb.components.filter(c => c.status === 'REMOVED').length, 0), 0), [inCat]);
  const catSystems = useMemo(() => inCat
    .map(s => (showRemoved ? s : { ...s, monoblocks: s.monoblocks.map(mb => ({ ...mb, components: mb.components.filter(c => c.status !== 'REMOVED') })) }))
    .sort((a, b) => compareTags(a.name, b.name)), [inCat, showRemoved]);

  const catCount = useCallback((catId: string) => systems.filter(s => s.category === catId).length, [systems]);

  const allBlocks = useMemo(() => {
    const map: Record<string, { block: Component; unit: SystemUnit; mono: Monoblock }> = {};
    for (const s of systems) for (const mb of s.monoblocks) for (const c of mb.components) map[c.id] = { block: c, unit: s, mono: mb };
    return map;
  }, [systems]);

  const selected = selectedBlockId ? allBlocks[selectedBlockId] : null;
  // Тип и вид каждой позиции — одним правилом на дерево, список, карточку и выгрузку
  const types = useMemo(() => classifyAll(Object.values(allBlocks).map(x => x.block) as any), [allBlocks]);
  const [listMode, setListMode] = useState(false);
  const [treeMode, setTreeMode] = useState<TreeMode>(() => {
    try { return localStorage.getItem('flux_equip_tree') === 'type' ? 'type' : 'composition'; } catch (_) { return 'composition'; }
  });
  const chooseTreeMode = (m: TreeMode) => {
    setTreeMode(m);
    try { localStorage.setItem('flux_equip_tree', m); } catch (_) { /* приватный режим */ }
  };
  const openBlock = (id: string) => {
    const e = allBlocks[id];
    if (e) setExpanded(x => ({ ...x, [e.unit.id]: true, [e.mono.id]: true }));
    setSelectedBlockId(id); setSelectedUnitId(null); setShowAllParams(false); setListMode(false);
  };
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

  // ── Центр операций: что ввозится в фоне ──
  const [showOps, setShowOps] = useState(false);
  const [ops, setOps] = useState<OperationBatch[]>([]);
  const [opsLoading, setOpsLoading] = useState(false);

  const loadOps = useCallback(async () => {
    if (!pid) return;
    setOpsLoading(true);
    try {
      const r = await fetch(api(`/import-jobs?projectId=${pid}`));
      const d = await r.json();
      setOps(Array.isArray(d?.batches) ? d.batches : []);
    } catch (_) { /* сервер не ответил — центр покажет прежнее */ }
    finally { setOpsLoading(false); }
  }, [pid]);

  /**
   * Пока партия не закончилась, состояние перечитывается само.
   *
   * Опрос, а не сокет: ввоз идёт минутами, и три секунды задержки здесь ничего
   * не решают, а вот лишний канал доставки — это ещё одно место, где «у меня не
   * обновилось». Как только незаконченных партий не осталось, опрос гаснет.
   */
  useEffect(() => {
    if (!showOps) return;
    loadOps();
    const live = ops.some(b => b.state === 'RUNNING');
    if (!live) return;
    const t = setInterval(loadOps, 3000);
    return () => clearInterval(t);
  }, [showOps, loadOps, ops.length, ops.map(b => `${b.id}:${b.done}:${b.state}`).join(',')]);

  const cancelOps = async (batchId: string) => {
    try {
      const r = await fetch(api(`/import-jobs/${batchId}/cancel`), { method: 'POST' });
      const d = await r.json();
      addToast(d?.note || 'Отменено', d?.running ? 'info' : 'success');
    } catch (_) { addToast('Не удалось отменить', 'error'); }
    loadOps();
  };

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
  const addPosition = async (body: AddPositionBody): Promise<string> => {
    try {
      const url = addTo?.id ? `/equipment/component/${addTo.id}/position` : `/equipment/monoblock/${addTo?.monoblockId}/position`;
      const res = await fetch(api(url), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return data?.error || 'Не удалось завести позицию';
      addToast(
        data?.parentTag ? `Позиция заведена, родитель тега — «${data.parentTag}»` : 'Позиция заведена',
        'success',
      );
      if (data?.tag?.corrected) addToast(`Тег исправлен: ${data.tag.corrected.what} — записан «${data.tag.identifier}»`, 'info');
      if (data?.warning) addToast(data.warning, 'info');
      loadSystems(); loadTags();
      return '';
    } catch (_) { return 'Сервер не ответил'; }
  };

  // Вид категории — по типу оборудования (lib/categoryView). Прежние скрытия по
  // equipType читаются, пока у типа нет своего вида, и переезжают первой правкой
  const catView = useCategoryView(activeCat, user?.id, !isAdmin || visMode === 'self');
  const [viewOpen, setViewOpen] = useState(false);
  const clsOf = (c: Component) => types.get(c.id)?.cls || 'ПРОЧЕЕ';
  // Тег родителя по составу — от него приставка нового тега в окнах привязки
  const parentTagOf = (c: Component, inside = false) => {
    const e = allBlocks[c.id];
    if (!e) return '';
    if (inside && c.tags?.[0]?.identifier) return c.tags[0].identifier;
    return compositionOf(e.unit.monoblocks.flatMap(m => m.components) as any, e.unit.name).parentTagOf(c as any);
  };
  const addInside = (c: Component) => setAddTo({ id: c.id, name: blockLabel(c as any), role: c.role, parentTag: parentTagOf(c, true) });
  const createTag = async (c: Component, identifier: string): Promise<string> => {
    const r = await fetch(api(`/equipment/component/${c.id}/tag`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier }),
    }).catch(() => null);
    const d = await r?.json().catch(() => ({}));
    if (!r?.ok) return d?.error || 'Сервер не ответил';
    addToast(d.corrected ? `Тег исправлен (${d.corrected.what}) и привязан: «${d.identifier}»` : `Тег «${d.identifier}» заведён и привязан`, 'success');
    setTagPickerFor(null); loadSystems(); loadTags();
    return '';
  };
  const cvOf = (c: Component) => viewOf(catView.view, clsOf(c), visibility[c.equipType] || []);
  const isHidden = (_t: string, token: string) => !!selected && isHiddenIn(cvOf(selected.block), token);
  const toggleHidden = (_t: string, token: string) => {
    if (selected) catView.save(toggleIn(catView.view, clsOf(selected.block), token, visibility[selected.block.equipType] || []));
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
    <div className="fx-page @container">
      <SectionHead title="Оборудование" count={(categories.find(c => c.id === activeCat)?.label || '') + (catCount(activeCat) ? ` · ${catCount(activeCat)}` : '')}
        actions={<>
          {/* Центр операций рядом с импортом не случайно: сюда идут за ответом
              «а мой ввоз-то как?» — сразу после того, как его отправили в фон */}
          <Btn tone="ghost" onClick={() => { setShowOps(true); loadOps(); }} title="Центр операций: что ввозится в фоне и чем кончилось недавнее"><List />Центр операций</Btn>
          <Btn onClick={() => navigate(`/equipment-export?projectId=${encodeURIComponent(pid)}&scope=${encodeURIComponent(selectedUnitId ? `unit:${selectedUnitId}` : `cat:${activeCat}`)}`)} title="Выгрузка по шаблону: типы, столбцы, порядок — в Excel, CSV, буфер или таблицу Flux Office"><Download />Выгрузка данных</Btn>
          <Btn tone="primary" data-tour="equipment-import-btn" onClick={() => setShowDocImport(true)}
            title="Импорт из документов: распознать бланк, ведомость или страницу каталога — PDF, Excel, Word, XML"><ScanLine />Импорт из документов</Btn>
          <IconBtn label="Настройки оборудования" onClick={() => setShowSettings(true)}><Settings /></IconBtn>
        </>} />
      {undoable && (
        <div className="fx-tools text-amber-800 dark:text-amber-300">
          <RefreshCw className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1 min-w-0 truncate">
            Импорт расчёта от {new Date(undoable.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            {undoable.files > 1 ? ` · файлов: ${undoable.files}` : ''} — можно отменить
          </span>
          <Btn tone="danger" size="sm" onClick={undoImport} disabled={undoBusy}>{undoBusy ? 'Отменяю…' : 'Отменить импорт'}</Btn>
          <IconBtn label="Больше не предлагать" onClick={() => { forgetImport(activeProject?.id || ''); setUndoable(null); }}><X /></IconBtn>
        </div>
      )}
      <div className="flex-1 min-h-0 flex overflow-x-auto">
      {/* Категории — боковой список; подсказка о форматах — в подвале списка */}
      <nav className="fx-side w-44 @[1060px]:w-56 shrink-0 flex flex-col overflow-hidden" aria-label="Категории оборудования">
        <div className="flex-1 overflow-y-auto p-2">
          <div className="hidden @[820px]:block fx-gh">Категории</div>
          {categories.map(c => {
            const n = catCount(c.id);
            return (
              <button type="button" key={c.id} onClick={() => { setActiveCat(c.id); setSelectedBlockId(null); setSelectedUnitId(null); setListMode(false); }}
                title={n > 0 ? `${c.label} · ${n}` : c.label}
                aria-current={c.id === activeCat ? 'true' : undefined}
                className="fx-li justify-start">
                {catIcon(c.id)}
                <span className="flex-1 min-w-0 truncate">{c.label}</span>
                {n > 0 && <span className="fx-n">{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="hidden @[820px]:block px-3 py-2 text-xs text-slate-400 border-t border-slate-200 dark:border-slate-800">
          PDF, Excel, Word, XML расчёта — или файл через «Проводник»
        </div>
      </nav>


      {viewOpen && (
        <CategoryViewDialog
          categoryLabel={categories.find(c => c.id === activeCat)?.label || activeCat}
          positions={catSystems.flatMap(s => s.monoblocks.flatMap(m => m.components))
            .map(c => ({ id: c.id, cls: clsOf(c), groups: normalizeSpecs(c.specs).groups as any }))}
          view={catView.view}
          legacyOf={(cls) => [...new Set(Object.values(allBlocks).filter(x => clsOf(x.block) === cls)
            .flatMap(x => visibility[x.block.equipType] || []))]}
          initialClass={selected ? clsOf(selected.block) : undefined}
          isAdmin={isAdmin} visMode={visMode} onSwitchMode={switchVisMode}
          onSave={catView.save}
          onClose={() => setViewOpen(false)}
        />
      )}

      {addTo && (
        <AddPositionDialog target={addTo} projectId={pid} onClose={() => setAddTo(null)} onSubmit={addPosition}
          freeTags={tags.filter(t => !(t.componentElements || []).length).map(t => t.identifier)} />
      )}

      {showOps && (
        <ImportOperations
          batches={ops} loading={opsLoading}
          onRefresh={loadOps} onCancel={cancelOps}
          onClose={() => { setShowOps(false); loadSystems(); }}
        />
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
        onAddPosition={(c) => addInside(c as any)}
        onAddToMonoblock={(mb, u) => setAddTo({ monoblockId: mb.id, name: mb.name, parentTag: compositionOf(u.monoblocks.flatMap(m => m.components) as any, u.name).unitTag })}
        types={types}
        removedCount={removedCount}
        showRemoved={showRemoved}
        onShowRemoved={chooseShowRemoved}
        mode={treeMode}
        onMode={chooseTreeMode}
        onOpenList={() => setListMode(true)}
        onOpenView={() => setViewOpen(true)}
        onPickTag={(c) => setTagPickerFor(c as any)}
      />

      {/* КАРТОЧКА БЛОКА */}
      <div className="zone flex-1 min-w-[280px] overflow-hidden flex flex-col">
        {listMode ? (
          <PositionList systems={catSystems as any} types={types} onOpen={openBlock} onClose={() => setListMode(false)} />
        ) : selected ? (
          <BlockCard
            composition={compositionView(selected.block as any, selected.unit.monoblocks.flatMap(m => m.components) as any, types, blockLabel as any)}
            onOpenPosition={openBlock}
            classTitle={classTitle}
            arrangeGroups={(g: any[]) => arrange(g, cvOf(selected.block))}
            typed={types.get(selected.block.id)}
            say={addToast}
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
            onAddInside={() => addInside(selected.block)}
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
                  <div className="font-medium text-slate-500">v{h.version} · {new Date(h.changedAt).toLocaleString('ru-RU')}</div>
                  <div className="text-slate-400 mt-0.5">{h.changeType}</div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {tagPickerFor && (
        <TagPickerModal
          projectId={pid}
          tags={tags}
          currentComponentId={tagPickerFor.id}
          parentTag={parentTagOf(tagPickerFor)}
          onCreate={(identifier) => createTag(tagPickerFor, identifier)}
          onPick={(tagId) => linkTag(tagPickerFor, tagId)}
          onClose={() => setTagPickerFor(null)}
        />
      )}
      </div>
    </div>
  );
}

// ── Карточка блока ──
// ── Выбор тега для привязки: поиск + занятость (один тег — одно изделие) ──
// ── Универсальная модалка ──
// Окна раздела — общий диалог программы (components/ui)
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <Dialog title={title} width="max-w-lg" onClose={onClose}>{children}</Dialog>;
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
    const was = conflictMode;
    setConflictMode(m);
    // Режим общий для отдела; отказ сервера не должен выглядеть как выбор
    const res = await fetch(api('/settings/equip_conflict_mode'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: null, value: m }) }).catch(() => null);
    if (!res?.ok) {
      setConflictMode(was);
      addToast?.(res?.status === 403 ? 'Режим для всех меняет администратор' : 'Не удалось сохранить режим', 'error');
    }
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
        {/* Профиль видимости («для всех / только для меня») был здесь и в окне
            «Вид категории» — одна настройка в двух местах. Остался там, где
            им пользуются: рядом с самим видом */}
        <div>
          <div className="fx-label mb-1.5">При новой ревизии</div>
          <div className="fx-segctl" role="group" aria-label="При новой ревизии">
            <button type="button" aria-pressed={conflictMode === 'wait'} onClick={() => saveConflictMode('wait')}>Ждать решения (✓/✎)</button>
            <button type="button" aria-pressed={conflictMode === 'immediate'} onClick={() => saveConflictMode('immediate')}>Изменять сразу</button>
          </div>
        </div>

        {isAdmin && (
          <div>
            <div className="fx-label mb-1.5">Категории оборудования</div>
            <div className="space-y-1 mb-2 max-h-40 overflow-y-auto">
              {categories.map((c: Category) => (
                <div key={c.id} className="fx-li cursor-default justify-between">
                  <span>{c.label}</span>
                  {!['AHU', 'FAN', 'VALVE', 'CURTAIN'].includes(c.id) && <button type="button" onClick={() => removeCategory(c.id)} className="text-slate-400 hover:text-rose-500 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>}
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="Новая категория…" className="fx-input flex-1" />
              <button type="button" onClick={addCategory} className="fx-btn fx-btn-primary">Добавить</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
