import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import { useInsightStore } from '../store/insightStore';
import { dataService } from '../services/dataService';
import {
  Table,
  Trash2,
  Edit2,
  Link2,
  X,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Database,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Activity,
  Eye,
  ArrowRight,
  ClipboardCheck,
  Check,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { createPortal } from 'react-dom';
import TagImportWizard from '../components/TagImportWizard';
import { encodeShare } from '../lib/shareLink';
import { useShareStore } from '../store/shareStore';
import { useModalStore } from '../store/modalStore';
import NoProject from '../components/NoProject';
import ExchangeDialog from '../components/ExchangeDialog';
import ExchangeTab from '../components/registry/ExchangeTab';
import { type Column } from '../lib/exchange';
import { tagExchangeColumns, buildTagExchange } from '../lib/tagExchange';
import {
  linkChild, unlinkChild, whyNotLink, descendantsOf, type TreeNode, type TreePatch,
} from '../lib/tagTree';
import {
  layoutForest, linkPath, portAt, boundsOf, fitView, zoomAt, screenToWorld,
  hitTestCard, hitTestBox, boxFromDrag, findFreePosition as freeSpot, placeUnplaced, cleanMeta, snap, fitZoom,
  DEFAULT_BOX as LAYOUT_BOX, GRID, type TreeAxis, type Point,
} from '../lib/tagLayout';
import BoardLinks, { type BoardLink } from '../components/registry/BoardLinks';
import BoardCard, { type PortHover } from '../components/registry/BoardCard';
import CardActions from '../components/registry/CardActions';
import DuplicatesPanel from '../components/registry/DuplicatesPanel';
import SegmentCollectorTab from '../components/registry/SegmentCollectorTab';
import { useSegmentCollector } from '../components/registry/useSegmentCollector';
import SpecTable from '../components/registry/SpecTable';
import TagCardModal from '../components/registry/TagCardModal';
import RegistryHeader from '../components/registry/RegistryHeader';
import BoardControls from '../components/registry/BoardControls';
import BoardContextMenu from '../components/registry/BoardContextMenu';
import QuickCreateBar from '../components/registry/QuickCreateBar';
import { useQuickCreate } from '../components/registry/useQuickCreate';
import { useTagExtractor } from '../components/registry/useTagExtractor';
import { useRegistryTags } from '../components/registry/useRegistryTags';
import { useTagTreeOps } from '../components/registry/useTagTreeOps';
import { saveTagMetadataPatch, rememberVersions } from '../components/registry/tagWrite';
import { splitSegments } from '../lib/tagExtract';
import TagSearchPanel from '../components/registry/TagSearchPanel';
import { Status, Empty } from '../components/ui';
import { parseTagMetadata, getTagOverallStatus, statusConfig, type DescriptionItem, type ParsedMetadata } from '../components/registry/tagMeta';

import { useShallow } from 'zustand/react/shallow';
// Диалоги программы вместо системных окон Windows
const { openConfirm, openAlert, openPrompt } = useModalStore.getState();

// Габариты карточки, раскладка, геометрия портов и линий — общие правила из
// src/lib/tagLayout.ts. Здесь их держать нельзя: числа 330 и 22 уже жили
// вписанными в четырёх местах этого файла и однажды разошлись с разметкой
const CARD_W = LAYOUT_BOX.w;
const CARD_H = LAYOUT_BOX.h;

interface ActiveConnectionDrag {
  sourceId: string;
  side: 'left' | 'right';
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  reconnectTargetId?: string;
}

export default function Registry() {
  const { activeProject, theme, user } = useStore(useShallow((s: ReturnType<typeof useStore.getState>) => ({ activeProject: s.activeProject, theme: s.theme, user: s.user })));
  const location = useLocation();
  const navigate = useNavigate();
  const { addToast } = useToastStore();
  // Панель связей: «где ещё встречается этот тег» — из меню карточки и с её панели
  const openWhereUsed = useInsightStore((st) => st.openWhere);
  const [tags, setTags] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'board' | 'tree' | 'segments' | 'table' | 'exchange' | 'equipment'>('board');
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Equipment tree and specs integration
  const [tagSearchText, setTagSearchText] = useState('');

  // Board cards expanded states
  const [expandedCardIds, setExpandedCardIds] = useState<{ [tagId: string]: boolean }>({});
  // Быстрое добавление связи из карточки: поиск тега без перетаскивания линий
  const [linkPicker, setLinkPicker] = useState<{ tagId: string; search: string; dir: 'child' | 'parent' } | null>(null);

  // Sub-description inline editing state
  const [editingDescId, setEditingDescId] = useState<string | null>(null);
  const [editDescForm, setEditDescForm] = useState<{
    text: string;
    comment: string;
    status: DescriptionItem['status'];
  }>({ text: '', comment: '', status: 'actual' });
  
  // Infinite Canvas Navigation (Zoom & Pan)
  const [zoom, setZoom] = useState<number>(0.9);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 80, y: 50 });
  const [isPanning, setIsPanning] = useState(false);
  const [draggedTagId, setDraggedTagId] = useState<string | null>(null);
  // Мир (фон+связи+карточки) — двигаем напрямую во время панорамы (без ре-рендера)
  const worldRef = useRef<HTMLDivElement>(null);
  const panMovedRef = useRef(false);
  // Режим «связать»: клик по «+» на карточке → клик по цели создаёт связь
  const [linkingFrom, setLinkingFrom] = useState<string | null>(null);
  const linkingFromRef = useRef<string | null>(null);
  useEffect(() => { linkingFromRef.current = linkingFrom; }, [linkingFrom]);

  // Способ создания связей — один и для холста, и для дерева: 'click' или
  // 'drag'. Раньше на дерево был отдельный ключ tree_link_mode, и в Настройках
  // стояли два одинаковых выбора; теперь выбор один (Настройки → Теги), ключ
  // registry_link_mode. Меняется вживую по событию.
  const [linkMode, setLinkMode] = useState<'click' | 'drag'>('click');
  // Режим «связать» в дереве (клик по «+» у строки → клик по строке-получателю)
  const [treeLinkingFrom, setTreeLinkingFrom] = useState<string | null>(null);
  const treeLinkingFromRef = useRef<string | null>(null);
  useEffect(() => { treeLinkingFromRef.current = treeLinkingFrom; }, [treeLinkingFrom]);
  // Перетаскивание строки дерева на другую (drag-режим)
  const [treeDragOverId, setTreeDragOverId] = useState<string | null>(null);
  const treeDraggedIdRef = useRef<string | null>(null);
  useEffect(() => {
    fetch('/api/settings/registry_link_mode').then(r => r.json()).then(d => {
      if (d.global === 'drag' || d.global === 'click') setLinkMode(d.global);
    }).catch(() => {});
    const onSettings = (e: any) => {
      const v = e?.detail?.value;
      if (v !== 'click' && v !== 'drag') return;
      if (e.detail.key !== 'registry_link_mode') return;
      // Недоделанная связь прежнего способа сбрасывается в обоих местах
      setLinkMode(v); setLinkingFrom(null); setTreeLinkingFrom(null);
    };
    window.addEventListener('flux:settings-changed', onSettings);
    return () => window.removeEventListener('flux:settings-changed', onSettings);
  }, []);
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  
  // Real-time Dynamo Revit Connection Wires
  const [activeConnectionDrag, setActiveConnectionDrag] = useState<ActiveConnectionDrag | null>(null);
  const [hoveredPort, setHoveredPort] = useState<PortHover | null>(null);

  const boardRef = useRef<HTMLDivElement>(null);
  /**
   * Узел холста — состоянием, а не только ссылкой.
   *
   * Холст живёт внутри `AnimatePresence mode="wait"`: при возврате на вкладку
   * он появляется в DOM НЕ сразу, а после того, как уходящий вид доиграет свой
   * выход. Значит эффект, подписанный на смену вкладки, застаёт `boardRef`
   * пустым, выходит ни с чем и больше не повторяется — а колесо и наблюдатель
   * размера остаются без узла. Отсюда и «в тегах колесо не масштабирует»: на
   * первом открытии всё работало, после первой же смены вкладки — нет.
   *
   * Ссылка через функцию даёт состояние ровно тогда, когда узел появился и
   * когда исчез, а эффекты подписываются на него, а не на вкладку.
   */
  const [boardEl, setBoardEl] = useState<HTMLDivElement | null>(null);
  const attachBoard = useCallback((node: HTMLDivElement | null) => {
    boardRef.current = node;
    setBoardEl(node);
  }, []);

  const [selectedConnection, setSelectedConnection] = useState<{ sourceId: string; targetId: string } | null>(null);
  // Подсветки связи под курсором в состоянии больше нет: она означала полную
  // перерисовку холста на каждое наведение мыши. Теперь это делает CSS в
  // components/registry/BoardLinks — без единой перерисовки

  // Performance-optimized Refs
  const cardPositionsRef = useRef<Record<string, { x: number, y: number }>>({});
  const activeConnectionDragRef = useRef<any>(null);
  const reconnectingConnectionRef = useRef<{ sourceId: string, targetId: string } | null>(null);
  const animatingRef = useRef<boolean>(false);
  const zoomRef = useRef<number>(0.9);
  const panRef = useRef<{ x: number, y: number }>({ x: 80, y: 50 });
  /**
   * Ось раскладки для обработчиков, которые пишут в DOM напрямую.
   *
   * Они живут вне перерисовки — состояние в них приезжает старым. Ось нужна
   * им, чтобы линия при перетаскивании считалась так же, как в слое связей.
   */
  const axisRef = useRef<TreeAxis>('right');
  /** Слой точечной сетки: он вне трансформируемого мира и двигается отдельно */
  const gridRef = useRef<HTMLDivElement>(null);
  /** Надпись с масштабом: во время кручения обновляется мимо перерисовки */
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const wheelCommitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Карточка, на которую сейчас нацелена тянущаяся связь */
  const dropTargetRef = useRef<string | null>(null);
  /** Зажат ли Alt: при нём карточка не прилипает к сетке */
  const altHeldRef = useRef(false);
  /** Куда ставить тег, заведённый через меню правой кнопки по холсту */
  const newTagSpotRef = useRef<Point | null>(null);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  // Места тегов без координат (автотеги ввоза): однажды выданное место
  // помнится на сессию, и перенос одной карточки не двигает остальные —
  // правило в src/lib/tagLayout.ts placeUnplaced
  const parkedRef = useRef<Record<string, Point>>({});
  useEffect(() => {
    const code = new Map<string, string>(tags.map((t: any) => [t.id, t.identifier || '']));
    const positions = placeUnplaced(tags.map((t: any) => {
      const m = parseTagMetadata(t);
      return { id: t.id, connections: m.connections || [], at: m._noPos ? undefined : { x: m.x, y: m.y } };
    }), parkedRef.current, axisRef.current, { box: LAYOUT_BOX, keyOf: (id) => code.get(id) || id });
    for (const t of tags) {
      const meta = parseTagMetadata(t);
      if (meta._noPos) { meta.x = positions[t.id].x; meta.y = positions[t.id].y; }
    }
    cardPositionsRef.current = positions;
  }, [tags]);

  // Update direct line positioning during drags
  const updateLinePathDOM = (sourceId: string, targetId: string, sX: number, sY: number, tX: number, tY: number) => {
    // Та же функция, что рисует линии в слое связей. Пока она была здесь своя,
    // перетаскивание карточки в одной оси давало кривую, а всё остальное —
    // ломаную: линия «перескакивала» в момент, когда отпускали карточку
    const pathData = linkPath({ x: sX, y: sY }, { x: tX, y: tY }, axisRef.current, LAYOUT_BOX);

    const linePath = document.getElementById(`path-${sourceId}-${targetId}`);
    if (linePath) {
      linePath.setAttribute('d', pathData);
    }
    const linePathOverlay = document.getElementById(`path-overlay-${sourceId}-${targetId}`);
    if (linePathOverlay) {
      linePathOverlay.setAttribute('d', pathData);
    }
    const flowDot = document.getElementById(`flow-dot-${sourceId}-${targetId}`);
    if (flowDot) {
      const animateNode = flowDot.querySelector('animateMotion');
      if (animateNode) {
        animateNode.setAttribute('path', pathData);
      }
    }
  };

  // Handle keyboard Delete and Backspace for selected connection path
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (activeEl && (
        activeEl.tagName === 'INPUT' || 
        activeEl.tagName === 'TEXTAREA' || 
        activeEl.getAttribute('contenteditable') === 'true'
      )) {
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedConnection) {
          e.preventDefault();
          handleRemoveConnection(selectedConnection.sourceId, selectedConnection.targetId);
          setSelectedConnection(null);
        }
      }

      // Esc: сначала выходим из режима связывания, затем закрываем панели и снимаем выделение
      if (e.key === 'Escape') {
        if (linkingFromRef.current) { setLinkingFrom(null); return; }
        if (treeLinkingFromRef.current) { setTreeLinkingFrom(null); return; }
        setCardPanel(null);
        setDupPanel(null);
        setMultiSelectMode(false);
        setSelectedTagIds(prev => (prev.size > 0 ? new Set<string>() : prev));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedConnection, tags]);

  // Pre-calculate tag positions and connections for high performance
  const tagsById = useMemo(() => {
    const map: Record<string, any> = {};
    for (const t of tags) {
      map[t.id] = t;
    }
    return map;
  }, [tags]);

  // Входящие связи: к карточке могут вести линии от нескольких родителей
  const incomingByTagId = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const t of tags) {
      const meta = parseTagMetadata(t);
      for (const childId of (meta.connections || [])) {
        if (!map[childId]) map[childId] = [];
        map[childId].push(t.id);
      }
    }
    return map;
  }, [tags]);

  // Дубликаты: коды тегов, встречающиеся более одного раза (подсветка авто-очищается, когда код уникален)
  const duplicateCodes = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tags) {
      const code = (t.identifier || '').trim();
      if (code) counts[code] = (counts[code] || 0) + 1;
    }
    return new Set(Object.keys(counts).filter(c => counts[c] > 1));
  }, [tags]);
  const isDuplicateTag = (t: any) => duplicateCodes.has((t?.identifier || '').trim());

  // Filter/Search (обновляется с дебаунсом из панели поиска — для таблицы/дерева)
  const [searchQuery, setSearchQuery] = useState('');

  // Выделение карточек на холсте: Ctrl+клик, галочки в поиске, функция «Связи»
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());

  // Контекстное меню карточки (ПКМ): «Связи» вверх/вниз, «Поделиться в чате»
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; tagId: string } | null>(null);

  // Мини-панель действий у курсора: появляется по клику на карточку (клик = выделение)
  const [cardPanel, setCardPanel] = useState<{ x: number; y: number; tagId: string } | null>(null);
  const cardPanelOpenedAtRef = useRef(0);

  // Режим «Выбрать несколько»: каждый клик добавляет карточку без зажатого Ctrl
  const [multiSelectMode, setMultiSelectMode] = useState(false);

  // Панель дублей: список позиций с тем же кодом; колесо/наведение перемещает вид
  const [dupPanel, setDupPanel] = useState<{ code: string; ids: string[]; activeIdx: number } | null>(null);
  const dupPanelRef = useRef<HTMLDivElement>(null);

  // Порог перетаскивания: mousedown ещё не перенос — ждём сдвига >5px, иначе это клик
  const pendingDragRef = useRef<{ tagId: string; startX: number; startY: number } | null>(null);

  // Выбор «главного родителя» для центрирования его дерева (один клик по «Центрировать»)
  const [centerPickerOpen, setCenterPickerOpen] = useState(false);
  /** Выбор оси раскладки открыт */
  const [axisPickerOpen, setAxisPickerOpen] = useState(false);
  /**
   * Меню правой кнопки по пустому месту холста.
   *
   * Раньше правая кнопка по полю умела ровно одно — гасить системное меню.
   * `at` — точка холста под курсором: «Создать тег здесь» без неё пришлось бы
   * ставить наугад в центр экрана.
   */
  const [boardMenu, setBoardMenu] = useState<{ x: number; y: number; at: Point } | null>(null);

  // Размер видимой области холста — для центрирования и отсечения невидимых карточек
  const [boardSize, setBoardSize] = useState({ w: 1200, h: 700 });

  // Оптимизация больших холстов: рендерим только карточки в видимой области (+запас)
  const cullInfo = useMemo(() => {
    const active = tags.length > 80;
    const x0 = (-pan.x) / zoom - 380;
    const y0 = (-pan.y) / zoom - 320;
    const x1 = (boardSize.w - pan.x) / zoom + 60;
    const y1 = (boardSize.h - pan.y) / zoom + 60;
    return { active, x0, y0, x1, y1 };
  }, [tags.length, pan, zoom, boardSize]);

  // Размер координатного пространства холста: раньше был жёстко задан
  // (3500×2500), и при большом реестре часть карточек оказывалась за его
  // границей. Считаем по фактическому размещению.
  const [showCanvasHint, setShowCanvasHint] = useState(() => {
    try { return localStorage.getItem('flux_canvas_hint_seen') !== '1'; } catch (_) { return true; }
  });
  const hideCanvasHint = React.useCallback(() => {
    setShowCanvasHint((prev) => {
      if (prev) { try { localStorage.setItem('flux_canvas_hint_seen', '1'); } catch (_) {} }
      return false;
    });
  }, []);

  const worldSize = useMemo(() => {
    let maxX = 0, maxY = 0;
    for (const t of tags) {
      const p = cardPositionsRef.current[t.id] || parseTagMetadata(t);
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { w: Math.max(3500, Math.ceil(maxX + CARD_W + 400)), h: Math.max(2500, Math.ceil(maxY + 400)) };
  }, [tags]);

  const isTagVisibleOnBoard = (t: any): boolean => {
    if (!cullInfo.active) return true;
    if (draggedTagId === t.id || selectedTagIds.has(t.id) || expandedCardIds[t.id]) return true;
    const p = cardPositionsRef.current[t.id] || parseTagMetadata(t);
    return p.x < cullInfo.x1 && p.x + CARD_W > cullInfo.x0 && p.y < cullInfo.y1 && p.y + CARD_H > cullInfo.y0;
  };

  // Анимированные точки на связях отключаем на больших графах (экономия ресурсов)
  const showFlowDots = tags.length <= 60;

  /**
   * Куда растёт дерево. Хранится у человека, а не в общих настройках: это
   * привычка смотреть, а не свойство проекта, — и общая настройка меняла бы
   * вид холста у всех разом. Тем же способом помнится подсказка холста.
   */
  const [axis, setAxis] = useState<TreeAxis>(() => {
    try { return localStorage.getItem('flux_registry_axis') === 'down' ? 'down' : 'right'; } catch (_) { return 'right'; }
  });
  const chooseAxis = React.useCallback((next: TreeAxis) => {
    setAxis(next);
    axisRef.current = next;
    try { localStorage.setItem('flux_registry_axis', next); } catch (_) { /* приватный режим */ }
  }, []);
  useEffect(() => { axisRef.current = axis; }, [axis]);

  /**
   * Связи, которые и правда надо нарисовать.
   *
   * Считается здесь, а не внутри слоя связей: слой обязан оставаться
   * мемоизированным, а живые координаты во время перетаскивания лежат в ref —
   * читать ref внутри мемоизированного компонента значит рисовать вчерашнее.
   */
  const visibleLinks = useMemo<BoardLink[]>(() => {
    const out: BoardLink[] = [];
    for (const tag of tags) {
      const meta = parseTagMetadata(tag);
      for (const targetId of meta.connections || []) {
        const target = tagsById[targetId];
        if (!target) continue;
        const from = cardPositionsRef.current[tag.id] || meta;
        const to = cardPositionsRef.current[targetId] || parseTagMetadata(target);
        if (cullInfo.active) {
          const bx0 = Math.min(from.x, to.x); const bx1 = Math.max(from.x, to.x) + CARD_W;
          const by0 = Math.min(from.y, to.y); const by1 = Math.max(from.y, to.y) + CARD_H;
          if (bx1 < cullInfo.x0 || bx0 > cullInfo.x1 || by1 < cullInfo.y0 || by0 > cullInfo.y1) continue;
        }
        // Связь, которую сейчас перецепляют, в общем слое не рисуется: иначе
        // рядом с тянущейся линией висела бы её же старая копия
        const re = reconnectingConnectionRef.current;
        if (re && re.sourceId === tag.id && re.targetId === targetId) continue;
        out.push({
          sourceId: tag.id, targetId,
          sourceName: tag.identifier || '', targetName: target.identifier || '',
          from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y },
        });
      }
    }
    return out;
    // activeConnectionDrag в списке не для чтения, а ради пересчёта: перецепку
    // помнит ref, и без этой зависимости старая линия так и висела бы рядом с
    // той, которую тянут
  }, [tags, tagsById, cullInfo, activeConnectionDrag]);

  const handleSelectConnection = React.useCallback((sourceId: string, targetId: string) => {
    setSelectedConnection({ sourceId, targetId });
  }, []);

  /**
   * Кого можно предложить в родители или в дети.
   *
   * Заведомо негодных не показываем вовсе. `whyNotLink` их, конечно, отвергнет
   * («так получится кольцо»), но предложить тег и тут же на него отругаться —
   * плохой разговор: человек не виноват, что программа сама его и предложила.
   *
   * Потомков считаем ОДИН раз на весь список. `descendantsOf` на каждого
   * кандидата — это перебор в квадрате, и на двух тысячах тегов поиск начал бы
   * заикаться на каждой набранной букве.
   */
  const linkCandidates = (tagId: string, dir: 'child' | 'parent', search: string): any[] => {
    const q = search.trim().toLowerCase();
    const meta = parseTagMetadata(tagsById[tagId] || {});
    const blocked = dir === 'parent'
      ? descendantsOf(treeNodes(), tagId)               // свой состав в родители не годится
      : new Set<string>([tagId, ...(meta.connections || [])]);
    const parents = dir === 'parent' ? (incomingByTagId[tagId] || []) : [];
    return tags.filter((t: any) =>
      !blocked.has(t.id)
      && !parents.includes(t.id)
      && (!q || (t.identifier || '').toLowerCase().includes(q))).slice(0, 8);
  };

  // Закрытие контекстного меню карточки, мини-панели и списка «главных родителей»
  useEffect(() => {
    if (!cardMenu && !centerPickerOpen && !cardPanel && !axisPickerOpen && !boardMenu) return;
    const close = (ev?: Event) => {
      // Клик, который открыл мини-панель, не должен тут же её закрыть
      if (ev && Date.now() - cardPanelOpenedAtRef.current < 200) return;
      const target = ev?.target as HTMLElement | undefined;
      if (target?.closest?.('[data-card-panel]')) return;
      setCardMenu(null);
      setCenterPickerOpen(false);
      setCardPanel(null);
      setAxisPickerOpen(false);
      setBoardMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [cardMenu, centerPickerOpen, cardPanel, axisPickerOpen, boardMenu]);

  // Sort state for Table View
  const [sortConfig, setSortConfig] = useState<{key: string; direction: 'asc' | 'desc'}>({ key: 'createdAt', direction: 'desc' });

  // Detail Modal / Sidebar editor
  const [editingTag, setEditingTag] = useState<any | null>(null);

  // Inline comments creation state
  const [quickDescText, setQuickDescText] = useState<{ [tagId: string]: string }>({});
  const [quickCommentText, setQuickCommentText] = useState<{ [tagId: string]: string }>({});
  const [quickStatus, setQuickStatus] = useState<{ [tagId: string]: DescriptionItem['status'] }>({});

  // Tree view expanded states
  const [expandedTagIds, setExpandedTagIds] = useState<{ [tagId: string]: boolean }>({});
  const [showTreeDescriptions, setShowTreeDescriptions] = useState<{ [tagId: string]: boolean }>({});
  const [showTableDescriptions, setShowTableDescriptions] = useState<{ [tagId: string]: boolean }>({});
  const [showOptionalTableColumns, setShowOptionalTableColumns] = useState(false);

  // Остались здесь, а не в useQuickCreate: «Доп» открывает меню правой кнопки
  // по холсту, а выбор по умолчанию раскладывает загрузка словарей
  const [showAdvancedCreation, setShowAdvancedCreation] = useState(false);
  const [dynamicCategorySelections, setDynamicCategorySelections] = useState<Record<string, string>>({});

  const [editTagBrand, setEditTagBrand] = useState('');

  // Форма карточки: контролируемые поля + автосохранение (без кнопок «Применить»)
  const [modalMainName, setModalMainName] = useState('');
  const [modalCode, setModalCode] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const savedFlashTimer = useRef<any>(null);
  const flashSaved = () => {
    setSavedFlash(true);
    if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
    savedFlashTimer.current = setTimeout(() => setSavedFlash(false), 1400);
  };
  // Инициализируем поля формы только при ОТКРЫТИИ карточки (по смене id),
  // чтобы автосохранение и обновления editingTag не сбрасывали ввод.
  const modalInitRef = useRef<string | null>(null);
  useEffect(() => {
    if (editingTag && modalInitRef.current !== editingTag.id) {
      modalInitRef.current = editingTag.id;
      const m = parseTagMetadata(editingTag);
      setEditTagBrand(editingTag.brand || '');
      setModalMainName(m.mainName || '');
      setModalCode(editingTag.identifier || '');
    } else if (!editingTag) {
      modalInitRef.current = null;
    }
  }, [editingTag]);

  const [tagSearchQueries, setTagSearchQueries] = useState<{ [position: number]: string }>({});
  const [markSearchQueries, setMarkSearchQueries] = useState<{ [position: number]: string }>({});

  const [dictionaries, setDictionaries] = useState<any[]>([]);

  const loadDictionaries = async () => {
    if (!activeProject) return;
    try {
      const data = await dataService.getDictionaries(activeProject.id);
      setDictionaries(data.dictionaries || []);
    } catch (err) {
      console.error('Failed to load dictionaries:', err);
    }
  };

  useEffect(() => {
    if (dictionaries && dictionaries.length > 0) {
      const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
      if (configDict) {
        const cats = (configDict.items || [])
          .filter((i: any) => !i.parentId)
          .sort((a: any, b: any) => a.code.localeCompare(b.code));
        const initialSelections: Record<string, string> = {};
        cats.forEach((cat: any) => {
          const options = (configDict.items || [])
            .filter((i: any) => i.parentId === cat.id)
            .sort((a: any, b: any) => a.nameRu.localeCompare(b.nameRu));
          if (options.length > 0) {
            initialSelections[cat.id] = options[0].nameRu;
          } else {
            initialSelections[cat.id] = "";
          }
        });
        setDynamicCategorySelections(initialSelections);
      }
    }
  }, [dictionaries]);

  useEffect(() => {
    loadTags();
    loadDictionaries();
  }, [activeProject?.id]); // по идентификатору, а не по объекту: иначе перезапрос при каждой смене ссылки

  // Загрузка тегов и подсветка после захвата — в useRegistryTags. Вызов стоит
  // там же, где раньше были их эффекты: после «загрузить при смене проекта»,
  // чтобы порядок эффектов не изменился
  const {
    loadedTagsRef, loadTags, lastCapture, setLastCapture, captureUntilRef, flashCapture,
  } = useRegistryTags({
    activeProject, activeTab, setTags, setIsLoading, setSelectedTagIds,
    fitToTags: (list) => fitToTags(list),
  });

  /**
   * Колесо мыши.
   *
   * Обычное колесо по-прежнему меняет масштаб к точке под курсором: подсказка
   * на холсте учит именно этому, и менять уже заученный жест значило бы
   * переучивать людей без выгоды. Добавлено то, чего не хватало: **Shift —
   * ехать вбок**. После того как деревья встали в ряд, вбок ездят постоянно,
   * а умела это только правая кнопка.
   *
   * Главное здесь не жесты, а то, что ни один щелчок колеса больше не
   * перерисовывает холст. Раньше `setZoom` со вложенным `setPan` гоняли полную
   * перерисовку всех карточек и линий на КАЖДЫЙ щелчок — на пятистах тегах это
   * и есть та медленность, на которую жаловались. Теперь, как и панорама,
   * масштаб пишется прямо в стиль, а в состояние попадает один раз, когда
   * колесо остановилось: состояние нужно только отсечению невидимого.
   */
  useEffect(() => {
    const board = boardEl;
    if (!board) return;

    const paint = () => {
      const z = zoomRef.current; const p = panRef.current;
      if (worldRef.current) worldRef.current.style.transform = `translate(${p.x}px, ${p.y}px) scale(${z})`;
      // Сетка лежит ВНЕ трансформируемого мира (так дешевле её растрировать),
      // поэтому её надо двигать отдельно — иначе точки отстают от карточек
      if (gridRef.current) {
        gridRef.current.style.backgroundSize = `${GRID * z}px ${GRID * z}px`;
        gridRef.current.style.backgroundPosition = `${p.x}px ${p.y}px`;
      }
      if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(z * 100)}%`;
    };

    const commit = () => { setZoom(zoomRef.current); setPan({ ...panRef.current }); };

    const handleWheelEvent = (e: WheelEvent) => {
      e.preventDefault();
      const rect = board.getBoundingClientRect();

      // Наклонное колесо и трекпад дают deltaX сами — их незачем заставлять
      // держать Shift
      const sideways = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (sideways || e.altKey) {
        const step = (e.shiftKey ? e.deltaY : e.deltaX || e.deltaY) || 0;
        const alt = e.altKey && !e.shiftKey;
        panRef.current = {
          x: panRef.current.x - (alt ? 0 : step),
          y: panRef.current.y - (alt ? e.deltaY : 0),
        };
      } else {
        const next = zoomAt(zoomRef.current, panRef.current,
          { x: e.clientX - rect.left, y: e.clientY - rect.top }, e.deltaY < 0 ? 1 : -1);
        zoomRef.current = next.zoom;
        panRef.current = next.pan;
      }
      paint();
      if (wheelCommitRef.current) clearTimeout(wheelCommitRef.current);
      wheelCommitRef.current = setTimeout(commit, 120);
    };

    board.addEventListener('wheel', handleWheelEvent, { passive: false });
    return () => {
      board.removeEventListener('wheel', handleWheelEvent);
      if (wheelCommitRef.current) clearTimeout(wheelCommitRef.current);
    };
  }, [boardEl]);

  const splitCache = useRef<Record<string, string[]>>({});
  // Split Tag into parts using multiple separators (/ - . \)
  const splitTagIntoParts = useCallback((identifier: string): string[] => {
    if (!identifier) return [];
    if (splitCache.current[identifier]) return splitCache.current[identifier];
    // Split by dash, dot, slash, backslash, underscore
    const result = identifier.split(/[\-\.\/\\_]+/).filter(Boolean);
    splitCache.current[identifier] = result;
    return result;
  }, []);

  // Check if standard tag exists
  const checkTagExists = (identifier: string): boolean => {
    if (!identifier) return false;
    const norm = identifier.trim().toLowerCase();
    return tags.some(t => t.identifier.trim().toLowerCase() === norm);
  };

  // parseTagMetadata / getTagOverallStatus / statusConfig вынесены на уровень
  // модуля (см. выше компонента): они чистые и нужны компоненту поиска.

  // Human date formatting with safety check
  const formatDateStr = (isoString?: string): string => {
    if (!isoString) return '';
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return '';
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const year = d.getFullYear();
      const hours = String(d.getHours()).padStart(2, '0');
      const mins = String(d.getMinutes()).padStart(2, '0');
      return `${day}.${month}.${year} ${hours}:${mins}`;
    } catch {
      return '';
    }
  };

  // Safe save metadata to database
  // Уходят только изменившиеся ключи и версия, которую экран читал (tagWrite.ts):
  // копия тега устаревает за время работы, и целиком она стирала бы чужие правки
  const saveTagMetadata = async (tagId: string, metadata: ParsedMetadata): Promise<boolean> => {
    const tag = tags.find(t => t.id === tagId) || { id: tagId };
    // Служебные пометки окна в базу не едут, а записанные координаты делают
    // тег размещённым: иначе перенесённый автотег возвращался в сетку
    const clean = cleanMeta(metadata);
    setTags(prev => prev.map(t => t.id === tagId ? { ...t, parsedMetadata: { ...clean, _noPos: false }, metadata: JSON.stringify(clean) } : t));
    return saveTagMetadataPatch(tag, clean, tagWriteDeps);
  };
  // Свежая копия при конфликте попадает и в открытую карточку, а не только в список
  const tagWriteDeps = { setTags, addToast, onFresh: (t: any) => setEditingTag((prev: any) => (prev && prev.id === t.id ? { ...prev, ...t, parsedMetadata: undefined } : prev)) };
  // Поля тега (код, марка, WBS) тоже идут с версией и забирают новую себе: иначе
  // следующая правка комментария ушла бы со старой версией и получила конфликт с собой
  const saveTagFields = (tag: any, fields: Record<string, unknown>) => saveTagMetadataPatch(tag, tag?.metadata, tagWriteDeps, fields);

  // Seed demo data loop (using standard separators as requested)
  const handleSeedDemoData = async () => {
    if (!activeProject) return;
    setIsLoading(true);
    try {
      for (const t of tags) {
        await fetch(`/api/tags/${t.id}`, { method: 'DELETE' });
      }

      // 1. Ventilation master
      const ahuMetadata: ParsedMetadata = {
        x: 100,
        y: 180,
        connections: [],
        descriptions: [
          { id: '1', text: 'Приточный вентилятор SF-1', comment: 'Вибрационный контроль в норме.', status: 'actual' },
          { id: '2', text: 'Калорифер водяного нагрева HE-1', comment: 'Выявлен изгиб датчиков крепления.', status: 'warning' }
        ]
      };
      const rAhu = await fetch(`/api/projects/${activeProject.id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: '3700-C01-AHU-001',
          department: 'Технологический отдел',
          fluid: 'Воздух',
          wbs: 'WBS-VENT-1',
          metadata: JSON.stringify(ahuMetadata)
        })
      });
      const { tag: tagAhu } = await rAhu.json();

      // 2. Motor Fan Component (the BLM that the user specified)
      const blmMetadata: ParsedMetadata = {
        x: 480,
        y: 120,
        parentId: tagAhu.id,
        // Дети перечисляет РОДИТЕЛЬ. Здесь стоял сам родитель, и связь смотрела
        // в обе стороны сразу — с этого дерево и начинало читаться наизнанку
        connections: [],
        descriptions: [
          { id: '3', text: 'Асинхронный двигатель вентилятора', comment: 'Маркировка BLM. Измеренная температура подшипников 42C.', status: 'actual' }
        ]
      };
      const rBlm = await fetch(`/api/projects/${activeProject.id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: '3700-C01-BLM-001',
          department: 'Электротехнический отдел',
          fluid: 'Электрокабели',
          wbs: 'WBS-VENT-2',
          metadata: JSON.stringify(blmMetadata)
        })
      });
      const { tag: tagBlm } = await rBlm.json();

      // 3. Motor Fan #2 (BLM-002)
      const blm2Metadata: ParsedMetadata = {
        x: 480,
        y: 360,
        parentId: tagAhu.id,
        connections: [],
        descriptions: [
          { id: '23', text: 'Резервный двигатель вентилятора В-2', comment: 'Шифр BLM. Режим ожидания активен.', status: 'actual' }
        ]
      };
      const rBlm2 = await fetch(`/api/projects/${activeProject.id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: '3700-E02-BLM-002',
          department: 'Электротехнический отдел',
          fluid: 'Электрокабели',
          wbs: 'WBS-VENT-3',
          metadata: JSON.stringify(blm2Metadata)
        })
      });
      const { tag: tagBlm2 } = await rBlm2.json();

      // Оба двигателя — дети установки, и записывает их установка: список
      // детей ведёт родитель, а не наоборот
      ahuMetadata.connections = [tagBlm.id, tagBlm2.id];
      await saveTagMetadata(tagAhu.id, ahuMetadata);

      // 4. Component Junction Box
      const jbMetadata: ParsedMetadata = {
        x: 880,
        y: 200,
        parentId: tagBlm.id,
        connections: [],
        descriptions: [
          { id: '4', text: 'Клеммная коробка двигателя JB', comment: 'Пылевлагозащита обеспечена.', status: 'actual' },
          { id: '5', text: 'Кабельные гермовводы', comment: 'Ревизия прокладок успешна.', status: 'actual' }
        ]
      };
      await fetch(`/api/projects/${activeProject.id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: '3700-C01-BLM-JB-01',
          department: 'Отдел КИПиА',
          fluid: 'Сигналы',
          wbs: 'WBS-AUTO-5',
          metadata: JSON.stringify(jbMetadata)
        })
      });

      await loadTags();
    } catch (err) {
      console.error('Failed to seed demo tags data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // Node Drag Start
  const handleTagMouseDown = (e: React.MouseEvent, tagId: string, currentMeta: ParsedMetadata) => {
    if (e.button !== 0) return; // Left mouse only
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input') || target.closest('select') || target.closest('.no-drag') || target.closest('.connection-port')) return;

    e.preventDefault();
    e.stopPropagation();

    // Ctrl+клик — мультивыбор карточек (для «Поделиться» и групповых действий)
    if (e.ctrlKey || e.metaKey) {
      setSelectedTagIds(prev => {
        const next = new Set(prev);
        if (next.has(tagId)) next.delete(tagId);
        else next.add(tagId);
        return next;
      });
      return;
    }

    // Перенос начнётся только после сдвига >5px (см. handleCanvasMouseMove) —
    // иначе обычный клик «дёргал» карточку и не позволял просто выделить её
    pendingDragRef.current = { tagId, startX: e.clientX, startY: e.clientY };
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  // Port Drag-to-Connect Wire (includes high performance reconnect/detach)
  const handlePortMouseDown = (e: React.MouseEvent, tagId: string, side: 'left' | 'right') => {
    e.preventDefault();
    e.stopPropagation();

    const tag = tagsById[tagId];
    if (!tag) return;
    const meta = parseTagMetadata(tag);

    // Detach and reconnect feature for existing incoming connections (left port)
    if (side === 'left' && meta.parentId) {
      const parentId = meta.parentId;
      const parentTag = tagsById[parentId];
      if (parentTag) {
        const parentMeta = parseTagMetadata(parentTag);
        const port = portAt(parentMeta, 'out', axisRef.current, LAYOUT_BOX);
        const portX = port.x;
        const portY = port.y;

        const rect = boardRef.current?.getBoundingClientRect();
        const mouseX = rect ? e.clientX - rect.left : portX;
        const mouseY = rect ? e.clientY - rect.top : portY;
        const currentZoom = zoomRef.current;
        const currentPan = panRef.current;
        const canvasX = rect ? (mouseX - currentPan.x) / currentZoom : portX;
        const canvasY = rect ? (mouseY - currentPan.y) / currentZoom : portY;

        const dragData = {
          sourceId: parentId,
          side: 'right' as const, // Start from parent and follow mouse
          startX: portX,
          startY: portY,
          currentX: canvasX,
          currentY: canvasY,
          reconnectTargetId: tagId
        };

        setActiveConnectionDrag(dragData);
        activeConnectionDragRef.current = dragData;
        reconnectingConnectionRef.current = { sourceId: parentId, targetId: tagId };

        lastMousePosRef.current = { x: e.clientX, y: e.clientY };
        return;
      }
    }

    const port = portAt(meta, side === 'left' ? 'in' : 'out', axisRef.current, LAYOUT_BOX);
    const portX = port.x;
    const portY = port.y; 

    const rect = boardRef.current?.getBoundingClientRect();
    const mouseX = rect ? e.clientX - rect.left : portX;
    const mouseY = rect ? e.clientY - rect.top : portY;
    const currentZoom = zoomRef.current;
    const currentPan = panRef.current;
    const canvasX = rect ? (mouseX - currentPan.x) / currentZoom : portX;
    const canvasY = rect ? (mouseY - currentPan.y) / currentZoom : portY;

    const dragData = {
      sourceId: tagId,
      side,
      startX: portX,
      startY: portY,
      currentX: canvasX,
      currentY: canvasY
    };

    setActiveConnectionDrag(dragData);
    activeConnectionDragRef.current = dragData;

    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  // Unified MouseMove for Canvas Panning, Node Dragging and Connection Dragging
  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    if (!boardRef.current) return;
    altHeldRef.current = e.altKey;

    const currentZoom = zoomRef.current;
    const currentPan = panRef.current;

    // Ожидающий перенос: карточка зажата, но ещё не сдвинута на порог
    if (pendingDragRef.current && !draggedTagId) {
      const dx = e.clientX - pendingDragRef.current.startX;
      const dy = e.clientY - pendingDragRef.current.startY;
      if (Math.hypot(dx, dy) > 5) {
        setDraggedTagId(pendingDragRef.current.tagId);
        pendingDragRef.current = null;
        lastMousePosRef.current = { x: e.clientX, y: e.clientY };
      }
      return;
    }

    if (draggedTagId) {
      const dx = (e.clientX - lastMousePosRef.current.x) / currentZoom;
      const dy = (e.clientY - lastMousePosRef.current.y) / currentZoom;

      lastMousePosRef.current = { x: e.clientX, y: e.clientY };

      const pos = cardPositionsRef.current[draggedTagId] || { x: 0, y: 0 };
      const newX = pos.x + dx;
      const newY = pos.y + dy;
      cardPositionsRef.current[draggedTagId] = { x: newX, y: newY };

      // Request animation frame for smooth visual update
      if (!animatingRef.current) {
        animatingRef.current = true;
        requestAnimationFrame(() => {
          animatingRef.current = false;

          // Читаем позицию из ref в момент кадра: между планированием rAF и самим кадром
          // могли прийти новые mousemove — иначе карточка отстает на событие
          const livePos = cardPositionsRef.current[draggedTagId];
          if (!livePos) return;

          // 1. Direct card DOM manipulation
          const cardEl = document.getElementById(`tag-card-${draggedTagId}`);
          if (cardEl) {
            cardEl.style.transform = `translate(${livePos.x}px, ${livePos.y}px)`;
          }

          // 2. Direct lines DOM manipulation (all lines connected to this card)
          const targetTag = tagsById[draggedTagId];
          if (targetTag) {
            const tempMeta = parseTagMetadata(targetTag);

            // Outgoing lines from this card to its children (Right Port)
            const currentConnections = tempMeta.connections || [];
            currentConnections.forEach((childId: string) => {
              const childTag = tagsById[childId];
              if (childTag) {
                const childPos = cardPositionsRef.current[childId] || parseTagMetadata(childTag);
                updateLinePathDOM(draggedTagId, childId, livePos.x, livePos.y, childPos.x, childPos.y);
              }
            });

            // Incoming lines: все родители, чьи connections указывают на эту карточку
            const parents = incomingByTagId[draggedTagId] || [];
            parents.forEach((parentId: string) => {
              const parentTag = tagsById[parentId];
              if (parentTag) {
                const parentPos = cardPositionsRef.current[parentId] || parseTagMetadata(parentTag);
                updateLinePathDOM(parentId, draggedTagId, parentPos.x, parentPos.y, livePos.x, livePos.y);
              }
            });
          }
        });
      }

    } else if (activeConnectionDragRef.current) {
      const rect = boardRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const canvasX = (mouseX - currentPan.x) / currentZoom;
      const canvasY = (mouseY - currentPan.y) / currentZoom;

      lastMousePosRef.current = { x: e.clientX, y: e.clientY };

      activeConnectionDragRef.current.currentX = canvasX;
      activeConnectionDragRef.current.currentY = canvasY;

      // Цель броска — вся карточка, а не кружок порта шириной шестнадцать
      // пикселей. Пока целью был только порт, промах мимо кружка выглядел как
      // «связь не создаётся», хотя человек всё делал правильно
      const overId = hitTestCard(cardPositionsRef.current, { x: canvasX, y: canvasY },
        tags.map((t: any) => t.id), LAYOUT_BOX);
      const dropId = overId && overId !== activeConnectionDragRef.current.tagId ? overId : null;
      if (dropId !== dropTargetRef.current) {
        // Подсветка идёт классом напрямую: состояние здесь означало бы полную
        // перерисовку холста на каждое движение мыши
        const off = dropTargetRef.current && document.getElementById(`tag-card-${dropTargetRef.current}`);
        if (off) off.classList.remove('ring-2', 'ring-emerald-500');
        const on = dropId && document.getElementById(`tag-card-${dropId}`);
        if (on) on.classList.add('ring-2', 'ring-emerald-500');
        dropTargetRef.current = dropId;
      }

      // Update active connection line in DOM
      requestAnimationFrame(() => {
        const pathEl = document.getElementById('active-drag-path');
        if (pathEl && activeConnectionDragRef.current) {
          const { startX, startY, currentX, currentY, side } = activeConnectionDragRef.current;
          const dx = Math.abs(currentX - startX);
          const ctrlOffset = Math.max(90, dx * 0.45);
          const down = axisRef.current === 'down';
          // При раскладке сверху вниз изгиб тоже вертикальный: иначе тянущаяся
          // линия ведёт себя не так, как все нарисованные
          const pathData = down
            ? `M ${startX} ${startY} C ${startX} ${startY + (side === 'right' ? ctrlOffset : -ctrlOffset)}, `
              + `${currentX} ${currentY - (side === 'right' ? ctrlOffset : -ctrlOffset)}, ${currentX} ${currentY}`
            : `M ${startX} ${startY} C ${startX + (side === 'right' ? ctrlOffset : -ctrlOffset)} ${startY}, `
              + `${currentX - (side === 'right' ? ctrlOffset : -ctrlOffset)} ${currentY}, ${currentX} ${currentY}`;
          pathEl.setAttribute('d', pathData);
          pathEl.style.display = 'block';
        }
      });

    } else if (isPanning) {
      const dx = e.clientX - lastMousePosRef.current.x;
      const dy = e.clientY - lastMousePosRef.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) panMovedRef.current = true;

      lastMousePosRef.current = { x: e.clientX, y: e.clientY };

      // Двигаем мир напрямую (без setState) — панорама не лагает на больших графах.
      // Итоговое значение фиксируем в state на mouseup.
      panRef.current = { x: panRef.current.x + dx, y: panRef.current.y + dy };
      if (worldRef.current) {
        worldRef.current.style.transform = `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${zoomRef.current})`;
      }
    }
  };

  // Unified MouseUp finishing events
  const handleCanvasMouseUp = async (e?: React.MouseEvent) => {
    // Отпустили без сдвига — это клик по карточке: выделение + мини-панель действий.
    // onMouseLeave тоже зовёт этот обработчик — там клик не засчитываем
    const pending = pendingDragRef.current;
    pendingDragRef.current = null;
    if (pending && !draggedTagId && e?.type === 'mouseup') {
      const tagId = pending.tagId;
      // Режим «связать»: кликнули по цели → создаём связь; по источнику → отмена
      if (linkingFromRef.current) {
        const from = linkingFromRef.current;
        setLinkingFrom(null);
        setIsPanning(false);
        if (from !== tagId) await handleAddConnection(from, tagId);
        return;
      }
      if (multiSelectMode) {
        setSelectedTagIds(prev => {
          const next = new Set(prev);
          if (next.has(tagId)) next.delete(tagId);
          else next.add(tagId);
          return next;
        });
      } else {
        setSelectedTagIds(new Set([tagId]));
        if (e) {
          cardPanelOpenedAtRef.current = Date.now();
          setCardPanel({ x: e.clientX + 14, y: e.clientY - 10, tagId });
        }
      }
      setIsPanning(false);
      return;
    }

    if (draggedTagId) {
      const finalPos = cardPositionsRef.current[draggedTagId];
      if (finalPos) {
        const tag = tagsById[draggedTagId];
        if (tag) {
          // Прилипание к той самой сетке, которая на холсте и нарисована.
          // Пока координаты были произвольными, ровный ряд карточек получался
          // только случайно. Alt отпускает: иногда надо поставить именно так.
          //
          // Прилипаем при отпускании, а не во время переноса: иначе карточка
          // дёргается по клеткам и не поспевает за курсором
          const free = altHeldRef.current;
          const put = free ? finalPos : { x: snap(finalPos.x), y: snap(finalPos.y) };
          cardPositionsRef.current[draggedTagId] = put;
          const cardEl = document.getElementById(`tag-card-${draggedTagId}`);
          if (cardEl) cardEl.style.transform = `translate(${put.x}px, ${put.y}px)`;
          // Первый перенос неразмещённой карточки закрепляет места всех
          // неразмещённых одним запросом — при следующем открытии никто не
          // разложится заново
          if (parseTagMetadata(tag)._noPos) {
            const parked = Object.fromEntries(tags.filter((t: any) => parseTagMetadata(t)._noPos)
              .map((t: any) => [t.id, cardPositionsRef.current[t.id]]));
            await applyPositions({ ...parked, [draggedTagId]: put }).catch(() => addToast('Не удалось сохранить место карточки', 'error'));
          } else await saveTagMetadata(draggedTagId, { ...parseTagMetadata(tag), x: put.x, y: put.y });
        }
      }
      setDraggedTagId(null);
    }

    if (activeConnectionDragRef.current) {
      const { sourceId, reconnectTargetId } = activeConnectionDragRef.current;
      
      // Порт по-прежнему годится, но бросить можно и на саму карточку: порты
      // учат, ОТКУДА тянуть связь, и незачем им же быть единственным местом,
      // где её можно отпустить
      const destId = (hoveredPort && hoveredPort.tagId !== sourceId ? hoveredPort.tagId : null)
        || (dropTargetRef.current !== sourceId ? dropTargetRef.current : null);

      // Подсветку цели снимаем в любом случае: иначе рамка останется висеть
      const lit = dropTargetRef.current && document.getElementById(`tag-card-${dropTargetRef.current}`);
      if (lit) lit.classList.remove('ring-2', 'ring-emerald-500');
      dropTargetRef.current = null;

      if (destId) {
        // Правила связи одни на всю программу (lib/tagTree): линию тянут мышью
        // или заводят в карточке — дерево от этого не должно получаться разным
        const why = whyNotLink(treeNodes(), sourceId, destId);
        if (why) {
          addToast(why, 'error');
        } else {
          // Перетянули линию с прежнего ребёнка на нового — прежнюю снимаем
          let nodes = treeNodes();
          if (reconnectTargetId && reconnectTargetId !== destId) {
            const cut = unlinkChild(nodes, sourceId, reconnectTargetId);
            await applyTreePatches(cut);
            nodes = withPatches(nodes, cut);
          }
          await applyTreePatches(linkChild(nodes, sourceId, destId));
        }
      } else {
        // Отпустили в пустоту: связь возвращается на место (без вопросов).
        // Удалить связь легко и явно: крестик на линии или крестик у связи в карточке.
      }

      // Hide active dragging path
      const pathEl = document.getElementById('active-drag-path');
      if (pathEl) {
        pathEl.style.display = 'none';
        pathEl.setAttribute('d', '');
      }

      reconnectingConnectionRef.current = null;
      setActiveConnectionDrag(null);
      activeConnectionDragRef.current = null;
    }

    // Панораму двигали напрямую через worldRef — фиксируем итог в state
    if (isPanning) setPan({ ...panRef.current });
    setIsPanning(false);
  };

  /**
   * Список тегов глазами дерева — для общих правил (lib/tagTree).
   *
   * Пересобирается на каждое действие, а не хранится: связей у тега единицы, а
   * рассогласование двух списков стоило владельцу перевёрнутого дерева.
   */
  const treeNodes = (): TreeNode[] => tags.map((t) => {
    const m = parseTagMetadata(t);
    return { id: t.id, connections: m.connections || [], parentId: m.parentId };
  });

  /**
   * Наложить правки на список в памяти.
   *
   * Нужно потому, что запись в базу не меняет `tags` сию секунду: React
   * обновит состояние позже. Два действия подряд (снять прежнюю связь и
   * поставить новую) без этого считались бы от одного и того же устаревшего
   * дерева, и второе отменяло бы первое.
   */
  const withPatches = (nodes: TreeNode[], patches: TreePatch[]): TreeNode[] =>
    nodes.map((n) => {
      const p = patches.find((x) => x.id === n.id);
      return p ? { id: n.id, connections: p.connections, parentId: p.parentId } : n;
    });

  /**
   * Записать правки дерева: обе стороны связи одним движением.
   *
   * Смена родителя помечается `parentBy: 'hand'`. Импорт расчёта строит
   * родство сам, по составу оборудования, и без этой отметки он переставлял бы
   * связь обратно при каждом новом файле: инженер знает про объект то, чего в
   * расчёте нет, и переделывать одну работу дважды его заставлять нельзя.
   */
  const applyTreePatches = async (patches: TreePatch[]) => {
    for (const patch of patches) {
      const tag = tagsById[patch.id];
      if (!tag) continue;
      const was = parseTagMetadata(tag);
      const meta: ParsedMetadata = { ...was, connections: patch.connections, parentId: patch.parentId };
      if ((was as any).parentId !== patch.parentId) (meta as any).parentBy = 'hand';
      await saveTagMetadata(patch.id, meta);
    }
  };

  const handleRemoveConnection = async (sourceId: string, targetId: string) => {
    await applyTreePatches(unlinkChild(treeNodes(), sourceId, targetId));
  };

  /** Разрыв связи крестиком на линии: тем же путём, но со словами и снятием выбора */
  const handleRemoveLink = React.useCallback(async (l: BoardLink) => {
    await handleRemoveConnection(l.sourceId, l.targetId);
    setSelectedConnection((cur) =>
      (cur && cur.sourceId === l.sourceId && cur.targetId === l.targetId ? null : cur));
    addToast(`Связь ${l.sourceName} → ${l.targetName} разорвана`, 'success');
  }, [tags]);

  // Создание связи «родитель → дочерний» из карточки (без перетаскивания линии).
  // Правила — общие (lib/tagTree): у тега один родитель, кольца не заводятся,
  // а обе записи связи ставятся вместе, а не порознь в трёх местах
  const handleAddConnection = async (parentId: string, childId: string) => {
    const why = whyNotLink(treeNodes(), parentId, childId);
    if (why) { addToast(why, 'error'); return; }
    const patches = linkChild(treeNodes(), parentId, childId);
    if (!patches.length) return;
    await applyTreePatches(patches);
    addToast('Связь создана', 'success');
  };

  // Следим за размером холста (для центрирования и отсечения невидимого).
  // Подписка на узел, а не на вкладку, — по той же причине, что и у колеса
  useEffect(() => {
    const board = boardEl;
    if (!board) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setBoardSize({ w: entry.contentRect.width || 1200, h: entry.contentRect.height || 700 });
      }
    });
    observer.observe(board);
    return () => observer.disconnect();
  }, [boardEl]);

  // Центрирует холст на конкретной карточке (сохраняя комфортный зум)
  const centerOnTag = (tagId: string) => {
    const tag = tagsById[tagId];
    if (!tag) return;
    const pos = cardPositionsRef.current[tagId] || parseTagMetadata(tag);
    const z = Math.min(1.2, Math.max(zoomRef.current, 0.7));
    setZoom(z);
    setPan({
      x: boardSize.w / 2 - (pos.x + CARD_W / 2) * z,
      y: boardSize.h / 2 - (pos.y + CARD_H / 2) * z
    });
    // Пульс-подсветка найденной карточки
    setTimeout(() => {
      const el = document.getElementById(`tag-card-${tagId}`);
      if (el) {
        el.classList.add('share-pulse');
        setTimeout(() => el.classList.remove('share-pulse'), 3000);
      }
    }, 250);
  };

  // Последняя версия centerOnTag для отложенных вызовов. Ссылка на тег
  // (из письма, Проводника, чата) открывает окно Тегов, и холст меряется уже
  // после срабатывания ссылки: замкнутая в setTimeout старая функция считала
  // центр по размеру холста по умолчанию, и карточка уезжала за край окна
  const centerOnTagRef = useRef(centerOnTag);
  centerOnTagRef.current = centerOnTag;
  // Окно, открытое ссылкой, ещё раскрывается и растёт: центр, посчитанный по
  // первому размеру холста, после разворота оказывается сбоку. Пока ссылка
  // свежая, каждое новое измерение холста снова ставит тег в центр
  const pendingCenterRef = useRef<{ id: string; until: number } | null>(null);
  useEffect(() => {
    const p = pendingCenterRef.current;
    if (p && Date.now() < p.until) centerOnTagRef.current(p.id);
  }, [boardSize.w, boardSize.h]);

  // Вписывает группу карточек (или весь холст) в видимую область
  const fitToTags = (list: any[]) => {
    if (list.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of list) {
      const p = cardPositionsRef.current[t.id] || parseTagMetadata(t);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + CARD_W);
      maxY = Math.max(maxY, p.y + CARD_H);
    }
    const bw = Math.max(maxX - minX, 200);
    const bh = Math.max(maxY - minY, 160);
    const z = fitZoom({ x: 0, y: 0, w: bw, h: bh }, boardSize);
    setZoom(z);
    setPan({
      x: (boardSize.w - bw * z) / 2 - minX * z,
      y: (boardSize.h - bh * z) / 2 - minY * z
    });
  };

  const fitCanvasToCenter = () => {
    if (tags.length > 0) fitToTags(tags);
    else { setZoom(0.85); setPan({ x: 120, y: 80 }); }
  };

  // «Связи» вниз: выбранный тег и все его потомки по цепочке
  const collectDescendants = (tagId: string): Set<string> => {
    const out = new Set<string>([tagId]);
    const stack = [tagId];
    while (stack.length) {
      const id = stack.pop()!;
      const t = tagsById[id];
      if (!t) continue;
      for (const child of (parseTagMetadata(t).connections || [])) {
        if (!out.has(child) && tagsById[child]) {
          out.add(child);
          stack.push(child);
        }
      }
    }
    return out;
  };

  // «Связи» вверх: выбранный тег и все родители дальше вверх по лестнице
  const collectAncestors = (tagId: string): Set<string> => {
    const out = new Set<string>([tagId]);
    const stack = [tagId];
    while (stack.length) {
      const id = stack.pop()!;
      for (const p of (incomingByTagId[id] || [])) {
        if (!out.has(p)) {
          out.add(p);
          stack.push(p);
        }
      }
    }
    return out;
  };

  // Корневые теги («главные родители») — без входящих связей
  const rootTags = useMemo(
    () => tags.filter(t => !(incomingByTagId[t.id] && incomingByTagId[t.id].length > 0)),
    [tags, incomingByTagId]
  );

  // ── «Найти дубли»: перелёт/скролл к дублю на любой вкладке ──────────────────

  // Показывает тег на текущей вкладке: холст — перелёт камеры с пульсом,
  // дерево — раскрытие ветки и скролл, спецификация — скролл виртуализатора
  const focusTagEverywhere = (tagId: string) => {
    if (activeTab === 'board') {
      centerOnTag(tagId);
      return;
    }
    if (activeTab === 'tree') {
      // Раскрываем всех родителей, чтобы узел был видим
      const toExpand: Record<string, boolean> = {};
      for (const anc of collectAncestors(tagId)) toExpand[anc] = true;
      setExpandedTagIds(prev => ({ ...prev, ...toExpand }));
      setTimeout(() => {
        const el = document.getElementById(`tree-node-${tagId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('share-pulse');
          setTimeout(() => el.classList.remove('share-pulse'), 2500);
        }
      }, 120);
      return;
    }
    if (activeTab === 'table') {
      const idx = sortedTagsList.findIndex((t: any) => t.id === tagId);
      if (idx >= 0) {
        tableVirtualizer.scrollToIndex(idx, { align: 'center' });
        setTimeout(() => {
          const el = document.getElementById(`spec-row-${tagId}`);
          if (el) {
            el.classList.add('share-pulse');
            setTimeout(() => el.classList.remove('share-pulse'), 2500);
          }
        }, 250);
      }
      return;
    }
  };

  // Все теги с тем же кодом; один дубль — сразу летим к нему, несколько — панель справа
  const openDuplicates = (tagId: string) => {
    const tag = tagsById[tagId];
    if (!tag) return;
    const code = (tag.identifier || '').trim();
    const ids = tags
      .filter(t => (t.identifier || '').trim() === code)
      .map(t => t.id);
    if (ids.length <= 1) {
      addToast('Дубликатов этого кода не найдено', 'info');
      return;
    }
    const others = ids.filter(id => id !== tagId);
    if (others.length === 1) {
      focusTagEverywhere(others[0]);
      addToast(`Дубль «${code}» найден и показан`, 'success');
      return;
    }
    const startIdx = Math.max(0, ids.indexOf(tagId));
    setDupPanel({ code, ids, activeIdx: startIdx });
    focusTagEverywhere(ids[startIdx]);
  };

  const dupCountOf = (tagId: string): number => {
    const code = (tagsById[tagId]?.identifier || '').trim();
    if (!code || !duplicateCodes.has(code)) return 0;
    return tags.filter(t => (t.identifier || '').trim() === code).length;
  };

  // Переход по списку дублей (клик по строке, колесо мыши)
  const gotoDup = (idx: number) => {
    setDupPanel(prev => {
      if (!prev) return prev;
      const next = ((idx % prev.ids.length) + prev.ids.length) % prev.ids.length;
      focusTagEverywhere(prev.ids[next]);
      return { ...prev, activeIdx: next };
    });
  };

  // Колесо мыши над панелью дублей листает позиции (нужен непассивный слушатель,
  // иначе preventDefault не сработает и прокрутится страница)
  useEffect(() => {
    const el = dupPanelRef.current;
    if (!el || !dupPanel) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      gotoDup((dupPanel.activeIdx) + (e.deltaY > 0 ? 1 : -1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [dupPanel]);

  // Глубокие ссылки от ИИ-помощника: /registry?focus=<tagId> — центрировать на холсте,
  // /registry?dup=<code> — открыть панель дублей этого кода. Параметр гасим после срабатывания.
  const deepLinkHandledRef = useRef<string>('');
  useEffect(() => {
    if (tags.length === 0) return;
    const params = new URLSearchParams(location.search);
    // ?tag=<обозначение> — то же, что ?focus=, но по тому, что человек видит
    // глазами. По обозначению сюда ведут теги из Проводника и из письма: в
    // письме внутреннего номера карточки нет и быть не может.
    const byCode = params.get('tag');
    const focus = params.get('focus')
      || (byCode ? (tags.find((x) => (x.identifier || '').trim() === byCode.trim())?.id || '') : '');
    const dup = params.get('dup');
    const sig = `${params.get('focus') || ''}|${byCode || ''}|${dup || ''}`;
    if (!sig.replace(/\|/g, '').trim() || deepLinkHandledRef.current === sig) return;
    deepLinkHandledRef.current = sig;
    if (focus && tagsById[focus]) {
      setActiveTab('board');
      pendingCenterRef.current = { id: focus, until: Date.now() + 2500 };
      setTimeout(() => centerOnTagRef.current(focus), 350);
    } else if (byCode) {
      // Тег есть в письме, но не в этом проекте — молчать нельзя, иначе
      // нажатие выглядит как сломанное
      addToast(`Тег ${byCode} в этом проекте не найден.`, 'error');
    } else if (dup) {
      const t = tags.find(x => (x.identifier || '').trim() === dup.trim());
      if (t) { setActiveTab('board'); setTimeout(() => openDuplicates(t.id), 200); }
    }
    navigate('/registry', { replace: true });
  }, [location.search, tags]);

  // Свободная позиция для новой карточки: не перекрывает существующие
  const findFreePosition = (baseX: number, baseY: number): { x: number; y: number } =>
    freeSpot(Object.values(cardPositionsRef.current), { x: baseX, y: baseY }, LAYOUT_BOX);

  // Вытаскивание обозначений из текста: состояние и обработчики — в useTagExtractor.
  // Вызывается после findFreePosition: это const, и раньше строки с ней он не виден
  useTagExtractor({ activeProject, pan, zoom, findFreePosition, checkTagExists, loadTags });

  // «Поделиться в чате»: каждый выбранный тег — отдельная кликабельная кнопка
  // с названием тега, но всё в одном сообщении
  const shareTagsInChat = (ids: string[]) => {
    const list = ids.map(id => tagsById[id]).filter(Boolean);
    if (list.length === 0) return;
    const tokens = list
      .map(t => encodeShare({
        r: '/registry',
        f: `tag:${t.id}`,
        l: t.identifier,
        ty: 'el',
        p: activeProject?.id,
        pn: activeProject?.name
      }))
      .join(' ');
    useShareStore.getState().openPicker({
      route: '/registry',
      label: list.length === 1 ? list[0].identifier : `Теги (${list.length}): ${list.map(t => t.identifier).join(', ').slice(0, 60)}…`,
      type: 'el',
      insert: tokens
    });
  };

  // Переход по «поделиться-ссылке» на тег: открываем граф, центрируем и подсвечиваем
  const focusTarget = useShareStore(s => s.focusTarget);
  const clearShareFocus = useShareStore(s => s.clearFocus);
  useEffect(() => {
    if (!focusTarget || focusTarget.r !== '/registry') return;
    const f = focusTarget.f || '';
    if (!f.startsWith('tag:')) return;
    const tagId = f.slice(4);
    if (!tagsById[tagId]) return; // теги ещё загружаются — дождёмся следующего рендера
    setActiveTab('board');
    setSelectedTagIds(new Set([tagId]));
    setTimeout(() => centerOnTag(tagId), 150);
    clearShareFocus();
  }, [focusTarget, tagsById]);

  // Центрировать дерево выбранного главного родителя (и выделить его)
  const centerTreeOfRoot = (rootId: string) => {
    const treeIds = collectDescendants(rootId);
    setSelectedTagIds(treeIds);
    fitToTags(tags.filter(t => treeIds.has(t.id)));
    setCenterPickerOpen(false);
  };

  /**
   * Записать координаты сразу многим тегам.
   *
   * Раньше раскладка слала Promise.all из отдельных PUT — по запросу на тег.
   * На проекте в две тысячи тегов это две тысячи запросов и столько же
   * транзакций. Массовый маршрут в сервере есть давно, им просто не
   * пользовались отсюда.
   *
   * Пачку режем сами: сервер молча обрезает список до двух тысяч, и часть
   * координат просто не сохранилась бы, ничего об этом не сказав.
   */
  const applyPositions = async (positions: Record<string, { x: number; y: number }>) => {
    // Локальная копия — полная metadata, а на сервер уходят одни координаты:
    // он сливает ключи, и устаревший снимок остальных ключей чужих правок не затрёт
    const updates: { id: string; metadata: string }[] = [];
    const full: { id: string; metadata: string }[] = [];
    for (const t of tags) {
      const p = positions[t.id];
      if (!p) continue;
      cardPositionsRef.current[t.id] = p;
      updates.push({ id: t.id, metadata: JSON.stringify({ x: p.x, y: p.y }) });
      full.push({ id: t.id, metadata: JSON.stringify(cleanMeta({ ...parseTagMetadata(t), x: p.x, y: p.y })) });
    }
    if (!updates.length) return;
    const byId = new Map(full.map((u) => [u.id, u.metadata]));
    // parsedMetadata сбрасываем, а не переписываем: разбор кэшируется прямо в
    // объекте тега, и старый разбор пережил бы новую строку
    setTags((prev: any[]) => prev.map((t) => (byId.has(t.id)
      ? { ...t, metadata: byId.get(t.id), parsedMetadata: undefined }
      : t)));
    for (let i = 0; i < updates.length; i += 500) {
      const res = await fetch('/api/tags/bulk-metadata', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: updates.slice(i, i + 500) }),
      });
      if (!res.ok) throw new Error('bulk-metadata');
      rememberVersions((await res.json().catch(() => null))?.versions, setTags);
    }
  };

  /**
   * Авто-раскладка «Упорядочить».
   *
   * Правила раскладки — в src/lib/tagLayout.ts, здесь только применение: так их
   * можно проверить скриптом, а не глазами на трёх учебных тегах.
   */
  const [isArranging, setIsArranging] = useState(false);
  const [undoArrange, setUndoArrange] = useState<Record<string, { x: number; y: number }> | null>(null);
  const arrangeTreeLayout = async (dir: TreeAxis = axis) => {
    if (tags.length === 0 || isArranging) return;
    setIsArranging(true);
    try {
      // Развёрнутая карточка выше свёрнутой в несколько раз, а раскладка
      // считает её свёрнутой — соседний ряд лёг бы поверх неё
      setExpandedCardIds({});
      const nodes: TreeNode[] = tags.map((t: any) => ({
        id: t.id,
        connections: parseTagMetadata(t).connections || [],
      }));
      const codeOf = new Map<string, string>(tags.map((t: any) => [t.id, t.identifier || '']));
      const res = layoutForest(nodes, dir, {
        box: LAYOUT_BOX,
        keyOf: (id) => codeOf.get(id) || id,
        grid: GRID,
      });

      // Снимок ДО записи: раскладка переписывает координаты всех тегов разом,
      // и без отката расставленное руками терялось бы безвозвратно
      const before: Record<string, { x: number; y: number }> = {};
      for (const t of tags) {
        const p = cardPositionsRef.current[t.id] || parseTagMetadata(t);
        before[t.id] = { x: p.x, y: p.y };
      }

      await applyPositions(res.positions);
      setUndoArrange(before);
      fitToTags(tags);
      addToast(`Дерево упорядочено: ${dir === 'down' ? 'сверху вниз' : 'слева направо'}`, 'success');
      if (res.cycled.length) {
        addToast(`Теги в кольце: ${res.cycled.length}. Они вынесены отдельно и ждут выправления.`, 'info');
      }
    } catch (e) {
      addToast('Не удалось упорядочить дерево', 'error');
    } finally {
      setIsArranging(false);
    }
  };

  /** Вернуть карточки туда, где они стояли до раскладки */
  const undoArrangeLayout = async () => {
    if (!undoArrange) return;
    try {
      await applyPositions(undoArrange);
      setUndoArrange(null);
      fitToTags(tags);
      addToast('Раскладка отменена', 'success');
    } catch (e) {
      addToast('Не удалось вернуть прежнюю раскладку', 'error');
    }
  };


  // Form description mechanics
  const handleAddDescription = async (tagId: string, text: string, comment: string, status: DescriptionItem['status'] = 'actual') => {
    if (!text) return;
    const tag = tags.find(t => t.id === tagId);
    if (!tag) return;

    const meta = parseTagMetadata(tag);
    const newDesc: DescriptionItem = {
      id: Date.now().toString(),
      text,
      comment,
      status,
      createdBy: user?.name || user?.login || 'Пользователь',
      createdAt: new Date().toISOString()
    };
    meta.descriptions = [...meta.descriptions, newDesc];
    meta.updatedBy = user?.name || user?.login || 'Пользователь';
    meta.updatedAt = new Date().toISOString();

    // Конфликт: введённый текст остаётся в поле — «повторите правку» не должно стирать набранное
    if (!await saveTagMetadata(tagId, meta)) return;

    setQuickDescText(prev => ({ ...prev, [tagId]: '' }));
    setQuickCommentText(prev => ({ ...prev, [tagId]: '' }));
    setQuickStatus(prev => ({ ...prev, [tagId]: 'actual' }));

    if (editingTag && editingTag.id === tagId) {
      setEditingTag({ ...tag, metadata: JSON.stringify(meta) });
    }
  };

  const handleRemoveDescription = async (tagId: string, descId: string) => {
    const tag = tags.find(t => t.id === tagId);
    if (!tag) return;

    const meta = parseTagMetadata(tag);
    meta.descriptions = meta.descriptions.filter(d => d.id !== descId);
    meta.updatedBy = user?.name || user?.login || 'Пользователь';
    meta.updatedAt = new Date().toISOString();

    const saved = await saveTagMetadata(tagId, meta);

    if (saved && editingTag && editingTag.id === tagId) {
      setEditingTag({ ...tag, metadata: JSON.stringify(meta) });
    }
  };

  const handleUpdateMainName = async (tagId: string, name: string) => {
    const tag = tags.find(t => t.id === tagId);
    if (!tag) return;

    const meta = parseTagMetadata(tag);
    meta.mainName = name;
    meta.updatedBy = user?.name || user?.login || 'Пользователь';
    meta.updatedAt = new Date().toISOString();

    const saved = await saveTagMetadata(tagId, meta);

    if (saved && editingTag && editingTag.id === tagId) {
      setEditingTag({ ...tag, metadata: JSON.stringify(meta) });
    }
  };

  // Переименование кода тега (identifier). Связи хранятся по id — сохраняются.
  const handleRenameTag = async (tagId: string, rawCode: string) => {
    const code = rawCode.trim();
    const tag = tags.find(t => t.id === tagId);
    if (!tag || !code || code === tag.identifier) return;
    if (/[а-яё]/i.test(code)) { addToast('Код тега только на латинице', 'error'); setModalCode(tag.identifier); return; }
    try {
      if (!await saveTagFields(tag, { identifier: code })) { setModalCode(tag.identifier); return; }
      setTags(prev => prev.map(t => t.id === tagId ? { ...t, identifier: code } : t));
      if (editingTag && editingTag.id === tagId) setEditingTag((prev: any) => prev ? { ...prev, identifier: code } : null);
      flashSaved();
    } catch { addToast('Не удалось изменить код тега', 'error'); setModalCode(tag.identifier); }
  };

  const handleUpdateDynamicFields = async (tagId: string, updatedFields: Record<string, string>) => {
    const tag = tags.find(t => t.id === tagId);
    if (!tag) return;

    const meta = { ...parseTagMetadata(tag) };
    meta.dynamicFields = {
      ...(meta.dynamicFields || {}),
      ...updatedFields
    };

    // Determine if any updated fields affect DB columns department / fluid
    const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
    const cats = configDict
      ? (configDict.items || [])
          .filter((i: any) => !i.parentId)
          .sort((a: any, b: any) => a.code.localeCompare(b.code))
      : [];

    let updatedDepartment = tag.department;
    let updatedFluid = tag.fluid;

    cats.forEach((cat: any) => {
      const val = meta.dynamicFields?.[cat.id] ?? meta.dynamicFields?.[cat.nameRu];
      if (val !== undefined) {
        const lowName = cat.nameRu.toLowerCase();
        const lowCode = cat.code.toLowerCase();
        if (lowCode.includes('dep') || lowName.includes('дисциплина') || lowName.includes('отдел')) {
          updatedDepartment = val;
        } else if (lowCode.includes('fluid') || lowName.includes('среда') || lowName.includes('свойство') || lowName.includes('fluid')) {
          updatedFluid = val;
        }
      }
    });

    try {
      setTags(prev => prev.map(t => t.id === tagId ? { 
        ...t, 
        department: updatedDepartment,
        fluid: updatedFluid,
        parsedMetadata: meta, 
        metadata: JSON.stringify(meta) 
      } : t));

      // Версия и только изменившиеся ключи — как в saveTagMetadata (tagWrite.ts)
      if (!await saveTagMetadataPatch(tag, meta, { setTags, addToast }, { department: updatedDepartment, fluid: updatedFluid })) return;

      if (editingTag && editingTag.id === tagId) {
        setEditingTag({ ...tag, department: updatedDepartment, fluid: updatedFluid, metadata: JSON.stringify(meta), parsedMetadata: meta });
      }
    } catch (err) {
      console.error("Error updating dynamic fields:", err);
    }
  };


  const handleUpdateBrand = async (tagId: string, value: string) => {
    const tag = tags.find(t => t.id === tagId);
    if (!tag) return;

    try {
      setTags(prev => prev.map(t => t.id === tagId ? { 
        ...t, 
        brand: value
      } : t));

      if (!await saveTagFields(tag, { brand: value })) return;

      if (editingTag && editingTag.id === tagId) {
        setEditingTag(prev => prev ? { ...prev, brand: value } : null);
      }
    } catch (err) {
      console.error("Error updating brand:", err);
    }
  };

  const handleUpdateDescriptionStatus = async (tagId: string, descId: string, newStatus: DescriptionItem['status']) => {
    const tag = tags.find(t => t.id === tagId);
    if (!tag) return;

    const meta = parseTagMetadata(tag);
    meta.descriptions = meta.descriptions.map(d => 
      d.id === descId 
        ? { 
            ...d, 
            status: newStatus, 
            updatedBy: user?.name || user?.login || 'Пользователь', 
            updatedAt: new Date().toISOString() 
          } 
        : d
    );
    meta.updatedBy = user?.name || user?.login || 'Пользователь';
    meta.updatedAt = new Date().toISOString();

    const saved = await saveTagMetadata(tagId, meta);

    if (saved && editingTag && editingTag.id === tagId) {
      setEditingTag({ ...tag, metadata: JSON.stringify(meta) });
    }
  };

  const handleUpdateDescription = async (tagId: string, descId: string, fields: Partial<DescriptionItem>) => {
    const tag = tags.find(t => t.id === tagId);
    if (!tag) return;

    const meta = parseTagMetadata(tag);
    meta.descriptions = meta.descriptions.map(d => {
      if (d.id === descId) {
        return {
          ...d,
          ...fields,
          updatedBy: user?.name || user?.login || 'Пользователь',
          updatedAt: new Date().toISOString()
        };
      }
      return d;
    });
    meta.updatedBy = user?.name || user?.login || 'Пользователь';
    meta.updatedAt = new Date().toISOString();

    const saved = await saveTagMetadata(tagId, meta);

    if (saved && editingTag && editingTag.id === tagId) {
      setEditingTag({ ...tag, metadata: JSON.stringify(meta) });
    }
  };

  // Строка быстрого создания: состояние и логика — в useQuickCreate. Вызывается
  // здесь, после загрузки тегов и доски, потому что им нужны loadTags и поиск
  // свободного места
  const {
    newTagIdentifier, setNewTagIdentifier, newTagMainName, setNewTagMainName,
    setNewTagDepartment, setNewTagFluid, newTagActuality, setNewTagActuality,
    newTagBrand, setNewTagBrand, isIdentifierUnique, matchingSuggestions,
    handleDynamicCategoryChange, handleTagIdentifierChange, handleCreateTag,
  } = useQuickCreate({
    tags, activeProject, user, dictionaries, pan, zoom, findFreePosition, newTagSpotRef,
    splitSegments, checkTagExists, loadTags, dynamicCategorySelections, setDynamicCategorySelections,
  });

  // Удаление тега, сборка дерева и цепочка предков — в useTagTreeOps. Вызов стоит
  // раньше сборщика по сегментам: ему нужна getParentTraceLineage
  const { handleDeleteTag, buildTree, getParentTraceLineage } = useTagTreeOps({
    tags, searchQuery, saveTagMetadata, setEditingTag, setSelectedTagIds, loadTags,
  });

  // Re-assign logical parenting
  const handleSort = (key: string) => {
    setSortConfig(current => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const getSortedTags = () => {
    const filtered = tags.filter(t => 
      t.identifier.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (t.department && t.department.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (t.fluid && t.fluid.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (t.brand && t.brand.toLowerCase().includes(searchQuery.toLowerCase()))
    );

    return filtered.sort((a, b) => {
      let valA = a[sortConfig.key] || '';
      let valB = b[sortConfig.key] || '';

      if (sortConfig.key === 'createdAt') {
        valA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        valB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      }

      if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  };

  const toggleTagExpand = (id: string) => {
    setExpandedTagIds(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // Сборщик по сегментам: состояние и логика — в useSegmentCollector. Хук вызывается здесь,
  // а не во вкладке: вкладка монтируется заново и теряла бы введённое, а список
  // подборки нужен ещё и «Обмену»
  const collector = useSegmentCollector({ tags, dictionaries, splitSegments, splitTagIntoParts, getParentTraceLineage });
  const { matchedTagsList } = collector;

  const parentRefTable = useRef<HTMLDivElement>(null);
  const sortedTagsList = useMemo(() => getSortedTags(), [tags, searchQuery, sortConfig]);

  // Марки, уже встречающиеся в проекте: подсказка вместо конструктора марки.
  // Люди пишут одну и ту же марку по-разному, и список сам это выравнивает
  const projectBrands = useMemo(() => {
    const set = new Set<string>();
    for (const t of tags) { const b = String(t.brand || '').trim(); if (b) set.add(b); }
    return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
  }, [tags]);

  const tableVirtualizer = useVirtualizer({
    count: sortedTagsList.length,
    getScrollElement: () => parentRefTable.current,
    estimateSize: () => 80,
    overscan: 10,
  });

  // Excel compliant export (CSV with Cyrillic BOM)
  /**
   * Подборка тегов в виде таблицы: заголовки и строки по выбранным колонкам.
   *
   * Одна сборка на два выхода — файл Excel и буфер обмена. Раньше выход был
   * один, и «скопировать три строки в письмо» требовало создать файл, открыть
   * его, выделить и потом удалить.
   */
  /**
   * Обмен одним окном (§9 дизайна): что выгружаем, куда и какие столбцы —
   * в одном окне, с подписью «сколько получится» до нажатия. Прежняя полоса
   * занимала экран целиком, и чтобы найти нужное, приходилось крутить страницу.
   */
  const [exchangeOpen, setExchangeOpen] = useState(false);
  const dynamicFieldNames = useMemo(() => {
    const config = dictionaries.find((dictionary: any) => dictionary.name === '__tag_creation_config__');
    return Object.fromEntries((config?.items || []).filter((item: any) => !item.parentId).map((item: any) => [item.id, item.nameRu]));
  }, [dictionaries]);
  const EXCHANGE_COLUMNS = useMemo(() => tagExchangeColumns(tags, dynamicFieldNames), [tags, dynamicFieldNames]);

  const buildExchange = (scopeId: string, cols: Column[]) => buildTagExchange(
    scopeId === 'selected' ? tags.filter((t: any) => selectedTagIds.has(t.id))
      : scopeId === 'filtered' ? matchedTagsList : tags,
    cols,
    { lineage: getParentTraceLineage, meta: parseTagMetadata, status: getTagOverallStatus, dynamicFieldNames },
  );

  const startNewTag = () => {
    if (activeTab !== 'board' && activeTab !== 'table') setActiveTab('table');
    setTimeout(() => (document.querySelector('#registry-screen-root [data-tour="tag-code-input"]') as HTMLInputElement | null)?.focus(), 60);
  };

  if (!activeProject) {
    return (
      <NoProject what="Реестр тегов" />
    );
  }

  return (
    <div id="registry-screen-root" className="fx-page @container animate-fadeIn">
      <RegistryHeader
        tagCount={tags.length}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onNewTag={startNewTag}
        lastCapture={lastCapture}
        onDismissCapture={() => setLastCapture(null)}
        onShowCapture={(capture) => {
          captureUntilRef.current = Date.now() + 3600;
          const ids = [...capture.created, ...capture.filled];
          const cards = ids.map((id) => loadedTagsRef.current.find((t: any) => t.id === id)).filter(Boolean);
          if (cards.length && activeTab === 'board') fitToTags(cards as any[]);
          flashCapture(capture);
        }}
      />

      {/* QUICK PANEL, REAL-TIME VALIDATION & SEARCH */}
      {/* Панель инструментов: найти → создать. Строка создания — только там,
          где новый тег сразу виден (схема и спецификация); на Подборе и в
          Экспорте её не было смысла держать на экране */}
      {(activeTab === 'board' || activeTab === 'table' || activeTab === 'tree') && (
      <div className="fx-tools items-start">
        {(activeTab === 'board' || activeTab === 'table') && (
          <QuickCreateBar
            newTagIdentifier={newTagIdentifier}
            setNewTagIdentifier={setNewTagIdentifier}
            handleTagIdentifierChange={handleTagIdentifierChange}
            isIdentifierUnique={isIdentifierUnique}
            matchingSuggestions={matchingSuggestions}
            newTagBrand={newTagBrand}
            setNewTagBrand={setNewTagBrand}
            newTagMainName={newTagMainName}
            setNewTagMainName={setNewTagMainName}
            newTagActuality={newTagActuality}
            setNewTagActuality={setNewTagActuality}
            setNewTagDepartment={setNewTagDepartment}
            setNewTagFluid={setNewTagFluid}
            showAdvancedCreation={showAdvancedCreation}
            setShowAdvancedCreation={setShowAdvancedCreation}
            dictionaries={dictionaries}
            dynamicCategorySelections={dynamicCategorySelections}
            handleDynamicCategoryChange={handleDynamicCategoryChange}
            handleCreateTag={handleCreateTag}
          />
        )}

        {/* Универсальный поиск по разделу: тег, наименование, марка, дубли */}
        <div className="w-64 shrink-0 ml-auto">
        <TagSearchPanel
          tags={tags}
          selectedTagIds={selectedTagIds}
          activeTab={activeTab}
          onQueryChange={setSearchQuery}
          onToggleSelect={(tagId) => {
            setSelectedTagIds(prev => {
              const next = new Set(prev);
              if (next.has(tagId)) next.delete(tagId);
              else next.add(tagId);
              return next;
            });
          }}
          onOpenResult={(tagId) => {
            setSelectedTagIds(new Set([tagId]));
            if (activeTab === 'board') centerOnTag(tagId);
          }}
          onShowSelected={() => {
            if (activeTab === 'board') fitToTags(tags.filter(t => selectedTagIds.has(t.id)));
          }}
          onClearSelection={() => setSelectedTagIds(new Set())}
        />
        </div>
      </div>
      )}

      {/* TABS INTERFACE — схема и спецификация во всю ширину окна, остальные с отступом */}
      <div className={`flex-1 min-h-0 w-full relative ${activeTab === 'segments' || activeTab === 'exchange' || activeTab === 'tree' ? 'p-3' : ''}`}>
        <AnimatePresence mode="wait">
          
          {/* INTERACTIVE BOARD (GRAPH CANVAS) */}
          {activeTab === 'board' && (
            <motion.div
              key="canvas-board"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.15 }}
              className="h-full w-full flex flex-col min-h-0"
            >
              {/* THE GRAPH SPACE WITH OVERLAID CONTROLS */}
              <div 
                ref={attachBoard}
                className="w-full flex-1 min-h-0 overflow-hidden bg-slate-50 dark:bg-slate-900 border-2 border-slate-200/80 dark:border-slate-800/80 rounded-lg shadow-lg relative select-none transition-colors"
              style={{ cursor: isPanning ? 'grabbing' : (linkingFrom ? 'crosshair' : 'default') }}
              onMouseDown={(e) => {
                hideCanvasHint();
                // Правая (или средняя) кнопка — панорама холста
                if (e.button === 2 || e.button === 1) {
                  e.preventDefault();
                  setIsPanning(true);
                  panMovedRef.current = false;
                  lastMousePosRef.current = { x: e.clientX, y: e.clientY };
                  return;
                }
                // Левая по пустому месту — снять выделение и закрыть панели/режим связи
                if (e.button === 0 && e.target === e.currentTarget) {
                  setSelectedTagIds(new Set());
                  setCardPanel(null);
                  setCardMenu(null);
                  setSelectedConnection(null);
                  if (linkingFromRef.current) setLinkingFrom(null);
                }
              }}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={handleCanvasMouseUp}
              onMouseLeave={handleCanvasMouseUp}
              onContextMenu={(e) => {
                e.preventDefault();
                // Правая кнопка двигает холст, поэтому меню — только когда её
                // нажали и отпустили НА МЕСТЕ. Иначе меню выскакивало бы в
                // конце каждой панорамы
                if (panMovedRef.current) { panMovedRef.current = false; return; }
                if (e.target !== e.currentTarget) return;
                const rect = boardRef.current?.getBoundingClientRect();
                const at = rect
                  ? screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, panRef.current, zoomRef.current)
                  : { x: 0, y: 0 };
                setBoardMenu({ x: e.clientX, y: e.clientY, at });
              }}
            >
              {/* Режим связывания: подсказка сверху по центру */}
              {linkingFrom && (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-sky-600 text-white px-3 py-2 rounded-xl shadow-lg text-xs font-semibold animate-in fade-in slide-in-from-top-2">
                  <Link2 className="w-4 h-4" />
                  Кликните тег-получатель связи
                  <button type="button" onClick={() => setLinkingFrom(null)} className="ml-1 px-1.5 py-0.5 rounded bg-white/20 hover:bg-white/30 cursor-pointer">Esc — отмена</button>
                </div>
              )}

              {/* Подсказка по управлению холстом: висела поверх карточек всегда.
                  Показываем, пока пользователь не подвигал холст — дальше она
                  только загораживает. */}
              {showCanvasHint && (
              <div className="absolute bottom-3 left-3 z-30 text-2xs text-slate-400 dark:text-slate-500 bg-white/95 dark:bg-slate-950/95 backdrop-blur px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-800 pointer-events-none select-none">
                ПКМ — двигать холст · колесо — масштаб · {linkMode === 'click'
                  ? <><Link2 className="w-2.5 h-2.5 inline -mt-0.5" /> на карточке — связать</>
                  : <>тяни от точек-портов — связать</>}
              </div>
              )}

              <BoardControls
                zoom={zoom}
                setZoom={setZoom}
                zoomLabelRef={zoomLabelRef}
                fitCanvasToCenter={fitCanvasToCenter}
                centerPickerOpen={centerPickerOpen}
                setCenterPickerOpen={setCenterPickerOpen}
                rootTags={rootTags}
                centerTreeOfRoot={centerTreeOfRoot}
                axis={axis}
                axisPickerOpen={axisPickerOpen}
                setAxisPickerOpen={setAxisPickerOpen}
                chooseAxis={chooseAxis}
                arrangeTreeLayout={arrangeTreeLayout}
                isArranging={isArranging}
                undoArrange={undoArrange}
                undoArrangeLayout={undoArrangeLayout}
              />

              {/* Точечная сетка холста.
                  Раньше она была фоном самого холста — элемента 3500×2500,
                  который из-за transform уезжает в отдельный слой и
                  растрируется целиком: 8,75 млн пикселей узора при каждом
                  открытии раздела (1,35 с из 2 с на проекте с двумя тысячами
                  тегов). Теперь сетка живёт в отдельном слое размером с
                  видимую область, а панорама и масштаб отыгрываются
                  смещением и размером узора — рисуется только то, что видно. */}
              <div
                ref={gridRef}
                aria-hidden="true"
                className="absolute inset-0 pointer-events-none"
                style={{
                  backgroundImage: theme === 'dark'
                    ? 'radial-gradient(circle, #334155 1.1px, transparent 1.1px)'
                    : 'radial-gradient(circle, #cbd5e1 1.1px, transparent 1.1px)',
                  backgroundSize: `${GRID * zoom}px ${GRID * zoom}px`,
                  backgroundPosition: `${pan.x}px ${pan.y}px`,
                }}
              />
              <div
                ref={worldRef}
                className="absolute inset-0 origin-top-left pointer-events-none"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  width: `${worldSize.w}px`,
                  height: `${worldSize.h}px`
                }}
              >
                {/* Слой связей — отдельным компонентом (components/registry/BoardLinks).
                    Он же и мемоизирован: подсветка одной линии раньше жила в
                    состоянии экрана и потому перерисовывала весь холст. */}
                <BoardLinks
                  links={visibleLinks}
                  axis={axis}
                  box={LAYOUT_BOX}
                  selected={selectedConnection}
                  frame={cullInfo}
                  showFlowDots={showFlowDots}
                  onSelect={handleSelectConnection}
                  onRemove={handleRemoveLink}
                />

                {/* GRAPH CARDS CONTROLLERS */}
                <div className="absolute inset-0">
                  {tags.map((tag) => {
                    if (!isTagVisibleOnBoard(tag)) return null;
                    return (
                      <BoardCard
                        key={tag.id}
                        tag={tag}
                        tagsById={tagsById}
                        incomingByTagId={incomingByTagId}
                        selectedTagIds={selectedTagIds}
                        expandedCardIds={expandedCardIds}
                        linkMode={linkMode}
                        linkingFrom={linkingFrom}
                        activeConnectionDrag={activeConnectionDrag}
                        hoveredPort={hoveredPort}
                        draggedTagId={draggedTagId}
                        cardPositionsRef={cardPositionsRef}
                        panMovedRef={panMovedRef}
                        linkPicker={linkPicker}
                        setLinkPicker={setLinkPicker}
                        linkCandidates={linkCandidates}
                        setLinkingFrom={setLinkingFrom}
                        setHoveredPort={setHoveredPort}
                        setSelectedTagIds={setSelectedTagIds}
                        setExpandedCardIds={setExpandedCardIds}
                        setCardMenu={setCardMenu}
                        setEditingTag={setEditingTag}
                        editingDescId={editingDescId}
                        setEditingDescId={setEditingDescId}
                        editDescForm={editDescForm}
                        setEditDescForm={setEditDescForm}
                        quickDescText={quickDescText}
                        setQuickDescText={setQuickDescText}
                        quickCommentText={quickCommentText}
                        setQuickCommentText={setQuickCommentText}
                        quickStatus={quickStatus}
                        setQuickStatus={setQuickStatus}
                        isDuplicateTag={isDuplicateTag}
                        formatDateStr={formatDateStr}
                        handleTagMouseDown={handleTagMouseDown}
                        handlePortMouseDown={handlePortMouseDown}
                        handleAddConnection={handleAddConnection}
                        handleRemoveConnection={handleRemoveConnection}
                        handleAddDescription={handleAddDescription}
                        handleUpdateDescription={handleUpdateDescription}
                        handleRemoveDescription={handleRemoveDescription}
                        handleDeleteTag={handleDeleteTag}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Панель выделения: сколько выбрано + быстрые действия */}
              {selectedTagIds.size > 0 && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 bg-white/95 dark:bg-slate-950/95 backdrop-blur-md px-3 py-2 rounded-xl border border-emerald-200 dark:border-emerald-900 shadow-lg text-xs">
                  <span className="font-medium text-emerald-700 dark:text-emerald-300">Выбрано: {selectedTagIds.size}</span>
                  <button type="button"
                    onClick={() => fitToTags(tags.filter(t => selectedTagIds.has(t.id)))}
                    className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold cursor-pointer"
                  >
                    Показать
                  </button>
                  <button type="button"
                    onClick={() => shareTagsInChat(Array.from(selectedTagIds))}
                    className="px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold cursor-pointer"
                  >
                    Поделиться в чате
                  </button>
                  <button type="button"
                    onClick={() => setSelectedTagIds(new Set())}
                    className="px-2 py-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-900 text-slate-400 cursor-pointer"
                    title="Снять выделение (Esc)"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

          </motion.div>
        )}

        {/* Меню правой кнопки и мини-панель по клику — components/registry/CardActions.
            Оба открываются не только с холста: из дерева связей и из таблицы тоже */}
        {/* Меню правой кнопки по пустому холсту: раскладка, «по размеру» и
            создание тега прямо там, куда нажали */}
        {boardMenu && (
          <BoardContextMenu
            menu={boardMenu}
            chooseAxis={chooseAxis}
            arrangeTreeLayout={arrangeTreeLayout}
            fitCanvasToCenter={fitCanvasToCenter}
            /* Место запоминаем ДО открытия формы: пока человек набирает
               код, он успевает подвинуть холст, и «здесь» уезжает */
            onCreateHere={(at) => { newTagSpotRef.current = at; setShowAdvancedCreation(true); }}
            onClearSelection={() => { setSelectedTagIds(new Set()); setSelectedConnection(null); }}
            onClose={() => setBoardMenu(null)}
          />
        )}

        {/* Условие важно, а не косметика: этот блок лежит внутри
            AnimatePresence mode="wait", а тот допускает ровно одного ребёнка.
            Безусловный компонент делал детей двумя — motion ругался в консоль,
            перехватчик журнала на это предупреждение обновлял виджет прямо во
            время отрисовки, и React сообщал об обновлении при рендере. Раньше
            здесь стояли три отдельных условия, и пустых детей не возникало */}
        {(cardMenu || cardPanel || multiSelectMode) && (
        <CardActions
          menu={cardMenu}
          panel={cardPanel}
          multi={multiSelectMode}
          selectedCount={selectedTagIds.size}
          codeOf={(id) => tagsById[id]?.identifier || ''}
          dupCountOf={dupCountOf}
          onCloseMenu={() => setCardMenu(null)}
          onClosePanel={() => setCardPanel(null)}
          onSelectAncestors={(id) => setSelectedTagIds(collectAncestors(id))}
          onSelectDescendants={(id) => setSelectedTagIds(collectDescendants(id))}
          onOpenDuplicates={openDuplicates}
          onWhereUsed={(id) => openWhereUsed('tag', id)}
          onShare={(id) => shareTagsInChat(selectedTagIds.size > 0 ? Array.from(selectedTagIds) : [id])}
          onShowOnBoard={(id) => { setActiveTab('board'); setTimeout(() => centerOnTag(id), 150); }}
          onClearSelection={() => setSelectedTagIds(new Set())}
          onEdit={(id) => setEditingTag(tagsById[id])}
          onStartMulti={() => setMultiSelectMode(true)}
          onStopMulti={() => setMultiSelectMode(false)}
        />
        )}

        {dupPanel && (
          <DuplicatesPanel
            code={dupPanel.code}
            items={dupPanel.ids.map((id) => {
              const t = tagsById[id];
              return {
                id,
                code: t?.identifier || '',
                name: t ? (parseTagMetadata(t).mainName || '') : '',
                department: t?.department || '',
              };
            })}
            activeIdx={dupPanel.activeIdx}
            panelRef={dupPanelRef}
            onGo={gotoDup}
            onClose={() => setDupPanel(null)}
          />
        )}

        {/* Панель выделения для вкладок «Дерево связей» и «Спецификация» */}
        {selectedTagIds.size > 0 && activeTab !== 'board' && createPortal(
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[110] flex items-center gap-2 bg-white/95 dark:bg-slate-950/95 backdrop-blur-md px-3 py-2 rounded-xl border border-emerald-200 dark:border-emerald-900 shadow-lg text-xs">
            <span className="font-medium text-emerald-700 dark:text-emerald-300">Выбрано: {selectedTagIds.size}</span>
            <button type="button"
              onClick={() => shareTagsInChat(Array.from(selectedTagIds))}
              className="px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold cursor-pointer"
            >
              Поделиться в чате
            </button>
            <button type="button"
              onClick={() => setSelectedTagIds(new Set())}
              className="px-2 py-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-900 text-slate-400 cursor-pointer"
              title="Снять выделение (Esc)"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>,
          document.body
        )}

        {/* TREE VIEW */}
        {activeTab === 'tree' && (
          <motion.div
            key="tree-wood-tab"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -15 }}
            transition={{ duration: 0.15 }}
            className="h-full w-full overflow-y-auto space-y-4 text-left pr-1"
          >
            {/* Подсказка по способу связывания в дереве */}
            <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span className="flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5" />
                {linkMode === 'click'
                  ? <>Связи кликом: кнопка <Link2 className="w-3 h-3 inline -mt-0.5" /> у строки, затем клик по дочерней.</>
                  : <>Связи перетаскиванием: тяните строку тега на другую (перетащенный станет дочерним).</>}
              </span>
              {treeLinkingFrom && (
                <button type="button" onClick={() => setTreeLinkingFrom(null)} className="fx-btn shrink-0">Отменить связь (Esc)</button>
              )}
            </div>
            <div>
              {buildTree().length === 0 ? (
                <Empty title="Тегов пока нет" text="Дерево строится из связей «родитель — потомок». Создайте тег — кнопкой «Новый тег» справа в шапке." />
              ) : (
                <div>
                  {buildTree().map((node) => renderTreeNode(node, 0))}
                </div>
              )}
            </div>
          </motion.div>
        )}

        {activeTab === 'exchange' && (
          <motion.div
            key="exchange-tab"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -15 }}
            transition={{ duration: 0.15 }}
            className="h-full w-full overflow-y-auto pr-1"
          >
            <ExchangeTab total={tags.length}
              onImport={() => setShowImportWizard(true)}
              onExport={() => setExchangeOpen(true)} />
          </motion.div>
        )}

        {/* TAB 4: ADVANCED SEGMENT COLLECTOR & EXPORT PROCESSOR */}
        {activeTab === 'segments' && (
          <motion.div
            key="segment-aggregator-tab"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -15 }}
            transition={{ duration: 0.15 }}
            className="h-full w-full overflow-y-auto space-y-4 text-left pr-1"
          >
            <SegmentCollectorTab collector={collector} dictionaries={dictionaries} splitSegments={splitSegments} />
          </motion.div>
        )}

        {/* SPECIFICATION TABLE */}
        {activeTab === 'table' && (
          <motion.div
            key="table-spec-tab"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -15 }}
            transition={{ duration: 0.15 }}
            className="h-full w-full flex flex-col min-h-0 text-left pr-1"
          >
            <SpecTable
              tagCount={tags.length}
              sortedTags={sortedTagsList}
              tableVirtualizer={tableVirtualizer}
              scrollRef={parentRefTable}
              sortConfig={sortConfig}
              onSort={handleSort}
              showOptionalColumns={showOptionalTableColumns}
              setShowOptionalColumns={setShowOptionalTableColumns}
              showDescriptions={showTableDescriptions}
              setShowDescriptions={setShowTableDescriptions}
              selectedTagIds={selectedTagIds}
              setSelectedTagIds={setSelectedTagIds}
              setCardMenu={setCardMenu}
              onEditTag={setEditingTag}
              onDeleteTag={handleDeleteTag}
            />
          </motion.div>
        )}

      </AnimatePresence>
      </div>

      {/* Карточка тега. Код правится прямо в заголовке, остальное — ниже;
          всё сохраняется само, поэтому в подвале нет «Сохранить» */}
      {editingTag && (
        <TagCardModal
          tag={editingTag}
          setEditingTag={setEditingTag}
          loadTags={loadTags}
          modalCode={modalCode}
          setModalCode={setModalCode}
          onRenameTag={handleRenameTag}
          savedFlash={savedFlash}
          flashSaved={flashSaved}
          onDeleteTag={handleDeleteTag}
          modalMainName={modalMainName}
          setModalMainName={setModalMainName}
          onUpdateMainName={handleUpdateMainName}
          editTagBrand={editTagBrand}
          setEditTagBrand={setEditTagBrand}
          onUpdateBrand={handleUpdateBrand}
          onSaveFields={saveTagFields}
          projectBrands={projectBrands}
          setTags={setTags}
          dictionaries={dictionaries}
          onUpdateDynamicFields={handleUpdateDynamicFields}
          onAddDescription={handleAddDescription}
          onUpdateDescription={handleUpdateDescription}
          onRemoveDescription={handleRemoveDescription}
          formatDate={formatDateStr}
          projectId={activeProject?.id || 'default'}
        />
      )}

      {exchangeOpen && (
        <ExchangeDialog
          section="Теги"
          scopes={[
            { id: 'all', label: 'Все', count: tags.length },
            { id: 'filtered', label: 'Отобранные', count: matchedTagsList.length },
            { id: 'selected', label: 'Отмеченные', count: selectedTagIds.size },
          ]}
          columns={EXCHANGE_COLUMNS}
          build={buildExchange}
          onImport={() => setShowImportWizard(true)}
          importHint="Разбор файла со сверкой — прежним мастером"
          onClose={() => setExchangeOpen(false)}
        />
      )}

      {showImportWizard && activeProject && (
        <TagImportWizard
          projectId={activeProject.id}
          existingCodes={new Set(tags.map(t => (t.identifier || '').trim()).filter(Boolean))}
          onClose={() => setShowImportWizard(false)}
          onImported={() => { loadTags(); }}
        />
      )}

    </div>
  );

  // TREE VIEW RENDER NODE RECURSIVE FUNCTION
  function renderTreeNode(node: any, level: number) {
    const isExpanded = !!expandedTagIds[node.id];
    const isTreeDescVisible = !!showTreeDescriptions[node.id];
    const hasChildren = node.children && node.children.length > 0;
    const configList = node.meta.descriptions || [];

    return (
      <div key={node.id}>
        <div
          id={`tree-node-${node.id}`}
          draggable={linkMode === 'drag'}
          onDragStart={(e) => {
            if (linkMode !== 'drag') return;
            treeDraggedIdRef.current = node.id;
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', node.id); } catch (_) {}
          }}
          onDragOver={(e) => {
            if (linkMode !== 'drag') return;
            const from = treeDraggedIdRef.current;
            if (from && from !== node.id) { e.preventDefault(); if (treeDragOverId !== node.id) setTreeDragOverId(node.id); }
          }}
          onDragLeave={() => { if (treeDragOverId === node.id) setTreeDragOverId(null); }}
          onDrop={async (e) => {
            if (linkMode !== 'drag') return;
            e.preventDefault();
            const from = treeDraggedIdRef.current;
            treeDraggedIdRef.current = null;
            setTreeDragOverId(null);
            if (from && from !== node.id) await handleAddConnection(node.id, from); // перетащенный (from) → дочерний узла node
          }}
          onDragEnd={() => { treeDraggedIdRef.current = null; setTreeDragOverId(null); }}
          onClick={(e) => {
            // Ctrl+клик — мультивыбор для «Поделиться в чате»
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              setSelectedTagIds(prev => {
                const next = new Set(prev);
                if (next.has(node.id)) next.delete(node.id);
                else next.add(node.id);
                return next;
              });
              return;
            }
            // Режим «связать» кликом: выбираем строку-получателя (станет дочерней)
            if (treeLinkingFrom) {
              const from = treeLinkingFrom;
              setTreeLinkingFrom(null);
              if (from !== node.id) handleAddConnection(from, node.id);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!selectedTagIds.has(node.id)) setSelectedTagIds(new Set([node.id]));
            setCardMenu({ x: e.clientX, y: e.clientY, tagId: node.id });
          }}
          aria-current={selectedTagIds.has(node.id) || treeLinkingFrom === node.id || undefined}
          className={`fx-li group/tr justify-between ${linkMode === 'drag' ? 'cursor-move' : ''} ${
            treeDragOverId === node.id || treeLinkingFrom === node.id
              ? 'ring-1 ring-inset ring-sky-400'
              : treeLinkingFrom ? 'cursor-pointer hover:ring-1 hover:ring-inset hover:ring-sky-300' : ''
          }`}
          style={{ marginLeft: `${level * 24}px` }}
        >
          <div className="flex items-center gap-2.5 min-w-0 flex-1 text-left">
            <button type="button"
              onClick={() => toggleTagExpand(node.id)}
              aria-label={isExpanded ? 'Свернуть' : 'Развернуть'}
              className={`fx-ibtn shrink-0 ${!hasChildren ? 'invisible' : ''}`}
              disabled={!hasChildren}
            >
              {isExpanded ? <ChevronDown className="w-4 h-4 text-slate-600 dark:text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-600 dark:text-slate-400" />}
            </button>

            <Database className="w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0" />
            
            <div className="min-w-0 flex items-center gap-2.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-slate-900 dark:text-slate-100 select-all">{node.identifier}</span>
                {duplicateCodes.has((node.identifier || '').trim()) && (
                  <span className="fx-badge fx-badge-bad shrink-0" title="Дубликат кода тега">дубль</span>
                )}
                <span className="text-xs text-slate-500 dark:text-slate-400 shrink-0">
                  {node.department || 'Комплексный'}
                </span>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-[280px]" title={node.meta.mainName || 'Наименование отсутствует'}>
                {node.meta.mainName ? `— ${node.meta.mainName}` : '— без наименования'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {configList.length > 0 && (
              <div className="flex items-center gap-2">
                <button type="button"
                  onClick={() => setShowTreeDescriptions(prev => ({ ...prev, [node.id]: !prev[node.id] }))}
                  title={isTreeDescVisible ? "Скрыть комментарии" : `Показать комментарии (${configList.length})`}
                  className={`p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-colors cursor-pointer flex items-center justify-center ${
                    isTreeDescVisible ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 font-semibold' : 'text-slate-400'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5" />
                  {configList.length > 0 && <span className="text-xs ml-1">{configList.length}</span>}
                </button>
                <div className="flex items-center gap-1">
                  {configList.slice(0, 3).map((d: any, idx: number) => {
                    const s = statusConfig[d.status] || statusConfig.draft;
                    return (
                      <span 
                        key={d.id || idx} 
                        title={`${d.text}: ${d.comment}`}
                        className={`w-2 h-2 rounded-full inline-block ${s.text} bg-current`}
                      />
                    );
                  })}
                  {configList.length > 3 && <span className="text-xs text-slate-400">+{configList.length - 3}</span>}
                </div>
              </div>
            )}

            <div className={`flex gap-0.5 ${treeLinkingFrom === node.id ? '' : 'invisible group-hover/tr:visible group-focus-within/tr:visible'}`}>
              {linkMode === 'click' && (
                <button type="button"
                  onClick={(e) => { e.stopPropagation(); setTreeLinkingFrom(prev => prev === node.id ? null : node.id); }}
                  title={treeLinkingFrom === node.id ? 'Отменить связывание' : 'Связать: затем кликните дочернюю строку'}
                  aria-label="Связать с дочерним"
                  aria-pressed={treeLinkingFrom === node.id}
                  className="fx-ibtn"
                >
                  <Link2 className="w-3.5 h-3.5" />
                </button>
              )}
              <button type="button"
                onClick={() => setEditingTag(node)}
                title="Редактировать описания и комментарии тега"
                aria-label="Изменить тег"
                className="fx-ibtn"
              >
                <Edit2 className="w-3.5 h-3.5" />
              </button>
              <button type="button"
                onClick={() => handleDeleteTag(node.id)}
                title="Удалить тег"
                aria-label="Удалить тег"
                className="fx-ibtn"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {configList.length > 0 && isTreeDescVisible && (
          <div className="space-y-1.5 pb-2 text-left animate-fadeIn" style={{ marginLeft: `${(level * 24) + 38}px` }}>
            {configList.map((desc: any) => {
              const s = statusConfig[desc.status] || statusConfig.draft;
              const Icon = s.icon;
              return (
                <div key={desc.id} className="py-1 flex items-start gap-2 max-w-2xl">
                  <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${s.text}`} />
                  <div>
                    <span className="text-xs font-medium text-slate-800 dark:text-slate-100">{desc.text}</span>
                    <span className="ml-2"><Status tone={s.tone}>{s.label}</Status></span>
                    {desc.comment && (
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-normal">
                        {desc.comment}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {hasChildren && isExpanded && (
          <div className="space-y-1">
            {node.children.map((child: any) => renderTreeNode(child, level + 1))}
          </div>
        )}
      </div>
    );
  }
}
