import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useStore } from '../store/store';
import { useToastStore } from '../store/toastStore';
import VdrItemPicker from '../components/VdrItemPicker';
import { officePathForKind, isOffice, legacyAdvice, appsFor } from '../lib/fileTypes';
import ExplorerMenu from '../components/explorer/ExplorerMenu';
import { ExplorerTabs, ExplorerStatus, buildStatus, useExplorerTabs } from '../components/explorer/ExplorerTabs';
import { ROOT_NAME } from '../lib/explorerTabs';
import { useInsightStore } from '../store/insightStore';
import { useModalStore } from '../store/modalStore';
import {
  Folder, File as FileIcon, ChevronRight, ChevronDown, Plus, Upload,
  Search, MoreVertical, Copy, Edit2, Trash2, FolderPlus,
  ArrowLeft, ArrowRight, ArrowUp, Tag, PanelRight, LayoutGrid, List,
  Download, Info, Boxes, Clock, X,
} from 'lucide-react';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import EquipmentImportPreview from '../components/EquipmentImportPreview';
import { countOf } from '../lib/plural';
import { openInProject, useProjectNames } from '../lib/projectScope';
import { useWindowTitle } from '../lib/paneTitle';
import FilePreview from '../components/explorer/FilePreview';
import { uploadDropped } from '../lib/dropUpload';
import { heavyOnes, MB } from '../lib/dropFiles';
import { saveFileNode, openInWindowsSaid } from '../lib/saveToWindows';
import {
  SEC_SHARED, SEC_DISK, TRASH_ID, SMART_RECENT, SMART_UNTAGGED, SMART_DUPES,
  isSmartId, personalSecId, isSectionId, parseSection,
} from '../lib/explorerSections';
import {
  getFileIcon, formatSize, FILE_STATUSES, STATUS_ORDER, statusOf, StatusChip,
  FileRowItem, FileCardItem,
} from '../components/explorer/FileItems';
import FileProperties from '../components/explorer/FileProperties';


// data:...;base64,<...> → текст в UTF-8 (atob даёт latin1, поэтому через TextDecoder)
const decodeTextContent = (dataUri: string): string => {
  try {
    const comma = dataUri.indexOf(',');
    const meta = dataUri.slice(0, comma);
    const body = dataUri.slice(comma + 1);
    if (/;base64/i.test(meta)) {
      const bin = atob(body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    }
    return decodeURIComponent(body);
  } catch (_) {
    return dataUri;
  }
};

export default function Explorer() {
  const { 
    activeProject, 
    explorerHistory, 
    explorerForward, 
    pushHistory, 
    goBack, 
    goForward,
    user
  } = useStore();
  
  const { addToast } = useToastStore();
  const { openPrompt, openConfirm, openSelect } = useModalStore();
  const navigate = useNavigate();
  const routeLoc = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentFolderId = explorerHistory[explorerHistory.length - 1];

  const [folders, setFolders] = useState<any[]>([]);
  /**
   * Проект, который на самом деле есть общий диск.
   *
   * Диск устроен служебным проектом (server/systemFolders.ts): у папки проект
   * обязателен, и завести «папку вне проектов» без правки схемы, которую
   * автомиграция общей базы не умеет, нельзя. Окну достаточно знать его
   * идентификатор — по нему оно отличает третий корень от папок проекта.
   */
  const [diskProjectId, setDiskProjectId] = useState('');
  /**
   * Настоящая корневая папка диска.
   *
   * «Общий диск» в дереве — раздел, но его содержимое лежит в обычной папке, и
   * это не украшение: у файла своего проекта в базе нет, он наследует его от
   * папки. Файл без папки не принадлежит никакому проекту — а значит, и
   * никакому диску. Корневая папка снимает этот угол: на диске всё лежит
   * внутри неё, и перенос, корзина, права и дерево работают как обычно.
   */
  const [diskRootId, setDiskRootId] = useState('');
  const [rootFiles, setRootFiles] = useState<any[]>([]);
  const [projectTags, setProjectTags] = useState<any[]>([]);
  // Главный Администратор видит личные разделы всех пользователей
  const [isMainAdmin, setIsMainAdmin] = useState(false);
  const [owners, setOwners] = useState<Array<{ id: string; name: string; symbol: string }>>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' }>({ key: 'name', direction: 'asc' });
  const [tagSortConfig, setTagSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' }>({ key: 'createdAt', direction: 'desc' });
  const [isLoading, setIsLoading] = useState(false);
  
  // Selection & Renaming
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Панель свойств открыта по умолчанию: клик по файлу должен сразу
  // показывать, что это за файл. Выбор запоминается.
  // Фильтр по статусу документа: в архиве постоянно нужно «покажи только
  // черновики» или «что уже выдано».
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  // Ширины колонок таблицы: тянутся за границу заголовка и запоминаются.
  // В архиве у одних длинные имена файлов, у других — длинные названия
  // отделов; одна раскладка на всех не подходит.
  const COL_KEYS = ['name', 'updatedAt', 'statusCode', 'size', 'tags', 'department'] as const;
  const DEFAULT_COL_W: Record<string, number> = { name: 320, updatedAt: 150, statusCode: 120, size: 90, tags: 130, department: 120 };
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('flux_explorer_cols') || '{}');
      return { ...DEFAULT_COL_W, ...saved };
    } catch (_) { return { ...DEFAULT_COL_W }; }
  });
  const resizeRef = useRef<{ key: string; startX: number; startW: number } | null>(null);

  const startColResize = (key: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { key, startX: e.clientX, startW: colWidths[key] || DEFAULT_COL_W[key] || 120 };
    const onMove = (ev: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const next = Math.max(60, r.startW + (ev.clientX - r.startX));
      setColWidths((prev) => ({ ...prev, [r.key]: next }));
    };
    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setColWidths((prev) => {
        try { localStorage.setItem('flux_explorer_cols', JSON.stringify(prev)); } catch (_) {}
        return prev;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const colStyle = (key: string) => ({ width: colWidths[key] || DEFAULT_COL_W[key], minWidth: 60 });
  const [showPreviewPane, setShowPreviewPaneState] = useState<boolean>(() => {
    try { return localStorage.getItem('flux_explorer_details') !== '0'; } catch (_) { return true; }
  });
  const setShowPreviewPane = (v: boolean) => {
    try { localStorage.setItem('flux_explorer_details', v ? '1' : '0'); } catch (_) {}
    setShowPreviewPaneState(v);
  };

  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');


  // Context Menu
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, targetId?: string, isFile?: boolean, isContainer?: boolean, isSection?: boolean } | null>(null);
  // «Прикрепить к строке ВДР»: файл (замечания/выпуск) привязывается к документу реестра
  const [vdrAttachFileId, setVdrAttachFileId] = useState<string | null>(null);

  // Clipboard (for Copy/Paste within app)
  const [clipboard, setClipboard] = useState<{ ids: string[], type: 'copy' | 'cut' } | null>(null);

  const [uploadProgress, setUploadProgress] = useState<{current: number, total: number} | null>(null);
  const [trash, setTrash] = useState<{ folders: any[]; files: any[] } | null>(null);
  const [trashLoading, setTrashLoading] = useState(false);

  const loadTrash = React.useCallback(async () => {
    setTrashLoading(true);
    try {
      const r = await fetch(`/api/projects/${activeProject?.id || 'default'}/trash`);
      const d = r.ok ? await r.json() : { folders: [], files: [] };
      setTrash({ folders: d.folders || [], files: d.files || [] });
    } catch (_) {
      setTrash({ folders: [], files: [] });
    } finally {
      setTrashLoading(false);
    }
  }, [activeProject?.id]);

  const restoreItem = async (kind: 'file' | 'folder', id: string, name: string) => {
    try {
      const r = await fetch(`/api/${kind === 'file' ? 'files' : 'folders'}/${id}/restore`, { method: 'POST' });
      if (!r.ok) throw new Error('Сервер отказал в восстановлении');
      addToast(`«${name}» возвращён${kind === 'folder' ? 'а' : ''} на место`, 'success');
      await Promise.all([loadTrash(), fetchData()]);
    } catch (e: any) {
      addToast(e.message || 'Не удалось восстановить', 'error');
    }
  };

  const purgeTrash = async () => {
    const total = (trash?.files.length || 0) + (trash?.folders.length || 0);
    if (!total) return;
    const okToPurge = await openConfirm('Очистить корзину?',
      `Будет безвозвратно удалено: ${countOf(total, 'элемент')}. Вернуть их будет нельзя.`,
      { confirmLabel: 'Очистить корзину', tone: 'danger' });
    if (!okToPurge) return;
    try {
      const r = await fetch(`/api/projects/${activeProject?.id || 'default'}/trash`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Сервер отказал в очистке');
      addToast('Корзина очищена', 'success');
      await loadTrash();
    } catch (e: any) {
      addToast(e.message || 'Не удалось очистить корзину', 'error');
    }
  };
  
  const [propertiesModal, setPropertiesModal] = useState<{item: any, isFile: boolean} | null>(null);
  
  const [assignTagModal, setAssignTagModal] = useState<{ fileId: string, mainTags: string[], additionalTags: string[] } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mainPaneRef = useRef<HTMLDivElement>(null);

  // Synchronizing state references for memory-safe and efficient hotkey event listener
  const selectedIdsRef = useRef(selectedIds);
  const lastSelectedIdRef = useRef(lastSelectedId);
  const clipboardRef = useRef(clipboard);
  const allCurrentItemsRef = useRef<any[]>([]);
  const currentFolderIdRef = useRef(currentFolderId);
  const foldersRef = useRef(folders);
  
  const handleDeleteRef = useRef<any>(null);
  const handlePasteRef = useRef<any>(null);
  const navigateToRef = useRef<any>(null);
  const filesRef = useRef<any[]>([]);

  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { lastSelectedIdRef.current = lastSelectedId; }, [lastSelectedId]);
  useEffect(() => { clipboardRef.current = clipboard; }, [clipboard]);
  useEffect(() => { currentFolderIdRef.current = currentFolderId; }, [currentFolderId]);
  useEffect(() => { foldersRef.current = folders; }, [folders]);
  const sectionsRef = useRef<any[]>([]);
  // navigateTo объявлен раньше вкладок и потому зовёт их через ссылку
  const tabsRef = useRef<any>(null);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      // Проводник — общий раздел: файлы видны все, из любого проекта. Раньше
      // папки чужих проектов просто исчезали при переключении, и найти по
      // названию документ, который «точно где-то был», было невозможно.
      // Папка чужого проекта видна, но войти в неё без переключения нельзя —
      // см. src/lib/projectScope.ts.
      const projectId = activeProject?.id || 'default';
      const [fRes, tRes] = await Promise.all([
        fetch(`/api/projects/default/folders?actorId=${encodeURIComponent(user?.id || '')}`),
        fetch(`/api/projects/${projectId}/tags`)
      ]);
      const fData = await fRes.json();
      const tData = await tRes.json();
      setFolders(fData.folders || []);
      setRootFiles(fData.rootFiles || []);
      setIsMainAdmin(!!fData.isMainAdmin);
      setDiskProjectId(String(fData.diskProjectId || ''));
      setDiskRootId(String(fData.diskFolderId || ''));
      setOwners(fData.owners || []);
      setProjectTags(tData.tags || []);
    } catch (err) {
      console.error("Failed to fetch explorer data:", err);
      setFolders([]);
      setRootFiles([]);
      setProjectTags([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Какие файлы ждут выбора категории для импорта в «Оборудование» (мультивыбор)
  const [importPickerFiles, setImportPickerFiles] = useState<string[] | null>(null);
  const [importPreview, setImportPreview] = useState<{ fileIds: string[]; category: string } | null>(null);
  // Карта загруженных в оборудование файлов: имя файла -> { category, version }
  const [loadedMap, setLoadedMap] = useState<Record<string, { category: string; version: number }>>({});

  const loadEquipMap = useCallback(async () => {
    const projectId = activeProject?.id;
    if (!projectId) { setLoadedMap({}); return; }
    try {
      const r = await fetch(`/api/projects/${projectId}/systems`);
      const d = await r.json();
      const map: Record<string, { category: string; version: number }> = {};
      for (const s of (d.systems || [])) {
        if (!s.fileName) continue;
        let v = 1;
        for (const mb of (s.monoblocks || [])) for (const c of (mb.components || [])) v = Math.max(v, c.version || 1);
        const prev = map[s.fileName];
        map[s.fileName] = { category: s.category, version: Math.max(prev?.version || 1, v) };
      }
      setLoadedMap(map);
    } catch (_) { setLoadedMap({}); }
  }, [activeProject?.id]); // по идентификатору, а не по объекту: иначе перезапрос при каждой смене ссылки

  useEffect(() => { loadEquipMap(); }, [loadEquipMap]);

  // Импорт: категория выбрана → открываем предпросмотр (dry-run) вместо прямой записи
  const importFilesToCategory = (fileIds: string[], category: string) => {
    setImportPickerFiles(null);
    if (!fileIds.length) return;
    setImportPreview({ fileIds, category });
  };

  // Категории оборудования для подменю импорта (с учётом добавленных в настройках)
  const [equipCats, setEquipCats] = useState<{ id: string; label: string }[]>([
    { id: 'AHU', label: 'Центральные кондиционеры' },
    { id: 'FAN', label: 'Радиальные вентиляторы' },
    { id: 'VALVE', label: 'Воздушные клапаны' },
    { id: 'CURTAIN', label: 'Воздушные завесы' },
  ]);
  useEffect(() => {
    fetch('/api/equipment/categories').then(r => r.json()).then(d => { if (Array.isArray(d.categories) && d.categories.length) setEquipCats(d.categories); }).catch(() => {});
  }, []);

  const catLabel = useCallback((id: string) => equipCats.find(c => c.id === id)?.label || id, [equipCats]);

  // Открыть выбор категории для импорта в «Оборудование» по выделенным файлам
  const openImportPicker = (fallbackId?: string) => {
    const fileIds = Array.from(selectedIds).filter(id => {
      const it = allCurrentItemsRef.current.find(i => i.id === id);
      return it && !it.isFolder;
    });
    if (fileIds.length === 0 && fallbackId) fileIds.push(fallbackId);
    if (fileIds.length === 0) { addToast('Выберите хотя бы один файл.', 'error'); return; }
    setImportPickerFiles(fileIds);
  };

  useEffect(() => {
    fetchData();
  }, [activeProject?.id]); // по идентификатору, а не по объекту: иначе перезапрос при каждой смене ссылки

  /**
   * /explorer?file=<идентификатор> — открыть папку с этим файлом, выделить его
   * и показать предпросмотр. Так сюда ведут упоминания из письма: в письме
   * есть имя документа, а куда он положен — знает только программа.
   *
   * Ждём загрузки списка: до неё файл искать негде.
   */
  const deepFileRef = useRef('');
  useEffect(() => {
    // Именно useLocation, а не window.location: адрес живёт в решётке, и у
    // window.location строка запроса всегда пустая.
    const want = new URLSearchParams(routeLoc.search).get('file');
    if (!want || deepFileRef.current === want) return;
    if (isLoading || (!folders.length && !rootFiles.length)) return;
    deepFileRef.current = want;

    const inFolder = folders.find((f: any) => (f.files || []).some((x: any) => x.id === want));
    const root = rootFiles.find((f: any) => f.id === want);
    const file = inFolder ? (inFolder.files || []).find((x: any) => x.id === want) : root;
    navigate('/explorer', { replace: true });

    if (!file) { addToast('Документ не найден — возможно, его удалили.', 'error'); return; }
    pushHistory(inFolder ? inFolder.id : itemSection(file));
    setSelectedIds(new Set([want]));
    setLastSelectedId(want);
    setShowPreviewPane(true);
  }, [isLoading, folders, rootFiles, routeLoc.search]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Меню закрывается кликом мимо и клавишей Esc — иначе оно оставалось
    // висеть поверх содержимого, в том числе после перехода в другую папку.
    const handleGlobalClick = () => setContextMenu(null);
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
    window.addEventListener('click', handleGlobalClick);
    window.addEventListener('keydown', handleEsc);
    return () => {
      window.removeEventListener('click', handleGlobalClick);
      window.removeEventListener('keydown', handleEsc);
    };
  }, []);

  /** Имя папки для вкладки: корень — «Проводник», раздел — его имя */
  const folderTitle = (id: string | null): string => {
    if (!id) return ROOT_NAME;
    if (id === TRASH_ID) return 'Корзина';
    const f = foldersRef.current.find((x: any) => x.id === id);
    if (f?.name) return f.name;
    return sectionsRef.current.find((x: any) => x.id === id)?.name || ROOT_NAME;
  };

  const navigateTo = (folderIdRaw: string | null) => {
    // Корень диска — папка, но человек его знает как раздел: показываем раздел,
    // иначе в пути вылезала бы служебная папка с тем же именем
    const folderId = folderIdRaw && folderIdRaw === diskRootId ? SEC_DISK : folderIdRaw;
    // Папка чужого проекта видна в списке, но открывается только вместе с
    // переключением: внутри неё лежат файлы, размеченные тегами того проекта,
    // и без переключения теги в предпросмотре оказались бы чужими.
    const target = folderId && !isSectionId(folderId) && !isSmartId(folderId) && folderId !== TRASH_ID
      ? folders.find((f: any) => f.id === folderId)
      : null;
    // Диск от проекта не зависит — переключать ради него нечего
    if (target?.projectId && target.projectId !== diskProjectId && target.projectId !== activeProject?.id) {
      openInProject({
        what: `Папка «${target.name}»`,
        projectId: target.projectId,
        open: () => navigateToRef.current(folderId),
      });
      return;
    }
    setContextMenu(null);
    if (folderId === TRASH_ID) loadTrash();
    pushHistory(folderId);
    setSearchQuery('');
    setSelectedIds(new Set());
    // Показанная вкладка переехала вместе с нами: иначе, вернувшись на неё,
    // человек попадал бы не туда, где был
    tabsRef.current?.follow(folderId);
  };

  /**
   * Вкладки Проводника: раньше «две папки рядом» означало два окна, и для
   * простого сравнения списков приходилось разводить их по экрану. Поведение
   * целиком живёт в components/explorer/ExplorerTabs.
   */
  const tabs = useExplorerTabs({ currentFolderId, navigateTo, titleOf: folderTitle });
  tabsRef.current = tabs;

  // ── Переход по ссылке: /explorer?file=…&folder=… ──
  // Сюда ведут панель связей, общий поиск и рабочий стол. Для ФАЙЛА папка в
  // ссылке обязательна: Проводник держит только текущую папку и по одному имени
  // файла не знал бы, куда идти. Папка без файла — тоже осмысленная ссылка (так
  // открывают папку со стола); раньше она молча не делала ничего.
  useEffect(() => {
    const fileId = searchParams.get('file');
    const folderId = searchParams.get('folder');
    if (!fileId && !folderId) return;
    if (folderId && folderId !== currentFolderIdRef.current) navigateTo(folderId);
    // Выделение ставим после перехода: список папки перерисовывается, и
    // выделение, поставленное раньше, тут же затирается
    if (fileId) setTimeout(() => setSelectedIds(new Set([fileId])), 250);
    const next = new URLSearchParams(searchParams);
    next.delete('file'); next.delete('folder');
    setSearchParams(next, { replace: true });
  }, [searchParams]);

  /* ── Чей это файл ────────────────────────────────────────────────────────
     Проводник общий, а папки — проектные. У файла своего проекта нет: он
     наследует проект папки, в которой лежит. Файл в корне раздела не привязан
     ни к какому проекту и открыт всем. */
  const folderProject = useMemo(
    () => new Map<string, string | null>(folders.map((f: any) => [f.id, f.projectId || null])),
    [folders],
  );
  const projectOf = useCallback((item: any): string | null => {
    if (!item || item.isSection) return null;
    // По наличию `projectId`, а не по флажку `isFolder`: флажок ставит список,
    // а дерево отдаёт папки как есть — и папка в дереве считалась файлом без
    // проекта. Из-за этого корень диска показывался внутри «Общего».
    if (item.projectId) return String(item.projectId);
    return item.folderId ? (folderProject.get(item.folderId) ?? null) : null;
  }, [folderProject]);

  // Раздел (диск/общий/личный), которому принадлежит папка или файл
  const itemSection = useCallback((item: any): string => {
    // Всё, что лежит в служебном проекте, — это общий диск, каким бы ни был
    // проект на экране. Иначе содержимое диска пропадало бы при смене проекта —
    // а он затем и заведён, чтобы от проекта не зависеть
    if (diskProjectId && projectOf(item) === diskProjectId) return SEC_DISK;
    return item?.scope === 'PERSONAL' && item?.ownerId ? personalSecId(item.ownerId) : SEC_SHARED;
  }, [diskProjectId, projectOf]);
  const projectOfRef = useRef(projectOf);
  projectOfRef.current = projectOf;
  const nameOfProject = useProjectNames();

  /** Подпись «из проекта такого-то» — только для чужого; для своего пусто. */
  const foreignOf = useCallback((item: any): string => {
    const owner = projectOf(item);
    // Диск не «чужой проект», а место хранения: подпись про проект здесь врёт
    if (!owner || owner === activeProject?.id || owner === diskProjectId) return '';
    return nameOfProject(owner);
  }, [projectOf, activeProject?.id, diskProjectId, nameOfProject]);

  // Список корневых разделов: «Общий диск», «Общий», «Личный»
  // (+ личные всех пользователей у ГлавАдмина)
  const sections = useMemo(() => {
    const list: Array<{ id: string; name: string; ownerId: string | null; isFolder: boolean; isSection: boolean }> = [
      // Диск первым: он от проекта не зависит, и человек, ищущий норматив или
      // шаблон бланка, не должен сначала вспоминать, в каком он проекте
      { id: SEC_DISK, name: 'Общий диск', ownerId: null, isFolder: true, isSection: true },
      { id: SEC_SHARED, name: 'Общий', ownerId: null, isFolder: true, isSection: true },
      { id: personalSecId(user?.id || ''), name: 'Личный', ownerId: user?.id || null, isFolder: true, isSection: true },
    ];
    if (isMainAdmin) {
      for (const o of owners) {
        if (o.id !== user?.id) {
          list.push({ id: personalSecId(o.id), name: `Личная: ${o.name}`, ownerId: o.id, isFolder: true, isSection: true });
        }
      }
    }
    return list;
  }, [user?.id, isMainAdmin, owners]);

  useEffect(() => { sectionsRef.current = sections; }, [sections]);

  const sectionName = useCallback((secId: string): string => {
    return sections.find(s => s.id === secId)?.name
      || (secId === SEC_DISK ? 'Общий диск' : secId === SEC_SHARED ? 'Общий' : 'Личный');
  }, [sections]);

  // Раздел, в котором пользователь находится сейчас (null — на списке разделов)
  const currentSectionId = useMemo(() => {
    if (!currentFolderId) return null;
    if (isSectionId(currentFolderId)) return currentFolderId;
    const folder = folders.find(f => f.id === currentFolderId);
    return folder ? itemSection(folder) : null;
  }, [currentFolderId, folders, itemSection]);

  // Имя окна — имя открытой папки: два окна Проводника иначе неразличимы
  useWindowTitle(folders.find(f => f.id === currentFolderId)?.name || '');

  /**
   * Настоящая папка для места, куда кладут. Для диска это его корневая папка,
   * для остальных разделов — сам раздел (у них корневые файлы без папки).
   */
  const asFolderId = useCallback((id: string | null): string | null => {
    if (id === SEC_DISK) return diskRootId || null;
    // Остальные разделы настоящей папкой не являются: их корневые файлы лежат
    // без папки. Вернуть здесь «sec:shared» значило бы записать в parentId
    // строку, которой в базе нет
    return isSectionId(id || '') ? null : id;
  }, [diskRootId]);

  const handleNavigateUp = () => {
    if (!currentFolderId) return;
    if (isSectionId(currentFolderId)) {
      navigateTo(null);
      return;
    }
    const folder = folders.find(f => f.id === currentFolderId);
    if (folder?.parentId) navigateTo(folder.parentId);
    else navigateTo(folder ? itemSection(folder) : null);
  };

  const createFolder = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!currentFolderId) {
      addToast('Откройте раздел «Общий» или «Личный», чтобы создать папку.', 'error');
      return;
    }
    const name = await openPrompt("Новая папка", "Имя папки:") || "Новая папка";
    if (!name.trim()) return;
    const realParentId = asFolderId(currentFolderId);
    const inSectionRoot = realParentId === null && isSectionId(currentFolderId);
    const sec = inSectionRoot ? parseSection(currentFolderId) : null;
    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        // Папка наследует проект родителя: на диске это служебный проект, и
        // отдавать сюда проект с экрана нельзя — папка ушла бы из диска
        projectId: (realParentId && folders.find((f: any) => f.id === realParentId)?.projectId)
          || activeProject?.id || 'default',
        parentId: realParentId,
        ...(sec ? { scope: sec.scope, ownerId: sec.ownerId || user?.id } : {})
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.folder) {
      addToast(`Не удалось создать папку: ${data?.error || res.status}`, 'error');
      return;
    }
    await fetchData();
    setRenamingId(data.folder.id);
    setRenameValue(name);
  };

  const triggerIPCExcelParse = async (file: File) => {
    const reader = new FileReader();
    const base64Promise = new Promise<string>((resolve, reject) => {
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1] || result;
        resolve(base64);
      };
      reader.onerror = (e) => reject(e);
      reader.readAsDataURL(file);
    });
    
    const fileContent = await base64Promise;
    
    const win = window as any;
    if (win.electron && win.electron.ipcRenderer) {
      try {
        return await win.electron.ipcRenderer.invoke('excel:parse-and-import', {
          projectId: activeProject?.id || 'default',
          fileName: file.name,
          fileContent
        });
      } catch (err) {
        console.warn("Electron IPC excel:parse-and-import failed, using API:", err);
      }
    }

    const response = await fetch(`/api/projects/${activeProject?.id || 'default'}/excel/parse-and-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileContent, fileName: file.name })
    });

    if (!response.ok) {
      const errText = await response.text();
      let parsedErr = { error: 'Unknown parse error' };
      try { parsedErr = JSON.parse(errText); } catch(e) {}
      throw new Error(parsedErr.error || "Error parsing file template");
    }

    return await response.json();
  };

  const uploadFiles = async (files: FileList | File[], targetFolderId: string | null = currentFolderId) => {
    if (!targetFolderId) {
      addToast('Откройте раздел «Общий» или «Личный», чтобы загрузить файлы.', 'error');
      return;
    }
    // У диска корень настоящий — файл ложится в него, а не «без папки»
    const realFolderId = asFolderId(targetFolderId);
    const inSectionRoot = realFolderId === null && isSectionId(targetFolderId);
    const sec = inSectionRoot ? parseSection(targetFolderId) : null;

    // Предела на размер нет, но полгигабайта лягут в общую базу и в резервную
    // копию: спрашиваем один раз, а не отказываем
    const heavy = heavyOnes(Array.from(files));
    if (heavy.length && !await openConfirm(
      'Файл очень большой',
      `${heavy.map((f) => f.name).join(', ')} — это ${MB(heavy.reduce((n, f) => n + f.size, 0))}. `
      + 'Он ляжет в общую базу и попадёт в резервную копию, а перенос займёт время. Продолжить?',
      { confirmLabel: 'Загрузить' },
    )) return;

    // Имена, уже занятые в целевой папке: по ним считается «Смета (2).xlsx»
    const existingNames = (realFolderId === null
      ? rootFiles.filter((f: any) => itemSection(f) === targetFolderId)
      : (folders.find((f: any) => f.id === realFolderId)?.files || [])
    ).map((f: any) => String(f.name));

    // Приём — общий со столом (src/lib/dropUpload.ts). Пока он был записан
    // здесь, стол не принимал файлы вовсе: одно движение мышью давало разный
    // результат в зависимости от того, куда его сделали
    setUploadProgress({ current: 0, total: files.length });
    const out = await uploadDropped(
      Array.from(files),
      {
        folderId: realFolderId,
        ...(sec ? { scope: sec.scope as 'SHARED' | 'PERSONAL', ownerId: sec.ownerId || user?.id } : {}),
        userId: user?.id || null,
      },
      existingNames,
      (done, total) => setUploadProgress({ current: done, total }),
    );
    setUploadProgress(null);

    if (out.said) addToast(out.said, out.ok && !out.failed.length && !out.refused.length ? 'success' : (out.ok ? 'info' : 'error'));
    fetchData();
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) uploadFiles(event.target.files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const createEmptyFile = async (name: string, type: string, defaultContent: string) => {
     if (!currentFolderId) {
       addToast('Откройте раздел «Общий» или «Личный», чтобы создать документ.', 'error');
       return;
     }
     const inSectionRoot = isSectionId(currentFolderId);
     const sec = inSectionRoot ? parseSection(currentFolderId) : null;
     let uniqueName = name;
     let counter = 1;
     while (files.some((f: any) => f.name === uniqueName)) {
        const parts = name.split('.');
        if (parts.length > 1) {
          const ext = parts.pop();
          const base = parts.join('.');
          uniqueName = `${base} (${counter}).${ext}`;
        } else {
          uniqueName = `${name} (${counter})`;
        }
        counter++;
     }
     
     await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: uniqueName,
          folderId: inSectionRoot ? null : currentFolderId,
          ...(sec ? { scope: sec.scope, ownerId: sec.ownerId || user?.id } : {}),
          filePath: `/shared/${uniqueName}`,
          size: defaultContent.length,
          type,
          department: "Unassigned",
          content: defaultContent,
          createdById: user?.id,
          updatedById: user?.id
        })
     });
     fetchData();
  };

  // «Создать → Таблицу/Документ»: новый документ Flux Office нужного типа
  // и сразу в его редактор. Зеркало в Проводнике появится после именования.
  const createConstructorDoc = async (kind: 'DOC' | 'TEXT') => {
    try {
      const res = await fetch('/api/constructor/docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: activeProject?.id || '', ...(kind !== 'DOC' ? { kind } : {}) }),
      });
      const data = await res.json();
      if (!res.ok || !data?.doc?.id) throw new Error(data?.error || 'Не удалось создать документ');
      navigate(`${officePathForKind(kind)}?doc=${data.doc.id}`);
    } catch (e: any) {
      addToast(`Не удалось создать документ: ${e.message}`, 'error');
    }
  };
  const createConstructorSheet = () => createConstructorDoc('DOC');

  // «Редактировать копию»: xlsx/csv → Таблица, txt/md/docx → Документ.
  // Исходный файл не меняется — правится копия-документ Flux Office.
  const editCopyInConstructor = async (fileId: string) => {
    try {
      const res = await fetch('/api/constructor/docs/import-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, projectId: activeProject?.id || '' }),
      });
      const data = await res.json();
      if (!res.ok || !data?.doc?.id) throw new Error(data?.error || 'Не удалось открыть файл');
      addToast('Создана редактируемая копия — исходный файл не изменён', 'success');
      navigate(`${officePathForKind(data.doc.kind)}?doc=${data.doc.id}`);
    } catch (e: any) {
      addToast(String(e.message || e), 'error');
    }
  };

  // Файл можно открыть в Flux Office? Спрашиваем общую таблицу расширений, а
  // не свой список: их было семь, и они разошлись — .xls принимал один и
  // отвергал другой, отчего «не все файлы открывались»
  const canEditInConstructor = (name: string) =>
    isOffice({ id: '', name }) || /\.(txt|md|log|json)$/i.test(name || '');

  // Тело запроса перемещения/копирования с учётом виртуальных разделов:
  // при переносе в корень раздела передаём его область видимости
  const buildCopyBody = (ids: string[], target: string | null, isCut: boolean) => {
    const realIds = ids.filter(id => !isSectionId(id));
    // Диск — настоящая папка: кладём внутрь неё, а не «в корень раздела»
    if (target === SEC_DISK && diskRootId) {
      return { ids: realIds, targetFolderId: diskRootId, isCut };
    }
    if (target && isSectionId(target)) {
      const sec = parseSection(target);
      return { ids: realIds, targetFolderId: null, isCut, targetScope: sec.scope, targetOwnerId: sec.ownerId || user?.id };
    }
    return { ids: realIds, targetFolderId: target, isCut };
  };

  const handleMoveItems = async (ids: string[], targetFolderId: string | null) => {
    const body = buildCopyBody(ids, targetFolderId, true);
    if (body.ids.length === 0) return;
    await fetch('/api/files/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    fetchData();
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
  };

  // Actions
  const handleRenameSubmit = async (id: string, isFile: boolean, newName: string) => {
    if (!newName.trim()) return setRenamingId(null);
    const endpoint = isFile ? `/api/files/${id}` : `/api/folders/${id}`;
    await fetch(endpoint, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName })
    });
    setRenamingId(null);
    fetchData();
  };

  // skipConfirm — когда подтверждение уже спросили один раз на всю пачку
  // (удаление нескольких выделенных), иначе программа спрашивала бы про
  // каждый файл отдельно.
  const handleDelete = async (id: string, isFile: boolean, skipConfirm = false) => {
    if (isSectionId(id)) {
      addToast('Разделы «Общий» и «Личный» встроены в программу — их нельзя удалить.', 'error');
      return;
    }
    const confirmed = skipConfirm || await openConfirm(
      isFile ? 'Удалить файл?' : 'Удалить папку?',
      isFile
        ? 'Файл попадёт в корзину Проводника — оттуда его можно вернуть.'
        : 'Папка со всем содержимым попадёт в корзину Проводника — оттуда её можно вернуть.',
      { confirmLabel: 'Удалить', tone: 'danger' },
    );
    if (!confirmed) return;
    const endpoint = isFile ? `/api/files/${id}` : `/api/folders/${id}`;
    const res = await fetch(endpoint, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      addToast(d.error || 'Не удалось удалить', 'error');
      return;
    }
    if (!isFile && currentFolderId === id) navigateTo(null);
    if (!skipConfirm) addToast(isFile ? 'Файл перемещён в корзину' : 'Папка перемещена в корзину', 'success');
    fetchData();
    if (trash) loadTrash();
  };

  const handleAssignTag = (fileId: string) => {
    const item = files.find(f => f.id === fileId);
    if (item) {
        setAssignTagModal({
           fileId,
           mainTags: item.mainTags?.map((t:any) => t.id) || [],
           additionalTags: item.additionalTags?.map((t:any) => t.id) || []
        });
    }
  };

  const handleAssignDepartment = async (fileId: string) => {
    const dept = await openSelect("Назначение отдела", "Выберите отдел для этого файла:", [
      { value: '', label: 'Нет отдела' },
      { value: 'КИПиА', label: 'Отдел КИПиА' },
      { value: 'ОВиК', label: 'Отдел ОВиК' },
      { value: 'Менеджеры', label: 'Отдел менеджеров' }
    ]);
    if (dept !== null) {
        await fetch(`/api/files/${fileId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ department: dept === '' ? "Unassigned" : dept })
        });
        fetchData();
    }
  }

  // Смена статуса документооборота: применяется к выделению (или к одному файлу)
  const handleChangeStatus = async (fileId: string) => {
    const target = selectedIds.has(fileId) ? Array.from(selectedIds) : [fileId];
    const fileTargets = target.filter(id => {
      const it = allCurrentItemsRef.current.find(i => i.id === id);
      return it && !it.isFolder;
    });
    if (fileTargets.length === 0) return;
    const code = await openSelect('Статус документа', `Новый статус для ${fileTargets.length > 1 ? countOf(fileTargets.length, 'файл') : 'файла'}:`,
      STATUS_ORDER.map(c => ({ value: c, label: FILE_STATUSES[c].label })));
    if (code === null) return;
    await Promise.all(fileTargets.map(id => fetch(`/api/files/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ statusCode: code }),
    })));
    addToast(`Статус изменён: ${FILE_STATUSES[code].label}${fileTargets.length > 1 ? ` (${fileTargets.length})` : ''}`, 'success');
    fetchData();
  };

  const handlePaste = async () => {
    if (!clipboard || clipboard.ids.length === 0) return;
    if (!currentFolderId) {
      addToast('Вставка возможна только внутри раздела «Общий» или «Личный».', 'error');
      return;
    }
    const body = buildCopyBody(clipboard.ids, currentFolderId, clipboard.type === 'cut');
    if (body.ids.length === 0) return;
    await fetch('/api/files/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    addToast(clipboard.type === 'cut' ? 'Элементы перемещены' : 'Элементы скопированы', 'success');
    if (clipboard.type === 'cut') setClipboard(null);
    fetchData();
  };

  useEffect(() => { handleDeleteRef.current = handleDelete; }, [handleDelete]);
  useEffect(() => { handlePasteRef.current = handlePaste; }, [handlePaste]);
  useEffect(() => { navigateToRef.current = navigateTo; }, [navigateTo]);

  /**
   * Выгрузить файл в Windows.
   *
   * Раньше это было скачивание мимо человека: файл падал в «Загрузки» и там
   * терялся. Теперь открывается обычное окно сохранения и, если известно,
   * откуда файл когда-то принесли, предлагается та же папка — файл, который
   * ходит туда-сюда, ходит по одной тропинке.
   */
  const handleDownload = async (id: string, isFolder: boolean) => {
    if (isFolder) return;
    const item = allCurrentItems.find(i => i.id === id);
    if (!item) return;
    const out = await saveFileNode(id);
    if (out.canceled) return;
    addToast(out.ok ? `Сохранено: ${out.path || item.name}` : (out.error || 'Не удалось выгрузить'), out.ok ? 'success' : 'error');
  };

  const diskRootFolder = folders.find((f: any) => f.id === diskRootId);
  const currentFolder = isSectionId(currentFolderId)
    ? (currentFolderId === SEC_DISK ? diskRootFolder : undefined)
    : folders.find(f => f.id === currentFolderId);
  const files = currentFolderId === null
    ? []
    // У диска корень настоящий: его файлы лежат в папке, а не «без папки»
    : currentFolderId === SEC_DISK
      ? (diskRootFolder?.files || [])
      : isSectionId(currentFolderId)
        ? rootFiles.filter((f: any) => itemSection(f) === currentFolderId)
        : (currentFolder?.files || []);
  filesRef.current = files; // для колбэков (двойной клик по зеркалу Конструктора)

  const allCurrentItems = useMemo(() => {
    const searchLower = searchQuery.toLowerCase();

    // Умные подборки: срез по всем файлам, доступным пользователю
    if (isSmartId(currentFolderId)) {
      const folderName = new Map<string, string>(folders.map((f: any) => [f.id, f.name]));
      const all = [
        ...rootFiles.map((f: any) => ({ ...f, smartLocation: itemSection(f) === SEC_SHARED ? 'Общий' : 'Личный' })),
        ...folders.flatMap((f: any) => (f.files || []).map((x: any) => ({ ...x, smartLocation: folderName.get(f.id) || '' }))),
      ]
        .filter((f: any) => f.type !== 'CHAT_FILE')
        .filter((f: any) => !searchQuery || String(f.name || '').toLowerCase().includes(searchLower))
        .map((f: any) => ({ ...f, isFolder: false }));

      if (currentFolderId === SMART_RECENT) {
        return [...all]
          .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
          .slice(0, 100);
      }
      if (currentFolderId === SMART_UNTAGGED) {
        return all.filter((f: any) => !(f.mainTags || []).length && !(f.additionalTags || []).length);
      }
      // Дубли: одинаковое имя встречается больше одного раза
      const byName = new Map<string, number>();
      for (const f of all) {
        const k = String(f.name || '').toLowerCase();
        byName.set(k, (byName.get(k) || 0) + 1);
      }
      return all
        .filter((f: any) => (byName.get(String(f.name || '').toLowerCase()) || 0) > 1)
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
    }

    // Список разделов (корень проводника): «Общий», «Личный», у ГлавАдмина — личные всех
    if (currentFolderId === null && !searchQuery) {
      return sections.map(s => ({ ...s, type: 'Раздел' }));
    }

    // Папки уровня: в корне раздела — папки без родителя из этого раздела
    const childFolders = currentFolderId === SEC_DISK
      ? folders.filter(f => f.parentId === diskRootId)
      : isSectionId(currentFolderId)
        ? folders.filter(f => !f.parentId && itemSection(f) === currentFolderId)
        : folders.filter(f => f.parentId === currentFolderId);

    // Поиск ограничен текущим разделом (или всеми доступными, если раздел не открыт)
    const searchScope = (it: any) => !currentSectionId || itemSection(it) === currentSectionId;

    const items = [
      ...(searchQuery
        ? folders.filter(f => searchScope(f) && f.name.toLowerCase().includes(searchLower))
        : childFolders
      ).map(f => ({ ...f, isFolder: true })),
      ...(searchQuery
        ? [...rootFiles, ...folders.flatMap(f => f.files || [])].filter((f: any) => searchScope(f) && f.name.toLowerCase().includes(searchLower))
        : files
      ).map((f: any) => ({ ...f, isFolder: false }))
    ];

    const filtered = statusFilter
      ? items.filter((i: any) => i.isFolder || (i.statusCode || 'D') === statusFilter)
      : items;
    filtered.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;

      let valA = a[sortConfig.key];
      let valB = b[sortConfig.key];

      if (sortConfig.key === 'updatedAt') {
        valA = new Date(valA || 0).getTime();
        valB = new Date(valB || 0).getTime();
      }

      if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });

    return filtered;
  }, [folders, rootFiles, currentFolderId, currentSectionId, sections, searchQuery, sortConfig, statusFilter]);
  const statusLine = useMemo(
    () => buildStatus(allCurrentItems, selectedIds),
    [allCurrentItems, selectedIds],
  );


  useEffect(() => { allCurrentItemsRef.current = allCurrentItems; }, [allCurrentItems]);

  // Сколько ФАЙЛОВ (не папок) выделено — для контекстных кнопок тулбара
  const selectedFileCount = useMemo(
    () => Array.from(selectedIds).filter(id => { const it = allCurrentItems.find(i => i.id === id); return it && !it.isFolder; }).length,
    [selectedIds, allCurrentItems]
  );

  const [paneWidth, setPaneWidth] = useState(800);

  useEffect(() => {
    if (!mainPaneRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setPaneWidth(entry.contentRect.width || 800);
      }
    });
    observer.observe(mainPaneRef.current);
    return () => observer.disconnect();
  }, []);

  const listVirtualizer = useVirtualizer({
    count: allCurrentItems.length,
    getScrollElement: () => mainPaneRef.current,
    estimateSize: () => 36,
    overscan: 10,
  });

  const cols = Math.max(1, Math.floor((paneWidth - 32) / 128) || 5);
  const gridRows = React.useMemo(() => {
    const rows = [];
    for (let i = 0; i < allCurrentItems.length; i += cols) {
      rows.push(allCurrentItems.slice(i, i + cols));
    }
    return rows;
  }, [allCurrentItems, cols]);

  const gridVirtualizer = useVirtualizer({
    count: gridRows.length,
    getScrollElement: () => mainPaneRef.current,
    estimateSize: () => 140, // Height of card row + padding gaps
    overscan: 5,
  });

  useEffect(() => {
    listVirtualizer.measure();
    gridVirtualizer.measure();
  }, [viewMode, allCurrentItems.length, cols]);

  const handleDropOnFolder = useCallback(async (ids: string[], targetFolderId: string | null) => {
    if (ids.includes(targetFolderId || '')) return;
    const body = buildCopyBody(ids, targetFolderId, true);
    if (body.ids.length === 0) return;
    await fetch('/api/files/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    fetchData();
  }, [activeProject, user?.id]);

  const handleDragStart = useCallback((e: React.DragEvent, item: any) => {
    if (item.isSection) {
      e.preventDefault();
      return;
    }
    let currentSelected = selectedIdsRef.current;
    if (!currentSelected.has(item.id)) {
      const newSelected = new Set(currentSelected);
      newSelected.add(item.id);
      setSelectedIds(newSelected);
      currentSelected = newSelected;
    }
    const idsToMove = Array.from(currentSelected);
    e.dataTransfer.setData('text/plain', JSON.stringify({ ids: idsToMove, type: 'app_items' }));
  }, []);

  const handleDropItems = useCallback((e: React.DragEvent, targetFolderId: string | null) => {
    const dataStr = e.dataTransfer.getData('text/plain');
    if (dataStr) {
      try {
        const data = JSON.parse(dataStr);
        if (data.type === 'app_items') {
          handleDropOnFolder(data.ids, targetFolderId);
        }
      } catch (err) {}
    }
  }, [handleDropOnFolder]);

  const handleItemClickClean = useCallback((e: React.MouseEvent, id: string, isFile: boolean) => {
    e.stopPropagation();
    const newSelected = new Set(selectedIdsRef.current);
    if (e.ctrlKey || e.metaKey) {
      if (newSelected.has(id)) newSelected.delete(id);
      else newSelected.add(id);
    } else if (e.shiftKey && lastSelectedIdRef.current) {
      const startIdx = allCurrentItemsRef.current.findIndex(i => i.id === lastSelectedIdRef.current);
      const endIdx = allCurrentItemsRef.current.findIndex(i => i.id === id);
      if (startIdx !== -1 && endIdx !== -1) {
        newSelected.clear();
        const min = Math.min(startIdx, endIdx);
        const max = Math.max(startIdx, endIdx);
        for (let i = min; i <= max; i++) {
          newSelected.add(allCurrentItemsRef.current[i].id);
        }
      }
    } else {
      newSelected.clear();
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
    setLastSelectedId(id);
  }, []);

  const handleItemDoubleClick = useCallback((id: string, isFolder: boolean) => {
    if (isFolder) { navigateToRef.current(id); return; }
    const f = allCurrentItemsRef.current?.find((x: any) => x.id === id);
    // Файл из чужого проекта: имя видно, содержимое — после переключения.
    // Документ Конструктора в чужом проекте просто не соберётся
    const owner = projectOfRef.current(f);
    if (owner && owner !== useStore.getState().activeProject?.id) {
      openInProject({
        what: `Документ «${f?.name || ''}»`,
        projectId: owner,
        open: () => handleItemDoubleClickRef.current(id, false),
      });
      return;
    }
    /*
      Чем открыть — решает общая таблица сопоставлений (lib/fileTypes).
      Здесь она наконец и решает: до этого места разбирались два случая руками —
      документ и ПДФ, — а всё остальное падало в предпросмотр. Из-за этого
      книга Excel, открытая со стола, попадала в «Таблицу», а та же книга из
      Проводника — в картинку-заглушку сбоку. Одно движение мышью, два разных
      ответа, и оба «правильные» по своему куску кода.
    */
    if (!f) return;
    const app = appsFor({ ...f, id })[0];
    if (app?.id === 'windows') { void openInWindowsSaid(id, String(f.name || ''), addToast); return; }
    if (app && app.id !== 'explorer') { navigate(app.href({ ...f, id })); return; }

    // Открывать нечем — но и молчать нельзя: у .doc и .rtf есть совет, что
    // делать, и человек должен его прочитать, а не смотреть на пустой значок
    const advice = legacyAdvice(String(f.name || ''));
    if (advice) addToast(advice, 'info');
    setSelectedIds(new Set([id]));
    setLastSelectedId(id);
    setShowPreviewPane(true);
  }, [navigate, addToast]);

  // Ссылка на себя: после согласия переключить проект открытие повторяется
  // уже в новых условиях — и второй раз проходит без вопроса.
  const handleItemDoubleClickRef = useRef(handleItemDoubleClick);
  handleItemDoubleClickRef.current = handleItemDoubleClick;

  const handleItemContextMenu = useCallback((e: React.MouseEvent, id: string, isFile: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    let currentSelected = selectedIdsRef.current;
    if (!currentSelected.has(id)) {
      setSelectedIds(new Set([id]));
      setLastSelectedId(id);
    }
    setContextMenu({ x: e.clientX, y: e.clientY, targetId: id, isFile, isSection: isSectionId(id) });
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if writing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const selected = selectedIdsRef.current;
      const currFolderId = currentFolderIdRef.current;
      const items = allCurrentItemsRef.current;
      const clip = clipboardRef.current;

      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selected.size > 0) {
        setClipboard({ ids: Array.from(selected), type: 'copy' });
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'x' && selected.size > 0) {
        setClipboard({ ids: Array.from(selected), type: 'cut' });
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        setSelectedIds(new Set(items.map(i => i.id)));
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'v' && clip) {
        handlePasteRef.current();
      } else if (e.key === 'Delete' && selected.size > 0) {
        const deletable = Array.from(selected).filter(id => !isSectionId(id));
        if (deletable.length === 0) return;
        openConfirm(`Удалить ${countOf(deletable.length, 'элемент')}?`,
          'Удалённое попадёт в корзину Проводника — оттуда его можно вернуть.',
          { confirmLabel: 'Удалить', tone: 'danger' }).then(confirmed => {
           if (confirmed) {
             deletable.forEach(id => {
               const item = items.find(i => i.id === id);
               const isFile = item ? !item.isFolder : false;
               handleDeleteRef.current(id, isFile, true);
             });
             setSelectedIds(new Set());
             addToast(`Перемещено в корзину: ${countOf(deletable.length, 'элемент')}`, 'success');
           }
        });
      } else if (e.key === 'F2' && selected.size === 1) {
        const id = Array.from(selected)[0];
        if (isSectionId(id)) return; // встроенные разделы не переименовываются
        setRenamingId(id);
        const item = items.find(i => i.id === id);
        setRenameValue(item?.name || '');
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        const lastSelIdx = lastSelectedIdRef.current;
        const currentIdx = items.findIndex(i => i.id === lastSelIdx);
        if (currentIdx < items.length - 1) {
          const nextId = items[currentIdx + 1].id;
          setSelectedIds(new Set([nextId]));
          setLastSelectedId(nextId);
        } else if (items.length > 0 && currentIdx === -1) {
          const nextId = items[0].id;
          setSelectedIds(new Set([nextId]));
          setLastSelectedId(nextId);
        }
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const lastSelIdx = lastSelectedIdRef.current;
        const currentIdx = items.findIndex(i => i.id === lastSelIdx);
        if (currentIdx > 0) {
          const prevId = items[currentIdx - 1].id;
          setSelectedIds(new Set([prevId]));
          setLastSelectedId(prevId);
        } else if (items.length > 0 && currentIdx === -1) {
          const prevId = items[items.length - 1].id;
          setSelectedIds(new Set([prevId]));
          setLastSelectedId(prevId);
        }
      } else if (e.key === 'Enter') {
        if (selected.size === 1) {
          const id = Array.from(selected)[0] as string;
          const item = items.find(i => i.id === id);
          if (item?.isFolder) navigateToRef.current(id);
        }
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        if (!currFolderId) return;
        if (isSectionId(currFolderId)) {
          navigateToRef.current(null);
          return;
        }
        const folder = foldersRef.current.find(f => f.id === currFolderId);
        // Из папки на верхнем уровне возвращаемся в её раздел (Общий/Личный)
        const target = folder?.parentId
          || (folder ? (folder.scope === 'PERSONAL' && folder.ownerId ? personalSecId(folder.ownerId) : SEC_SHARED) : null);
        navigateToRef.current(target);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);


  const handleContextMenu = (e: React.MouseEvent, targetId?: string, isFile?: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    if (targetId) {
      if (!selectedIds.has(targetId)) {
        setSelectedIds(new Set([targetId]));
        setLastSelectedId(targetId);
      }
      setContextMenu({ x: e.clientX, y: e.clientY, targetId, isFile });
    } else {
      setSelectedIds(new Set());
      setContextMenu({ x: e.clientX, y: e.clientY, isContainer: true });
    }
  };


  const handleSort = (key: string) => {
    setSortConfig(current => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  // Breadcrumbs
  const getBreadcrumbs = () => {
    const crumbs = [];
    let curr = currentFolder;
    while (curr) {
      crumbs.unshift(curr);
      curr = folders.find(f => f.id === curr.parentId);
    }
    return crumbs;
  };
  const breadcrumbs = getBreadcrumbs();

  const formatSize = (bytes: number) => {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const sortedProjectTags = [...projectTags].sort((a, b) => {
    let valA = a[tagSortConfig.key] || '';
    let valB = b[tagSortConfig.key] || '';

    if (tagSortConfig.key === 'createdAt') {
      valA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      valB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    }

    if (valA < valB) return tagSortConfig.direction === 'asc' ? -1 : 1;
    if (valA > valB) return tagSortConfig.direction === 'asc' ? 1 : -1;
    return 0;
  });

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
      className="h-full flex flex-col bg-white dark:bg-dark-bg border border-slate-205 dark:border-dark-border rounded-xl shadow-xs overflow-hidden text-sm transition-ui" 
      onClick={() => setSelectedIds(new Set())}
    >
      
      {/* Вкладки: две папки рядом в одном окне. Раньше для этого разводили
          два окна по экрану */}
      <ExplorerTabs
        tabs={tabs.tabs}
        activeId={tabs.activeId}
        onPick={tabs.pick}
        onClose={tabs.close}
        onNew={tabs.add}
      />

      {/* Explorer Top Bar - Like Windows */}
      <div className="flex flex-col bg-slate-100/95 dark:bg-slate-900/90 border-b border-slate-200 dark:border-slate-800">
        {/* Современный компактный тулбар */}
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-850">
           <button type="button" onClick={createFolder} title="Новая папка"
             className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-750 shadow-xs cursor-pointer">
              <FolderPlus className="w-4 h-4 text-amber-500" /> Новая папка
           </button>
           <button type="button" data-tour="explorer-upload-btn" onClick={() => fileInputRef.current?.click()} title="Загрузить файлы"
             className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 shadow-sm cursor-pointer">
              <Upload className="w-4 h-4" /> Загрузить
           </button>
           <input type="file" ref={fileInputRef} className="hidden" multiple onChange={handleFileUpload} />

           {selectedFileCount > 0 && (
             <>
               <div className="w-px h-6 bg-slate-300 dark:bg-slate-700 mx-1" />
               <button type="button" onClick={() => openImportPicker()} title="Загрузить данные выбранных файлов в «Оборудование»"
                 className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 hover:bg-emerald-100 dark:hover:bg-emerald-950/50 cursor-pointer">
                  <Boxes className="w-4 h-4" /> В оборудование
               </button>
               <button type="button" onClick={() => handleChangeStatus(Array.from(selectedIds)[0])} title="Сменить статус выделенных"
                 className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-750 cursor-pointer">
                  <Info className="w-4 h-4" /> Статус
               </button>
               <span className="text-xs text-slate-400 ml-1">выбрано: {selectedFileCount}</span>
             </>
           )}

           <div className="ml-auto flex items-center gap-2">
             <div className="flex border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden bg-white dark:bg-slate-800">
               <button type="button" onClick={() => setViewMode('list')} className={`p-1.5 cursor-pointer ${viewMode === 'list' ? 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-750'}`} title="Списком">
                 <List className="w-4 h-4" />
               </button>
               <button type="button" onClick={() => setViewMode('grid')} className={`p-1.5 cursor-pointer ${viewMode === 'grid' ? 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-750'}`} title="Сеткой">
                 <LayoutGrid className="w-4 h-4" />
               </button>
             </div>
             <button type="button" onClick={() => setShowPreviewPane(!showPreviewPane)} title="Панель предпросмотра"
               className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${showPreviewPane ? 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300' : 'text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-750'}`}>
               <PanelRight className="w-4 h-4" /> Превью
             </button>
           </div>
        </div>
 
        {/* Address Bar Row */}
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface">
          <div className="flex items-center gap-1 mr-2 text-slate-500 dark:text-dark-text-muted">
            <button type="button" onClick={() => goBack()} disabled={explorerHistory.length <= 1} className="p-1.5 hover:bg-slate-100 dark:hover:bg-dark-panel rounded text-slate-700 dark:text-dark-text-main disabled:opacity-30 cursor-pointer">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <button type="button" onClick={() => goForward()} disabled={explorerForward.length === 0} className="p-1.5 hover:bg-slate-100 dark:hover:bg-dark-panel rounded text-slate-700 dark:text-dark-text-main disabled:opacity-30 cursor-pointer">
              <ArrowRight className="w-4 h-4" />
            </button>
            <button type="button" title="На уровень выше" onClick={handleNavigateUp} disabled={!currentFolderId} className="p-1.5 hover:bg-slate-100 dark:hover:bg-dark-panel rounded text-slate-700 dark:text-dark-text-main disabled:opacity-30 cursor-pointer">
              <ArrowUp className="w-4 h-4" />
            </button>
          </div>
 
          <div className="flex-1 min-w-0 flex items-center bg-white dark:bg-dark-panel border border-slate-250 dark:border-dark-border px-2 py-1 rounded-md flex-wrap gap-1 hover:border-emerald-405 transition-colors">
            <Folder className="w-4 h-4 shrink-0 text-amber-600 mr-1 @[560px]:mr-2" />
            {/* Корень называется «Проводник», а не именем проекта: файлы здесь
                со всех проектов, и имя одного проекта в начале пути обещало
                бы обратное. Чей файл — написано на самом файле. */}
            <span className="min-w-0 truncate cursor-pointer hover:bg-slate-100 dark:hover:bg-dark-surface text-slate-700 dark:text-dark-text-main px-1.5 py-0.5 rounded hover:underline" title="Проводник: файлы всех проектов" onClick={() => navigateTo(null)}>Проводник</span>
            {currentSectionId && (
              <>
                <ChevronRight className="w-3 h-3 text-slate-400 dark:text-slate-455 mx-0.5" />
                <span className="cursor-pointer hover:bg-slate-100 dark:hover:bg-dark-surface text-slate-700 dark:text-dark-text-main px-1.5 py-0.5 rounded hover:underline font-medium" onClick={() => navigateTo(currentSectionId)}>{sectionName(currentSectionId)}</span>
              </>
            )}
            {breadcrumbs.map((crumb, idx) => (
              <React.Fragment key={crumb.id}>
                <ChevronRight className="w-3 h-3 text-slate-400 dark:text-slate-455 mx-0.5" />
                <span className="cursor-pointer hover:bg-slate-100 dark:hover:bg-dark-surface text-slate-700 dark:text-dark-text-main px-1.5 py-0.5 rounded hover:underline" onClick={() => navigateTo(crumb.id)}>{crumb.name}</span>
              </React.Fragment>
            ))}
          </div>
 
          <div className="relative w-40 @[900px]:w-64 ml-2 min-w-0">
           <Search className="w-4 h-4 absolute left-2.5 top-2 text-slate-400 dark:text-dark-text-muted" />
           <input 
             type="text" 
             placeholder={currentFolder ? `Поиск в папке «${currentFolder.name}»` : 'Поиск по проводнику'} 
             value={searchQuery}
             onChange={(e) => setSearchQuery(e.target.value)}
             className="pl-8 pr-4 py-1 w-full border border-slate-255 dark:border-dark-border focus:outline-none focus:border-emerald-500 bg-white dark:bg-dark-panel text-slate-800 dark:text-dark-text-main rounded-lg transition-ui focus:ring-1 focus:ring-emerald-500/20"
           />
          </div>
        </div>

        {/* Фильтр по статусу документа */}
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
          <span className="text-2xs font-mono uppercase tracking-wider text-slate-400 mr-1">Статус</span>
          <button
            type="button"
            onClick={() => setStatusFilter(null)}
            aria-pressed={statusFilter === null}
            className={`px-2 py-1 min-h-6 rounded-full text-2xs font-semibold transition-ui cursor-pointer ${
              statusFilter === null
                ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300 ring-1 ring-emerald-600/40'
                : 'text-slate-500 dark:text-dark-text-muted hover:bg-slate-100 dark:hover:bg-dark-panel'
            }`}
          >
            Все
          </button>
          {STATUS_ORDER.map((code) => {
            const st = FILE_STATUSES[code];
            const active = statusFilter === code;
            return (
              <button
                key={code}
                type="button"
                onClick={() => setStatusFilter(active ? null : code)}
                aria-pressed={active}
                title={`Показать только «${st.label}»`}
                className={`inline-flex items-center gap-1 px-2 py-1 min-h-6 rounded-full text-2xs font-semibold transition-ui cursor-pointer ${
                  active ? `${st.chip} ring-1 ring-slate-400/40` : 'text-slate-500 dark:text-dark-text-muted hover:bg-slate-100 dark:hover:bg-dark-panel'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} /> {st.label}
              </button>
            );
          })}
          {statusFilter && (
            <span className="text-2xs text-slate-400 ml-1">показаны только «{FILE_STATUSES[statusFilter].label}»</span>
          )}
        </div>
      </div>



      <div className="flex flex-1 overflow-hidden">
        {/* Tree Sidebar */}
        <div 
          className="w-44 @[900px]:w-56 border-r border-slate-200 dark:border-slate-850 bg-slate-50/60 dark:bg-slate-950/40 overflow-y-auto pt-2 flex-shrink-0 select-none scrollbar-thin scrollbar-thumb-slate-300 dark:scrollbar-thumb-slate-800"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
            <div
              className={`flex items-center py-1.5 px-3 mx-2 rounded-lg cursor-pointer transition-colors text-slate-700 dark:text-slate-300 ${currentFolderId === null ? 'bg-emerald-500/10 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 font-medium' : 'hover:bg-slate-200/50 dark:hover:bg-slate-900'}`}
              onClick={() => navigateTo(null)}
            >
              <FileIcon className="w-4 h-4 mr-2 text-slate-500 shrink-0" />
              <span className="text-sm">Проводник</span>
            </div>
            {sections.map(sec => (
              <div key={sec.id}>
                <div
                  className={`flex items-center py-1.5 px-3 mx-2 mt-1 rounded-lg cursor-pointer transition-colors text-slate-700 dark:text-slate-300 ${currentFolderId === sec.id ? 'bg-emerald-500/10 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 font-medium' : 'hover:bg-slate-200/50 dark:hover:bg-slate-900'}`}
                  onClick={() => navigateTo(sec.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                     e.preventDefault();
                     e.stopPropagation();
                     if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                        uploadFiles(e.dataTransfer.files, sec.id);
                     } else {
                        const dataStr = e.dataTransfer.getData('text/plain');
                        if (dataStr) {
                           try {
                              const data = JSON.parse(dataStr);
                              if (data.type === 'app_items') handleMoveItems(data.ids, sec.id);
                           } catch (err) {}
                        }
                     }
                  }}
                  title={sec.id === SEC_DISK
                    ? 'Общий диск: виден всем и не зависит от проекта. Класть и удалять — по праву «Запись на общий диск»'
                    : sec.id === SEC_SHARED ? 'Общий раздел: файлы видят все пользователи' : 'Личный раздел: файлы видит только владелец'}
                >
                  {getFileIcon({ isSection: true, id: sec.id }, 'w-4 h-4 mr-2 shrink-0')}
                  <span className="text-sm font-medium truncate">{sec.name}</span>
                </div>
                {folders.filter(f => (sec.id === SEC_DISK
                  ? f.parentId === diskRootId
                  : !f.parentId && itemSection(f) === sec.id)).map(folder => (
                  <TreeFolder key={folder.id} folder={folder} allFolders={folders} currentFolderId={currentFolderId} onSelect={navigateTo} onDropFiles={uploadFiles} onMoveItems={handleMoveItems} depth={2} />
                ))}
              </div>
            ))}

            {/* Подборки: срезы по всем файлам, а не папки */}
            <div className="mt-3 mb-1 px-4 text-2xs font-mono uppercase tracking-wider text-slate-400">Подборки</div>
            {[
              { id: SMART_RECENT, label: 'Недавние', icon: Clock, hint: 'Сто последних изменённых файлов проекта' },
              { id: SMART_UNTAGGED, label: 'Без тегов', icon: Tag, hint: 'Файлы, не привязанные ни к одному тегу оборудования' },
              { id: SMART_DUPES, label: 'Дубликаты', icon: Copy, hint: 'Файлы с одинаковыми именами — вероятные повторы' },
            ].map((sm) => {
              const Icon = sm.icon as any;
              const active = currentFolderId === sm.id;
              return (
                <div
                  key={sm.id}
                  className={`flex items-center py-1.5 px-3 mx-2 rounded-lg cursor-pointer transition-ui ${
                    active
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 font-semibold'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-900'
                  }`}
                  onClick={() => navigateTo(sm.id)}
                  title={sm.hint}
                >
                  <Icon className="w-4 h-4 mr-2 text-slate-500 shrink-0" />
                  <span className="text-sm">{sm.label}</span>
                </div>
              );
            })}

            {/* Корзина: удалённое хранится здесь до явной очистки */}
            <div
              className={`flex items-center py-1.5 px-3 mx-2 mt-2 rounded-lg cursor-pointer transition-ui ${
                currentFolderId === TRASH_ID
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 font-semibold'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-900'
              }`}
              onClick={() => navigateTo(TRASH_ID)}
              title="Удалённые файлы и папки — можно вернуть"
            >
              <Trash2 className="w-4 h-4 mr-2 text-slate-500 shrink-0" />
              <span className="text-sm">Корзина</span>
              {!!((trash?.files.length || 0) + (trash?.folders.length || 0)) && (
                <span className="ml-auto text-2xs font-mono text-slate-400">
                  {(trash?.files.length || 0) + (trash?.folders.length || 0)}
                </span>
              )}
            </div>
        </div>

        {/* Main Pane - Table View */}
        <div 
          ref={mainPaneRef}
          className={`@container flex-1 overflow-y-auto overflow-x-auto bg-white dark:bg-dark-bg relative select-none scrollbar-thin scrollbar-thumb-slate-300 dark:scrollbar-thumb-slate-850 ${isDragging ? 'bg-emerald-50/10' : ''}`}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onDragOver={handleDragOver}
          onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
          onDrop={handleDrop}
          onContextMenu={(e) => handleContextMenu(e)}
        >
            {isDragging && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-emerald-500/10 border-2 border-emerald-500 border-dashed m-2 pointer-events-none">
                 <div className="text-emerald-600 font-medium flex items-center gap-2 bg-white/90 dark:bg-slate-950/90 px-4 py-2 rounded-full shadow-sm">
                   <Upload className="w-5 h-5" /> Отпустите — загрузим сюда
                 </div>
              </div>
            )}

            {/* Подборка: короткое пояснение, что именно показано */}
            {isSmartId(currentFolderId) && (
              <div className="px-4 py-2.5 border-b border-slate-100 dark:border-dark-border bg-slate-50/60 dark:bg-dark-surface/40">
                <p className="text-sm font-bold">
                  {currentFolderId === SMART_RECENT ? 'Недавние'
                    : currentFolderId === SMART_UNTAGGED ? 'Без тегов' : 'Дубликаты'}
                </p>
                <p className="text-xs text-slate-500 dark:text-dark-text-muted mt-0.5">
                  {currentFolderId === SMART_RECENT
                    ? 'Сто последних изменённых файлов проекта, независимо от папки.'
                    : currentFolderId === SMART_UNTAGGED
                      ? 'Файлы, не привязанные ни к одному тегу оборудования.'
                      : 'Файлы с одинаковыми именами — вероятные повторы одного документа.'}
                </p>
              </div>
            )}

            {/* Корзина: отдельный вид вместо таблицы файлов */}
            {currentFolderId === TRASH_ID ? (
              <div className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h2 className="text-sm font-bold flex items-center gap-2">
                      <Trash2 className="w-4 h-4 text-slate-500" /> Корзина
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-dark-text-muted mt-0.5">
                      Удалённое хранится здесь, пока корзину не очистят. Восстановленное возвращается в свою папку.
                    </p>
                  </div>
                  {!!((trash?.files.length || 0) + (trash?.folders.length || 0)) && (
                    <button type="button" onClick={purgeTrash}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-rose-700 dark:text-rose-300 border border-rose-300 dark:border-rose-900 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-ui cursor-pointer">
                      Очистить корзину
                    </button>
                  )}
                </div>

                {trashLoading && <p className="text-xs text-slate-400 py-6">Загружаю…</p>}

                {!trashLoading && !((trash?.files.length || 0) + (trash?.folders.length || 0)) && (
                  <div className="flex flex-col items-center justify-center py-20 text-slate-400 dark:text-slate-500">
                    <div className="w-16 h-16 bg-slate-50 dark:bg-slate-950/60 rounded-full flex items-center justify-center mb-3">
                      <Trash2 className="w-8 h-8" />
                    </div>
                    <p className="text-sm">Корзина пуста</p>
                    <p className="text-2xs pt-1">Удалённые файлы и папки появятся здесь.</p>
                  </div>
                )}

                <div className="flex flex-col divide-y divide-slate-100 dark:divide-dark-border">
                  {(trash?.folders || []).map((f: any) => (
                    <div key={f.id} className="flex items-center gap-3 py-2">
                      <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                      <span className="text-sm font-medium flex-1 truncate">{f.name}</span>
                      <span className="text-2xs text-slate-400 shrink-0">папка · удалена {f.deletedAt ? format(new Date(f.deletedAt), 'dd.MM.yyyy HH:mm') : ''}</span>
                      <button type="button" onClick={() => restoreItem('folder', f.id, f.name)}
                        className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer shrink-0">
                        Восстановить
                      </button>
                    </div>
                  ))}
                  {(trash?.files || []).map((f: any) => (
                    <div key={f.id} className="flex items-center gap-3 py-2">
                      {getFileIcon(f, 'w-4 h-4 shrink-0')}
                      <span className="text-sm font-medium flex-1 truncate">{f.name}</span>
                      <span className="text-2xs text-slate-400 shrink-0">{formatSize(f.size)} · удалён {f.deletedAt ? format(new Date(f.deletedAt), 'dd.MM.yyyy HH:mm') : ''}</span>
                      <button type="button" onClick={() => restoreItem('file', f.id, f.name)}
                        className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 hover:underline cursor-pointer shrink-0">
                        Восстановить
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
            <AnimatePresence mode="wait">
              {isLoading ? (
                <motion.table
                  key="skeleton"
                  className="w-full text-left border-collapse select-none table-fixed"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <thead className="sticky top-0 bg-white dark:bg-dark-surface shadow-xs border-b border-slate-200 dark:border-dark-border z-10 text-xs text-slate-500 dark:text-dark-text-muted font-medium">
                    <tr>
                      <th className="flux-cell border-r border-slate-200 dark:border-dark-border font-medium cursor-default">Имя</th>
                      <th className="flux-cell border-r border-slate-200 dark:border-dark-border font-medium cursor-default">Дата изменения</th>
                      <th className="flux-cell border-r border-slate-200 dark:border-dark-border font-medium cursor-default">Статус</th>
                      <th className="flux-cell hidden @[760px]:table-cell border-r border-slate-200 dark:border-dark-border font-medium cursor-default">Размер</th>
                      <th className="flux-cell hidden @[880px]:table-cell border-r border-slate-200 dark:border-dark-border font-medium cursor-default">Теги</th>
                      <th className="flux-cell hidden @[1000px]:table-cell font-medium cursor-default">Отдел</th>
                    </tr>
                  </thead>
                  <tbody>
                    <SkeletonRow />
                    <SkeletonRow />
                    <SkeletonRow />
                    <SkeletonRow />
                    <SkeletonRow />
                  </tbody>
                </motion.table>
              ) : viewMode === 'list' ? (
                <motion.table 
                  key="list"
                  className="w-full text-left border-collapse table-fixed"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <thead className="sticky top-0 bg-white dark:bg-dark-surface shadow-xs border-b border-slate-200 dark:border-dark-border z-10 text-xs text-slate-500 dark:text-dark-text-muted font-medium">
                    <tr>
                      <th className="relative flux-cell border-r border-slate-200 dark:border-dark-border font-medium cursor-pointer hover:bg-slate-100 dark:hover:bg-dark-panel" onClick={() => handleSort('name')} style={colStyle('name')}>
                        Имя {sortConfig.key === 'name' && (sortConfig.direction==='asc'?'↑':'↓')}
                      
                        <span onMouseDown={startColResize('name')} onClick={(e) => e.stopPropagation()}
                          className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-emerald-400/60" title="Потянуть — изменить ширину колонки" />
                      </th>
                      <th className="relative flux-cell border-r border-slate-200 dark:border-dark-border font-medium cursor-pointer hover:bg-slate-100 dark:hover:bg-dark-panel" onClick={() => handleSort('updatedAt')} style={colStyle('updatedAt')}>
                        Дата изменения {sortConfig.key === 'updatedAt' && (sortConfig.direction==='asc'?'↑':'↓')}
                      
                        <span onMouseDown={startColResize('updatedAt')} onClick={(e) => e.stopPropagation()}
                          className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-emerald-400/60" title="Потянуть — изменить ширину колонки" />
                      </th>
                      <th className="relative flux-cell border-r border-slate-200 dark:border-dark-border font-medium cursor-pointer hover:bg-slate-100 dark:hover:bg-dark-panel" onClick={() => handleSort('statusCode')} style={colStyle('statusCode')}>
                        Статус {sortConfig.key === 'statusCode' && (sortConfig.direction==='asc'?'↑':'↓')}
                      
                        <span onMouseDown={startColResize('statusCode')} onClick={(e) => e.stopPropagation()}
                          className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-emerald-400/60" title="Потянуть — изменить ширину колонки" />
                      </th>
                      <th className="relative flux-cell hidden @[760px]:table-cell border-r border-slate-200 dark:border-dark-border font-medium cursor-pointer hover:bg-slate-100 dark:hover:bg-dark-panel" onClick={() => handleSort('size')} style={colStyle('size')}>
                        Размер {sortConfig.key === 'size' && (sortConfig.direction==='asc'?'↑':'↓')}
                      
                        <span onMouseDown={startColResize('size')} onClick={(e) => e.stopPropagation()}
                          className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-emerald-400/60" title="Потянуть — изменить ширину колонки" />
                      </th>
                      <th className="flux-cell hidden @[880px]:table-cell border-r border-slate-200 dark:border-dark-border font-medium cursor-pointer hover:bg-slate-100 dark:hover:bg-dark-panel">Теги</th>
                      <th className="flux-cell hidden @[1000px]:table-cell font-medium cursor-pointer hover:bg-slate-100 dark:hover:bg-dark-panel">Отдел</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allCurrentItems.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center">
                           <div className="flex flex-col items-center justify-center py-20 text-slate-400 dark:text-slate-500">
                             <div className="w-16 h-16 bg-slate-50 dark:bg-slate-950/60 rounded-full flex items-center justify-center mb-3 text-slate-400 dark:text-slate-500">
                                  {searchQuery ? <Search className="w-8 h-8" /> : <Folder className="w-8 h-8" />}
                             </div>
                             <p className="text-sm">{
                               searchQuery ? 'Ничего не найдено — попробуйте другой запрос.'
                               : currentFolderId === SMART_UNTAGGED ? 'Все файлы привязаны к тегам — это хорошо.'
                               : currentFolderId === SMART_DUPES ? 'Повторов по именам не нашлось.'
                               : currentFolderId === SMART_RECENT ? 'Пока ничего не менялось.'
                               : 'Эта папка пуста.'
                             }</p>
                             {!searchQuery && !isSmartId(currentFolderId) && (
                               <>
                                 <div className="flex items-center gap-2 pt-3">
                                   <button type="button" onClick={() => fileInputRef.current?.click()}
                                     className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 transition-ui cursor-pointer">
                                     <Upload className="w-3.5 h-3.5" /> Загрузить файлы
                                   </button>
                                   <button type="button" onClick={createFolder}
                                     className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-200 dark:border-dark-border hover:bg-slate-50 dark:hover:bg-dark-panel transition-ui cursor-pointer">
                                     <FolderPlus className="w-3.5 h-3.5 text-amber-500" /> Новая папка
                                   </button>
                                 </div>
                                 <p className="text-2xs pt-2 text-slate-400 dark:text-slate-500">Файлы можно просто перетащить сюда из проводника Windows.</p>
                               </>
                             )}
                           </div>
                        </td>
                      </tr>
                    ) : (
                      <>
                        {listVirtualizer.getVirtualItems().length > 0 && (
                          <tr style={{ height: `${listVirtualizer.getVirtualItems()[0].start}px`, border: 'none' }}>
                            <td colSpan={6} style={{ padding: 0, border: 'none' }} />
                          </tr>
                        )}
                        {listVirtualizer.getVirtualItems().map(virtualRow => {
                          const item = allCurrentItems[virtualRow.index];
                          if (!item) return null;
                          const isSelected = selectedIds.has(item.id);
                          const isRenaming = renamingId === item.id;
                          const isCut = clipboard?.type === 'cut' && clipboard.ids.includes(item.id);

                          return (
                            <FileRowItem
                              key={item.id}
                              item={item}
                              index={virtualRow.index}
                              isSelected={isSelected}
                              isRenaming={isRenaming}
                              isCut={isCut}
                              loaded={!item.isFolder ? loadedMap[item.name] : undefined}
                              foreign={foreignOf(item)}
                              catLabel={catLabel}
                              renameValue={renameValue}
                              onRenameValueChange={setRenameValue}
                              onRenameSubmit={handleRenameSubmit}
                              onCancelRename={() => setRenamingId(null)}
                              onClick={(e: React.MouseEvent) => handleItemClickClean(e, item.id, !item.isFolder)}
                              onDoubleClick={() => handleItemDoubleClick(item.id, item.isFolder)}
                              onContextMenu={(e: React.MouseEvent) => handleItemContextMenu(e, item.id, !item.isFolder)}
                              onDragStart={(e: React.DragEvent) => handleDragStart(e, item)}
                              onDropItems={handleDropItems}
                              measureElement={listVirtualizer.measureElement}
                              onChangeStatus={handleChangeStatus}
                              onOpenTag={(ident: string) => navigate(`/registry?tag=${encodeURIComponent(ident)}`)}
                            />
                          );
                        })}
                        {listVirtualizer.getVirtualItems().length > 0 && (
                          <tr style={{ height: `${listVirtualizer.getTotalSize() - listVirtualizer.getVirtualItems()[listVirtualizer.getVirtualItems().length - 1].end}px`, border: 'none' }}>
                            <td colSpan={6} style={{ padding: 0, border: 'none' }} />
                          </tr>
                        )}
                      </>
                    )}
                  </tbody>
                </motion.table>
              ) : (
              <motion.div 
                key="grid"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.15 }}
                className="w-full h-full animate-in fade-in"
              >
               {allCurrentItems.length === 0 ? (
                  <div className="p-4 flex flex-wrap gap-4 items-start content-start">
                    <div className="w-full text-center flex flex-col items-center justify-center py-20 text-slate-400">
                       <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mb-3 text-slate-300">
                           {searchQuery ? <Search className="w-8 h-8" /> : <Folder className="w-8 h-8" />}
                       </div>
                       <p className="text-sm">{searchQuery ? "Ничего не найдено — попробуйте другой запрос." : "Эта папка пуста."}</p>
                       {!searchQuery && <p className="text-xs pt-1 text-slate-400">Перетащите файлы сюда или используйте кнопку 'Загрузить'.</p>}
                    </div>
                  </div>
                ) : (
                  <div style={{ height: `${gridVirtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
                    {gridVirtualizer.getVirtualItems().map(virtualRow => {
                      const rowItems = gridRows[virtualRow.index];
                      if (!rowItems) return null;

                      return (
                        <div
                          key={virtualRow.key}
                          ref={gridVirtualizer.measureElement}
                          data-index={virtualRow.index}
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: `${virtualRow.size}px`,
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                          className="flex gap-4 p-4"
                        >
                          {rowItems.map(item => {
                            const isSelected = selectedIds.has(item.id);
                            const isRenaming = renamingId === item.id;
                            const isCut = clipboard?.type === 'cut' && clipboard.ids.includes(item.id);

                            return (
                              <FileCardItem
                                key={item.id}
                                item={item}
                                isSelected={isSelected}
                                isRenaming={isRenaming}
                                isCut={isCut}
                                loaded={!item.isFolder ? loadedMap[item.name] : undefined}
                                foreign={foreignOf(item)}
                                catLabel={catLabel}
                                renameValue={renameValue}
                                onRenameValueChange={setRenameValue}
                                onRenameSubmit={handleRenameSubmit}
                                onCancelRename={() => setRenamingId(null)}
                                onClick={(e: React.MouseEvent) => handleItemClickClean(e, item.id, !item.isFolder)}
                                onDoubleClick={() => handleItemDoubleClick(item.id, item.isFolder)}
                                onContextMenu={(e: React.MouseEvent) => handleItemContextMenu(e, item.id, !item.isFolder)}
                                onDragStart={(e: React.DragEvent) => handleDragStart(e, item)}
                                onDropItems={handleDropItems}
                              />
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}
              </motion.div>
            )}
            </AnimatePresence>
            )}
        </div>

        {/* Preview Pane */}
        {showPreviewPane && (
          <div className="hidden @[820px]:flex w-64 border-l border-slate-200 dark:border-dark-border bg-slate-50 dark:bg-dark-surface overflow-y-auto flex-col flex-shrink-0">
             {(() => {
                if (selectedIds.size === 0) return <div className="p-4 text-center text-slate-500 dark:text-dark-text-muted text-xs mt-10">Выберите файл для предпросмотра.</div>;
                if (selectedIds.size > 1) return <div className="p-4 text-center text-slate-500 dark:text-dark-text-muted text-xs mt-10">Выбрано: {countOf(selectedIds.size, 'элемент')}.</div>;

                const id = Array.from(selectedIds)[0];
                const item = allCurrentItems.find(i => i.id === id);
                if (!item) return null;

                if (item.isFolder) {
                  return (
                     <div className="p-4 flex flex-col items-center mt-10">
                       <Folder className="w-16 h-16 text-amber-500 fill-amber-200 mb-4" />
                       <h3 className="font-semibold text-slate-800 dark:text-dark-text-main text-center break-words w-full">{item.name}</h3>
                       <p className="text-xs text-slate-500 dark:text-dark-text-muted mt-2">Папка с файлами</p>
                     </div>
                  );
                }

                return (
                  <div className="p-4 flex flex-col">
                     <FilePreview item={item} icon={getFileIcon(item, 'w-12 h-12 mb-2')} />
                     
                     <h3 className="font-semibold text-slate-800 dark:text-dark-text-main mb-2 break-words text-sm">{item.name}</h3>
                     
                     <div className="space-y-2 text-xs mt-2">
                       <div className="flex justify-between border-b border-slate-100 pb-1">
                         <span className="text-slate-500 dark:text-dark-text-muted">Размер</span>
                         <span className="text-slate-800 dark:text-dark-text-main">{formatSize(item.size)}</span>
                       </div>
                       <div className="flex justify-between border-b border-slate-100 pb-1">
                         <span className="text-slate-500 dark:text-dark-text-muted">Тип</span>
                         <span className="text-slate-800 dark:text-dark-text-main flex-1 text-right truncate ml-2">{item.type}</span>
                       </div>
                       <div className="flex justify-between items-center border-b border-slate-100 pb-1">
                         <span className="text-slate-500 dark:text-dark-text-muted">Статус</span>
                         <StatusChip code={item.statusCode} onClick={(e) => { e.stopPropagation(); handleChangeStatus(item.id); }} />
                       </div>
                       <div className="flex justify-between border-b border-slate-100 pb-1">
                         <span className="text-slate-500 dark:text-dark-text-muted">Ревизия</span>
                         <span className="text-slate-800 dark:text-dark-text-main">v{item.revision || '1'}</span>
                       </div>
                       <div className="flex justify-between border-b border-slate-100 pb-1">
                         <span className="text-slate-500 dark:text-dark-text-muted">Дата изменения</span>
                         <span className="text-slate-800 dark:text-dark-text-main">{item.updatedAt ? format(new Date(item.updatedAt), 'dd.MM.yyyy HH:mm') : ''}</span>
                       </div>
                       {item.department && item.department !== "Unassigned" && (
                       <div className="flex justify-between border-b border-slate-100 pb-1">
                         <span className="text-slate-500 dark:text-dark-text-muted">Отдел</span>
                         <span className="text-slate-800 font-medium text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300 px-1.5 py-0.5 rounded">{item.department}</span>
                       </div>
                       )}
                       {((item.mainTags && item.mainTags.length > 0) || (item.additionalTags && item.additionalTags.length > 0)) && (
                       <div className="flex flex-col border-b border-slate-100 pb-1 pt-1">
                         <span className="text-slate-500 dark:text-dark-text-muted mb-1.5">Назначенные теги</span>
                         <div className="flex flex-wrap gap-1">
                           {item.mainTags?.map((t:any) => <span key={t.id} className="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded text-xs font-bold font-mono border border-amber-200" title="Основной тег">{t.identifier}</span>)}
                           {item.additionalTags?.map((t:any) => <span key={t.id} className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-xs font-mono border border-slate-200" title="Дополнительный тег">{t.identifier}</span>)}
                         </div>
                       </div>
                       )}
                       {/* Кто и когда: в общем архиве это первый вопрос к чужому файлу */}
                       {(item.updatedBy?.name || item.createdBy?.name) && (
                         <div className="flex justify-between border-b border-slate-100 dark:border-dark-border pb-1">
                           <span className="text-slate-500 dark:text-dark-text-muted">Изменил</span>
                           <span className="text-slate-800 dark:text-dark-text-main truncate ml-2">{(item.updatedBy?.name || item.createdBy?.name || '').replace(/\s*\(.*\)$/, '')}</span>
                         </div>
                       )}
                       {item.createdAt && (
                         <div className="flex justify-between border-b border-slate-100 dark:border-dark-border pb-1">
                           <span className="text-slate-500 dark:text-dark-text-muted">Создан</span>
                           <span className="text-slate-800 dark:text-dark-text-main">{format(new Date(item.createdAt), 'dd.MM.yyyy HH:mm')}</span>
                         </div>
                       )}
                     </div>

                     {/* Действия над файлом — закреплены внизу панели: на экране
                         ноутбука они иначе уходят ниже видимой части. */}
                     <div className="sticky bottom-0 -mx-4 px-4 pt-3 pb-1 bg-slate-50 dark:bg-dark-surface border-t border-slate-200 dark:border-dark-border grid grid-cols-2 gap-1.5 mt-3">
                       <button type="button" onClick={() => handleDownload(item.id, false)}
                         className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-2xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 transition-ui cursor-pointer">
                         <Download className="w-3.5 h-3.5" /> Выгрузить в Windows
                       </button>
                       <button type="button" onClick={() => handleAssignTag(item.id)}
                         className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-2xs font-semibold border border-slate-200 dark:border-dark-border hover:bg-white dark:hover:bg-dark-panel transition-ui cursor-pointer">
                         <Tag className="w-3.5 h-3.5 text-amber-500" /> Теги
                       </button>
                       <button type="button" onClick={() => { setRenamingId(item.id); setRenameValue(item.name); }}
                         className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-2xs font-semibold border border-slate-200 dark:border-dark-border hover:bg-white dark:hover:bg-dark-panel transition-ui cursor-pointer">
                         <Edit2 className="w-3.5 h-3.5" /> Переименовать
                       </button>
                       <button type="button" onClick={() => handleDelete(item.id, true)}
                         className="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-2xs font-semibold text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-ui cursor-pointer">
                         <Trash2 className="w-3.5 h-3.5" /> Удалить
                       </button>
                     </div>
                  </div>
                );
             })()}
          </div>
        )}
      </div>

      {/* Строка состояния — как в проводнике: сколько всего, что выбрано и
          что с выбранным */}
      <ExplorerStatus line={statusLine} />

      {/* Меню правой кнопки — отдельным модулем (components/explorer/ExplorerMenu) */}
      {contextMenu && (
        <ExplorerMenu
          menu={contextMenu}
          target={allCurrentItems.find(i => i.id === contextMenu.targetId)}
          currentFolderId={currentFolderId}
          hasClipboard={!!clipboard}
          canEditInConstructor={canEditInConstructor(allCurrentItems.find(i => i.id === contextMenu.targetId)?.name || '')}
          onClose={() => setContextMenu(null)}
          open={(id) => handleItemDoubleClick(id, false)}
          openWith={(href, appId) => {
            // Проводник — это мы сами: показываем файл в панели предпросмотра,
            // а не уходим по адресу к себе же
            if (appId === 'explorer') {
              setSelectedIds(new Set([contextMenu.targetId!]));
              setShowPreviewPane(true);
              return;
            }
            // Windows — тоже не адрес: файл надо выложить во временную папку и
            // отдать её проводнику системы
            if (appId === 'windows') {
              const it = allCurrentItems.find((i) => i.id === contextMenu.targetId);
              void openInWindowsSaid(String(contextMenu.targetId), String(it?.name || 'Файл'), addToast);
              return;
            }
            navigate(href);
          }}
          openFolder={navigateTo}
          refresh={fetchData}
          createFolder={createFolder}
          createDoc={createConstructorDoc}
          createTxt={() => createEmptyFile('Новый документ.txt', 'TXT', '')}
          upload={() => fileInputRef.current?.click()}
          paste={handlePaste}
          editCopy={editCopyInConstructor}
          toEquipment={openImportPicker}
          attachVdr={setVdrAttachFileId}
          download={(id) => handleDownload(id, false)}
          assignTag={handleAssignTag}
          assignDepartment={handleAssignDepartment}
          changeStatus={handleChangeStatus}
          cut={() => setClipboard({ ids: Array.from(selectedIds), type: 'cut' })}
          copy={() => setClipboard({ ids: Array.from(selectedIds), type: 'copy' })}
          rename={(id, isFile) => {
            setRenamingId(id);
            const item = isFile ? files.find(f => f.id === id) : folders.find(f => f.id === id);
            setRenameValue(item?.name || '');
          }}
          properties={(id, isFile) => {
            const item = isFile ? files.find(f => f.id === id) : folders.find(f => f.id === id);
            if (item) setPropertiesModal({ item, isFile });
          }}
          /* Папка своей карточки связей не имеет: связи есть у документа, а
             не у места, где он лежит */
          links={(id) => useInsightStore.getState().openWhere('file', id)}
          remove={(id, isFile) => handleDelete(id, isFile)}
        />
      )}

      {uploadProgress && (
        <div className="absolute bottom-10 right-6 bg-white rounded-lg shadow-xl border border-slate-200 w-80 overflow-hidden z-50">
           <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
             <h3 className="font-semibold text-slate-800 text-sm flex items-center gap-2">
               <Upload className="w-4 h-4 text-emerald-500 animate-bounce" /> Загрузка файлов
             </h3>
             {/* Мегабайты, а не «файл 1 из 3»: перенос книги на четыреста
                 мегабайт — один файл, и счётчик файлов о нём молчит */}
             <span className="text-xs font-medium text-slate-500 tabular-nums">
               {formatSize(uploadProgress.current)} из {formatSize(uploadProgress.total)}
             </span>
           </div>
           <div className="p-4">
              <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                 <div 
                    className="bg-emerald-600 h-2 rounded-full transition-ui duration-300 ease-out" 
                    style={{ width: `${Math.round((uploadProgress.current / uploadProgress.total) * 100)}%` }}
                 />
              </div>
              <p className="text-xs text-slate-500 mt-2 text-right">{Math.round((uploadProgress.current / uploadProgress.total) * 100)}%</p>
           </div>
        </div>
      )}

      {propertiesModal && (
        <FileProperties
          item={propertiesModal.item}
          isFile={propertiesModal.isFile}
          icon={getFileIcon(propertiesModal.item, 'w-6 h-6')}
          userId={user?.id || null}
          onClose={() => setPropertiesModal(null)}
          onSaved={() => { setPropertiesModal(null); fetchData(); addToast('Свойства обновлены', 'success'); }}
        />
      )}

      {assignTagModal && (
        <div className="fixed inset-0 bg-slate-950/55 backdrop-blur-md flex items-center justify-center z-50" onClick={() => setAssignTagModal(null)}>
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="bg-white rounded-lg shadow-xl border border-slate-200 w-[500px] max-w-full overflow-hidden flex flex-col max-h-[80vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-805 bg-slate-50 dark:bg-slate-950 flex items-center gap-3">
              <Tag className="w-5 h-5 text-emerald-500" />
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">Назначение тегов</h2>
            </div>
            
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <p className="text-sm text-slate-600 mb-2">Выберите основные и дополнительные теги для файла из реестра тегов проекта.</p>
              
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">Сортировка</span>
                <div className="flex bg-slate-100 rounded p-0.5">
                  <button type="button" onClick={() => setTagSortConfig({ key: 'createdAt', direction: tagSortConfig.key === 'createdAt' && tagSortConfig.direction === 'desc' ? 'asc' : 'desc'})} className={`px-2 py-1 text-xs rounded transition-colors ${tagSortConfig.key === 'createdAt' ? 'bg-white shadow-sm text-slate-800 font-medium' : 'text-slate-500 hover:text-slate-700'}`}>
                    По дате {tagSortConfig.key === 'createdAt' && (tagSortConfig.direction === 'asc' ? '↑' : '↓')}
                  </button>
                  <button type="button" onClick={() => setTagSortConfig({ key: 'identifier', direction: tagSortConfig.key === 'identifier' && tagSortConfig.direction === 'asc' ? 'desc' : 'asc'})} className={`px-2 py-1 text-xs rounded transition-colors ${tagSortConfig.key === 'identifier' ? 'bg-white shadow-sm text-slate-800 font-medium' : 'text-slate-500 hover:text-slate-700'}`}>
                    По имени {tagSortConfig.key === 'identifier' && (tagSortConfig.direction === 'asc' ? '↑' : '↓')}
                  </button>
                  <button type="button" onClick={() => setTagSortConfig({ key: 'department', direction: tagSortConfig.key === 'department' && tagSortConfig.direction === 'asc' ? 'desc' : 'asc'})} className={`px-2 py-1 text-xs rounded transition-colors ${tagSortConfig.key === 'department' ? 'bg-white shadow-sm text-slate-800 font-medium' : 'text-slate-500 hover:text-slate-700'}`}>
                    По отделу {tagSortConfig.key === 'department' && (tagSortConfig.direction === 'asc' ? '↑' : '↓')}
                  </button>
                </div>
              </div>

              <div className="max-h-60 overflow-y-auto border border-slate-200 rounded p-2 space-y-1">
                {sortedProjectTags.length === 0 ? <p className="text-sm text-slate-500 py-2 text-center">Нет тегов в реестре.</p> : (
                  sortedProjectTags.map(tag => (
                    <div key={tag.id} className="flex items-center justify-between text-sm py-1 hover:bg-slate-50 px-2 rounded">
                      <div>
                        <span className="font-medium text-slate-800 block">{tag.identifier}</span>
                        {tag.department && <span className="text-xs text-slate-500">{tag.department}</span>}
                      </div>
                      <div className="flex items-center gap-4 text-xs">
                        <label className="flex items-center gap-1 cursor-pointer">
                          <input 
                            type="checkbox" 
                            checked={assignTagModal.mainTags.includes(tag.id)}
                            onChange={(e) => {
                              setAssignTagModal(prev => {
                                if (!prev) return prev;
                                const newMain = e.target.checked ? [...prev.mainTags, tag.id] : prev.mainTags.filter(id => id !== tag.id);
                                const newAdd = e.target.checked ? prev.additionalTags.filter(id => id !== tag.id) : prev.additionalTags;
                                return { ...prev, mainTags: newMain, additionalTags: newAdd };
                              });
                            }}
                          />
                          <span>Основной</span>
                        </label>
                        <label className="flex items-center gap-1 cursor-pointer">
                          <input 
                            type="checkbox" 
                            checked={assignTagModal.additionalTags.includes(tag.id)}
                            onChange={(e) => {
                              setAssignTagModal(prev => {
                                if (!prev) return prev;
                                const newAdd = e.target.checked ? [...prev.additionalTags, tag.id] : prev.additionalTags.filter(id => id !== tag.id);
                                const newMain = e.target.checked ? prev.mainTags.filter(id => id !== tag.id) : prev.mainTags;
                                return { ...prev, mainTags: newMain, additionalTags: newAdd };
                              });
                            }}
                          />
                          <span>Дополнит.</span>
                        </label>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-100 bg-slate-50">
              <button type="button" onClick={() => setAssignTagModal(null)} className="px-4 py-2 text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 text-sm">
                Отмена
              </button>
              <button 
                type="button" 
                onClick={async () => {
                  await fetch(`/api/files/${assignTagModal.fileId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                       mainTagIds: assignTagModal.mainTags, 
                       additionalTagIds: assignTagModal.additionalTags,
                       updatedById: user?.id
                    })
                  });
                  setAssignTagModal(null);
                  fetchData();
                  addToast('Теги обновлены', 'success');
                }}
                className="px-4 py-2 text-white bg-emerald-600 hover:bg-emerald-700 rounded text-sm cursor-pointer"
              >
                Сохранить
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Выбор категории оборудования для импорта выделенных файлов */}
      {importPreview && (
        <EquipmentImportPreview
          fileIds={importPreview.fileIds}
          category={importPreview.category}
          categoryLabel={catLabel(importPreview.category)}
          projectId={activeProject?.id || 'default'}
          onClose={() => { setImportPreview(null); Promise.all([fetchData(), loadEquipMap()]); }}
          onDone={({ files, conflicts }) => {
            setImportPreview(null);
            Promise.all([fetchData(), loadEquipMap()]);
            if (conflicts > 0) addToast(`Импортировано (файлов: ${files}). Расхождений значений: ${conflicts} — нажмите для разрешения.`, 'error', () => navigate('/equipment'));
            else addToast(`Данные импортированы в оборудование (файлов: ${files}).`, 'success');
          }}
        />
      )}

      {importPickerFiles && (
        <div className="fixed inset-0 bg-slate-950/55 backdrop-blur-md flex items-center justify-center z-[70]" onClick={() => setImportPickerFiles(null)}>
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="bg-white dark:bg-dark-panel rounded-lg shadow-2xl border border-slate-200 dark:border-dark-border w-[min(94vw,460px)] max-h-[88vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-100 dark:border-dark-border bg-slate-50 dark:bg-dark-surface flex items-center gap-3">
              <Boxes className="w-5 h-5 text-emerald-600" />
              <div className="flex flex-col">
                <h2 className="text-base font-semibold text-slate-900 dark:text-white">Загрузить в оборудование</h2>
                <span className="text-xs text-slate-500 dark:text-dark-text-muted">Выбрано файлов: {importPickerFiles.length}. Выберите категорию:</span>
              </div>
            </div>
            <div className="p-3 overflow-y-auto scrollbar-thin grid grid-cols-1 gap-1.5">
              {equipCats.map(c => (
                <button type="button"
                  key={c.id}
                  onClick={() => importFilesToCategory(importPickerFiles, c.id)}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface hover:bg-emerald-50 dark:hover:bg-emerald-950/40 hover:border-emerald-400 transition-colors text-left cursor-pointer"
                >
                  <span className="w-9 h-9 rounded-lg bg-emerald-100 dark:bg-emerald-950/60 flex items-center justify-center shrink-0">
                    <Boxes className="w-5 h-5 text-emerald-600 dark:text-emerald-300" />
                  </span>
                  <span className="text-sm font-medium text-slate-800 dark:text-dark-text-main">{c.label}</span>
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100 dark:border-dark-border bg-slate-50 dark:bg-dark-surface">
              <button type="button" onClick={() => setImportPickerFiles(null)} className="px-4 py-2 text-slate-700 dark:text-slate-300 bg-white dark:bg-dark-panel border border-slate-300 dark:border-dark-border rounded-lg hover:bg-slate-50 dark:hover:bg-dark-surface text-sm cursor-pointer">
                Отмена
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Прикрепить файл к строке ВДР: файл замечаний/выпуска у документа реестра */}
      {vdrAttachFileId && (
        <VdrItemPicker
          projectId={activeProject?.id || 'default'}
          title="Прикрепить файл к строке ВДР"
          onClose={() => setVdrAttachFileId(null)}
          onPick={async (it) => {
            try {
              const r = await fetch(`/api/vdr/items/${it.id}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileNodeId: vdrAttachFileId }),
              });
              if (r.ok) addToast(`Файл прикреплён к «${it.contractorNo || it.titleRu}»`, 'success');
              else addToast('Не удалось прикрепить', 'error');
            } catch (_) { addToast('Ошибка сети', 'error'); }
            setVdrAttachFileId(null);
          }}
        />
      )}
    </motion.div>
  );
}

// Subcomponents

const TreeFolder = ({ folder, allFolders, currentFolderId, onSelect, depth = 1, onDropFiles, onMoveItems }: any) => {
  const children = allFolders.filter((f: any) => f.parentId === folder.id);
  const [expanded, setExpanded] = useState(true);
  const [isDragOver, setIsDragOver] = useState(false);
  const isSelected = currentFolderId === folder.id;

  return (
    <div>
      <div 
        onClick={() => onSelect(folder.id)}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={(e) => { e.preventDefault(); setIsDragOver(false); }}
        onDrop={async (e) => {
           e.preventDefault();
           e.stopPropagation();
           setIsDragOver(false);
           if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
              onDropFiles(e.dataTransfer.files, folder.id);
           } else {
             const dataStr = e.dataTransfer.getData('text/plain');
             if (dataStr) {
               try {
                 const data = JSON.parse(dataStr);
                 if (data.type === 'app_items') {
                   if (data.ids.includes(folder.id)) return;
                   onMoveItems(data.ids, folder.id);
                 }
               } catch (err) {}
             }
           }
        }}
        className={`flex items-center py-1.5 px-2 mx-2 rounded-lg cursor-pointer transition-colors text-slate-700 dark:text-slate-300 ${isDragOver ? 'bg-emerald-200 dark:bg-emerald-950/45' : isSelected ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200 font-medium' : 'hover:bg-slate-200/50 dark:hover:bg-slate-900'}`}
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        <div 
           className="w-4 h-4 flex items-center justify-center hover:bg-slate-300/50"
           onClick={(e) => { if(children.length) { e.stopPropagation(); setExpanded(!expanded); } }}
        >
          {children.length > 0 ? (expanded ? <ChevronDown className="w-3 h-3 text-slate-500" /> : <ChevronRight className="w-3 h-3 text-slate-500" />) : <span className="w-3 h-3" />}
        </div>
        <Folder className={`w-4 h-4 mr-2 flex-shrink-0 ${isSelected ? 'text-amber-600 fill-amber-200' : 'text-amber-500 fill-amber-100'}`} />
        <span className="truncate text-xs select-none">{folder.name}</span>
      </div>
      {expanded && children.map((child: any) => (
        <TreeFolder key={child.id} folder={child} allFolders={allFolders} currentFolderId={currentFolderId} onSelect={onSelect} depth={depth + 1} onDropFiles={onDropFiles} onMoveItems={onMoveItems} />
      ))}
    </div>
  );
};

const SkeletonRow = () => (
  <tr className="animate-pulse border-b border-slate-100 dark:border-slate-800">
    <td className="flux-cell flex items-center gap-2">
      <div className="w-5 h-5 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
      <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-40 animate-pulse" />
    </td>
    <td className="flux-cell">
      <div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-28 animate-pulse" />
    </td>
    <td className="flux-cell">
      <div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-20 animate-pulse" />
    </td>
    <td className="flux-cell hidden @[760px]:table-cell">
      <div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-16 animate-pulse" />
    </td>
    <td className="flux-cell hidden @[880px]:table-cell">
      <div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-24 animate-pulse" />
    </td>
    <td className="flux-cell hidden @[1000px]:table-cell">
      <div className="h-4 bg-slate-100 dark:bg-slate-800 rounded w-16 animate-pulse" />
    </td>
  </tr>
);

