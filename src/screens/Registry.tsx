import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import { useInsightStore } from '../store/insightStore';
import { copyAsTable } from '../lib/copyTable';
import { dataService } from '../services/dataService';
import {
  Network,
  Copy,
  List,
  Table,
  Plus,
  Trash2, 
  Edit2, 
  Link2, 
  X, 
  ChevronRight,
  ChevronDown,
  Maximize2,
  Undo2,
  ChevronUp,
  Database, 
  AlertTriangle, 
  CheckCircle2, 
  XCircle, 
  Info, 
  HelpCircle, 
  Activity, 
  ZoomIn, 
  ZoomOut, 
  RefreshCw,
  FolderTree,
  FileSpreadsheet,
  Eye,
  ArrowRight,
  ClipboardCheck,
  Check,
  Edit,
  Sliders
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { createPortal } from 'react-dom';
import { format } from 'date-fns';
import CustomSelect from '../components/CustomSelect';
import ContextMenu from '../components/ContextMenu';
import TagImportWizard from '../components/TagImportWizard';
import { encodeShare } from '../lib/shareLink';
import { useShareStore } from '../store/shareStore';
import { countOf } from '../lib/plural';
import { useModalStore } from '../store/modalStore';
import NoProject from '../components/NoProject';
import ExchangeDialog from '../components/ExchangeDialog';
import ExchangeTab from '../components/registry/ExchangeTab';
import TagComments from '../components/registry/TagComments';
import { toCsv, fileName, type Column } from '../lib/exchange';
import { TAG_EXCHANGE_COLUMNS, buildTagExchange, buildSegmentTable } from '../lib/tagExchange';
import {
  linkChild, unlinkChild, whyNotLink, repairTagTree, descendantsOf, type TreeNode, type TreePatch,
} from '../lib/tagTree';
import {
  layoutForest, linkPath, portAt, boundsOf, fitView, clampZoom, zoomAt, screenToWorld,
  hitTestCard, hitTestBox, boxFromDrag, findFreePosition as freeSpot, parkGrid, snap, fitZoom,
  DEFAULT_BOX as LAYOUT_BOX, GRID, type TreeAxis, type Point,
} from '../lib/tagLayout';
import BoardLinks, { type BoardLink } from '../components/registry/BoardLinks';
import CardActions from '../components/registry/CardActions';
import DuplicatesPanel from '../components/registry/DuplicatesPanel';

// Диалоги программы вместо системных окон Windows
const { openConfirm, openAlert, openPrompt } = useModalStore.getState();

// Габариты карточки, раскладка, геометрия портов и линий — общие правила из
// src/lib/tagLayout.ts. Здесь их держать нельзя: числа 330 и 22 уже жили
// вписанными в четырёх местах этого файла и однажды разошлись с разметкой
const CARD_W = LAYOUT_BOX.w;
const CARD_H = LAYOUT_BOX.h;

// Чистые функции уровня модуля: не зависят от состояния компонента,
// используются и главным экраном, и выделенным компонентом поиска
function parseTagMetadata(tag: any): ParsedMetadata {
  if (!tag) {
    return {
      x: Math.floor(Math.random() * 550 + 80),
      y: Math.floor(Math.random() * 320 + 80),
      connections: [],
      descriptions: []
    };
  }
  if (tag.parsedMetadata) {
    return tag.parsedMetadata;
  }
  try {
    if (tag.metadata) {
      const parsed = typeof tag.metadata === 'string' ? JSON.parse(tag.metadata) : tag.metadata;
      const res: ParsedMetadata = {
        ...parsed,
        // Пометка «координат в базе нет»: раскладку такому тегу назначает
        // сетка при загрузке реестра. Без пометки пришлось бы разбирать
        // JSON второй раз — на двух тысячах тегов это заметно.
        _noPos: parsed.x === undefined || parsed.y === undefined,
        x: parsed.x !== undefined ? parsed.x : Math.floor(Math.random() * 500 + 100),
        y: parsed.y !== undefined ? parsed.y : Math.floor(Math.random() * 300 + 100),
        parentId: parsed.parentId,
        connections: Array.isArray(parsed.connections) ? parsed.connections : [],
        descriptions: Array.isArray(parsed.descriptions) ? parsed.descriptions : []
      };
      tag.parsedMetadata = res;
      return res;
    }
  } catch (e) {
    console.error('Error parsing tag metadata:', e);
  }
  const fallback: ParsedMetadata = {
    _noPos: true,
    x: Math.floor(Math.random() * 550 + 80),
    y: Math.floor(Math.random() * 320 + 80),
    connections: [],
    descriptions: []
  };
  tag.parsedMetadata = fallback;
  return fallback;
}

function getTagOverallStatus(tag: any): 'actual' | 'warning' | 'critical' | 'info' | 'draft' {
  const meta = parseTagMetadata(tag);
  if (!meta.descriptions || meta.descriptions.length === 0) {
    return 'draft';
  }
  if (meta.descriptions.some(d => d.status === 'critical')) return 'critical';
  if (meta.descriptions.some(d => d.status === 'warning')) return 'warning';
  if (meta.descriptions.some(d => d.status === 'info')) return 'info';
  if (meta.descriptions.some(d => d.status === 'actual')) return 'actual';
  return 'draft';
}

const statusConfig = {
  actual: { bg: 'bg-emerald-500/10 dark:bg-emerald-500/20', text: 'text-emerald-500 dark:text-emerald-400', border: 'border-emerald-500/20', icon: CheckCircle2, label: 'Актуально' },
  warning: { bg: 'bg-amber-500/10 dark:bg-amber-500/20', text: 'text-amber-500 dark:text-amber-400', border: 'border-amber-500/20', icon: AlertTriangle, label: 'Проверить' },
  critical: { bg: 'bg-rose-500/10 dark:bg-rose-500/20', text: 'text-rose-500 dark:text-rose-400', border: 'border-rose-500/20', icon: XCircle, label: 'Критично' },
  info: { bg: 'bg-sky-500/10 dark:bg-sky-500/20', text: 'text-sky-500 dark:text-sky-400', border: 'border-sky-500/20', icon: Info, label: 'В работе' },
  draft: { bg: 'bg-slate-500/10 dark:bg-slate-500/20', text: 'text-slate-500 dark:text-slate-400', border: 'border-slate-500/20', icon: HelpCircle, label: 'Устарело' }
};

// Панель универсального поиска. Отдельный memo-компонент: ввод текста
// перерисовывает только эту панель, а не весь холст с карточками —
// иначе на больших проектах поиск «залагивал» при каждом символе.
interface TagSearchPanelProps {
  tags: any[];
  selectedTagIds: Set<string>;
  activeTab: string;
  onQueryChange: (q: string) => void;          // дебаунс — для фильтра таблицы/дерева
  onToggleSelect: (tagId: string) => void;
  onOpenResult: (tagId: string) => void;       // клик по строке: выделить и показать
  onShowSelected: () => void;
  onClearSelection: () => void;
}

const TagSearchPanel = React.memo(function TagSearchPanel({
  tags, selectedTagIds, activeTab, onQueryChange, onToggleSelect, onOpenResult, onShowSelected, onClearSelection
}: TagSearchPanelProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [onlyDuplicates, setOnlyDuplicates] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Дебаунс наружу: фильтр таблицы/дерева обновляется после паузы в наборе
  const handleInput = (val: string) => {
    setQuery(val);
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onQueryChange(val), 300);
  };

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const duplicateCodes = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tags) {
      const code = (t.identifier || '').trim();
      if (code) counts[code] = (counts[code] || 0) + 1;
    }
    return new Set(Object.keys(counts).filter(c => counts[c] > 1));
  }, [tags]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const dupMode = onlyDuplicates || q === 'дубли' || q === 'дубликаты';
    if (!q && !dupMode) return [];
    let list = tags;
    if (dupMode) list = list.filter(t => duplicateCodes.has((t.identifier || '').trim()));
    const qq = (q === 'дубли' || q === 'дубликаты') ? '' : q;
    if (qq) {
      list = list.filter(t => {
        const meta = parseTagMetadata(t);
        return (t.identifier || '').toLowerCase().includes(qq) ||
          (meta.mainName || '').toLowerCase().includes(qq) ||
          (t.brand || '').toLowerCase().includes(qq) ||
          (t.department || '').toLowerCase().includes(qq) ||
          (t.fluid || '').toLowerCase().includes(qq);
      });
    }
    return list.slice(0, 60);
  }, [tags, query, onlyDuplicates, duplicateCodes]);

  return (
    <div ref={boxRef} className="@[1080px]:col-span-2 p-3 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-xl shadow-xs flex flex-col justify-between text-left relative">
      <label className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase leading-none mb-1">
        Поиск по разделу:
      </label>
      <div className="relative flex-1 flex items-end">
        <input
          type="search"
          placeholder="Тег, название, марка…"
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          onFocus={() => setOpen(true)}
          className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs placeholder-slate-400 dark:placeholder-slate-550 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:bg-white dark:focus:bg-slate-950 text-slate-800 dark:text-slate-100 font-medium h-8"
        />
      </div>

      {open && (query.trim() || onlyDuplicates) && (
        <div className="absolute top-full right-0 mt-1 w-[min(94vw,420px)] bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl z-[60] overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-850 flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              Найдено: {results.length}
            </span>
            <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={onlyDuplicates}
                onChange={(e) => setOnlyDuplicates(e.target.checked)}
                className="accent-rose-500"
              />
              Только дубли
            </label>
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5 space-y-0.5">
            {results.length === 0 ? (
              <div className="text-center text-xs text-slate-400 py-5">Ничего не найдено</div>
            ) : results.map(t => {
              const meta = parseTagMetadata(t);
              const st = statusConfig[getTagOverallStatus(t)] || statusConfig.draft;
              const dup = duplicateCodes.has((t.identifier || '').trim());
              const checked = selectedTagIds.has(t.id);
              return (
                <div
                  key={t.id}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900 cursor-pointer ${checked ? 'bg-emerald-50 dark:bg-emerald-950/30' : ''}`}
                  onClick={() => {
                    onOpenResult(t.id);
                    setOpen(false);
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      e.stopPropagation();
                      onToggleSelect(t.id);
                    }}
                    className="accent-emerald-500 shrink-0"
                    title="Отметить для мультивыбора"
                  />
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${st.text} bg-current`} title={`Актуальность: ${st.label}`} />
                  <span className="font-mono font-bold text-xs text-emerald-700 dark:text-emerald-400 truncate">{t.identifier}</span>
                  {dup && (
                    <span className="shrink-0 text-2xs font-bold px-1 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60 uppercase">дубль</span>
                  )}
                  <span className="text-xs text-slate-500 dark:text-slate-400 truncate flex-1">{meta.mainName || ''}</span>
                  {t.brand && <span className="font-mono text-2xs text-slate-400 truncate max-w-[80px] shrink-0">{t.brand}</span>}
                </div>
              );
            })}
          </div>
          {selectedTagIds.size > 0 && (
            <div className="px-3 py-2 border-t border-slate-100 dark:border-slate-850 flex items-center justify-between gap-2 bg-slate-50/60 dark:bg-slate-900/40">
              <span className="text-xs font-bold text-emerald-600 dark:text-emerald-300">Отмечено: {selectedTagIds.size}</span>
              <div className="flex items-center gap-1.5">
                <button type="button"
                  onClick={() => {
                    onShowSelected();
                    setOpen(false);
                  }}
                  className="px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold cursor-pointer"
                >
                  Показать
                </button>
                <button type="button"
                  onClick={onClearSelection}
                  className="px-2 py-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-900 text-slate-400 text-xs cursor-pointer"
                >
                  Сбросить
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/** Одинаковое поле карточки тега: раньше каждое несло свой набор классов */
const cardField = 'w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-900 border border-slate-205 dark:border-slate-800 rounded-lg text-xs text-slate-850 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500';

const actualitySelectOptions = [
  { value: 'actual', label: '🟢 Актуально' },
  { value: 'warning', label: '🟡 Проверить' },
  { value: 'critical', label: '🔴 Критично' },
  { value: 'info', label: '🔵 В работе' },
  { value: 'draft', label: '⚪ Устарело' }
];

const emojiOptions = [
  { value: 'actual', label: '🟢' },
  { value: 'warning', label: '🟡' },
  { value: 'critical', label: '🔴' },
  { value: 'info', label: '🔵' },
  { value: 'draft', label: '⚪' }
];

interface DescriptionItem {
  id: string;
  text: string;
  comment: string;
  status: 'actual' | 'warning' | 'critical' | 'info' | 'draft';
  createdBy?: string;
  createdAt?: string;
  updatedBy?: string;
  updatedAt?: string;
}

interface ParsedMetadata {
  x: number;
  y: number;
  /** Координат в базе не было — позицию назначает сетка при загрузке */
  _noPos?: boolean;
  mainName?: string;
  parentId?: string;
  connections: string[]; // List of tag IDs this tag has peer-connections with
  descriptions: DescriptionItem[];
  dynamicFields?: Record<string, string>;
  createdBy?: string;
  createdAt?: string;
  updatedBy?: string;
  updatedAt?: string;
  tagSegments?: string[];
  markSegments?: string[];
}

interface PortHover {
  tagId: string;
  side: 'left' | 'right';
}

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
  const { activeProject, theme, user } = useStore();
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
  const [systems, setSystems] = useState<any[]>([]);
  const [selectedSystemId, setSelectedSystemId] = useState<string | null>(null);
  const [isSystemsLoading, setIsSystemsLoading] = useState(false);
  const [bindingBlock, setBindingBlock] = useState<{ id: string, name: string, tags: any[] } | null>(null);
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

  // Способ создания связей на ХОЛСТЕ и в ДЕРЕВЕ: 'click' или 'drag'. Настройки
  // из «Настройки → Теги»; меняются вживую по событию.
  const [linkMode, setLinkMode] = useState<'click' | 'drag'>('click');
  const [treeLinkMode, setTreeLinkMode] = useState<'click' | 'drag'>('click');
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
    fetch('/api/settings/tree_link_mode').then(r => r.json()).then(d => {
      if (d.global === 'drag' || d.global === 'click') setTreeLinkMode(d.global);
    }).catch(() => {});
    const onSettings = (e: any) => {
      const v = e?.detail?.value;
      if (v !== 'click' && v !== 'drag') return;
      if (e.detail.key === 'registry_link_mode') { setLinkMode(v); setLinkingFrom(null); }
      if (e.detail.key === 'tree_link_mode') { setTreeLinkMode(v); setTreeLinkingFrom(null); }
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

  useEffect(() => {
    // Теги без сохранённых координат раньше получали случайную точку в
    // области 550×320: полсотни карточек ложились друг на друга, и холст
    // при открытии читать было нельзя, пока не нажмёшь «Упорядочить».
    // Раскладываем их сеткой — детерминированно и без наложений.
    // Число столбцов подбирает parkGrid — так, чтобы холст был близок к
    // пропорциям экрана: при шести столбцах две тысячи тегов вытягивались в
    // ленту высотой 44 тысячи пикселей, и до нижних карточек было не добраться.
    const noPos = tags.filter((t: any) => parseTagMetadata(t)._noPos);
    const grid = parkGrid(noPos.length, { x: 80, y: 60 }, LAYOUT_BOX);
    const spot = new Map<string, Point>(noPos.map((t: any, i: number) => [t.id, grid[i]]));
    const positions: Record<string, { x: number, y: number }> = {};
    for (const t of tags) {
      const meta = parseTagMetadata(t);
      const put = spot.get(t.id);
      if (put) { meta.x = put.x; meta.y = put.y; }
      positions[t.id] = { x: meta.x, y: meta.y };
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

  // Quick manually create tag
  const [newTagIdentifier, setNewTagIdentifier] = useState('');
  const [newTagMainName, setNewTagMainName] = useState('');
  const [newTagDepartment, setNewTagDepartment] = useState('Отдел КИПиА');
  const [newTagFluid, setNewTagFluid] = useState('Воздух');
  const [newTagActuality, setNewTagActuality] = useState<'actual' | 'warning' | 'critical' | 'info' | 'draft'>('info');
  const [showAdvancedCreation, setShowAdvancedCreation] = useState(false);
  const [dynamicCategorySelections, setDynamicCategorySelections] = useState<Record<string, string>>({});

  // Brand (Марка) Creation & Editing States
  const [newTagBrand, setNewTagBrand] = useState('');
  const [newTagMarkingSelections, setNewTagMarkingSelections] = useState<Record<string, string>>({});
  const [newTagMarkingSeparator, setNewTagMarkingSeparator] = useState('-');

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

  const handleDynamicCategoryChange = (catId: string, val: string) => {
    setDynamicCategorySelections(prev => ({
      ...prev,
      [catId]: val
    }));
  };

  // Cyrillic layout warning and char blocker
  const handleTagIdentifierChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (/[а-яА-ЯёЁ]/.test(val)) {
      addToast("Смените раскладку! Ввод тегов разрешен только на латинице.", "error");
      return;
    }
    setNewTagIdentifier(val);
  };

  const matchingSuggestions = useMemo(() => {
    if (!newTagIdentifier) return [];
    const searchVal = newTagIdentifier.trim().toLowerCase();
    const prefix = tags.filter(t => t.identifier.toLowerCase().startsWith(searchVal));
    const sub = tags.filter(t => !t.identifier.toLowerCase().startsWith(searchVal) && t.identifier.toLowerCase().includes(searchVal));
    return [...prefix, ...sub].slice(0, 8);
  }, [newTagIdentifier, tags]);

  // Text Extractor Tool State
  const [pastedDocText, setPastedDocText] = useState('');
  const [extractedTags, setExtractedTags] = useState<{ identifier: string; exists: boolean }[]>([]);

  // Regex splitting utility
  const splitSegments = useCallback((str: string): string[] => {
    if (!str) return [];
    return str.split(/[-.,\/ ]+/).filter(Boolean);
  }, []);

  // Independent segment filters for Tag (left) and Mark (right)
  const [activeTagFilters, setActiveTagFilters] = useState<{ [position: number]: string }>({});
  const [activeMarkFilters, setActiveMarkFilters] = useState<{ [position: number]: string }>({});
  
  const [tagSearchQueries, setTagSearchQueries] = useState<{ [position: number]: string }>({});
  const [markSearchQueries, setMarkSearchQueries] = useState<{ [position: number]: string }>({});

  const [tagDictBindings, setTagDictBindings] = useState<{ [position: number]: string }>({});
  const [markDictBindings, setMarkDictBindings] = useState<{ [position: number]: string }>({});

  const [tagHierarchySelections, setTagHierarchySelections] = useState<{ [position: number]: any }>({});
  const [markHierarchySelections, setMarkHierarchySelections] = useState<{ [position: number]: any }>({});

  const [selectedTagFilterCategoryIds, setSelectedTagFilterCategoryIds] = useState<{ [position: number]: string }>({});
  const [selectedMarkFilterCategoryIds, setSelectedMarkFilterCategoryIds] = useState<{ [position: number]: string }>({});

  const [addedTagSegmentsCount, setAddedTagSegmentsCount] = useState<number>(0);
  const [addedMarkSegmentsCount, setAddedMarkSegmentsCount] = useState<number>(0);

  const [dictionaries, setDictionaries] = useState<any[]>([]);

  const [excludeEmptyWBS, setExcludeEmptyWBS] = useState(false);
  const [onlyWithWarning, setOnlyWithWarning] = useState(false);
  const [exportColumns, setExportColumns] = useState({
    identifier: true,
    brand: true,
    brandParts: true,
    department: true,
    fluid: true,
    parts: true,
    chain: true,
    descriptions: true
  });

  // Load all tags
  // Последний прочитанный список — состояние в замыкании эффекта уже устарело,
  // а подсветке после захвата нужны свежие карточки прямо сейчас
  const loadedTagsRef = useRef<any[]>([]);

  const loadTags = async () => {
    if (!activeProject) return;
    setIsLoading(true);
    try {
      const data = await dataService.getTags(activeProject.id);
      const tagsList = data.tags || [];
      const tagsWithParsedMetadata = tagsList.map((t: any) => ({
        ...t,
        parsedMetadata: parseTagMetadata(t)
      }));
      /**
       * Выправить дерево, если его успели испортить.
       *
       * Прежняя строка «Родительский тег» писала выбранного родителя в
       * СОБСТВЕННЫЙ список детей тега: связь смотрела в обе стороны сразу, и
       * дерево читалось наизнанку — родитель оказывался ребёнком своего же
       * ребёнка. Строку убрали, но записи в базе остались, и сами они не
       * выпрямятся. Правки нужны редко: здоровое дерево не даёт ни одной.
       */
      const patches = repairTagTree(tagsWithParsedMetadata.map((t: any) => ({
        id: t.id,
        connections: t.parsedMetadata.connections || [],
        parentId: t.parsedMetadata.parentId,
      })));
      for (const patch of patches) {
        const t = tagsWithParsedMetadata.find((x: any) => x.id === patch.id);
        if (!t) continue;
        t.parsedMetadata = { ...t.parsedMetadata, connections: patch.connections, parentId: patch.parentId };
        t.metadata = JSON.stringify(t.parsedMetadata);
        void fetch(`/api/tags/${patch.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ metadata: t.metadata }),
        }).catch(() => { /* не записалось — выправим на следующей загрузке */ });
      }
      if (patches.length) {
        addToast(`Связи тегов выправлены: ${patches.length}`, 'info');
      }
      setTags(tagsWithParsedMetadata);
      loadedTagsRef.current = tagsWithParsedMetadata;
      // Выделение не должно ссылаться на удалённые теги (иначе «Выбрано: 2»
      // после удаления одного из выбранных и лишние рендеры)
      const liveIds = new Set(tagsList.map((t: any) => t.id));
      setSelectedTagIds(prev => {
        if (prev.size === 0) return prev;
        const next = new Set(Array.from(prev).filter(id => liveIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch (err) {
      console.error('Failed to load tags:', err);
    } finally {
      setIsLoading(false);
    }
  };

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

  const loadSystems = async () => {
    if (!activeProject) return;
    setIsSystemsLoading(true);
    try {
      const data = await dataService.getSystems(activeProject.id);
      const loaded = data.systems || [];
      setSystems(loaded);
      if (loaded.length > 0 && !selectedSystemId) {
        setSelectedSystemId(loaded[0].id);
      }
    } catch (err) {
      console.error('Failed to load systems:', err);
    } finally {
      setIsSystemsLoading(false);
    }
  };

  const handlePinTagToComponent = async (componentId: string, tagId: string) => {
    try {
      await dataService.linkTagToComponent(componentId, tagId);
      addToast("Тег успешно привязан к блоку", "success");
      await loadSystems();
      if (bindingBlock) {
        const selectedComponent = tags.find(t => t.id === tagId);
        setBindingBlock(prev => {
          if (!prev) return null;
          const updatedTags = [...prev.tags];
          if (!updatedTags.some(t => t.id === tagId) && selectedComponent) {
            updatedTags.push(selectedComponent);
          }
          return { ...prev, tags: updatedTags };
        });
      }
    } catch (e) {
      console.error(e);
      addToast("Ошибка привязки тега", "error");
    }
  };

  const handleUnpinTagFromComponent = async (componentId: string, tagId: string) => {
    try {
      await dataService.unlinkTagFromComponent(componentId, tagId);
      addToast("Связь с тегом удалена", "success");
      await loadSystems();
      if (bindingBlock) {
        setBindingBlock(prev => {
          if (!prev) return null;
          return {
            ...prev,
            tags: prev.tags.filter(t => t.id !== tagId)
          };
        });
      }
    } catch (e) {
      console.error(e);
      addToast("Ошибка разрыва связи", "error");
    }
  };

  const handleCreateAndPinTag = async (componentId: string) => {
    const identifier = await openPrompt('Новый тег', 'Код тега — латиницей, как в проектной документации.', 'Например: AHU-103');
    if (!identifier || !identifier.trim()) return;
    if (/[а-яА-ЯёЁ]/.test(identifier)) {
      addToast("Ошибка: Код тега должен быть на латинице!", "error");
      return;
    }
    
    let existing = tags.find(t => t.identifier.toLowerCase() === identifier.trim().toLowerCase());
    if (!existing) {
      try {
        const freePos = findFreePosition(Math.floor(Math.random() * 400 + 100), Math.floor(Math.random() * 300 + 100));
        const initialMeta: ParsedMetadata = {
          x: freePos.x,
          y: freePos.y,
          connections: [],
          descriptions: [{ id: 'auto', text: 'Создан при привязке к спецификации', comment: `Блок: ${bindingBlock?.name}`, status: 'info' }]
        };
        const res = await dataService.createTag(activeProject.id, {
          identifier: identifier.trim(),
          department: 'Отдел КИПиА',
          fluid: 'Воздух',
          metadata: JSON.stringify(initialMeta)
        });
        existing = res;
        await loadTags();
      } catch (err) {
        console.error(err);
        addToast("Ошибка регистрации", "error");
        return;
      }
    }

    if (existing) {
      await handlePinTagToComponent(componentId, existing.id);
    }
  };

  useEffect(() => {
    loadTags();
    loadDictionaries();
    loadSystems();
  }, [activeProject?.id]); // по идентификатору, а не по объекту: иначе перезапрос при каждой смене ссылки

  // ИИ-чат мог переименовать тег — перечитываем список, чтобы холст обновился
  useEffect(() => {
    const onTagsChanged = () => loadTags();
    window.addEventListener('flux:tags-changed', onTagsChanged);
    return () => window.removeEventListener('flux:tags-changed', onTagsChanged);
  }, []);

  // ── Подсветка после захвата с экрана ────────────────────────────────────
  //
  // Вспышки мало: отвернулся — и всё, что добавилось, потерялось. Поэтому
  // кроме волны в шапке остаётся закрываемая плашка «последний захват».
  // И вспышка обязана переезжать за инженером: подсветку зажигаем в том виде,
  // который открыт сейчас, и перезажигаем при переключении вкладки.
  const [lastCapture, setLastCapture] = useState<
    { created: string[]; filled: string[]; duplicated: string[] } | null
  >(null);
  const captureUntilRef = useRef(0);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const flashCapture = (data: { created: string[]; filled: string[]; duplicated: string[] }) => {
    const queue: { id: string; cls: string }[] = [
      ...data.created.map((id) => ({ id, cls: 'capture-pulse-new' })),
      ...data.filled.map((id) => ({ id, cls: 'capture-pulse-fill' })),
      ...data.duplicated.map((id) => ({ id, cls: 'capture-pulse-dup' })),
    ];
    queue.forEach(({ id, cls }, i) => {
      setTimeout(() => {
        // Один и тот же тег в разных видах живёт под своим идентификатором;
        // подсвечиваем тот элемент, который сейчас есть в разметке
        for (const domId of [`tag-card-${id}`, `tree-node-${id}`, `spec-row-${id}`]) {
          const el = document.getElementById(domId);
          if (!el) continue;
          el.classList.add(cls);
          setTimeout(() => el.classList.remove(cls), 3000);
        }
      }, i * 60);
    });
  };

  useEffect(() => {
    const onApplied = async (e: Event) => {
      const d = (e as CustomEvent).detail as
        { created: string[]; filled: string[]; duplicated: string[] };
      if (!d) return;
      const total = d.created.length + d.filled.length + d.duplicated.length;
      if (!total) return;
      setLastCapture(d);
      captureUntilRef.current = Date.now() + 3600 + total * 60;
      await loadTags();
      // Ждём отрисовку списка, иначе подсвечивать ещё нечего
      requestAnimationFrame(() => setTimeout(() => {
        const ids = [...d.created, ...d.filled];
        const cards = ids.map((id) => loadedTagsRef.current.find((t: any) => t.id === id)).filter(Boolean);
        // Наводим камеру только на холсте: в дереве и таблице она ни при чём
        if (cards.length && activeTabRef.current === 'board') fitToTags(cards as any[]);
        flashCapture(d);
      }, 60));
    };
    window.addEventListener('flux:capture-applied', onApplied as EventListener);
    return () => window.removeEventListener('flux:capture-applied', onApplied as EventListener);
  }, []);

  // Переключили вид, пока окно подсветки не истекло — зажигаем заново
  useEffect(() => {
    if (!lastCapture || Date.now() > captureUntilRef.current) return;
    const t = setTimeout(() => flashCapture(lastCapture), 140);
    return () => clearTimeout(t);
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'equipment') {
      loadSystems();
    }
  }, [activeTab]);

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

  // Extract tags from raw documentation text
  const handleExtractTagsText = () => {
    if (!pastedDocText) {
      setExtractedTags([]);
      return;
    }

    // Match patterns that look like components with separators
    // e.g. 3700-C01-HVC-001 or 01/AHU-001 or TE.101 etc.
    // Minimum length 4 characters, containing at least one of the separators
    const regex = /([a-zA-Z0-9А-Яа-яЁё]+(?:[\-\.\/\\_][a-zA-Z0-9А-Яа-яЁё]+)+)/g;
    const matches = pastedDocText.match(regex) || [];
    
    // De-duplicate
    const uniqueMatches: string[] = Array.from(new Set(matches.map(m => m.trim()))) as string[];
    
    const evaluated = uniqueMatches.map((identifier: string) => ({
      identifier,
      exists: checkTagExists(identifier)
    }));
    
    setExtractedTags(evaluated);
  };

  // Fast register extracted tag from text tool
  const handleQuickRegisterExtracted = async (identifier: string) => {
    if (!activeProject || checkTagExists(identifier)) return;
    try {
      const { x: dropX, y: dropY } = findFreePosition((300 - pan.x) / zoom, (250 - pan.y) / zoom);

      const initialMeta: ParsedMetadata = {
        x: dropX,
        y: dropY,
        connections: [],
        descriptions: [
          { id: 'ext1', text: 'Зарегистрирован из текста', comment: 'Быстрый импорт через текстовый инспектор.', status: 'info' }
        ]
      };

      const res = await fetch(`/api/projects/${activeProject.id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier,
          department: 'Технологический отдел',
          fluid: 'Автодетект',
          wbs: 'WBS-EXTRACTED',
          metadata: JSON.stringify(initialMeta)
        })
      });

      if (res.ok) {
        await loadTags();
        // Update live extractor checklist
        setExtractedTags(prev => prev.map(t => t.identifier === identifier ? { ...t, exists: true } : t));
      }
    } catch (err) {
      console.error('Failed to quick register tag:', err);
    }
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
  const saveTagMetadata = async (tagId: string, metadata: ParsedMetadata) => {
    try {
      setTags(prev => prev.map(t => t.id === tagId ? { ...t, parsedMetadata: metadata, metadata: JSON.stringify(metadata) } : t));

      await fetch(`/api/tags/${tagId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metadata: JSON.stringify(metadata)
        })
      });
    } catch (err) {
      console.error('Failed to save tag metadata:', err);
    }
  };

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
          await saveTagMetadata(draggedTagId, { ...parseTagMetadata(tag), x: put.x, y: put.y });
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

  /** Записать правки дерева: обе стороны связи одним движением */
  const applyTreePatches = async (patches: TreePatch[]) => {
    for (const patch of patches) {
      const tag = tagsById[patch.id];
      if (!tag) continue;
      const meta = { ...parseTagMetadata(tag), connections: patch.connections, parentId: patch.parentId };
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
      setTimeout(() => centerOnTag(focus), 200);
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
    const updates: { id: string; metadata: string }[] = [];
    for (const t of tags) {
      const p = positions[t.id];
      if (!p) continue;
      cardPositionsRef.current[t.id] = p;
      updates.push({ id: t.id, metadata: JSON.stringify({ ...parseTagMetadata(t), x: p.x, y: p.y }) });
    }
    if (!updates.length) return;
    const byId = new Map(updates.map((u) => [u.id, u.metadata]));
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

    await saveTagMetadata(tagId, meta);

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

    await saveTagMetadata(tagId, meta);

    if (editingTag && editingTag.id === tagId) {
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

    await saveTagMetadata(tagId, meta);

    if (editingTag && editingTag.id === tagId) {
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
      const res = await fetch(`/api/tags/${tagId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: code }),
      });
      if (!res.ok) throw new Error();
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
      const val = meta.dynamicFields?.[cat.nameRu];
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

      const res = await fetch(`/api/tags/${tagId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          department: updatedDepartment,
          fluid: updatedFluid,
          metadata: JSON.stringify(meta)
        })
      });

      if (!res.ok) throw new Error("Sync failed");
      const data = await res.json();

      if (editingTag && editingTag.id === tagId) {
        setEditingTag(data.tag ? { ...data.tag, parsedMetadata: meta } : { ...tag, department: updatedDepartment, fluid: updatedFluid, metadata: JSON.stringify(meta), parsedMetadata: meta });
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

      const res = await fetch(`/api/tags/${tagId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand: value
        })
      });

      if (!res.ok) throw new Error("Sync failed");
      const data = await res.json();

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

    await saveTagMetadata(tagId, meta);

    if (editingTag && editingTag.id === tagId) {
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

    await saveTagMetadata(tagId, meta);

    if (editingTag && editingTag.id === tagId) {
      setEditingTag({ ...tag, metadata: JSON.stringify(meta) });
    }
  };

  // Manual fast tag create with verification
  const handleCreateTag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTagIdentifier || !newTagBrand.trim() || !activeProject) {
      addToast("Ошибка: Заполните обязательные поля Tag и Mark!", "error");
      return;
    }

    if (checkTagExists(newTagIdentifier)) {
      void openAlert('Такой тег уже есть', `Тег «${newTagIdentifier}» уже заведён в этом проекте. Укажите другой код.`);
      return;
    }

    try {
      // Новая карточка появляется на свободном месте — не перекрывая существующие.
      // Если тег заводят через меню правой кнопки, «свободное место» ищется от
      // той точки, куда нажали, а не от центра экрана
      const spot = newTagSpotRef.current || { x: (300 - pan.x) / zoom, y: (200 - pan.y) / zoom };
      newTagSpotRef.current = null;
      const { x: dropX, y: dropY } = findFreePosition(spot.x, spot.y);

      const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
      const cats = configDict
        ? (configDict.items || [])
            .filter((i: any) => !i.parentId)
            .sort((a: any, b: any) => a.code.localeCompare(b.code))
        : [];

      let finalDepartment = newTagDepartment;
      let finalFluid = newTagFluid || 'Воздух';
      const finalDynamicFields: Record<string, string> = {};

      cats.forEach((cat: any) => {
        const value = dynamicCategorySelections[cat.id] || '';
        finalDynamicFields[cat.nameRu] = value;

        const lowName = cat.nameRu.toLowerCase();
        const lowCode = cat.code.toLowerCase();
        if (lowCode.includes('dep') || lowName.includes('дисциплина') || lowName.includes('отдел')) {
          finalDepartment = value;
        } else if (lowCode.includes('fluid') || lowName.includes('среда') || lowName.includes('свойство') || lowName.includes('fluid')) {
          finalFluid = value;
        }
      });

      const initialMeta: ParsedMetadata = {
        x: dropX,
        y: dropY,
        connections: [],
        descriptions: [
          {
            id: 'desc-' + Math.random().toString(36).substr(2, 9),
            text: 'Первичный статус',
            comment: 'Установлено при создании тега',
            status: newTagActuality,
            createdBy: user?.name || user?.login || 'Пользователь',
            createdAt: new Date().toISOString()
          }
        ],
        mainName: newTagMainName.trim(),
        dynamicFields: finalDynamicFields,
        createdBy: user?.name || user?.login || 'Пользователь',
        createdAt: new Date().toISOString(),
        tagSegments: splitSegments(newTagIdentifier.trim()),
        markSegments: splitSegments(newTagBrand.trim())
      };

      const res = await fetch(`/api/projects/${activeProject.id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: newTagIdentifier.trim(),
          department: finalDepartment,
          fluid: finalFluid,
          wbs: '',
          brand: newTagBrand.trim() || null,
          metadata: JSON.stringify(initialMeta)
        })
      });

      if (res.ok) {
        setNewTagIdentifier('');
        setNewTagMainName('');
        setNewTagBrand('');
        setNewTagMarkingSelections({});
        // reset to default status 'info' (В работе)
        setNewTagActuality('info');
        loadTags();
      }
    } catch (err) {
      console.error('Failed to create tag manually:', err);
    }
  };

  // Delete Node tag completely
  const handleDeleteTag = async (tagId: string) => {
    if (!await openConfirm('Удалить тег?', 'Тег и все его связи с другим оборудованием будут удалены. Действие необратимо.', { confirmLabel: 'Удалить тег', tone: 'danger' })) return;
    try {
      for (const otherTag of tags) {
        if (otherTag.id === tagId) continue;
        const otherMeta = parseTagMetadata(otherTag);
        let updated = false;
        if (otherMeta.connections.includes(tagId)) {
          otherMeta.connections = otherMeta.connections.filter(id => id !== tagId);
          updated = true;
        }
        if (otherMeta.parentId === tagId) {
          otherMeta.parentId = undefined;
          updated = true;
        }
        if (updated) {
          await saveTagMetadata(otherTag.id, otherMeta);
        }
      }

      await fetch(`/api/tags/${tagId}`, { method: 'DELETE' });
      setEditingTag(null);
      // Убираем удалённый тег из выделения сразу, не дожидаясь перезагрузки
      setSelectedTagIds(prev => {
        if (!prev.has(tagId)) return prev;
        const next = new Set(prev);
        next.delete(tagId);
        return next;
      });
      loadTags();
    } catch (err) {
      console.error('Failed to delete tag:', err);
    }
  };

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

  // Build tree logic for dependencies view
  const buildTree = () => {
    const tagMap: { [id: string]: any } = {};
    const rootNodes: any[] = [];

    const matchingTags = tags.filter(t => 
      t.identifier.toLowerCase().includes(searchQuery.toLowerCase()) || 
      (t.department && t.department.toLowerCase().includes(searchQuery.toLowerCase()))
    );

    matchingTags.forEach(t => {
      const meta = parseTagMetadata(t);
      tagMap[t.id] = {
        ...t,
        meta,
        children: []
      };
    });

    matchingTags.forEach(t => {
      const node = tagMap[t.id];
      const pId = node.meta.parentId;
      if (pId && tagMap[pId]) {
        tagMap[pId].children.push(node);
      } else {
        rootNodes.push(node);
      }
    });

    return rootNodes;
  };

  const toggleTagExpand = (id: string) => {
    setExpandedTagIds(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // Calculate full lineage chain of tag (from parent down to child list)
  const getParentTraceLineage = (tagId: string): string => {
    const chainList: string[] = [];
    let currentId: string | undefined = tagId;
    const visited = new Set<string>();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const tag = tags.find(t => t.id === currentId);
      if (tag) {
        chainList.unshift(tag.identifier);
        const meta = parseTagMetadata(tag);
        currentId = meta.parentId;
      } else {
        break;
      }
    }
    return chainList.join(' ➔ ');
  };

  // Extract all unique values at a specific segment/part index across all tags
  const getUniqueTagSegmentValuesForPos = (idx: number): string[] => {
    const values = new Set<string>();
    tags.forEach(t => {
      const parts = splitSegments(t.identifier);
      if (parts[idx]) {
        values.add(parts[idx]);
      }
    });
    return Array.from(values).sort();
  };

  const getUniqueMarkSegmentValuesForPos = (idx: number): string[] => {
    const values = new Set<string>();
    tags.forEach(t => {
      const parts = splitSegments(t.brand || '');
      if (parts[idx]) {
        values.add(parts[idx]);
      }
    });
    return Array.from(values).sort();
  };

  // Find max segment depth across all items
  const getMaximumTagSegmentLength = (): number => {
    let max = 0;
    tags.forEach(t => {
      const parts = splitSegments(t.identifier);
      if (parts.length > max) max = parts.length;
    });
    return max || 3;
  };

  const getMaximumMarkSegmentLength = (): number => {
    let max = 0;
    tags.forEach(t => {
      const parts = splitSegments(t.brand || '');
      if (parts.length > max) max = parts.length;
    });
    return max || 3;
  };

  // Safe mappings to keep existing references happy
  const getUniqueSegmentValuesForPos = getUniqueTagSegmentValuesForPos;
  const getMaximumSegmentLength = getMaximumTagSegmentLength;

  // Perform multi-segment query selection with independent Tag & Mark filter vectors
  const getSegmentMatchedTags = () => {
    return tags.filter(t => {
      const tagParts = splitSegments(t.identifier);
      const markParts = splitSegments(t.brand || '');
      
      // Left-side card filter values check only the data inside the Tag Segments column
      for (const posKey in activeTagFilters) {
        const filterVal = activeTagFilters[posKey];
        if (!filterVal || filterVal === '*') continue;
        
        const partVal = tagParts[Number(posKey)];
        if (!partVal || !partVal.toLowerCase().includes(filterVal.toLowerCase())) {
          return false;
        }
      }

      // Right-side card filter values check only data inside the Mark Segments column
      for (const posKey in activeMarkFilters) {
        const filterVal = activeMarkFilters[posKey];
        if (!filterVal || filterVal === '*') continue;
        
        const partVal = markParts[Number(posKey)];
        if (!partVal || !partVal.toLowerCase().includes(filterVal.toLowerCase())) {
          return false;
        }
      }

      // Supplementary filters
      if (excludeEmptyWBS && !t.wbs) return false;
      if (onlyWithWarning) {
        const meta = parseTagMetadata(t);
        const hasFlags = meta.descriptions.some(d => d.status === 'warning' || d.status === 'critical');
        if (!hasFlags) return false;
      }

      return true;
    });
  };

  const splitBrandIntoParts = (brandStr: string) => {
    if (!brandStr) return [];
    return brandStr.split(/[-/\.\s]+/);
  };

  const getMaximumBrandSegmentLength = () => {
    let max = 0;
    tags.forEach(t => {
      if (t.brand) {
        const len = splitBrandIntoParts(t.brand).length;
        if (len > max) max = len;
      }
    });
    return max;
  };

  // List Virtualization:
  const parentRefSegments = useRef<HTMLDivElement>(null);
  const matchedTagsList = useMemo(() => getSegmentMatchedTags(), [tags, activeTagFilters, activeMarkFilters, excludeEmptyWBS, onlyWithWarning, dictionaries]);
  
  const segmentsVirtualizer = useVirtualizer({
    count: matchedTagsList.length,
    getScrollElement: () => parentRefSegments.current,
    estimateSize: () => 75,
    overscan: 10,
  });

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
  const EXCHANGE_COLUMNS = TAG_EXCHANGE_COLUMNS;

  const buildExchange = (scopeId: string, cols: Column[]) => buildTagExchange(
    scopeId === 'selected' ? tags.filter((t: any) => selectedTagIds.has(t.id))
      : scopeId === 'filtered' ? matchedTagsList : tags,
    cols,
    { lineage: getParentTraceLineage, meta: parseTagMetadata },
  );

  // Сборка таблицы подбора уехала в lib/tagExchange: раздел «Теги» — самый
  // большой файл программы, и держать в нём ещё и разбор сегментов значит
  // растить его дальше. Заодно эту сборку теперь можно проверить скриптом
  const buildExportTable = (): { headers: string[]; rows: string[][] } | null => {
    const matched = getSegmentMatchedTags();
    if (matched.length === 0) return null;
    return buildSegmentTable(matched, exportColumns, {
      segments: getMaximumSegmentLength(),
      brandSegments: getMaximumBrandSegmentLength(),
      splitTag: splitTagIntoParts,
      splitBrand: splitBrandIntoParts,
      lineage: getParentTraceLineage,
      meta: parseTagMetadata,
    });
  };

  const handleExportSelectedToExcel = () => {
    const table = buildExportTable();
    if (!table) {
      void openAlert('Нечего выгружать', 'Под текущие фильтры не попала ни одна строка. Измените условия отбора и повторите.');
      return;
    }

    // Сборка CSV — общая (lib/exchange): BOM, точка с запятой и удвоение
    // кавычек одинаковы для всех разделов и проверяются скриптом
    const blob = new Blob([toCsv(table.headers, table.rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName('Теги — подбор', 'csv');
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  /** Та же подборка — сразу в буфер, чтобы вставить в письмо или протокол */
  const handleCopySelectedAsTable = async () => {
    const table = buildExportTable();
    if (!table) {
      void openAlert('Нечего копировать', 'Под текущие фильтры не попала ни одна строка. Измените условия отбора и повторите.');
      return;
    }
    const objects = table.rows.map(r => Object.fromEntries(table.headers.map((h, i) => [h, r[i] ?? ''])));
    const ok = await copyAsTable(objects, table.headers);
    addToast(
      ok ? `Скопировано строк: ${objects.length} — вставьте в Ворд или Эксель` : 'Не удалось скопировать',
      ok ? 'success' : 'error',
    );
  };

  const isIdentifierUnique = !newTagIdentifier || !checkTagExists(newTagIdentifier);

  if (!activeProject) {
    return (
      <NoProject what="Реестр тегов" />
    );
  }

  return (
    <div id="registry-screen-root" className="h-full flex flex-col min-h-0 text-slate-800 dark:text-slate-100 transition-colors duration-250 animate-fadeIn gap-3">
      
      {/* MODULE HEADER AND TAB SWITCHER */}
      <div className="flex flex-col @[1080px]:flex-row @[1080px]:items-center @[1080px]:justify-between gap-3 p-3 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-xl shadow-xs">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shadow-inner shrink-0">
            <Network className="w-5.5 h-5.5" />
          </div>
          <div className="text-left min-w-0">
            <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white flex flex-wrap items-center gap-2 min-w-0">
              Реестр технологических тегов
              <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border border-emerald-200/50">
                {countOf(tags.length, 'тег')}
              </span>
              {/* Что принёс последний захват. Вспышка гаснет за секунды, а это
                  остаётся, пока инженер сам не закроет */}
              {lastCapture && (
                <span className="inline-flex items-center gap-2 text-xs font-bold pl-2.5 pr-1 py-0.5 rounded-full
                                 bg-emerald-600 text-white">
                  последний захват: {lastCapture.created.length + lastCapture.filled.length}
                  <button
                    onClick={() => {
                      captureUntilRef.current = Date.now() + 3600;
                      const ids = [...lastCapture.created, ...lastCapture.filled];
                      const cards = ids.map((id) => loadedTagsRef.current.find((t: any) => t.id === id)).filter(Boolean);
                      if (cards.length && activeTab === 'board') fitToTags(cards as any[]);
                      flashCapture(lastCapture);
                    }}
                    className="px-1.5 py-0.5 rounded-full hover:bg-white/20 cursor-pointer font-semibold"
                  >
                    показать
                  </button>
                  <button onClick={() => setLastCapture(null)}
                          className="px-1.5 rounded-full hover:bg-white/20 cursor-pointer">✕</button>
                </span>
              )}
            </h1>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap bg-slate-100 dark:bg-slate-900 p-1 rounded-xl border border-slate-200/80 dark:border-slate-800">
            <button type="button"
              onClick={() => setActiveTab('board')}
              title="Схема связей между тегами"
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-ui cursor-pointer ${
                activeTab === 'board' 
                  ? 'bg-white dark:bg-slate-800 text-emerald-700 dark:text-emerald-300 shadow-xs' 
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Network className="w-3.5 h-3.5" />
              <span className="hidden @[760px]:inline">Схема</span>
            </button>
            <button type="button"
              onClick={() => setActiveTab('tree')}
              title="Дерево связей"
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-ui cursor-pointer ${
                activeTab === 'tree' 
                  ? 'bg-white dark:bg-slate-800 text-emerald-700 dark:text-emerald-300 shadow-xs' 
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <FolderTree className="w-3.5 h-3.5" />
              <span className="hidden @[760px]:inline">Дерево связей</span>
            </button>
            <button type="button"
              onClick={() => setActiveTab('segments')}
              title="Подбор по сегментам кода и разбор загруженного файла"
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-ui cursor-pointer ${
                activeTab === 'segments' 
                  ? 'bg-white dark:bg-slate-800 text-emerald-700 dark:text-emerald-300 shadow-xs' 
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <List className="w-3.5 h-3.5" />
              <span className="hidden @[760px]:inline">Подбор</span>
            </button>
            <button type="button" data-tour="tag-table-tab"
              onClick={() => setActiveTab('table')}
              title="Спецификация"
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-ui cursor-pointer ${
                activeTab === 'table' 
                  ? 'bg-white dark:bg-slate-800 text-emerald-700 dark:text-emerald-300 shadow-xs' 
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <List className="w-3.5 h-3.5" />
              <span className="hidden @[760px]:inline">Спецификация</span>
            </button>
            {/* Обмен с внешним миром — последним: сначала работа, потом
                выгрузка. Импорт и захват экрана лежали внутри «Подбора», где
                их никто не искал, а выгрузка была кнопкой в ряду вкладок */}
            <button type="button" data-tour="tag-exchange-tab"
              onClick={() => setActiveTab('exchange')}
              title="Импорт тегов, выгрузка и захват с экрана"
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-ui cursor-pointer ${
                activeTab === 'exchange'
                  ? 'bg-white dark:bg-slate-800 text-emerald-700 dark:text-emerald-300 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              <span className="hidden @[760px]:inline">Экспорт и импорт</span>
            </button>
          </div>
        </div>
      </div>

      {/* QUICK PANEL, REAL-TIME VALIDATION & SEARCH */}
      <div className="grid grid-cols-1 @[1080px]:grid-cols-12 gap-3 items-stretch">
        {/* Manual quick adding with active validation */}
        <form onSubmit={handleCreateTag} className="@[1080px]:col-span-10 p-3 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-855 rounded-xl shadow-xs text-left flex flex-col justify-between">
          <div className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider block pl-1 mb-1.5">
            Создать новый тег и оборудование:
          </div>
          
          <div className="grid grid-cols-1 @[560px]:grid-cols-2 @[760px]:grid-cols-3 @[1080px]:grid-cols-12 gap-2.5 items-end">
            {/* Tag identifier code */}
            <div className="relative flex flex-col gap-1 @[1080px]:col-span-3">
              <label className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase flex justify-between leading-none min-w-0 gap-2">
                <span className="truncate">Код тега (EN) *</span>
                {newTagIdentifier && !isIdentifierUnique && (
                  <span className="text-xs text-rose-550 lowercase font-semibold">Занят</span>
                )}
              </label>
              <div className="relative animate-fadeIn">
                <input
                  type="text"
                  required
                  data-tour="tag-code-input"
                  placeholder="Код тега"
                  value={newTagIdentifier}
                  onChange={handleTagIdentifierChange}
                  className={`w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-900 border text-xs rounded-lg focus:outline-none focus:bg-white dark:focus:bg-slate-950 ${
                    newTagIdentifier 
                      ? isIdentifierUnique 
                        ? 'border-emerald-500/40 focus:ring-2 focus:ring-emerald-500/20' 
                        : 'border-rose-500/50 focus:ring-2 focus:ring-rose-550/20'
                      : 'border-slate-200 dark:border-slate-800'
                  } dark:text-slate-100 font-mono`}
                />
                {newTagIdentifier && (
                  <div className="absolute right-2 top-1.5 z-10">
                    {isIdentifierUnique ? (
                      <span className="text-xs text-emerald-600 dark:text-emerald-400 font-semibold bg-emerald-50 dark:bg-emerald-950/60 px-1 py-0.5 rounded border border-emerald-200/40">Свободен</span>
                    ) : (
                      <span className="text-xs text-rose-605 dark:text-rose-400 font-semibold bg-rose-50 dark:bg-rose-950/60 px-1 py-0.5 rounded border border-rose-200/40">Занят</span>
                    )}
                  </div>
                )}
              </div>
              
              {/* Auto Suggestions list */}
              {newTagIdentifier && matchingSuggestions.length > 0 && (
                <div className="absolute top-full left-0 w-full mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl z-50 p-2 max-h-64 overflow-y-auto">
                  <div className="text-xs uppercase font-mono font-bold text-slate-400 dark:text-slate-550 pb-1 mb-1 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center pl-1">
                    <span>Существующие теги</span>
                    <span className="text-xs italic font-sans font-normal lowercase text-slate-500">выберите</span>
                  </div>
                  <div className="space-y-0.5">
                    {matchingSuggestions.map((st) => (
                      <button
                        key={st.id}
                        type="button"
                        onClick={() => {
                          setNewTagIdentifier(st.identifier);
                          if (st.department) setNewTagDepartment(st.department);
                          if (st.fluid) setNewTagFluid(st.fluid);
                          const stMeta = parseTagMetadata(st);
                          if (stMeta.mainName) setNewTagMainName(stMeta.mainName);
                          setNewTagActuality(getTagOverallStatus(st));
                        }}
                        className="w-full text-left px-2 py-1 text-xs text-slate-707 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded flex justify-between items-center transition-colors font-mono cursor-pointer"
                      >
                        <span className="font-bold text-emerald-600 dark:text-emerald-400">{st.identifier}</span>
                        <span className="text-xs text-slate-500 dark:text-slate-400 font-sans truncate ml-2 max-w-[240px]" title={parseTagMetadata(st).mainName || 'Без наименования'}>
                          {parseTagMetadata(st).mainName || <span className="italic opacity-40 text-xs">Без наименования</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Required Mark input field */}
            <div className="flex flex-col gap-1 animate-fadeIn @[1080px]:col-span-2">
              <label className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase leading-none truncate">
                Марка оборудования *
              </label>
              <input
                type="text"
                required
                placeholder="ВИР800-340"
                value={newTagBrand}
                onChange={(e) => setNewTagBrand(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs rounded-lg text-slate-850 dark:text-slate-100 focus:outline-none focus:bg-white dark:focus:bg-slate-950 focus:ring-2 focus:ring-emerald-500/20 font-medium"
              />
            </div>

            {/* Main Name string input */}
            <div className="flex flex-col gap-1 @[1080px]:col-span-3">
              <label className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase leading-none truncate">
                Главное наименование
              </label>
              <input
                type="text"
                placeholder="Приточный вентилятор"
                value={newTagMainName}
                onChange={(e) => setNewTagMainName(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs placeholder-slate-400 dark:placeholder-slate-550 focus:outline-none focus:bg-white dark:focus:bg-slate-950 text-slate-805 dark:text-slate-100 font-medium"
              />
            </div>

            {/* Actuality Selector */}
            <div className="flex flex-col gap-1 @[1080px]:col-span-2">
              <label className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase leading-none truncate">
                Актуальность
              </label>
              <CustomSelect
                value={newTagActuality}
                onChange={(val) => setNewTagActuality(val as any)}
                options={actualitySelectOptions}
              />
            </div>

            {/* Actions (Buttons) */}
            <div className="flex items-center gap-1.5 min-w-0 @[1080px]:col-span-2">
              {/* Advanced Toggle button */}
              <button
                type="button"
                onClick={() => setShowAdvancedCreation(!showAdvancedCreation)}
                className={`p-1.5 rounded-lg text-xs font-semibold border transition-ui flex items-center justify-center gap-1 cursor-pointer min-w-0 h-8 flex-1 ${
                  showAdvancedCreation 
                    ? 'bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-350 border-slate-300 dark:border-slate-750' 
                    : 'bg-white dark:bg-slate-950 text-slate-500 dark:text-slate-450 border-slate-200 dark:border-slate-850 hover:bg-slate-50'
                }`}
                title="Дополнительные поля спецификации"
              >
                <Sliders className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden @[1080px]:inline text-xs">Доп</span>
                <ChevronDown className={`w-3 h-3 transition-transform duration-200 shrink-0 ${showAdvancedCreation ? 'rotate-180' : ''}`} />
              </button>

              {/* Submit create button */}
              <button
                type="submit"
                data-tour="tag-create-btn"
                disabled={!isIdentifierUnique || !newTagIdentifier || !newTagBrand.trim()}
                className={`p-1.5 rounded-lg text-xs font-bold shadow-xs transition-ui flex items-center justify-center gap-1 cursor-pointer min-w-0 h-8 flex-1 border-none ${
                  isIdentifierUnique && newTagIdentifier && newTagBrand.trim()
                    ? 'bg-emerald-700 hover:bg-emerald-600 text-white font-semibold'
                    : 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
                }`}
              >
                <Plus className="w-3.5 h-3.5 text-white shrink-0" />
                <span className="truncate">Создать</span>
              </button>
            </div>
          </div>

          {/* Collapsible advanced details row */}
          {showAdvancedCreation && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              style={{ overflow: 'visible' }}
              className="flex flex-wrap items-center gap-3 pt-2.5 border-t border-slate-100 dark:border-slate-900/60 overflow-visible text-left"
            >
              {(() => {
                const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
                const cats = configDict
                  ? (configDict.items || [])
                      .filter((i: any) => !i.parentId)
                      .sort((a: any, b: any) => a.code.localeCompare(b.code))
                  : [];

                if (cats.length > 0) {
                  return cats.map((cat: any) => {
                    const options = (configDict?.items || [])
                      .filter((i: any) => i.parentId === cat.id)
                      .sort((a: any, b: any) => a.nameRu.localeCompare(b.nameRu));

                    return (
                      <div key={cat.id} className="flex flex-col gap-1 min-w-[160px] @[760px]:min-w-[180px] @[1080px]:min-w-[200px] flex-1 max-w-[300px]" id={`dynamic-field-${cat.id}`}>
                        <span className="text-xs font-bold text-slate-450 dark:text-slate-500 uppercase leading-none truncate" title={cat.nameRu}>
                          {cat.nameRu}
                        </span>
                        <CustomSelect
                          value={dynamicCategorySelections[cat.id] || ''}
                          onChange={(val) => handleDynamicCategoryChange(cat.id, val)}
                          placeholder="-- выбрать --"
                          options={options.map((opt: any) => ({
                            value: opt.nameRu,
                            label: opt.nameRu
                          }))}
                        />
                      </div>
                    );
                  });
                }
                return <span className="text-xs text-slate-400">Дополнительные поля для ККС не настроены в справочниках.</span>;
              })()}
            </motion.div>
          )}
        </form>

        {/* Универсальный поиск по разделу: тег, наименование, марка, дубли */}
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

      {/* TABS INTERFACE */}
      <div className="flex-1 min-h-0 w-full relative">
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

              {/* Overlaid Zoom and Canvas Controls on the top-right */}
              <div className="absolute top-4 right-4 z-40 flex items-center gap-2 bg-white/90 dark:bg-slate-950/90 backdrop-blur-md p-1.5 rounded-xl border border-slate-200 dark:border-slate-800/80 shadow-md">
                <div className="flex bg-slate-100 dark:bg-slate-900 p-0.5 rounded-lg border border-slate-200/50 dark:border-slate-800">
                  <button type="button"
                    onClick={() => setZoom((z) => clampZoom(z - 0.1))}
                    title="Отдалить"
                    className="p-1 px-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 rounded transition-colors cursor-pointer"
                  >
                    <ZoomOut className="w-3.5 h-3.5" />
                  </button>
                  <span ref={zoomLabelRef} className="px-2 py-0.5 text-xs font-mono font-bold text-slate-600 dark:text-slate-400 self-center tabular-nums">
                    {Math.round(zoom * 100)}%
                  </span>
                  <button type="button"
                    onClick={() => setZoom((z) => clampZoom(z + 0.1))}
                    title="Приблизить"
                    className="p-1 px-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 rounded transition-colors cursor-pointer"
                  >
                    <ZoomIn className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="w-[1px] h-5 bg-slate-200 dark:bg-slate-800" />

                {/* «По размеру» отдельной кнопкой. Раньше это был ВТОРОЙ щелчок
                    по «Центрировать» с таймером в 260 мс: задержка чувствуется
                    на каждом обычном нажатии, а научиться такому неоткуда */}
                <button type="button"
                  onClick={fitCanvasToCenter}
                  title="Вписать весь холст (F)"
                  className="px-2.5 py-1.5 bg-slate-200/70 dark:bg-slate-850 hover:bg-slate-300 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-300 rounded-lg font-bold text-xs transition-colors flex items-center gap-1 cursor-pointer"
                >
                  <Maximize2 className="w-3 h-3 text-emerald-600" />
                  По размеру
                </button>

                <div className="relative">
                  <button type="button"
                    onClick={(e) => { e.stopPropagation(); setCenterPickerOpen((v) => !v); }}
                    title="Показать дерево выбранной установки целиком"
                    className="px-2.5 py-1.5 bg-slate-200/70 dark:bg-slate-850 hover:bg-slate-300 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-300 rounded-lg font-bold text-xs transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3 text-emerald-600" />
                    Центрировать
                  </button>

                  {/* Выбор главного родителя: его дерево выделяется и центрируется */}
                  {centerPickerOpen && (
                    <div
                      className="absolute top-full right-0 mt-1.5 w-72 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl z-50 overflow-hidden"
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <div className="px-3 py-2 text-xs font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100 dark:border-slate-850">
                        Главные родители ({rootTags.length})
                      </div>
                      <div className="max-h-64 overflow-y-auto p-1.5 space-y-0.5">
                        {rootTags.length === 0 ? (
                          <div className="text-center text-xs text-slate-400 py-4">Нет корневых тегов</div>
                        ) : rootTags.map(rt => (
                          <button type="button"
                            key={rt.id}
                            onClick={() => centerTreeOfRoot(rt.id)}
                            className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-950/30 text-xs flex items-center justify-between gap-2 cursor-pointer"
                          >
                            <span className="font-mono font-bold text-emerald-700 dark:text-emerald-400 truncate">{rt.identifier}</span>
                            <span className="text-slate-400 truncate max-w-[120px]">{parseTagMetadata(rt).mainName || ''}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Упорядочить — с выбором оси. Ось меняет и раскладку, и то,
                    как идут линии: холст выглядит так, как его последний раз
                    разложили */}
                <div className="relative flex">
                  <button type="button"
                    onClick={() => { void arrangeTreeLayout(); }}
                    disabled={isArranging}
                    title={axis === 'down'
                      ? 'Разложить: родитель сверху, дети под ним, следующее дерево правее'
                      : 'Разложить: родитель слева, дети правее, следующее дерево правее'}
                    className="pl-2.5 pr-2 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-l-lg font-bold text-xs transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <Network className={`w-3 h-3 ${isArranging ? 'animate-pulse' : ''}`} />
                    {isArranging ? 'Раскладка…' : 'Упорядочить'}
                  </button>
                  <button type="button"
                    onClick={(e) => { e.stopPropagation(); setAxisPickerOpen((v) => !v); }}
                    disabled={isArranging}
                    title="Как раскладывать дерево"
                    aria-label="Выбрать раскладку"
                    className="px-1.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-r-lg border-l border-emerald-500 transition-colors cursor-pointer"
                  >
                    <ChevronDown className="w-3 h-3" />
                  </button>

                  {axisPickerOpen && (
                    <div
                      className="absolute top-full right-0 mt-1.5 w-64 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl z-50 overflow-hidden p-1.5 space-y-0.5"
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      {([
                        { id: 'down' as const, title: 'Сверху вниз', hint: 'Родитель сверху, состав под ним' },
                        { id: 'right' as const, title: 'Слева направо', hint: 'Родитель слева, состав правее' },
                      ]).map((o) => (
                        <button type="button"
                          key={o.id}
                          /* Выбор сразу и раскладывает: переключатель, которому
                             нужно второе нажатие, читается как несработавший */
                          onClick={() => { chooseAxis(o.id); setAxisPickerOpen(false); void arrangeTreeLayout(o.id); }}
                          className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs cursor-pointer flex items-center gap-2 ${
                            axis === o.id
                              ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300'
                              : 'hover:bg-slate-100 dark:hover:bg-slate-850 text-slate-700 dark:text-slate-300'}`}
                        >
                          <Check className={`w-3 h-3 shrink-0 ${axis === o.id ? '' : 'opacity-0'}`} />
                          <span className="min-w-0">
                            <span className="block font-bold">{o.title}</span>
                            <span className="block text-2xs text-slate-400">{o.hint}</span>
                          </span>
                        </button>
                      ))}
                      <p className="px-2.5 pt-1 text-2xs text-slate-400">
                        Деревья встают в ряд слева направо при обеих раскладках.
                      </p>
                    </div>
                  )}
                </div>

                {/* Откат раскладки: она переписывает координаты всех тегов
                    разом, и расставленное руками иначе теряется навсегда */}
                {undoArrange && !isArranging && (
                  <button type="button"
                    onClick={() => { void undoArrangeLayout(); }}
                    title="Вернуть карточки туда, где они стояли до раскладки"
                    className="px-2.5 py-1.5 bg-amber-100 dark:bg-amber-950/40 hover:bg-amber-200 dark:hover:bg-amber-900/50 text-amber-900 dark:text-amber-300 rounded-lg font-bold text-xs transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <Undo2 className="w-3 h-3" />
                    Отменить
                  </button>
                )}
              </div>

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
                    const meta = parseTagMetadata(tag);
                    const isSourceOfDrag = activeConnectionDrag?.sourceId === tag.id;
                    const hoveredLeft = hoveredPort?.tagId === tag.id && hoveredPort.side === 'left';
                    const hoveredRight = hoveredPort?.tagId === tag.id && hoveredPort.side === 'right';

                    const isExpanded = !!expandedCardIds[tag.id];
                    const overallStatus = getTagOverallStatus(tag);
                    const statusVal = statusConfig[overallStatus] || statusConfig.draft;
                    const dup = isDuplicateTag(tag);
                    const isSelected = selectedTagIds.has(tag.id);

                    return (
                      <div
                        key={tag.id}
                        id={`tag-card-${tag.id}`}
                        data-share-focus={`tag:${tag.id}`}
                        className={`absolute pointer-events-auto w-[310px] rounded-lg border text-left transition-shadow duration-200 select-none ${
                          linkingFrom === tag.id
                            ? 'ring-2 ring-sky-500 border-sky-500 shadow-xl z-40'
                            : linkingFrom
                              ? 'bg-white dark:bg-slate-950 border-sky-300/60 dark:border-sky-800/50 shadow-xs hover:ring-2 hover:ring-sky-400 cursor-crosshair z-10'
                            // «Тащу эту» и «выбрана» раньше различались цветом:
                            // зелёный против синего. Синего в палитре нет, а
                            // выбранное во всей программе зелёное — поэтому оба
                            // состояния теперь зелёные и разведены весом: у
                            // перетаскиваемой карточки кольцо темнее и тень выше.
                            : isSourceOfDrag
                            ? 'ring-2 ring-emerald-700 border-emerald-700 shadow-xl z-30'
                            : isSelected
                              ? `bg-white dark:bg-slate-950 ring-2 ring-emerald-500 border-emerald-400 dark:border-emerald-600 shadow-lg text-slate-900 dark:text-slate-100 ${isExpanded ? 'z-40' : 'z-20'}`
                              : dup
                                ? `bg-white dark:bg-slate-950 ring-2 ring-rose-400/70 border-rose-300 dark:border-rose-700/60 shadow-xs hover:shadow-md text-slate-900 dark:text-slate-100 ${isExpanded ? 'z-30' : 'z-10'}`
                                : `bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-850 shadow-xs hover:shadow-md text-slate-900 dark:text-slate-100 ${isExpanded ? 'z-30' : 'z-10'}`
                        }`}
                        style={{
                          transform: (() => {
                            const live = cardPositionsRef.current[tag.id] || meta;
                            return `translate(${live.x}px, ${live.y}px)`;
                          })(),
                          left: 0,
                          top: 0
                        }}
                        onMouseDown={(e) => handleTagMouseDown(e, tag.id, meta)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          // После правого перетаскивания (панорама) меню не показываем
                          if (panMovedRef.current) { panMovedRef.current = false; return; }
                          // ПКМ по невыделенной карточке — выделяем только её (как в проводнике)
                          if (!selectedTagIds.has(tag.id)) setSelectedTagIds(new Set([tag.id]));
                          setCardMenu({ x: e.clientX, y: e.clientY, tagId: tag.id });
                        }}
                      >
                        {/* Порты для связи перетаскиванием — только в режиме «Перетаскиванием» */}
                        {linkMode === 'drag' && (<>
                        <div
                          className={`absolute connection-port left-0 top-[22px] -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full border border-slate-300 dark:border-slate-800 transition-ui hover:scale-130 cursor-crosshair z-40 ${
                            hoveredLeft
                              ? 'bg-emerald-500 border-white scale-125 shadow-lg'
                              : 'bg-slate-200 dark:bg-slate-800'
                          }`}
                          onMouseDown={(e) => handlePortMouseDown(e, tag.id, 'left')}
                          onMouseEnter={() => { if (draggedTagId) return; setHoveredPort({ tagId: tag.id, side: 'left' }); }}
                          onMouseLeave={() => setHoveredPort(null)}
                          title="Сюда приходит линия от родителя"
                        >
                          <div className="w-1.5 h-1.5 rounded-full bg-slate-700 dark:bg-slate-300 m-auto mt-[4px]" />
                        </div>

                        <div
                          className={`absolute connection-port right-0 top-[22px] translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full border border-slate-300 dark:border-slate-800 transition-ui hover:scale-130 cursor-crosshair z-40 ${
                            hoveredRight
                              ? 'bg-emerald-500 border-white scale-125 shadow-lg'
                              : 'bg-slate-200 dark:bg-slate-800'
                          }`}
                          onMouseDown={(e) => handlePortMouseDown(e, tag.id, 'right')}
                          onMouseEnter={() => { if (draggedTagId) return; setHoveredPort({ tagId: tag.id, side: 'right' }); }}
                          onMouseLeave={() => setHoveredPort(null)}
                          title="Отсюда тянут линию к дочернему тегу"
                        >
                          <div className="w-1.5 h-1.5 rounded-full bg-slate-700 dark:bg-slate-300 m-auto mt-[4px]" />
                        </div>
                        </>)}

                        {/* CARD COMPACT HEADER ROW (Always visible) */}
                        <div className="px-4 py-3 cursor-move flex flex-col gap-1 w-full">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 min-w-0">
                              {/* Actuality Color Dot */}
                              <span 
                                className={`w-3.5 h-3.5 rounded-full inline-block shrink-0 border border-slate-200 dark:border-slate-800 ${statusVal.text} bg-current`}
                                title={`Актуальность: ${statusVal.label}`}
                              />
                              <Database className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                              <span className="font-mono font-bold tracking-tight text-xs text-slate-800 dark:text-slate-100 uppercase truncate select-all">
                                {tag.identifier}
                              </span>
                              {dup && (
                                <span className="shrink-0 text-2xs font-bold px-1.5 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60 uppercase tracking-wide" title="Дубликат кода тега">
                                  дубль
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-1 shrink-0 no-drag select-none">
                              {/* Связать: клик → затем клик по целевому тегу (режим «Кликом») */}
                              {linkMode === 'click' && (
                                <button type="button"
                                  title={linkingFrom === tag.id ? 'Отменить связывание' : 'Связать: затем кликните целевой тег'}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setLinkingFrom(prev => prev === tag.id ? null : tag.id);
                                  }}
                                  className={`p-1.5 rounded transition-colors cursor-pointer flex items-center justify-center ${
                                    linkingFrom === tag.id
                                      ? 'bg-sky-500 text-white'
                                      : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-450 dark:hover:text-slate-200'
                                  }`}
                                >
                                  <Link2 className="w-4 h-4" />
                                </button>
                              )}
                              {/* Toggle Info / Expand Detailed View */}
                              <button type="button"
                                title={isExpanded ? "Свернуть комментарии" : "Открыть комментарии тега"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedCardIds(prev => ({ ...prev, [tag.id]: !prev[tag.id] }));
                                }}
                                className={`p-1.5 rounded transition-colors cursor-pointer flex items-center justify-center ${
                                  isExpanded
                                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                                    : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-450 dark:hover:text-slate-200'
                                }`}
                              >
                                <Info className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                          
                          {/* Наименование — только если есть (пустые строки не занимают место) */}
                          {meta.mainName && (
                            <div className="text-xs font-semibold text-slate-600 dark:text-slate-350 truncate mt-0.5 pl-5" title={meta.mainName}>
                              {meta.mainName}
                            </div>
                          )}

                          {/* Марка и актуальность */}
                          <div className="flex items-center gap-1.5 pl-5 mt-0.5 min-w-0">
                            {tag.brand && (
                              <span className="font-mono text-2xs font-bold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 truncate max-w-[140px]" title={`Марка: ${tag.brand}`}>
                                {tag.brand}
                              </span>
                            )}
                            <span className={`text-2xs font-bold px-1.5 py-0.5 rounded-full border shrink-0 ${statusVal.bg} ${statusVal.text} ${statusVal.border}`} title={`Актуальность: ${statusVal.label}`}>
                              {statusVal.label}
                            </span>
                          </div>
                        </div>

                        {/* EXPANDED SECTION */}
                        {isExpanded && (
                          <div className="border-t border-slate-105 dark:border-slate-850 animate-fadeIn text-slate-800 dark:text-slate-300">
                            
                            {/* INFO TAG FLUID/DEPT */}
                            <div className="px-4 py-2 bg-slate-50/40 dark:bg-slate-950/20 text-xs text-slate-400 flex justify-between border-b border-slate-100 dark:border-slate-900 font-medium">
                              <span className="truncate max-w-[130px]" title={tag.department}>
                                Отд: <strong className="text-slate-700 dark:text-slate-300">{tag.department || 'Комплекс'}</strong>
                              </span>
                              <span className="truncate max-w-[120px]" title={tag.fluid}>
                                Среда: <strong className="text-slate-700 dark:text-slate-300">{tag.fluid || 'Воздух'}</strong>
                              </span>
                            </div>

                            {/* СВЯЗИ: родители и дочерние теги — добавить/снять в один клик */}
                            <div className="px-3.5 py-2.5 border-b border-slate-100 dark:border-slate-900 no-drag space-y-1.5 text-left">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-2xs font-bold uppercase tracking-wider text-slate-400">Связи</span>
                                {/* Две кнопки, а не одна: чипы связей и раньше показывали
                                    и родителя (↑), и детей (↓), а завести можно было
                                    только ребёнка. Родителя приходилось искать на холсте
                                    и тянуть линию — из другого конца проекта это неудобно */}
                                <span className="flex items-center gap-2 shrink-0">
                                  <button type="button"
                                    onClick={(e) => { e.stopPropagation(); setLinkPicker(prev => (prev?.tagId === tag.id && prev.dir === 'parent') ? null : { tagId: tag.id, search: '', dir: 'parent' }); }}
                                    className="text-2xs font-bold text-emerald-600 hover:text-emerald-700 cursor-pointer"
                                  >
                                    {(incomingByTagId[tag.id] || []).length ? '↑ сменить родителя' : '+ родительский тег'}
                                  </button>
                                  <button type="button"
                                    onClick={(e) => { e.stopPropagation(); setLinkPicker(prev => (prev?.tagId === tag.id && prev.dir === 'child') ? null : { tagId: tag.id, search: '', dir: 'child' }); }}
                                    className="text-2xs font-bold text-emerald-600 hover:text-emerald-700 cursor-pointer"
                                  >
                                    + дочерний тег
                                  </button>
                                </span>
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {(incomingByTagId[tag.id] || []).map(pid => tagsById[pid] && (
                                  <span key={`p-${pid}`} className="inline-flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 text-2xs font-bold text-emerald-700 dark:text-emerald-300" title={`Родитель: ${tagsById[pid].identifier}`}>
                                    ↑ <span className="font-mono truncate max-w-[110px]">{tagsById[pid].identifier}</span>
                                    <button type="button" onClick={(e) => { e.stopPropagation(); handleRemoveConnection(pid, tag.id); }} className="p-0.5 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900 hover:text-rose-500 cursor-pointer" title="Разорвать связь с родителем">
                                      <X className="w-2.5 h-2.5" />
                                    </button>
                                  </span>
                                ))}
                                {(meta.connections || []).map(cid => tagsById[cid] && (
                                  <span key={`c-${cid}`} className="inline-flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 text-2xs font-bold text-emerald-700 dark:text-emerald-300" title={`Дочерний: ${tagsById[cid].identifier}`}>
                                    ↓ <span className="font-mono truncate max-w-[110px]">{tagsById[cid].identifier}</span>
                                    <button type="button" onClick={(e) => { e.stopPropagation(); handleRemoveConnection(tag.id, cid); }} className="p-0.5 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900 hover:text-rose-500 cursor-pointer" title="Разорвать связь">
                                      <X className="w-2.5 h-2.5" />
                                    </button>
                                  </span>
                                ))}
                                {(incomingByTagId[tag.id] || []).length === 0 && (meta.connections || []).length === 0 && (
                                  <span className="text-2xs text-slate-400">Нет связей</span>
                                )}
                              </div>
                              {linkPicker?.tagId === tag.id && (() => {
                                const wantParent = linkPicker.dir === 'parent';
                                const oldParent = (incomingByTagId[tag.id] || [])[0];
                                const candidates = linkCandidates(tag.id, linkPicker.dir, linkPicker.search);
                                return (
                                <div className="pt-1 space-y-1">
                                  {/* Родитель у тега один, и linkChild сам отцепит прежнего.
                                      Молчаливая подмена здесь и была бы возвратом к той
                                      поломке, из-за которой строку «Родительский тег» убрали */}
                                  {wantParent && oldParent && tagsById[oldParent] && (
                                    <p className="text-2xs text-amber-700 dark:text-amber-400">
                                      Заменит нынешнего родителя:{' '}
                                      <b className="font-mono">{tagsById[oldParent].identifier}</b>
                                    </p>
                                  )}
                                  <input
                                    autoFocus
                                    value={linkPicker.search}
                                    onChange={(e) => setLinkPicker({ tagId: tag.id, search: e.target.value, dir: linkPicker.dir })}
                                    onKeyDown={(e) => { if (e.key === 'Escape') setLinkPicker(null); }}
                                    placeholder={wantParent ? 'Найти родительский тег…' : 'Найти дочерний тег…'}
                                    className="w-full px-2 py-1 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:border-emerald-400"
                                  />
                                  <div className="max-h-32 overflow-y-auto space-y-0.5">
                                    {candidates.length === 0 && (
                                      <p className="px-2 py-1 text-2xs text-slate-400">
                                        {wantParent
                                          ? 'Подходящих тегов нет: свой же состав родителем стать не может.'
                                          : 'Подходящих тегов нет.'}
                                      </p>
                                    )}
                                    {candidates.map(t => (
                                      <button type="button" key={t.id}
                                        /* Порядок доводов и есть всё различие: первым идёт
                                           РОДИТЕЛЬ, вторым — ребёнок. Перепутанный вызов
                                           однажды перевернул дерево целиком */
                                        onClick={async (e) => {
                                          e.stopPropagation();
                                          if (wantParent) await handleAddConnection(t.id, tag.id);
                                          else await handleAddConnection(tag.id, t.id);
                                          setLinkPicker(null);
                                        }}
                                        className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-emerald-50 dark:hover:bg-emerald-950/30 text-left text-xs font-mono font-bold text-slate-700 dark:text-slate-300 cursor-pointer">
                                        {wantParent ? '↑' : '↓'} {t.identifier}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                                );
                              })()}
                            </div>

                            {/* SUB-DESCRIPTIONS LIST (With full tracking timestamps and inline editing capability!) */}
                            <div className="p-3.5 space-y-2 max-h-[220px] overflow-y-auto no-drag">
                              <div className="text-2xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                                Комментарии ({meta.descriptions.length})
                              </div>

                              {meta.descriptions.map((desc) => {
                                const config = statusConfig[desc.status] || statusConfig.draft;
                                const StatusIcon = config.icon;
                                const isEditingThisDesc = editingDescId === desc.id;

                                return (
                                  <div key={desc.id} className="p-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-150/60 dark:border-slate-850 rounded-xl flex flex-col gap-1 text-left">
                                    {isEditingThisDesc ? (
                                      /* INLINE ITEM EDITOR FORM */
                                      <div className="space-y-2 pt-1">
                                        <div className="grid grid-cols-2 gap-1.5">
                                          <div className="space-y-0.5">
                                            <span className="text-xs font-bold text-slate-400">Название</span>
                                            <input
                                              type="text"
                                              value={editDescForm.text}
                                              onChange={(e) => setEditDescForm(prev => ({ ...prev, text: e.target.value }))}
                                              className="w-full px-2 py-1 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-xs text-slate-800 dark:text-slate-100 focus:outline-none"
                                            />
                                          </div>
                                          <div className="space-y-0.5">
                                            <span className="text-xs font-bold text-slate-400">Актуальность</span>
                                            <CustomSelect
                                              value={editDescForm.status}
                                              onChange={(val) => setEditDescForm(prev => ({ ...prev, status: val as any }))}
                                              options={actualitySelectOptions}
                                            />
                                          </div>
                                        </div>

                                        <div className="space-y-0.5">
                                          <span className="text-xs font-bold text-slate-400">Комментарий</span>
                                          <textarea
                                            value={editDescForm.comment}
                                            onChange={(e) => setEditDescForm(prev => ({ ...prev, comment: e.target.value }))}
                                            className="w-full p-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-xs text-slate-800 dark:text-slate-100 focus:outline-none"
                                            rows={2}
                                          />
                                        </div>

                                        <div className="flex justify-end gap-1.5 pt-1">
                                          <button type="button"
                                            onClick={() => setEditingDescId(null)}
                                            className="px-2 py-0.5 text-xs text-slate-450 hover:text-slate-650 transition-colors cursor-pointer"
                                          >
                                            Отмена
                                          </button>
                                          <button type="button"
                                            onClick={async () => {
                                              await handleUpdateDescription(tag.id, desc.id, {
                                                text: editDescForm.text,
                                                comment: editDescForm.comment,
                                                status: editDescForm.status
                                              });
                                              setEditingDescId(null);
                                            }}
                                            className="px-2.5 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded cursor-pointer"
                                          >
                                            Записать
                                          </button>
                                        </div>
                                      </div>
                                    ) : (
                                      /* STANDARD DISPLAY MODE WITH TIMESTAMPS */
                                      <>
                                        <div className="flex items-start justify-between gap-1.5">
                                          <div className="flex items-center gap-1.5 min-w-0">
                                            <div className={`w-1.5 h-1.5 rounded-full ${config.text} bg-current shrink-0`} />
                                            <span
                                              className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate"
                                              title={`${desc.text}${desc.createdBy ? `\nСоздал: ${desc.createdBy}${desc.createdAt ? ` (${formatDateStr(desc.createdAt)})` : ''}` : ''}${desc.updatedBy ? `\nИзменил: ${desc.updatedBy}${desc.updatedAt ? ` (${formatDateStr(desc.updatedAt)})` : ''}` : ''}`}
                                            >{desc.text}</span>
                                          </div>
                                          <div className="flex items-center gap-1 shrink-0">
                                            <span className={`inline-flex items-center gap-0.5 px-1 py-0.2 rounded text-xs font-semibold border ${config.bg} ${config.text} ${config.border}`}>
                                              <StatusIcon className="w-1.5 h-1.5" />
                                              {config.label}
                                            </span>
                                            
                                            {/* Actions */}
                                            <button type="button"
                                              title="Изменить комментарий"
                                              onClick={() => {
                                                setEditingDescId(desc.id);
                                                setEditDescForm({
                                                  text: desc.text,
                                                  comment: desc.comment || '',
                                                  status: desc.status
                                                });
                                              }}
                                              className="p-1 hover:text-emerald-600 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-colors text-slate-400 cursor-pointer"
                                            >
                                              <Edit className="w-2.5 h-2.5" />
                                            </button>
                                            <button type="button"
                                              title="Удалить комментарий"
                                              onClick={() => handleRemoveDescription(tag.id, desc.id)}
                                              className="p-1 hover:text-rose-500 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-colors text-slate-400 cursor-pointer"
                                            >
                                              <Trash2 className="w-2.5 h-2.5" />
                                            </button>
                                          </div>
                                        </div>

                                        {desc.comment && (
                                          <p className="text-xs text-slate-500 dark:text-slate-400 pl-2 border-l border-slate-200 dark:border-slate-800 italic leading-snug">
                                            {desc.comment}
                                          </p>
                                        )}

                                      </>
                                    )}
                                  </div>
                                );
                              })}

                              {meta.descriptions.length === 0 && (
                                <div className="text-center py-6 text-slate-400 dark:text-slate-500 text-xs italic">
                                  Описания отсутствуют.
                                </div>
                              )}
                            </div>

                            {/* Быстрое добавление комментария */}
                            <div className="p-3 bg-slate-50 dark:bg-slate-900 border-t border-slate-105 dark:border-slate-850 space-y-2 no-drag text-left text-xs">
                              <div className="flex gap-1.5">
                                <input
                                  type="text"
                                  placeholder="Напр. Вентилятор В-1"
                                  value={quickDescText[tag.id] || ''}
                                  onChange={(e) => setQuickDescText(prev => ({ ...prev, [tag.id]: e.target.value }))}
                                  className="px-2 py-1 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded text-xs flex-1 text-slate-800 dark:text-slate-100 focus:outline-none"
                                />
                                <CustomSelect
                                  value={quickStatus[tag.id] || 'actual'}
                                  onChange={(val) => setQuickStatus(prev => ({ ...prev, [tag.id]: val as any }))}
                                  options={emojiOptions}
                                />
                              </div>
                              
                              <div className="flex gap-1.5">
                                <input
                                  type="text"
                                  placeholder="Замечания..."
                                  value={quickCommentText[tag.id] || ''}
                                  onChange={(e) => setQuickCommentText(prev => ({ ...prev, [tag.id]: e.target.value }))}
                                  className="px-2 py-1 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded text-xs flex-1 text-slate-800 dark:text-slate-100 focus:outline-none"
                                />
                                <button type="button"
                                  onClick={() => handleAddDescription(
                                    tag.id, 
                                    quickDescText[tag.id], 
                                    quickCommentText[tag.id], 
                                    quickStatus[tag.id] || 'actual'
                                  )}
                                  className="px-3.5 py-1 bg-emerald-700 hover:bg-emerald-600 text-white font-bold rounded text-xs cursor-pointer"
                                >
                                  +
                                </button>
                              </div>
                            </div>

                            {/* Действия карточки */}
                            <div className="p-2 bg-slate-100/40 dark:bg-slate-950/40 border-t border-slate-200 dark:border-slate-850 flex items-center justify-end text-xs rounded-b-2xl no-drag">
                              <div className="flex items-center gap-1.5">
                                <button type="button"
                                  title="Настроить связи / свойства в модали"
                                  onClick={() => setEditingTag(tag)}
                                  className="flex items-center gap-1 px-2 py-1 hover:text-emerald-600 dark:hover:text-emerald-400 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-colors text-xs font-semibold cursor-pointer"
                                >
                                  <Edit2 className="w-3 h-3" /> Настройка
                                </button>
                                <button type="button"
                                  title="Удалить тег с холста"
                                  onClick={() => handleDeleteTag(tag.id)}
                                  className="p-1 px-2 hover:text-rose-600 text-slate-550 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded transition-colors text-xs font-semibold cursor-pointer"
                                >
                                  <Trash2 className="w-3 h-3" /> Удалить
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Панель выделения: сколько выбрано + быстрые действия */}
              {selectedTagIds.size > 0 && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 bg-white/95 dark:bg-slate-950/95 backdrop-blur-md px-3 py-2 rounded-xl border border-emerald-200 dark:border-emerald-900 shadow-lg text-xs">
                  <span className="font-bold text-emerald-700 dark:text-emerald-300">Выбрано: {selectedTagIds.size}</span>
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
          <ContextMenu
            x={boardMenu.x}
            y={boardMenu.y}
            items={[
              {
                label: 'Упорядочить сверху вниз',
                icon: <Network className="w-3.5 h-3.5" />,
                onClick: () => { chooseAxis('down'); void arrangeTreeLayout('down'); },
              },
              {
                label: 'Упорядочить слева направо',
                icon: <Network className="w-3.5 h-3.5" />,
                onClick: () => { chooseAxis('right'); void arrangeTreeLayout('right'); },
              },
              {
                label: 'Вписать весь холст',
                icon: <Maximize2 className="w-3.5 h-3.5" />,
                onClick: () => fitCanvasToCenter(),
              },
              {
                label: 'Создать тег здесь',
                icon: <Plus className="w-3.5 h-3.5" />,
                // Место запоминаем ДО открытия формы: пока человек набирает
                // код, он успевает подвинуть холст, и «здесь» уезжает
                onClick: () => { newTagSpotRef.current = boardMenu.at; setShowAdvancedCreation(true); },
              },
              {
                label: 'Снять выделение',
                icon: <X className="w-3.5 h-3.5" />,
                onClick: () => { setSelectedTagIds(new Set()); setSelectedConnection(null); },
              },
            ]}
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
            <span className="font-bold text-emerald-700 dark:text-emerald-300">Выбрано: {selectedTagIds.size}</span>
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
            <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-850 rounded-xl text-xs text-slate-500 dark:text-slate-400">
              <span className="flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5 text-sky-500" />
                {treeLinkMode === 'click'
                  ? <>Связи: <b>кликом</b> — кнопка <Link2 className="w-3 h-3 inline -mt-0.5" /> у строки, затем клик по дочерней.</>
                  : <>Связи: <b>перетаскиванием</b> — тяните строку тега на другую (перетащенный станет дочерним).</>}
              </span>
              {treeLinkingFrom && (
                <button type="button" onClick={() => setTreeLinkingFrom(null)} className="shrink-0 px-2 py-1 rounded-lg bg-sky-500 text-white font-semibold cursor-pointer">Отмена связи (Esc)</button>
              )}
            </div>
            <div className="p-5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-xl shadow-xs">
              {buildTree().length === 0 ? (
                <div className="text-center py-16 text-slate-400">
                  <Database className="w-12 h-12 mx-auto text-slate-200 dark:text-slate-800 mb-3" />
                  <p className="text-base text-slate-600 font-bold">Теги не найдены</p>
                  <p className="text-xs mt-1">Добавьте хотя бы один тег с кодом или восстановите демонстрационное дерево!</p>
                </div>
              ) : (
                <div className="space-y-3">
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

            {/* SELECTION FILTERS BLOCK */}
            <div className="grid grid-cols-1 @[880px]:grid-cols-2 gap-6 p-5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-xl  text-left">
              
              {/* LEFT COLUMN: TAG FILTERING ZONE */}
              <div className="space-y-4 border-r border-slate-100 dark:border-slate-850 pr-0 @[880px]:pr-6">
                <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-850">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>
                      Отбор по сегментам тега
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">По частям кода тега: только латиница и цифры.</p>
                  </div>
                  <button type="button"
                    onClick={() => setAddedTagSegmentsCount(prev => prev + 1)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer border-none"
                  >
                    <Plus className="w-3 h-3" /> Добавить сегмент
                  </button>
                </div>

                <div className="grid grid-cols-1 @[720px]:grid-cols-2 gap-4">
                  {Array.from({ length: getMaximumTagSegmentLength() + addedTagSegmentsCount }).map((_, idx) => {
                    const uniqueList = getUniqueTagSegmentValuesForPos(idx);
                    const currentVal = activeTagFilters[idx] || '';

                    const boundDictId = tagDictBindings[idx] || '';
                    const boundDict = dictionaries.find(d => d.id === boundDictId);

                    const selection = tagHierarchySelections[idx] || {};

                    const mainCategories = boundDict ? boundDict.items.filter((i: any) => !i.parentId) : [];
                    const subCategories = boundDict && selection.mainId 
                      ? boundDict.items.filter((i: any) => i.parentId === selection.mainId) 
                      : [];
                    const subSubCategories = boundDict && selection.subId 
                      ? boundDict.items.filter((i: any) => i.parentId === selection.subId) 
                      : [];

                    const handleMainChange = (mainId: string) => {
                      const mainItem = boundDict?.items.find((i: any) => i.id === mainId);
                      setTagHierarchySelections(prev => ({
                        ...prev,
                        [idx]: { mainId, subId: '', subSubId: '' }
                      }));
                      setActiveTagFilters(prev => ({
                        ...prev,
                        [idx]: mainItem ? mainItem.code : '*'
                      }));
                    };

                    const handleSubChange = (subId: string) => {
                      const subItem = boundDict?.items.find((i: any) => i.id === subId);
                      setTagHierarchySelections(prev => ({
                        ...prev,
                        [idx]: { ...prev[idx], subId, subSubId: '' }
                      }));
                      setActiveTagFilters(prev => ({
                        ...prev,
                        [idx]: subItem 
                          ? subItem.code 
                          : (boundDict?.items.find((i: any) => i.id === selection.mainId)?.code || '*')
                      }));
                    };

                    const handleSubSubChange = (subSubId: string) => {
                      const subSubItem = boundDict?.items.find((i: any) => i.id === subSubId);
                      setTagHierarchySelections(prev => ({
                        ...prev,
                        [idx]: { ...prev[idx], subSubId }
                      }));
                      setActiveTagFilters(prev => ({
                        ...prev,
                        [idx]: subSubItem 
                          ? subSubItem.code 
                          : (boundDict?.items.find((i: any) => i.id === selection.subId)?.code || '*')
                      }));
                    };

                    return (
                      <div key={`tag-seg-${idx}`} className="p-3 bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800 rounded-xl space-y-2 relative group transition-ui text-xs flex flex-col justify-between">
                        <div>
                          <div className="flex items-center justify-between border-b border-slate-200/40 dark:border-slate-800/45 pb-1 mb-2">
                            <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-1 uppercase tracking-wider">
                              Сегмент тега {idx + 1}
                            </span>
                            {idx >= getMaximumTagSegmentLength() && (
                              <button type="button"
                                onClick={() => {
                                  setAddedTagSegmentsCount(prev => Math.max(0, prev - 1));
                                  setActiveTagFilters(prev => {
                                    const clone = { ...prev };
                                    delete clone[idx];
                                    return clone;
                                  });
                                }}
                                className="p-0.5 text-slate-400 hover:text-rose-500 rounded transition-colors border-none bg-transparent cursor-pointer"
                                title="Удалить сегмент"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>

                          {/* Unified Custom Input */}
                          <div className="space-y-1">
                            <span className="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wide">
                              Поиск сегмента:
                            </span>
                            <input
                              type="text"
                              placeholder="Значение..."
                              value={currentVal === '*' ? '' : currentVal}
                              onChange={(e) =>
                                setActiveTagFilters(prev => ({ ...prev, [idx]: e.target.value || '*' }))
                              }
                              className="w-full px-2 py-1 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs rounded-md text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/15"
                            />
                          </div>

                          {/* Quick Select from Custom Preset Filter Categories */}
                          {(() => {
                            const presetDict = dictionaries.find(d => d.name === '__tag_presets_config__');
                            const presetItems = presetDict?.items || [];
                            const filterCategories = presetItems.filter((i: any) => !i.parentId);
                            const activeCatId = selectedTagFilterCategoryIds[idx] || '';
                            const categoryOptions = presetItems.filter((i: any) => i.parentId === activeCatId);

                            if (filterCategories.length === 0) return null;

                            return (
                              <div className="space-y-1 border-t border-slate-200/40 dark:border-slate-800/40 mt-2 pt-2">
                                <span className="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wide">
                                  Категория фильтра:
                                </span>
                                <CustomSelect
                                  value={activeCatId}
                                  onChange={(val) => setSelectedTagFilterCategoryIds(prev => ({ ...prev, [idx]: val }))}
                                  placeholder="-- Категории справочника --"
                                  options={filterCategories.map((cat: any) => ({
                                    value: cat.id,
                                    label: cat.nameRu
                                  }))}
                                />

                                {activeCatId && (
                                  <div className="bg-white/40 dark:bg-slate-950/20 p-2 rounded border border-slate-200/40 dark:border-slate-800/40 space-y-1">
                                    <span className="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase">
                                      Каталог:
                                    </span>
                                    <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto style-scrollbar pr-1">
                                      {categoryOptions.map((opt: any) => {
                                        const optVal = opt.code || opt.nameRu;
                                        const isSel = currentVal === optVal;
                                        return (
                                          <button
                                            key={opt.id}
                                            type="button"
                                            onClick={() => setActiveTagFilters(prev => ({ ...prev, [idx]: optVal }))}
                                            className={`px-1.5 py-0.5 border rounded text-xs font-mono transition-ui duration-150 cursor-pointer border-none ${
                                              isSel
                                                ? 'bg-emerald-600 border-emerald-600 text-white font-bold'
                                                : 'bg-white hover:bg-slate-100 dark:bg-slate-950 dark:hover:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400'
                                            }`}
                                          >
                                            {opt.nameRu}
                                          </button>
                                        );
                                      })}
                                      {categoryOptions.length === 0 && (
                                        <span className="text-xs text-slate-400 dark:text-slate-500 italic">Варианты отсутствуют</span>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          {/* Base database match list with max-h and scrollbar */}
                          {uniqueList.length > 0 && (
                            <div className="space-y-1 text-left border-t border-slate-200/40 dark:border-slate-800/40 mt-2 pt-2">
                              <span className="block text-xs font-bold text-slate-400/80 dark:text-slate-500 uppercase tracking-wide">
                                В базе ({uniqueList.length}):
                              </span>
                              <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto style-scrollbar">
                                {uniqueList.map((val) => {
                                  const isSelected = currentVal === val;
                                  return (
                                    <button
                                      key={val}
                                      type="button"
                                      onClick={() => setActiveTagFilters(prev => ({ ...prev, [idx]: val }))}
                                      className={`px-1.5 py-0.5 rounded text-xs cursor-pointer font-mono font-semibold transition-ui duration-150 border-none uppercase tracking-wider ${
                                        isSelected
                                          ? 'bg-emerald-600 text-white font-bold'
                                          : 'bg-white hover:bg-slate-150 dark:bg-slate-950 dark:hover:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200/80 dark:border-slate-800'
                                      }`}
                                    >
                                      {val}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Dictionary Integration Binding Section */}
                        <div className="space-y-1 border-t border-slate-200/40 dark:border-slate-800/40 mt-2 pt-2">
                          <div className="space-y-1">
                            <span className="block text-xs font-semibold text-slate-450 dark:text-slate-500 uppercase tracking-wider">
                              Справочник значений:
                            </span>
                            <CustomSelect
                              value={boundDictId}
                              onChange={(val) => {
                                setTagDictBindings(prev => ({ ...prev, [idx]: val }));
                                setTagHierarchySelections(prev => ({ ...prev, [idx]: {} }));
                              }}
                              placeholder="-- Без справочника --"
                              options={dictionaries.map((dict) => ({
                                value: dict.id,
                                label: dict.name
                              }))}
                            />
                          </div>

                          {boundDict && (
                            <div className="space-y-1 mt-1 bg-white/40 dark:bg-slate-950/20 p-2 rounded border border-slate-200/40 dark:border-slate-800/40 text-xs">
                              {/* Main Category */}
                              <div className="space-y-0.5 animate-fadeIn">
                                <span className="block text-xs font-bold text-slate-400 uppercase">1. Главная</span>
                                <CustomSelect
                                  value={selection.mainId || ''}
                                  onChange={(val) => handleMainChange(val)}
                                  placeholder="Не выбрано"
                                  options={mainCategories.map((cat: any) => ({
                                    value: cat.id,
                                    label: `${cat.code} — ${cat.nameRu}`
                                  }))}
                                />
                              </div>

                              {/* Subcategory */}
                              {selection.mainId && subCategories.length > 0 && (
                                <div className="space-y-0.5 animate-fadeIn">
                                  <span className="block text-xs font-bold text-slate-400 uppercase">2. Подкатегория</span>
                                  <CustomSelect
                                    value={selection.subId || ''}
                                    onChange={(val) => handleSubChange(val)}
                                    placeholder="Не выбрано"
                                    options={subCategories.map((sub: any) => ({
                                      value: sub.id,
                                      label: `${sub.code} — ${sub.nameRu}`
                                    }))}
                                  />
                                </div>
                              )}

                              {/* Sub-subcategory */}
                              {selection.subId && subSubCategories.length > 0 && (
                                <div className="space-y-0.5 animate-fadeIn">
                                  <span className="block text-xs font-bold text-slate-400 uppercase">3. Подподкатегория</span>
                                  <CustomSelect
                                    value={selection.subSubId || ''}
                                    onChange={(val) => handleSubSubChange(val)}
                                    placeholder="Не выбрано"
                                    options={subSubCategories.map((s: any) => ({
                                      value: s.id,
                                      label: `${s.code} — ${s.nameRu}`
                                    }))}
                                  />
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* RIGHT COLUMN: MARK FILTERING ZONE */}
              <div className="space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-850">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0"></span>
                      Отбор по сегментам марки
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">По частям марки оборудования: любой язык.</p>
                  </div>
                  <button type="button"
                    onClick={() => setAddedMarkSegmentsCount(prev => prev + 1)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-semibold transition-colors cursor-pointer border-none"
                  >
                    <Plus className="w-3 h-3" /> Добавить сегмент
                  </button>
                </div>

                <div className="grid grid-cols-1 @[720px]:grid-cols-2 gap-4">
                  {Array.from({ length: getMaximumMarkSegmentLength() + addedMarkSegmentsCount }).map((_, idx) => {
                    const uniqueList = getUniqueMarkSegmentValuesForPos(idx);
                    const currentVal = activeMarkFilters[idx] || '';

                    const boundDictId = markDictBindings[idx] || '';
                    const boundDict = dictionaries.find(d => d.id === boundDictId);

                    const selection = markHierarchySelections[idx] || {};

                    const mainCategories = boundDict ? boundDict.items.filter((i: any) => !i.parentId) : [];
                    const subCategories = boundDict && selection.mainId 
                      ? boundDict.items.filter((i: any) => i.parentId === selection.mainId) 
                      : [];
                    const subSubCategories = boundDict && selection.subId 
                      ? boundDict.items.filter((i: any) => i.parentId === selection.subId) 
                      : [];

                    const handleMainChange = (mainId: string) => {
                      const mainItem = boundDict?.items.find((i: any) => i.id === mainId);
                      setMarkHierarchySelections(prev => ({
                        ...prev,
                        [idx]: { mainId, subId: '', subSubId: '' }
                      }));
                      setActiveMarkFilters(prev => ({
                        ...prev,
                        [idx]: mainItem ? mainItem.code : '*'
                      }));
                    };

                    const handleSubChange = (subId: string) => {
                      const subItem = boundDict?.items.find((i: any) => i.id === subId);
                      setMarkHierarchySelections(prev => ({
                        ...prev,
                        [idx]: { ...prev[idx], subId, subSubId: '' }
                      }));
                      setActiveMarkFilters(prev => ({
                        ...prev,
                        [idx]: subItem 
                          ? subItem.code 
                          : (boundDict?.items.find((i: any) => i.id === selection.mainId)?.code || '*')
                      }));
                    };

                    const handleSubSubChange = (subSubId: string) => {
                      const subSubItem = boundDict?.items.find((i: any) => i.id === subSubId);
                      setMarkHierarchySelections(prev => ({
                        ...prev,
                        [idx]: { ...prev[idx], subSubId }
                      }));
                      setActiveMarkFilters(prev => ({
                        ...prev,
                        [idx]: subSubItem 
                          ? subSubItem.code 
                          : (boundDict?.items.find((i: any) => i.id === selection.subId)?.code || '*')
                      }));
                    };

                    return (
                      <div key={`mark-seg-${idx}`} className="p-3 bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800 rounded-xl space-y-2 relative group transition-ui text-xs flex flex-col justify-between">
                        <div>
                          <div className="flex items-center justify-between border-b border-slate-200/40 dark:border-slate-800/45 pb-1 mb-2">
                            <span className="text-xs font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1 uppercase tracking-wider">
                              Сегмент марки {idx + 1}
                            </span>
                            {idx >= getMaximumMarkSegmentLength() && (
                              <button type="button"
                                onClick={() => {
                                  setAddedMarkSegmentsCount(prev => Math.max(0, prev - 1));
                                  setActiveMarkFilters(prev => {
                                    const clone = { ...prev };
                                    delete clone[idx];
                                    return clone;
                                  });
                                }}
                                className="p-0.5 text-slate-400 hover:text-rose-500 rounded transition-colors border-none bg-transparent cursor-pointer"
                                title="Удалить сегмент"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>

                          {/* Unified Custom Input */}
                          <div className="space-y-1">
                            <span className="block text-xs font-bold text-slate-400 dark:text-slate-550 uppercase tracking-wide">
                              Поиск сегмента:
                            </span>
                            <input
                              type="text"
                              placeholder="Значение..."
                              value={currentVal === '*' ? '' : currentVal}
                              onChange={(e) =>
                                setActiveMarkFilters(prev => ({ ...prev, [idx]: e.target.value || '*' }))
                              }
                              className="w-full px-2 py-1 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-80 style-scrollbar text-xs rounded-md text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/15"
                            />
                          </div>

                          {/* Quick Select from Custom Preset Filter Categories */}
                          {(() => {
                            const presetDict = dictionaries.find(d => d.name === '__tag_presets_config__');
                            const presetItems = presetDict?.items || [];
                            const filterCategories = presetItems.filter((i: any) => !i.parentId);
                            const activeCatId = selectedMarkFilterCategoryIds[idx] || '';
                            const categoryOptions = presetItems.filter((i: any) => i.parentId === activeCatId);

                            if (filterCategories.length === 0) return null;

                            return (
                              <div className="space-y-1 border-t border-slate-200/40 dark:border-slate-800/40 mt-2 pt-2">
                                <span className="block text-xs font-bold text-slate-400 dark:text-slate-550 uppercase tracking-wide">
                                  Категория фильтра:
                                </span>
                                <CustomSelect
                                  value={activeCatId}
                                  onChange={(val) => setSelectedMarkFilterCategoryIds(prev => ({ ...prev, [idx]: val }))}
                                  placeholder="-- Категории справочника --"
                                  options={filterCategories.map((cat: any) => ({
                                    value: cat.id,
                                    label: cat.nameRu
                                  }))}
                                />

                                {activeCatId && (
                                  <div className="bg-white/40 dark:bg-slate-950/20 p-2 rounded border border-slate-200/40 dark:border-slate-800/40 space-y-1">
                                    <span className="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase">
                                      Каталог:
                                    </span>
                                    <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto style-scrollbar pr-1">
                                      {categoryOptions.map((opt: any) => {
                                        const optVal = opt.code || opt.nameRu;
                                        const isSel = currentVal === optVal;
                                        return (
                                          <button
                                            key={opt.id}
                                            type="button"
                                            onClick={() => setActiveMarkFilters(prev => ({ ...prev, [idx]: optVal }))}
                                            className={`px-1.5 py-0.5 border rounded text-xs font-mono transition-ui duration-150 cursor-pointer border-none ${
                                              isSel
                                                ? 'bg-amber-600 border-amber-600 text-white font-bold'
                                                : 'bg-white hover:bg-slate-100 dark:bg-slate-950 dark:hover:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400'
                                            }`}
                                          >
                                            {opt.nameRu}
                                          </button>
                                        );
                                      })}
                                      {categoryOptions.length === 0 && (
                                        <span className="text-xs text-slate-400 dark:text-slate-500 italic">Варианты отсутствуют</span>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          {/* Base database match list with max-h and scrollbar */}
                          {uniqueList.length > 0 && (
                            <div className="space-y-1 text-left border-t border-slate-200/40 dark:border-slate-800/40 mt-2 pt-2">
                              <span className="block text-xs font-bold text-slate-400/80 dark:text-slate-500 uppercase tracking-wide">
                                В базе ({uniqueList.length}):
                              </span>
                              <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto style-scrollbar">
                                {uniqueList.map((val) => {
                                  const isSelected = currentVal === val;
                                  return (
                                    <button
                                      key={val}
                                      type="button"
                                      onClick={() => setActiveMarkFilters(prev => ({ ...prev, [idx]: val }))}
                                      className={`px-1.5 py-0.5 rounded text-xs cursor-pointer font-mono font-semibold transition-ui duration-150 border-none uppercase tracking-wider ${
                                        isSelected
                                          ? 'bg-amber-600 text-white font-bold'
                                          : 'bg-white hover:bg-slate-150 dark:bg-slate-950 dark:hover:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200/80 dark:border-slate-800'
                                      }`}
                                    >
                                      {val}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Dictionary Integration Binding Section */}
                        <div className="space-y-1 border-t border-slate-200/40 dark:border-slate-800/40 mt-2 pt-2">
                          <div className="space-y-1">
                            <span className="block text-xs font-semibold text-slate-455 dark:text-slate-500 uppercase tracking-wider">
                              Справочник значений:
                            </span>
                            <CustomSelect
                              value={boundDictId}
                              onChange={(val) => {
                                setMarkDictBindings(prev => ({ ...prev, [idx]: val }));
                                setMarkHierarchySelections(prev => ({ ...prev, [idx]: {} }));
                              }}
                              placeholder="-- Без справочника --"
                              options={dictionaries.map((dict) => ({
                                value: dict.id,
                                label: dict.name
                              }))}
                            />
                          </div>

                          {boundDict && (
                            <div className="space-y-1 mt-1 bg-white/40 dark:bg-slate-950/20 p-2 rounded border border-slate-200/40 dark:border-slate-800/40 text-xs">
                              {/* Main Category */}
                              <div className="space-y-0.5 animate-fadeIn">
                                <span className="block text-xs font-bold text-slate-400 uppercase">1. Главная</span>
                                <CustomSelect
                                  value={selection.mainId || ''}
                                  onChange={(val) => handleMainChange(val)}
                                  placeholder="Не выбрано"
                                  options={mainCategories.map((cat: any) => ({
                                    value: cat.id,
                                    label: `${cat.code} — ${cat.nameRu}`
                                  }))}
                                />
                              </div>

                              {/* Subcategory */}
                              {selection.mainId && subCategories.length > 0 && (
                                <div className="space-y-0.5 animate-fadeIn">
                                  <span className="block text-xs font-bold text-slate-400 uppercase">2. Подкатегория</span>
                                  <CustomSelect
                                    value={selection.subId || ''}
                                    onChange={(val) => handleSubChange(val)}
                                    placeholder="Не выбрано"
                                    options={subCategories.map((sub: any) => ({
                                      value: sub.id,
                                      label: `${sub.code} — ${sub.nameRu}`
                                    }))}
                                  />
                                </div>
                              )}

                              {/* Sub-subcategory */}
                              {selection.subId && subSubCategories.length > 0 && (
                                <div className="space-y-0.5 animate-fadeIn">
                                  <span className="block text-xs font-bold text-slate-400 uppercase">3. Подподкатегория</span>
                                  <CustomSelect
                                    value={selection.subSubId || ''}
                                    onChange={(val) => handleSubSubChange(val)}
                                    placeholder="Не выбрано"
                                    options={subSubCategories.map((s: any) => ({
                                      value: s.id,
                                      label: `${s.code} — ${s.nameRu}`
                                    }))}
                                  />
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* SEPARATOR AND SUPPLEMENTARY CONTROLS */}
              <div className="@[880px]:col-span-2 flex flex-wrap gap-6 pt-3 border-t border-slate-100 dark:border-slate-850 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={excludeEmptyWBS}
                    onChange={(e) => setExcludeEmptyWBS(e.target.checked)}
                    className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 w-4 h-4 cursor-pointer"
                  />
                  <span className="text-slate-600 dark:text-slate-300 font-medium">Исключить пустые WBS элементы</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={onlyWithWarning}
                    onChange={(e) => setOnlyWithWarning(e.target.checked)}
                    className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 w-4 h-4 cursor-pointer"
                  />
                  <span className="text-slate-600 dark:text-slate-300 font-medium">Только теги с предупреждениями (Критично/Проверить)</span>
                </label>

                <button
                  type="button"
                  onClick={() => {
                    setActiveTagFilters({});
                    setActiveMarkFilters({});
                    setTagDictBindings({});
                    setMarkDictBindings({});
                    setTagHierarchySelections({});
                    setMarkHierarchySelections({});
                    setSelectedTagFilterCategoryIds({});
                    setSelectedMarkFilterCategoryIds({});
                    setAddedTagSegmentsCount(0);
                    setAddedMarkSegmentsCount(0);
                  }}
                  className="text-xs text-rose-500 hover:text-rose-600 ml-auto font-bold cursor-pointer border-none bg-transparent"
                >
                  Сбросить все настройки сегментов
                </button>
              </div>
            </div>

            {/* EXPORT COLUMNS SETTINGS */}
            <div className="p-5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-xl shadow-xs space-y-4">
              <div className="flex flex-col @[880px]:flex-row @[880px]:items-center @[880px]:justify-between gap-4">
                <div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white mb-1">
                    2. Выберите колонки для Экспорта в Excel (.CSV)
                  </h3>
                </div>

                <div className="flex items-center gap-2">
                  <button type="button" onClick={handleCopySelectedAsTable} title="Те же колонки — сразу в буфер обмена, без файла"
                    className="px-4 py-2.5 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-900 text-slate-700 dark:text-slate-150 rounded-xl text-xs font-bold flex items-center gap-2 transition-ui cursor-pointer">
                    <Copy className="w-4 h-4" /><span>Скопировать таблицей</span>
                  </button>
                  <button type="button" onClick={handleExportSelectedToExcel}
                    className="px-5 py-2.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded-xl text-xs font-bold shadow-sm flex items-center gap-2 transition-ui cursor-pointer">
                    <FileSpreadsheet className="w-4 h-4" /><span>Экспортировать подборку в Excel</span>
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-4 pt-1 text-xs">
                <label className="flex items-center gap-2 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-100 dark:border-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportColumns.identifier}
                    onChange={(e) => setExportColumns(p => ({ ...p, identifier: e.target.checked }))}
                    className="rounded border-slate-300 text-emerald-600"
                  />
                  <span>Код тега (Identifier)</span>
                </label>
                <label className="flex items-center gap-2 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-100 dark:border-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportColumns.parts}
                    onChange={(e) => setExportColumns(p => ({ ...p, parts: e.target.checked }))}
                    className="rounded border-slate-300 text-emerald-600"
                  />
                  <span>Сегменты отдельными колонками</span>
                </label>
                <label className="flex items-center gap-2 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-100 dark:border-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportColumns.department}
                    onChange={(e) => setExportColumns(p => ({ ...p, department: e.target.checked }))}
                    className="rounded border-slate-300 text-emerald-600"
                  />
                  <span>Технологическая зона / Дисциплина</span>
                </label>
                <label className="flex items-center gap-2 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-100 dark:border-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportColumns.fluid}
                    onChange={(e) => setExportColumns(p => ({ ...p, fluid: e.target.checked }))}
                    className="rounded border-slate-300 text-emerald-600"
                  />
                  <span>Рабочая среда (Fluid)</span>
                </label>
                <label className="flex items-center gap-2 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-100 dark:border-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportColumns.chain}
                    onChange={(e) => setExportColumns(p => ({ ...p, chain: e.target.checked }))}
                    className="rounded border-slate-300 text-emerald-600"
                  />
                  <span>Связи по иерархической цепочке родителей</span>
                </label>
                <label className="flex items-center gap-2 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-100 dark:border-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportColumns.brand}
                    onChange={(e) => setExportColumns(p => ({ ...p, brand: e.target.checked }))}
                    className="rounded border-slate-300 text-emerald-600"
                  />
                  <span>Марка оборудования</span>
                </label>
                <label className="flex items-center gap-2 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-100 dark:border-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportColumns.brandParts}
                    onChange={(e) => setExportColumns(p => ({ ...p, brandParts: e.target.checked }))}
                    className="rounded border-slate-300 text-emerald-600"
                  />
                  <span>Сегменты марки отдельно</span>
                </label>
                <label className="flex items-center gap-2 bg-slate-50 dark:bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-100 dark:border-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportColumns.descriptions}
                    onChange={(e) => setExportColumns(p => ({ ...p, descriptions: e.target.checked }))}
                    className="rounded border-slate-300 text-emerald-600"
                  />
                  <span>Комментарии / Контрольные точки КИП</span>
                </label>
              </div>
            </div>

            {/* MATCHED RESULTS PREVIEW TABLE */}
            <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-xl shadow-xs overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-150 dark:border-slate-855 flex justify-between items-center bg-slate-50/40 dark:bg-slate-900/40 border-none">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-widest block">
                  3. Выходные данные ({countOf(matchedTagsList.length, 'запись')} подобрано)
                </span>
              </div>

              <div 
                ref={parentRefSegments}
                className="overflow-auto max-h-[600px] style-scrollbar"
              >
                <table className="w-full text-sm text-left border-collapse">
                  <thead className="sticky top-0 bg-white dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-250 dark:border-slate-850 text-xs font-semibold uppercase tracking-wider z-10 shadow-xs">
                    <tr>
                      <th className="flux-cell">Сегменты тега</th>
                      <th className="flux-cell">Сегменты марки</th>
                      <th className="flux-cell">Наименование тега</th>
                      {/* Кнопка «добавить колонку» отсюда убрана: она только
                          сообщала, что возможность не готова. Кнопка, которая
                          ничего не делает, хуже отсутствующей — она обещает */}
                      <th className="flux-cell">Статус / Актуальность</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-850">
                    {segmentsVirtualizer.getVirtualItems().length > 0 && (
                      <tr style={{ height: `${segmentsVirtualizer.getVirtualItems()[0].start}px`, border: 'none' }}>
                        <td colSpan={4} style={{ padding: 0, border: 'none' }} />
                      </tr>
                    )}
                    {segmentsVirtualizer.getVirtualItems().map((virtualRow) => {
                      const t = matchedTagsList[virtualRow.index];
                      if (!t) return null;
                      const tMeta = parseTagMetadata(t);
                      const tagParts = tMeta.tagSegments && tMeta.tagSegments.length > 0
                        ? tMeta.tagSegments
                        : splitSegments(t.identifier || '');
                        
                      const markParts = tMeta.markSegments && tMeta.markSegments.length > 0
                        ? tMeta.markSegments
                        : splitSegments(t.brand || '');

                      const overallStatus = getTagOverallStatus(t);
                      const statusCfg = statusConfig[overallStatus] || statusConfig.draft;

                      return (
                        <tr 
                          key={t.id} 
                          ref={segmentsVirtualizer.measureElement}
                          data-index={virtualRow.index}
                          className="hover:bg-slate-50/60 dark:hover:bg-slate-950/40 transition-colors"
                        >
                          {/* COLUMN 1: TAG SEGMENTS (KKS) */}
                          <td className="flux-cell">
                            <div className="flex flex-wrap gap-1">
                              {tagParts.map((part, idx) => {
                                const isMatched = activeTagFilters[idx] && activeTagFilters[idx] !== '*' && activeTagFilters[idx] === part;
                                return (
                                  <span 
                                    key={`tag-part-${idx}`} 
                                    className={`px-2 py-0.5 rounded text-xs font-mono font-bold uppercase transition-ui ${
                                      isMatched 
                                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-800 ring-2 ring-emerald-400/25' 
                                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200/40'
                                    }`}
                                  >
                                    {part}
                                  </span>
                                );
                              })}
                            </div>
                          </td>

                          {/* COLUMN 2: MARK SEGMENTS */}
                          <td className="flux-cell">
                            <div className="flex flex-wrap gap-1">
                              {markParts.map((part, idx) => {
                                const isMatched = activeMarkFilters[idx] && activeMarkFilters[idx] !== '*' && activeMarkFilters[idx] === part;
                                return (
                                  <span 
                                    key={`mark-part-${idx}`} 
                                    className={`px-2 py-0.5 rounded text-xs font-mono font-bold uppercase transition-ui ${
                                      isMatched 
                                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-800 ring-2 ring-emerald-400/25' 
                                        : 'bg-amber-50 dark:bg-slate-900 text-amber-800 dark:text-amber-400 border border-amber-200/40 dark:border-amber-900/45'
                                    }`}
                                  >
                                    {part}
                                  </span>
                                );
                              })}
                              {markParts.length === 0 && (
                                <span className="text-xs text-slate-400 italic">—</span>
                              )}
                            </div>
                            {t.brand && (
                              <span className="text-xs text-slate-450 dark:text-slate-500 block mt-1 font-medium select-all font-mono">
                                {t.brand}
                              </span>
                            )}
                          </td>

                          {/* COLUMN 3: NAME */}
                          <td className="flux-cell font-semibold text-slate-800 dark:text-slate-300 text-xs">
                            <p className="font-bold text-slate-900 dark:text-white select-all">
                              {tMeta.mainName || <span className="italic opacity-50">Без наименования</span>}
                            </p>
                            <span className="text-xs text-slate-400 font-sans block mt-0.5 font-medium leading-relaxed font-mono">
                              {t.identifier}
                            </span>
                          </td>

                          {/* COLUMN 4: STATUS / RELEVANCE */}
                          <td className="flux-cell">
                            <div className="flex items-center gap-2">
                              <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-bold border uppercase tracking-wider ${statusCfg.bg} ${statusCfg.text} ${statusCfg.border}`}>
                                {statusCfg.label}
                              </span>
                              {tMeta.descriptions.length > 0 && (
                                <span className="text-xs text-rose-500 font-bold bg-rose-50 dark:bg-rose-950/20 px-1.5 py-0.5 rounded border border-rose-100 dark:border-rose-900/30">
                                  Замечаний ({tMeta.descriptions.length})
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {segmentsVirtualizer.getVirtualItems().length > 0 && (
                      <tr style={{ height: `${segmentsVirtualizer.getTotalSize() - segmentsVirtualizer.getVirtualItems()[segmentsVirtualizer.getVirtualItems().length - 1].end}px`, border: 'none' }}>
                        <td colSpan={4} style={{ padding: 0, border: 'none' }} />
                      </tr>
                    )}

                    {matchedTagsList.length === 0 && (
                      <tr>
                        <td colSpan={4} className="text-center py-16 text-slate-400">
                          Под запрашиваемые критерии Tag или Mark сегментов не подходит ни один тег. Пожалуйста, поменяйте конфигурацию фильтров.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
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
            <div className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-xl shadow-xs overflow-hidden border-none flex-1 flex flex-col min-h-0">
              {/* Optional view controls bar */}
              <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-850 bg-slate-50/50 dark:bg-slate-900/40 flex justify-between items-center flex-wrap gap-2 border-none shrink-0">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-widest block">Спецификация и Актуальность систем ({countOf(sortedTagsList.length, 'запись')})</span>
                
                <button
                  type="button"
                  onClick={() => setShowOptionalTableColumns(!showOptionalTableColumns)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border flex items-center gap-1.5 transition-ui cursor-pointer ${
                    showOptionalTableColumns
                      ? 'bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/20 shadow-xs'
                      : 'bg-white dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:bg-slate-50'
                  }`}
                >
                  <Sliders className="w-3.5 h-3.5" />
                  <span>{showOptionalTableColumns ? 'Скрыть поля Отдел/Среда' : 'Показать поля Отдел/Среда'}</span>
                </button>
              </div>

              <div 
                ref={parentRefTable}
                className="overflow-auto flex-1 min-h-0 style-scrollbar"
              >
                <table className="w-full text-sm text-left border-collapse">
                  <thead className="sticky top-0 bg-white dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-850 text-xs font-semibold uppercase tracking-wider z-10 shadow-xs">
                    <tr>
                      <th className="flux-cell cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" onClick={() => handleSort('identifier')}>
                        Тег / Главное наименование {sortConfig.key === 'identifier' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                      </th>
                      <th className="flux-cell cursor-pointer hover:bg-slate-105 dark:hover:bg-slate-800 transition-colors" onClick={() => handleSort('brand')}>
                        Марка {sortConfig.key === 'brand' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                      </th>
                      {showOptionalTableColumns && (
                        <>
                          <th className="flux-cell cursor-pointer hover:bg-slate-105 dark:hover:bg-slate-800 transition-colors" onClick={() => handleSort('department')}>
                            Зона / Отдел {sortConfig.key === 'department' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                          </th>
                          <th className="flux-cell cursor-pointer hover:bg-slate-105 dark:hover:bg-slate-800 transition-colors" onClick={() => handleSort('fluid')}>
                            Тех. Среда {sortConfig.key === 'fluid' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                          </th>
                        </>
                      )}
                      <th className="flux-cell font-bold">Актуальность</th>
                      <th className="flux-cell font-bold">Комментарии</th>
                      <th className="flux-cell cursor-pointer hover:bg-slate-105 dark:hover:bg-slate-800 transition-colors" onClick={() => handleSort('createdAt')}>
                        Регистрация {sortConfig.key === 'createdAt' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                      </th>
                      <th className="flux-cell font-bold text-right">Управление</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-850">
                    {tableVirtualizer.getVirtualItems().length > 0 && (
                      <tr style={{ height: `${tableVirtualizer.getVirtualItems()[0].start}px`, border: 'none' }}>
                        <td colSpan={showOptionalTableColumns ? 8 : 6} style={{ padding: 0, border: 'none' }} />
                      </tr>
                    )}
                    {tableVirtualizer.getVirtualItems().map((virtualRow) => {
                      const t = sortedTagsList[virtualRow.index];
                      if (!t) return null;
                      const meta = parseTagMetadata(t);
                      return (
                        <tr
                          key={t.id}
                          id={`spec-row-${t.id}`}
                          ref={tableVirtualizer.measureElement}
                          data-index={virtualRow.index}
                          onClick={(e) => {
                            // Ctrl+клик — мультивыбор строк для «Поделиться»
                            if (e.ctrlKey || e.metaKey) {
                              e.preventDefault();
                              setSelectedTagIds(prev => {
                                const next = new Set(prev);
                                if (next.has(t.id)) next.delete(t.id);
                                else next.add(t.id);
                                return next;
                              });
                            }
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (!selectedTagIds.has(t.id)) setSelectedTagIds(new Set([t.id]));
                            setCardMenu({ x: e.clientX, y: e.clientY, tagId: t.id });
                          }}
                          className={`transition-colors ${selectedTagIds.has(t.id) ? 'bg-emerald-50 dark:bg-emerald-950/30 ring-1 ring-inset ring-emerald-300 dark:ring-emerald-800' : 'hover:bg-slate-50/60 dark:hover:bg-slate-950/40'}`}
                        >
                          <td className="flux-cell">
                            <div className="font-mono font-bold text-slate-900 dark:text-white text-xs select-all">
                              {t.identifier}
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                              {meta.mainName || <span className="italic opacity-50">Без наименования</span>}
                            </div>
                            
                            {/* Optional visual pills shown when separate columns are closed */}
                            {!showOptionalTableColumns && (
                              <div className="flex flex-wrap items-center gap-1.5 mt-1.5 text-xs text-slate-450 dark:text-slate-500 font-medium">
                                <span className="bg-slate-50 dark:bg-slate-900 border border-slate-150 dark:border-slate-850 px-1.5 py-0.5 rounded text-xs" title="Инженерная Дисциплина">
                                  {t.department || 'Комплексный'}
                                </span>
                                <span>•</span>
                                <span className="font-mono bg-slate-50 dark:bg-slate-900 border border-slate-150 dark:border-slate-850 px-1.5 py-0.5 rounded" title="Технологическая Среда">
                                  среда: {t.fluid || '-'}
                                </span>
                              </div>
                            )}
                          </td>
                          <td className="flux-cell">
                            {t.brand ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 shadow-xs max-w-[150px] min-w-0" title={t.brand}>
                                <span className="flex-1 min-w-0 truncate">{t.brand}</span>
                              </span>
                            ) : (
                              <span className="text-slate-400 dark:text-slate-500 italic text-xs">—</span>
                            )}
                          </td>
                          {showOptionalTableColumns && (
                            <>
                              <td className="flux-cell text-slate-605 dark:text-slate-300 text-xs font-medium">
                                {t.department || '-'}
                              </td>
                              <td className="flux-cell text-slate-605 dark:text-slate-300 text-xs font-mono">
                                {t.fluid || '-'}
                              </td>
                            </>
                          )}
                          {/* Актуальность тега — отдельной колонкой: за ней и
                              приходят в спецификацию, а раньше её приходилось
                              выискивать среди комментариев */}
                          <td className="flux-cell">
                            {(() => {
                              const look = statusConfig[getTagOverallStatus(t)] || statusConfig.draft;
                              return (
                                <span className={`inline-block px-1.5 py-0.5 rounded text-2xs font-semibold border ${look.bg} ${look.text} ${look.border}`}>
                                  {look.label}
                                </span>
                              );
                            })()}
                          </td>
                          <td className="flux-cell">
                            {meta.descriptions.length > 0 ? (
                              <div className="space-y-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setShowTableDescriptions(p => ({ ...p, [t.id]: !p[t.id] }));
                                    setTimeout(() => tableVirtualizer.measure(), 20);
                                  }}
                                  className="text-xs inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors cursor-pointer text-slate-650 dark:text-slate-300 border border-slate-200 dark:border-slate-805"
                                >
                                  <Eye className="w-3.5 h-3.5 text-emerald-600" />
                                  <span>{showTableDescriptions[t.id] ? 'Скрыть' : 'Показать'} комментарии ({meta.descriptions.length})</span>
                                </button>
                                
                                {showTableDescriptions[t.id] && (
                                  <div className="space-y-1.5 max-w-[420px] pt-1.5 animate-fadeIn">
                                    {meta.descriptions.map((d) => {
                                      const config = statusConfig[d.status] || statusConfig.draft;
                                      const Icon = config.icon;
                                      return (
                                        <div key={d.id} className="flex items-start gap-1 p-1 px-2 bg-slate-50 dark:bg-slate-900 rounded text-xs text-slate-700 dark:text-slate-300 border border-slate-100 dark:border-slate-850 text-left">
                                          <Icon className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${config.text}`} />
                                          <div className="text-left">
                                            <strong className="text-slate-905 dark:text-slate-105">{d.text}: </strong>
                                            <span className="text-slate-500 dark:text-slate-400">{d.comment}</span>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-slate-400 italic text-xs">Комментариев нет</span>
                            )}
                          </td>
                          <td className="flux-cell text-slate-500 font-mono text-xs">
                            {t.createdAt ? format(new Date(t.createdAt), 'dd.MM.yyyy HH:mm') : '-'}
                          </td>
                          <td className="flux-cell text-right">
                            <div className="flex justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => setEditingTag(t)}
                                className="p-1 hover:text-emerald-600 dark:hover:text-emerald-400 text-slate-500 rounded transition-colors cursor-pointer"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteTag(t.id)}
                                className="p-1 hover:text-rose-600 text-slate-500 rounded transition-colors cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {tableVirtualizer.getVirtualItems().length > 0 && (
                      <tr style={{ height: `${tableVirtualizer.getTotalSize() - tableVirtualizer.getVirtualItems()[tableVirtualizer.getVirtualItems().length - 1].end}px`, border: 'none' }}>
                        <td colSpan={showOptionalTableColumns ? 8 : 6} style={{ padding: 0, border: 'none' }} />
                      </tr>
                    )}

                    {tags.length === 0 && (
                      <tr>
                        <td colSpan={showOptionalTableColumns ? 8 : 6} className="text-center py-20 text-slate-400">
                          В данном проекте отсутствуют теги. Создайте первый тег выше!
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </motion.div>
        )}

      </AnimatePresence>
      </div>

      {/* DETAIL MODAL DESCRIPTIONS CONTROL DIALOG */}
      <AnimatePresence>
        {editingTag && (
          <div className="fixed inset-0 bg-slate-950/55 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              className="bg-white dark:bg-slate-950 rounded-lg shadow-2xl border border-slate-205 dark:border-slate-850 w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="p-4 bg-slate-900 dark:bg-slate-900 text-white flex items-center justify-between border-b dark:border-slate-800 gap-3">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <Database className="w-5 h-5 text-emerald-400 shrink-0" />
                  <div className="text-left min-w-0 flex-1">
                    {/* Код тега редактируется прямо здесь — автосохранение на blur/Enter.
                        Видимая рамка и карандаш — чтобы редактируемость была очевидна */}
                    <div className="flex items-center gap-1.5 group/rename">
                      <input
                        value={modalCode}
                        onChange={(e) => setModalCode(e.target.value)}
                        onBlur={() => handleRenameTag(editingTag.id, modalCode)}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        spellCheck={false}
                        className="min-w-0 flex-1 bg-slate-800/60 px-2 py-0.5 rounded-md text-base font-bold font-mono tracking-tight text-white outline-none border border-dashed border-slate-600 hover:border-slate-400 focus:border-emerald-500 focus:border-solid transition-colors"
                        title="Код тега можно изменить прямо здесь — связи сохранятся"
                      />
                      <Edit2 className="w-3.5 h-3.5 text-slate-500 group-focus-within/rename:text-emerald-400 shrink-0" />
                    </div>
                    <p className="text-2xs text-slate-400 uppercase tracking-wider font-semibold mt-0.5">Код и данные тега редактируются · сохраняются сами</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`flex items-center gap-1 text-xs font-semibold text-emerald-400 transition-opacity duration-300 ${savedFlash ? 'opacity-100' : 'opacity-0'}`}>
                    <Check className="w-3.5 h-3.5" /> Сохранено
                  </span>
                  <button type="button"
                    onClick={() => { setEditingTag(null); loadTags(); }}
                    className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Плотнее, чем было: карточку открывают ради одной правки, а
                  она требовала прокрутки из-за крупных блоков с отступами */}
              <div className="p-4 overflow-y-auto space-y-3 text-left">

                {/* Наименование и актуальность — то, ради чего карточку открыли */}
                <div className="space-y-1 text-left">
                  <div className="flex items-baseline justify-between gap-2">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Наименование</label>
                    {/* Актуальность тега не задаётся отдельно: она складывается
                        из комментариев ниже. Показываем её тем же значком, что
                        и в списке, — иначе человек ищет переключатель, которого
                        нет, и решает, что поле пропало */}
                    {(() => {
                      const look = statusConfig[getTagOverallStatus(editingTag)] || statusConfig.draft;
                      return (
                        <span className={`px-1.5 py-0.5 rounded text-2xs font-semibold border ${look.bg} ${look.text} ${look.border}`}
                          title="Актуальность тега складывается из его комментариев">
                          {look.label}
                        </span>
                      );
                    })()}
                  </div>
                  <input
                    type="text"
                    placeholder="Напр., Приточная вентиляционная установка"
                    value={modalMainName}
                    onChange={(e) => setModalMainName(e.target.value)}
                    onBlur={async () => {
                      if (modalMainName !== (parseTagMetadata(editingTag).mainName || '')) {
                        await handleUpdateMainName(editingTag.id, modalMainName);
                        flashSaved();
                      }
                    }}
                    className={cardField}
                  />
                </div>

                {/* Марка и WBS. Конструктор марки убран: он собирал строку из
                    трёх списков справочника, которого почти нигде нет, и занимал
                    треть карточки, показывая пустоту. Марка сейчас — просто
                    марка, а подсказка берётся из марок этого же проекта */}
                <div className="grid grid-cols-1 @[560px]:grid-cols-2 gap-2.5">
                  <div className="space-y-1 text-left">
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">Марка</label>
                    <input
                      type="text"
                      list="tag-brands"
                      placeholder="Напр. Датчик-К1"
                      value={editTagBrand}
                      onChange={(e) => setEditTagBrand(e.target.value)}
                      onBlur={async () => {
                        if (editTagBrand !== (editingTag.brand || '')) {
                          await handleUpdateBrand(editingTag.id, editTagBrand);
                          flashSaved();
                        }
                      }}
                      className={cardField}
                    />
                    <datalist id="tag-brands">
                      {projectBrands.map((b) => <option key={b} value={b} />)}
                    </datalist>
                  </div>
                  <div className="space-y-1 text-left">
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">WBS</label>
                    <input
                      key={`wbs-${editingTag.id}`}
                      type="text"
                      placeholder="Структура работ, необязательно"
                      defaultValue={editingTag.wbs || ''}
                      onBlur={async (e) => {
                        const v = e.target.value.trim();
                        if (v === (editingTag.wbs || '')) return;
                        try {
                          const res = await fetch(`/api/tags/${editingTag.id}`, {
                            method: 'PUT', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ wbs: v }),
                          });
                          if (!res.ok) throw new Error();
                          setTags(prev => prev.map(t => t.id === editingTag.id ? { ...t, wbs: v } : t));
                          setEditingTag((prev: any) => prev ? { ...prev, wbs: v } : null);
                          flashSaved();
                        } catch { addToast('Не удалось сохранить WBS', 'error'); }
                      }}
                      className={cardField}
                    />
                  </div>
                </div>

                {/* Дополнительные поля — те, что заведены в «Справочнике».
                    Заведённое там появляется здесь само: это и есть обещанная
                    расширяемость, а не отдельная настройка карточки */}
                {(() => {
                  const configDict = dictionaries.find(d => d.name === '__tag_creation_config__');
                  const cats = configDict
                    ? (configDict.items || [])
                        .filter((i: any) => !i.parentId)
                        .sort((a: any, b: any) => a.code.localeCompare(b.code))
                    : [];

                  if (cats.length > 0) {
                    const tagMeta = parseTagMetadata(editingTag);
                    const tagDFields = tagMeta.dynamicFields || {};

                    return (
                      <div className="space-y-2">
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">Дополнительные поля</label>
                        <div className="grid grid-cols-1 @[560px]:grid-cols-2 gap-2.5">
                          {cats.map((cat: any) => {
                            const options = (configDict?.items || [])
                              .filter((i: any) => i.parentId === cat.id)
                              .sort((a: any, b: any) => a.nameRu.localeCompare(b.nameRu));

                            return (
                              <div key={cat.id} className="space-y-1">
                                <span className="text-xs font-bold text-slate-400 dark:text-slate-500">{cat.nameRu}</span>
                                <CustomSelect
                                  value={tagDFields[cat.nameRu] || ''}
                                  onChange={(val) => { handleUpdateDynamicFields(editingTag.id, { [cat.nameRu]: val }); flashSaved(); }}
                                  placeholder="-- Выберите --"
                                  options={options.map((opt: any) => ({
                                    value: opt.nameRu,
                                    label: opt.nameRu
                                  }))}
                                />
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }
                  return null;
                })()}

                <TagComments
                  items={parseTagMetadata(editingTag).descriptions as any}
                  statusConfig={statusConfig as any}
                  statusOptions={actualitySelectOptions}
                  formatDate={formatDateStr}
                  onAdd={async (text, comment, status) => {
                    await handleAddDescription(editingTag.id, text, comment, status as any);
                    flashSaved();
                  }}
                  onUpdate={async (id, patch) => {
                    await handleUpdateDescription(editingTag.id, id, patch as any);
                    flashSaved();
                  }}
                  onRemove={(id) => handleRemoveDescription(editingTag.id, id)}
                />

                {/* Документы ВДР по этому тегу (главный тег строки реестра) */}
                <TagVdrDocs identifier={editingTag.identifier} projectId={activeProject?.id || 'default'} />

              </div>

              <div className="p-3 bg-slate-50 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                <button type="button"
                  onClick={async () => { const id = editingTag.id; setEditingTag(null); await handleDeleteTag(id); }}
                  className="px-3 py-2 rounded-lg text-xs font-semibold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 cursor-pointer flex items-center gap-1.5 transition-colors"
                  title="Удалить тег со всеми связями"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Удалить тег
                </button>
                <div className="flex items-center gap-3">
                  <span className="text-2xs text-slate-400">Изменения сохраняются автоматически</span>
                  <button type="button"
                    onClick={() => { setEditingTag(null); loadTags(); }}
                    className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded-lg text-xs font-semibold cursor-pointer border-none"
                  >
                    Готово
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* CUSTOM MODAL FOR BINDING TAG TO COMPONENT BLOCKS */}
      <AnimatePresence>
        {bindingBlock && (
          <div className="fixed inset-0 bg-slate-950/55 backdrop-blur-md flex items-center justify-center z-[999] p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-850 rounded-xl max-w-lg w-full p-6 shadow-2xl flex flex-col max-h-[90vh] text-left space-y-4"
            >
              <div className="flex items-start justify-between border-b border-slate-100 dark:border-slate-900 pb-3">
                <div>
                  <h3 className="font-extrabold text-base text-slate-900 dark:text-white">
                    Связь тега (BIM/KKS) с блоком
                  </h3>
                  <p className="text-xs text-slate-550 dark:text-slate-400 mt-1 font-mono">
                    Элемент: {bindingBlock.name}
                  </p>
                </div>
                <button type="button"
                  onClick={() => {
                    setBindingBlock(null);
                    setTagSearchText('');
                  }}
                  className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-900 text-slate-400 hover:text-slate-600 dark:hover:text-white transition-ui cursor-pointer border-none bg-transparent"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* SEARCH INPUT */}
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-400 uppercase">Поиск тега в проекте</label>
                <input
                  type="text"
                  placeholder="Введите код или наименование..."
                  value={tagSearchText}
                  onChange={(e) => setTagSearchText(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none text-slate-800 dark:text-slate-100 focus:bg-white dark:focus:bg-slate-950"
                />
              </div>

              {/* ACTIVE BINDINGS */}
              <div className="space-y-1.5">
                <span className="text-xs font-bold text-slate-400 uppercase">Текущие привязки:</span>
                <div className="flex flex-wrap gap-1.5 min-h-[30px] p-2 rounded-lg bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-850">
                  {bindingBlock.tags.length === 0 ? (
                    <span className="text-xs text-slate-400 italic">Нет привязанного оборудования</span>
                  ) : (
                    bindingBlock.tags.map((t: any) => (
                      <span key={t.id} className="inline-flex items-center gap-1.5 text-xs font-semibold bg-emerald-500/10 dark:bg-emerald-500/20 border border-emerald-500/30 text-emerald-800 dark:text-emerald-300 px-2.5 py-1 rounded-md">
                        <span>{t.identifier}</span>
                        <button type="button"
                          onClick={() => handleUnpinTagFromComponent(bindingBlock.id, t.id)}
                          className="hover:text-rose-500 cursor-pointer border-none bg-transparent"
                          title="Удалить привязку"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))
                  )}
                </div>
              </div>

              {/* SEARCH RESULTS & SELECTIONS */}
              <div className="flex-1 overflow-y-auto space-y-1 pr-1 max-h-[250px] min-h-[140px] border border-slate-100 dark:border-slate-850 rounded-lg p-2 bg-slate-50/20">
                {(() => {
                  const filtered = tags.filter(t => 
                    t.identifier.toLowerCase().includes(tagSearchText.toLowerCase()) ||
                    (parseTagMetadata(t).mainName || '').toLowerCase().includes(tagSearchText.toLowerCase())
                  );
                  if (filtered.length === 0) {
                    return (
                      <div className="py-8 text-center text-slate-400 text-xs italic">
                        Подходящих тегов не зарегистрировано
                      </div>
                    );
                  }
                  return filtered.map((t) => {
                    const isAlreadyBound = bindingBlock.tags.some((activeT: any) => activeT.id === t.id);
                    return (
                      <div key={t.id} className="flex items-center justify-between p-2 rounded hover:bg-slate-50 dark:hover:bg-slate-900 border border-transparent hover:border-slate-150 dark:hover:border-slate-850 select-none transition-ui">
                        <div className="text-left max-w-[70%]">
                          <p className="font-mono text-xs font-bold text-slate-905 dark:text-slate-100">{t.identifier}</p>
                          <p className="text-xs text-slate-400 truncate">{parseTagMetadata(t).mainName || 'Без названия'}</p>
                        </div>
                        {isAlreadyBound ? (
                          <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200/50 px-2.5 py-1 rounded">
                            Активен
                          </span>
                        ) : (
                          <button type="button"
                            onClick={() => handlePinTagToComponent(bindingBlock.id, t.id)}
                            className="px-2.5 py-1 bg-emerald-700 hover:bg-emerald-600 text-white rounded text-xs font-bold cursor-pointer border-none"
                          >
                            Привязать
                          </button>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>

              {/* MODAL FOOTER ACTION CONTROLS */}
              <div className="pt-2 border-t border-slate-100 dark:border-slate-900 flex justify-between items-center bg-slate-50/50 dark:bg-slate-900/30 -mx-6 -mb-6 p-4 rounded-b-xl">
                <button
                  type="button"
                  onClick={() => handleCreateAndPinTag(bindingBlock.id)}
                  className="px-3 py-1.5 bg-slate-150 hover:bg-emerald-50 dark:bg-slate-900 dark:hover:bg-emerald-950/30 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:text-emerald-700 rounded text-xs font-bold transition-ui cursor-pointer flex items-center gap-1"
                >
                  <Plus className="w-4 h-4 text-emerald-500" />
                  <span>Создать новый тег</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBindingBlock(null);
                    setTagSearchText('');
                  }}
                  className="px-4 py-1.5 bg-slate-800 hover:bg-slate-705 text-white rounded text-xs font-bold cursor-pointer border-none"
                >
                  Готово
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {exchangeOpen && (
        <ExchangeDialog
          section="Теги"
          scopes={[
            { id: 'all', label: 'Все', count: tags.length },
            { id: 'filtered', label: 'Отобранные', count: matchedTagsList.length },
            { id: 'selected', label: 'Отмеченные', count: selectedTagIds.size },
          ]}
          columns={EXCHANGE_COLUMNS}
          defaultColumns={['identifier', 'brand', 'department', 'wbs', 'fluid']}
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
      <div key={node.id} className="space-y-1">
        <div
          id={`tree-node-${node.id}`}
          draggable={treeLinkMode === 'drag'}
          onDragStart={(e) => {
            if (treeLinkMode !== 'drag') return;
            treeDraggedIdRef.current = node.id;
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', node.id); } catch (_) {}
          }}
          onDragOver={(e) => {
            if (treeLinkMode !== 'drag') return;
            const from = treeDraggedIdRef.current;
            if (from && from !== node.id) { e.preventDefault(); if (treeDragOverId !== node.id) setTreeDragOverId(node.id); }
          }}
          onDragLeave={() => { if (treeDragOverId === node.id) setTreeDragOverId(null); }}
          onDrop={async (e) => {
            if (treeLinkMode !== 'drag') return;
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
          className={`flex items-center justify-between p-3 rounded-xl border transition-colors ${treeLinkMode === 'drag' ? 'cursor-move' : ''} ${
            treeLinkingFrom === node.id
              ? 'border-sky-400 dark:border-sky-600 bg-sky-50 dark:bg-sky-950/30 ring-2 ring-sky-400'
              : treeDragOverId === node.id
                ? 'border-emerald-400 dark:border-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 ring-2 ring-emerald-400'
                : treeLinkingFrom
                  ? 'border-sky-200/60 dark:border-sky-900/40 hover:ring-2 hover:ring-sky-300 cursor-pointer'
                  : selectedTagIds.has(node.id)
                    ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 ring-1 ring-emerald-300 dark:ring-emerald-800'
                    : duplicateCodes.has((node.identifier || '').trim())
                      ? 'border-rose-300 dark:border-rose-700/60 bg-rose-50/50 dark:bg-rose-950/20 hover:bg-rose-50 dark:hover:bg-rose-950/30'
                      : 'border-slate-100 dark:border-slate-850 hover:bg-slate-50 dark:hover:bg-slate-900/60'
          }`}
          style={{ marginLeft: `${level * 24}px` }}
        >
          <div className="flex items-center gap-2.5 min-w-0 flex-1 text-left">
            <button type="button"
              onClick={() => toggleTagExpand(node.id)}
              className={`p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-ui shrink-0 ${!hasChildren ? 'opacity-20 cursor-default' : ''}`}
              disabled={!hasChildren}
            >
              {isExpanded ? <ChevronDown className="w-4 h-4 text-slate-600 dark:text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-600 dark:text-slate-400" />}
            </button>

            <Database className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            
            <div className="min-w-0 flex flex-col @[720px]:flex-row @[720px]:items-center gap-1 @[720px]:gap-2.5">
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-slate-800 dark:text-slate-100 text-sm select-all">{node.identifier}</span>
                {duplicateCodes.has((node.identifier || '').trim()) && (
                  <span className="text-2xs font-bold px-1.5 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60 uppercase tracking-wide shrink-0" title="Дубликат кода тега">дубль</span>
                )}
                <span className="text-xs bg-slate-100 dark:bg-slate-900 text-slate-500 dark:text-slate-400 px-1.5 py-0.5 rounded-full border border-slate-200/60 dark:border-slate-800 font-semibold shrink-0">
                  {node.department || 'Комплексный'}
                </span>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-[280px]" title={node.meta.mainName || 'Наименование отсутствует'}>
                {node.meta.mainName ? `— ${node.meta.mainName}` : <span className="italic opacity-60">— (Наименование отсутствует)</span>}
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
                    isTreeDescVisible ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30 font-bold' : 'text-slate-400'
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
                  {configList.length > 3 && <span className="text-xs font-bold text-slate-400">+{configList.length - 3}</span>}
                </div>
              </div>
            )}

            <div className="flex bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg p-0.5 border border-slate-200 dark:border-slate-800">
              {treeLinkMode === 'click' && (
                <button type="button"
                  onClick={(e) => { e.stopPropagation(); setTreeLinkingFrom(prev => prev === node.id ? null : node.id); }}
                  title={treeLinkingFrom === node.id ? 'Отменить связывание' : 'Связать: затем кликните дочернюю строку'}
                  className={`p-1 rounded transition-colors cursor-pointer ${treeLinkingFrom === node.id ? 'bg-sky-500 text-white' : 'hover:text-sky-600 text-slate-500'}`}
                >
                  <Link2 className="w-3.5 h-3.5" />
                </button>
              )}
              <button type="button"
                onClick={() => setEditingTag(node)}
                title="Редактировать описания и комментарии тега"
                className="p-1 hover:text-emerald-600 dark:hover:text-emerald-400 rounded text-slate-500 transition-colors cursor-pointer"
              >
                <Edit2 className="w-3.5 h-3.5" />
              </button>
              <button type="button"
                onClick={() => handleDeleteTag(node.id)}
                title="Удалить тег"
                className="p-1 hover:text-rose-500 rounded text-slate-550 transition-colors cursor-pointer"
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
                <div key={desc.id} className="p-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-850 rounded-lg flex items-start gap-2 max-w-2xl">
                  <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${s.text}`} />
                  <div>
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-100">{desc.text}</span>
                    <span className={`inline-block px-1.5 py-0.2 rounded text-xs font-semibold ml-2 ${s.bg} ${s.text} ${s.border}`}>
                      {s.label}
                    </span>
                    {desc.comment && (
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 italic pl-1.5 border-l border-slate-200 dark:border-slate-800 leading-normal">
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

// ── Документы ВДР по тегу: тег — главный у строки реестра ──
// Показывается в карточке тега; клик — переход к строке в Менеджмент → ВДР.
function TagVdrDocs({ identifier, projectId }: { identifier: string; projectId: string }) {
  const [docs, setDocs] = React.useState<any[] | null>(null);
  const navigate = useNavigate();

  React.useEffect(() => {
    let dead = false;
    fetch(`/api/vdr/items/by-tag?projectId=${projectId}&tag=${encodeURIComponent(identifier)}`)
      .then(r => r.ok ? r.json() : { items: [] })
      .then(d => { if (!dead) setDocs((d.items || []).filter((x: any) => !x.titleEn?.includes('Vendor Document Register'))); })
      .catch(() => { if (!dead) setDocs([]); });
    return () => { dead = true; };
  }, [identifier, projectId]);

  if (!docs || docs.length === 0) return null;
  const stCls: Record<string, string> = {
    DRAFT: 'text-slate-500', READY: 'text-emerald-600', REMARKS: 'text-amber-600', ACCEPTED: 'text-sky-600',
  };
  const stLabel: Record<string, string> = { DRAFT: 'в работе', READY: 'готово', REMARKS: 'замечания', ACCEPTED: 'принят' };
  return (
    <div className="px-4 pb-3">
      <div className="text-2xs font-bold uppercase tracking-wide text-emerald-500 mb-1.5">Документы (ВДР) — {docs.length}</div>
      <div className="border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-850 max-h-40 overflow-auto">
        {docs.map((d: any) => (
          <button type="button" key={d.id}
            onClick={() => navigate(`/management?vdr=${d.registerId}&item=${d.id}`)}
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs hover:bg-emerald-50 dark:hover:bg-emerald-950/30 cursor-pointer">
            <span className="font-semibold text-slate-700 dark:text-slate-300 truncate flex-1" title={`${d.contractorNo}\n${d.titleRu || d.titleEn}`}>
              {d.contractorNo || d.titleRu || d.titleEn}
            </span>
            <span className="text-emerald-500 font-bold shrink-0">{d.vdrCode}</span>
            <span className="text-slate-400 shrink-0">рев. {d.revision}</span>
            <span className={`font-bold shrink-0 ${stCls[d.status] || ''}`}>{stLabel[d.status] || d.status}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
