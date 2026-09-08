/**
 * Рабочий стол: значки под окнами.
 *
 * На столе лежат две разные вещи, и различие видно и на глаз, и в Проводнике:
 *
 *   — системные значки (разделы Flux и корзина). Их нет в Проводнике и нет в
 *     базе: это привычка сотрудника и вид Проводника, а не документы проекта;
 *   — файлы и папки — настоящие. Лежат в системной папке «Рабочий стол» — своей
 *     у каждого и одной общей на проект, — и из Проводника видны там же.
 *     Значок из общей папки помечен: по нему сразу видно, что документ видят все.
 *
 * У стола два вида: значками и списком. Значки отвечают на «где лежит», список —
 * на «что с этим»: тег, стадия, ревизия, кто менял. Колонки те же, что в
 * Проводнике, иначе один документ был бы описан в двух местах по-разному.
 *
 * Раскладку (клетки, свободные места, что не поместилось) считает
 * src/lib/desktop.ts — там же и проверки: значок под значком и значок за краем
 * стола глазом неотличимы от пропавшего файла.
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FolderPlus, Table, Type, StickyNote, Users, Lock, RefreshCw, ArrowDownAZ, Clock, Shapes,
  Pencil, Trash2, FolderOpen, PinOff, Info, LayoutGrid, List, Link2, ArrowDownToLine,
} from 'lucide-react';
import { useStore } from '../store/store';
import { useDesktopStore } from '../store/desktopStore';
import { useInsightStore } from '../store/insightStore';
import { rememberSectionUse } from '../store/workspaceStore';
import { useModalStore } from '../store/modalStore';
import { useToastStore } from '../store/toastStore';
import {
  cellToXY, xyToCell, layout, withApps, isSystemKind, BIN_ID,
  type DeskItem, type SortBy,
} from '../lib/desktop';
import { deskMetric, DESK_SCALES } from '../lib/metrics';
import { hiddenIds, groupIdOf, groupById, folderItems } from '../lib/deskGroups';
import { deskAction, isTyping } from '../lib/deskKeys';
import { appsFor, openHref, officePathForKind } from '../lib/fileTypes';
import { filesFrom, carriesFiles, uploadDropped } from '../lib/dropUpload';
import { dropLabel, heavyOnes, MB } from '../lib/dropFiles';
import { saveFileNode, openInWindowsSaid } from '../lib/saveToWindows';
import ContextMenu, { MenuItem } from './ContextMenu';
import DeskIcon, { titleOf } from './desktop/DeskIcon';
import DeskList from './desktop/DeskList';
import DeskProperties from './desktop/DeskProperties';
import DeskFolder from './desktop/DeskFolder';

/** Корзина — это вид Проводника, поэтому и открывается им */
const BIN_HREF = '/explorer?folder=trash%3Aroot';

export default function Desktop() {
  const activeProject = useStore((s) => s.activeProject);
  const user = useStore((s) => s.user);
  const navigate = useNavigate();
  const {
    items, apps, cells, sortBy, scale, selected, error, personalFolderId, trashCount, groups,
    load, select, setCell, arrangeBy, setScale, unpinApp, createFolder, createDoc, rename, remove, share, setStatus,
    acceptDrop, foldIcons, unfoldIcon, renameGroup,
  } = useDesktopStore();
  // Клетка и значок — одного размера у всех, кто их рисует: сетка, значок и
  // расчёт попадания при переносе
  const metric = deskMetric(scale);
  const openWhere = useInsightStore((s) => s.openWhere);
  const openConfirm = useModalStore((s) => s.openConfirm);
  const addToast = useToastStore((s) => s.addToast);

  const ref = React.useRef<HTMLDivElement>(null);
  const [area, setArea] = React.useState({ w: 1280, h: 720 });
  const [menu, setMenu] = React.useState<{ x: number; y: number; id: string | null } | null>(null);
  const [renaming, setRenaming] = React.useState<{ id: string; value: string } | null>(null);
  const [band, setBand] = React.useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [dragging, setDragging] = React.useState<{ id: string; dx: number; dy: number; x: number; y: number } | null>(null);
  const [props, setProps] = React.useState<string | null>(null);
  const [dropHere, setDropHere] = React.useState(false);
  /** Что человек несёт из Windows — подписью под курсором, пока он не отпустил */
  const [carry, setCarry] = React.useState('');
  /** Сколько файлов уже легло: перенос книги на 20 МБ — дело не мгновенное */
  const [taking, setTaking] = React.useState<{ done: number; total: number } | null>(null);
  const pickRef = React.useRef<HTMLInputElement>(null);
  /** Раскрытая папка: полотно поверх стола, а не окно */
  const [folder, setFolder] = React.useState<string | null>(null);
  // Начатый перенос средствами браузера отменяет перенос указателем: иначе
  // значок и уедет по сетке, и переедет в другую папку одним движением
  const nativeDrag = React.useRef(false);
  // Вид стола личный и живёт рядом с местами значков: это привычка человека,
  // а не свойство проекта
  const [asList, setAsList] = React.useState(() => {
    try { return localStorage.getItem('flux_desk_view') === 'list'; } catch (_) { return false; }
  });
  const setView = (list: boolean) => {
    try { localStorage.setItem('flux_desk_view', list ? 'list' : 'icons'); } catch (_) { /* приватный режим */ }
    setAsList(list);
  };

  const projectId = activeProject?.id || '';
  React.useEffect(() => { load(projectId); }, [projectId, load]);

  // Меряем стол сами: сетка считается в точках, а сколько их — знает только DOM
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setArea({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * Полный список значков стола — ДО того, как папки что-то спрячут.
   *
   * Отдельно от `all` не для красоты: содержимое папки ищется именно здесь.
   * Пока папка искала свои значки в уже отфильтрованном списке, она находила
   * ноль (её же значки оттуда и убраны) и открывалась пустым белым полотном.
   */
  const base = React.useMemo(() => withApps(items, apps), [items, apps]);

  /**
   * Что лежит на столе с учётом папок: спрятанное в папках со стола убирается,
   * а сами папки встают значками. Иначе значок был бы виден и там и там —
   * и человек не понимал бы, где он на самом деле.
   */
  const all = React.useMemo(() => {
    const hidden = hiddenIds(groups);
    const byId = new Map(base.map((i) => [i.id, i]));
    const folders: DeskItem[] = groups.map((g) => ({
      id: groupIdOf(g),
      kind: 'group' as const,
      name: g.name,
      shared: false,
      members: g.items.filter((i) => byId.has(i)),
    }));
    return [...folders, ...base.filter((i) => !hidden.has(i.id))];
  }, [base, groups]);
  const view = React.useMemo(() => layout(all, cells, area, metric), [all, cells, area, metric]);

  /**
   * Открыть — значит только перейти по адресу. Окно (в оконной оболочке) или
   * вкладку панели (в панельной) заводит сама оболочка, увидев новый адрес.
   *
   * Раньше здесь и окно открывалось, и адрес менялся — и оболочка, увидев
   * новое окно, тут же уводила адрес на голый раздел: документ открывался
   * пустым, потому что «?doc=…» стирался на полпути. Одно действие — один
   * механизм.
   */
  const go = (to: string) => { rememberSectionUse(to.split('?')[0]); navigate(to); };

  const openItem = (item: DeskItem) => {
    if (item.kind === 'group') { setFolder(item.id); return; }
    if (item.kind === 'app' && item.path) return go(item.path);
    if (item.kind === 'bin') return go(BIN_HREF);
    // Папка стола открывается в Проводнике: второго проводника у программы нет,
    // и заводить его ради стола — значит развести два разных дерева одних папок
    if (item.kind === 'folder') return go(`/explorer?folder=${encodeURIComponent(item.id)}`);
    // Чем открыть — решает общая таблица сопоставлений (lib/fileTypes), одна на
    // стол и на Проводник. Пока их было две, чертёж со стола попадал в
    // предпросмотр, а из Проводника — в редактор пометок
    if (appsFor(item)[0]?.id === 'windows') { void openInWindowsSaid(item.id, item.name, addToast); return; }
    go(openHref(item));
  };

  // ── Перетаскивание значка ────────────────────────────────────────────────
  /**
   * Слушаем окно, а не сам значок. Захват указателя на значке выглядит короче,
   * но держится, только пока цел его узел, — а стол перерисовывается от любого
   * обновления списка (создали файл, коллега выложил документ на общий стол).
   * Перерисовка посреди переноса рвала захват: значок замирал под курсором и
   * оставался на месте, будто перенос не начинали. Окно живёт всегда.
   */
  const startDrag = (e: React.PointerEvent, item: DeskItem) => {
    if (e.button !== 0 || renaming) return;
    const cell = view.cells.get(item.id);
    const box = ref.current?.getBoundingClientRect();
    if (!cell || !box) return;
    e.preventDefault();
    nativeDrag.current = false;
    const at = cellToXY(cell, metric);
    // Смещение внутри значка запоминаем, иначе значок «прыгает» под курсор
    const dx = e.clientX - box.left - at.x;
    const dy = e.clientY - box.top - at.y;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      const x = ev.clientX - box.left - dx;
      const y = ev.clientY - box.top - dy;
      // Четыре точки: дрожание руки при нажатии не должно считаться переносом,
      // иначе значки разъезжаются от простых нажатий
      if (nativeDrag.current) { moved = false; return; }
      if (!moved && Math.abs(x - at.x) < 4 && Math.abs(y - at.y) < 4) return;
      moved = true;
      setDragging({ id: item.id, dx, dy, x, y });
    };
    const finish = (ev: PointerEvent, cancelled: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      setDragging(null);
      if (!moved || cancelled) return;
      const x = ev.clientX - box.left - dx + metric.w / 2;
      const y = ev.clientY - box.top - dy + metric.h / 2;
      const cell = xyToCell(x, y, area, metric);
      // Значок на значок — папка, как в системе на телефоне. Именно этого и
      // просил владелец; прежняя перестановка местами была нашей выдумкой,
      // и её никто не звал
      let occupant: string | null = null;
      view.cells.forEach((c, id) => {
        if (id !== item.id && c.col === cell.col && c.row === cell.row) occupant = id;
      });
      if (occupant && occupant !== BIN_ID && item.id !== BIN_ID) {
        foldIcons(item.id, occupant);
        return;
      }
      setCell(item.id, cell, area);
    };
    const onUp = (ev: PointerEvent) => finish(ev, false);
    // Перенос отменили (Esc, системный жест) — значок обязан вернуться, а не
    // остаться там, где его бросили на полпути
    const onCancel = (ev: PointerEvent) => finish(ev, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  // ── Выделение рамкой по пустому месту ────────────────────────────────────
  const startBand = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const x1 = e.clientX - box.left;
    const y1 = e.clientY - box.top;
    select([]);
    setRenaming(null);

    const onMove = (ev: PointerEvent) => {
      const x2 = ev.clientX - box.left;
      const y2 = ev.clientY - box.top;
      setBand({ x1, y1, x2, y2 });
      const l = Math.min(x1, x2); const r = Math.max(x1, x2);
      const t = Math.min(y1, y2); const b = Math.max(y1, y2);
      const hit: string[] = [];
      view.cells.forEach((cell, id) => {
        const p = cellToXY(cell, metric);
        if (p.x < r && p.x + metric.w > l && p.y < b && p.y + metric.h > t) hit.push(id);
      });
      select(hit);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setBand(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const doRemove = async (item: DeskItem) => {
    if (item.kind === 'app') { unpinApp(item.path || ''); return; }
    if (item.kind === 'bin') return; // корзину со стола не убирают
    const ok = await openConfirm(
      item.kind === 'folder' ? 'Убрать папку со стола?' : 'Убрать файл со стола?',
      'Со стола он уйдёт в корзину Проводника — оттуда его можно вернуть.',
      { confirmLabel: 'Убрать', tone: 'danger' },
    );
    if (!ok) return;
    try { await remove(item.id, projectId); } catch (e: any) { addToast(e?.message || 'Не удалось убрать', 'error'); }
  };

  const doShare = async (item: DeskItem) => {
    try {
      await share(item.id, item.shared ? 'PERSONAL' : 'SHARED', projectId);
      addToast(item.shared ? 'Вернулось на ваш стол' : 'Теперь лежит на общем столе — видят все', 'success');
    } catch (e: any) { addToast(e?.message || 'Не удалось перенести', 'error'); }
  };

  const create = async (what: 'folder' | 'DOC' | 'TEXT' | 'NOTE', scope: 'SHARED' | 'PERSONAL') => {
    try {
      if (what === 'folder') { await createFolder(projectId, scope); return; }
      const id = await createDoc(projectId, what, scope);
      // Вид документа известен здесь и нигде больше: заводили-то мы его
      // сами. Дальше по адресу видно, какая программа открылась
      if (id) go(`${officePathForKind(what)}?doc=${encodeURIComponent(id)}`);
    } catch (e: any) { addToast(e?.message || 'Не удалось создать', 'error'); }
  };

  const target = menu?.id ? all.find((i) => i.id === menu.id) || null : null;
  const canPersonal = !!personalFolderId && !!user;

  const itemMenu = (item: DeskItem): MenuItem[] => isSystemKind(item.kind)
    ? [
      { label: 'Открыть', icon: <FolderOpen className="w-3.5 h-3.5" />, onClick: () => openItem(item) },
      ...(item.kind === 'app'
        ? [{ label: 'Убрать со стола', icon: <PinOff className="w-3.5 h-3.5" />, onClick: () => unpinApp(item.path || '') }]
        : []),
      { label: 'Свойства', icon: <Info className="w-3.5 h-3.5" />, onClick: () => setProps(item.id) },
    ]
    : [
      { label: 'Открыть', icon: <FolderOpen className="w-3.5 h-3.5" />, onClick: () => openItem(item) },
      // «Открыть с помощью» — только там, где есть из чего выбирать: у чертежа
      // это редактор пометок и предпросмотр Проводника. Пункт, ведущий туда же,
      // куда и «Открыть», был бы обманом выбора
      ...(item.kind === 'file' ? appsFor(item).slice(1).map((app) => ({
        label: `Открыть в: ${app.name}`,
        icon: <FolderOpen className="w-3.5 h-3.5" />,
        // Windows — не адрес внутри программы: файл выкладывается во временную
        // папку и отдаётся системе
        onClick: () => (app.id === 'windows'
          ? void openInWindowsSaid(item.id, item.name, addToast)
          : go(app.href(item))),
      })) : []),
      { label: 'Переименовать', icon: <Pencil className="w-3.5 h-3.5" />, onClick: () => setRenaming({ id: item.id, value: item.name }) },
      // Дорога обратно в Windows. Для файла она прямая: те же байты, та же
      // папка, откуда его принесли. Документы Flux выгружаются из своего
      // редактора — там известно, во что их превращать
      ...(item.kind === 'file' ? [{
        label: 'Выгрузить в Windows',
        icon: <ArrowDownToLine className="w-3.5 h-3.5" />,
        onClick: () => { void exportItem(item); },
      }] : []),
      {
        label: item.shared ? 'Убрать с общего стола' : 'Положить на общий стол',
        icon: item.shared ? <Lock className="w-3.5 h-3.5" /> : <Users className="w-3.5 h-3.5" />,
        disabled: item.shared && !canPersonal,
        onClick: () => doShare(item),
      },
      {
        // Одна вещь целиком: где встречается тег этого документа, в каких
        // строках ВДР он выпускается, каким письмом его отправляли. Раньше
        // это открывалось только из помощника и проверки проекта — то есть
        // почти никогда
        label: 'Карточка связей',
        icon: <Link2 className="w-3.5 h-3.5" />,
        onClick: () => (item.kind === 'doc' && item.refId
          ? openWhere('doc', item.refId)
          : openWhere('file', item.id)),
      },
      { label: 'Свойства', icon: <Info className="w-3.5 h-3.5" />, onClick: () => setProps(item.id) },
      { label: 'Убрать со стола', separated: true, icon: <Trash2 className="w-3.5 h-3.5" />, danger: true, onClick: () => doRemove(item) },
    ];

  /**
   * Меню стола: шесть строк наверху, остальное — в подменю.
   *
   * Раньше все двенадцать пунктов стояли одним столбцом, и «Упорядочить по
   * стадии» приходилось искать глазами среди «Создать заметку» и «Обновить».
   * Правило верхнего уровня — не длиннее семи строк (см. ContextMenu).
   *
   * Куда кладём новое: на свой стол, если он есть. «На общем столе» — отдельным
   * пунктом, а не переключателем: положить документ всем на виду случайным
   * нажатием нельзя.
   */
  const deskMenu: MenuItem[] = [
    {
      label: 'Создать',
      icon: <FolderPlus className="w-3.5 h-3.5" />,
      items: [
        { label: 'Папку', icon: <FolderPlus className="w-3.5 h-3.5" />, onClick: () => create('folder', canPersonal ? 'PERSONAL' : 'SHARED') },
        { label: 'Таблицу', icon: <Table className="w-3.5 h-3.5" />, onClick: () => create('DOC', canPersonal ? 'PERSONAL' : 'SHARED') },
        { label: 'Текстовый документ', icon: <Type className="w-3.5 h-3.5" />, onClick: () => create('TEXT', canPersonal ? 'PERSONAL' : 'SHARED') },
        { label: 'Заметку', icon: <StickyNote className="w-3.5 h-3.5" />, onClick: () => create('NOTE', 'PERSONAL') },
        { label: 'Таблицу на общем столе', separated: true, icon: <Users className="w-3.5 h-3.5" />, onClick: () => create('DOC', 'SHARED') },
      ],
    },
    {
      // У стола не было ни выбора файла, ни вставки из буфера — только перенос
      // мышью. Мышью носят не все и не всегда: с ноутбука в поезде это просто
      // невозможно
      label: 'Добавить файл…',
      icon: <ArrowDownToLine className="w-3.5 h-3.5" />,
      onClick: () => pickRef.current?.click(),
    },
    {
      label: 'Вид',
      icon: <LayoutGrid className="w-3.5 h-3.5" />,
      items: [
        ...DESK_SCALES.map((s): MenuItem => ({
          label: s.label, checked: scale === s.id, onClick: () => setScale(s.id),
        })),
        { label: 'Значками', separated: true, checked: !asList, icon: <LayoutGrid className="w-3.5 h-3.5" />, onClick: () => setView(false) },
        { label: 'Списком', checked: asList, icon: <List className="w-3.5 h-3.5" />, onClick: () => setView(true) },
      ],
    },
    {
      label: 'Сортировка',
      icon: <ArrowDownAZ className="w-3.5 h-3.5" />,
      items: [
        { label: 'По имени', checked: sortBy === 'name', icon: <ArrowDownAZ className="w-3.5 h-3.5" />, onClick: () => arrangeBy('name', area) },
        { label: 'По дате', checked: sortBy === 'date', icon: <Clock className="w-3.5 h-3.5" />, onClick: () => arrangeBy('date', area) },
        { label: 'По типу', checked: sortBy === 'kind', icon: <Shapes className="w-3.5 h-3.5" />, onClick: () => arrangeBy('kind', area) },
        { label: 'По стадии', checked: sortBy === 'status', icon: <Shapes className="w-3.5 h-3.5" />, onClick: () => arrangeBy('status', area) },
      ],
    },
    { label: 'Обновить', separated: true, icon: <RefreshCw className="w-3.5 h-3.5" />, onClick: () => load(projectId) },
    { label: 'Открыть в Проводнике', icon: <FolderOpen className="w-3.5 h-3.5" />, onClick: () => go('/explorer') },
  ];

  const propsItem = props ? all.find((i) => i.id === props) || null : null;

  /**
   * Перенос между столом и Проводником — средствами браузера, тем же
   * содержимым, что кладёт Проводник (`app_items`). Так документ переносится
   * в обе стороны одним и тем же запросом; свой формат означал бы, что
   * перенос со стола и перенос в Проводнике однажды разойдутся.
   *
   * Пометка «desk» отличает перекладывание значка по столу от переноса файла
   * в другую папку: снаружи это одно движение, а внутри — разные вещи.
   */
  const onIconDragStart = (e: React.DragEvent, item: DeskItem) => {
    if (isSystemKind(item.kind)) { e.preventDefault(); return; }
    nativeDrag.current = true;
    setDragging(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'app_items', ids: [item.id], desk: true }));
  };

  /**
   * Принять файлы Windows: положить в личную папку стола и поставить значок в
   * ту клетку, куда метили.
   *
   * Правила приёма (что берём, под каким именем, что говорим) — в
   * src/lib/dropFiles.ts, отправка — в dropUpload.ts. Здесь только стол:
   * место значка и то, что человек видит, пока файл едет.
   */
  const takeFiles = async (files: File[], cell: { col: number; row: number } | null) => {
    // Предела на размер нет, но полгигабайта лягут в общую базу и в резервную
    // копию: спрашиваем один раз, а не отказываем
    const heavy = heavyOnes(files);
    if (heavy.length && !await openConfirm(
      'Файл очень большой',
      `${heavy.map((f) => f.name).join(', ')} — это ${MB(heavy.reduce((n, f) => n + f.size, 0))}. `
      + 'Он ляжет в общую базу и попадёт в резервную копию, а перенос займёт время. Продолжить?',
      { confirmLabel: 'Загрузить' },
    )) return;
    const before = new Set(useDesktopStore.getState().items.map((i) => i.id));
    const taken = useDesktopStore.getState().items.map((i) => i.name);
    setTaking({ done: 0, total: files.length });
    const out = await uploadDropped(
      files,
      { folderId: personalFolderId, scope: 'PERSONAL', ownerId: user?.id || null, userId: user?.id || null },
      taken,
      (done, total) => setTaking({ done, total }),
    );
    setTaking(null);
    if (out.ok) {
      await load(projectId);
      // Новые значки — те, которых не было до переноса. Первый ложится в
      // клетку, куда целились, остальные — рядом, чтобы не сесть друг на друга
      if (cell) {
        const fresh = useDesktopStore.getState().items.filter((i) => !before.has(i.id));
        fresh.forEach((item, n) => setCell(item.id, { col: cell.col + n, row: cell.row }, area));
      }
    }
    if (out.said) addToast(out.said, out.ok ? (out.refused.length || out.failed.length ? 'info' : 'success') : 'error');
  };

  /** Выгрузить файл обратно в Windows — в ту папку, откуда его принесли */
  const exportItem = async (item: DeskItem) => {
    const out = await saveFileNode(item.id);
    if (out.canceled) return;
    addToast(out.ok ? `Сохранено: ${out.path || item.name}` : (out.error || 'Не удалось выгрузить'), out.ok ? 'success' : 'error');
  };

  const onDeskDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropHere(false);
    setCarry('');
    const box = ref.current?.getBoundingClientRect();

    /**
     * Файл, принесённый из Windows.
     *
     * Этого не было вовсе: приём читал только своё содержимое переноса и молча
     * выходил, если пришло чужое. Человек тащил на стол книгу Excel — и не
     * получал ни значка, ни ошибки, ни объяснения.
     *
     * Кладём в ту клетку, куда метили: значок «где-нибудь» означает, что
     * человек будет искать его глазами по всему столу.
     */
    const brought = filesFrom(e.dataTransfer);
    if (brought.length) {
      const cell = box && !asList
        ? xyToCell(e.clientX - box.left + metric.w / 2 - 24, e.clientY - box.top + metric.h / 2 - 24, area, metric)
        : null;
      await takeFiles(brought, cell);
      return;
    }

    let data: any = null;
    try { data = JSON.parse(e.dataTransfer.getData('text/plain') || 'null'); } catch (_) { data = null; }

    // Программу принесли из Пуска: закрепляем её ровно в той клетке, куда
    // отпустили. Класть значок «куда-нибудь» нельзя — человек метил в место
    if (data && data.type === 'app_pin' && typeof data.path === 'string') {
      const { pinApp, setCell } = useDesktopStore.getState();
      pinApp(data.path);
      if (box && !asList) {
        const cell = xyToCell(e.clientX - box.left + metric.w / 2 - 24, e.clientY - box.top + metric.h / 2 - 24, area, metric);
        setCell(`app:${data.path}`, cell, area);
      }
      addToast('Программа на рабочем столе', 'success');
      return;
    }

    if (!data || data.type !== 'app_items' || !Array.isArray(data.ids)) return;

    // Со стола на стол — это перекладывание значка, а не перенос файла
    if (data.desk) {
      if (!box || asList) return;
      const cell = xyToCell(e.clientX - box.left + metric.w / 2 - 24, e.clientY - box.top + metric.h / 2 - 24, area, metric);
      setCell(data.ids[0], cell, area);
      return;
    }
    try {
      await acceptDrop(data.ids, projectId);
      addToast(data.ids.length > 1 ? 'Перенесено на ваш стол' : 'Документ на вашем столе', 'success');
    } catch (err: any) { addToast(err?.message || 'Не удалось перенести на стол', 'error'); }
  };

  /**
   * Клавиши стола. Правила — в src/lib/deskKeys.ts: там же и проверки, потому
   * что перехваченное не вовремя сочетание не падает и не мигает, а молча
   * отнимает клавишу у того, кто печатает.
   *
   * Окно поверх стола забирает клавиши себе: пока открыт Конструктор, Delete
   * относится к ячейке таблицы, а не к значку под окном.
   */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (renaming) return;
      const act = deskAction(e, {
        typing: isTyping(document.activeElement as any),
        hasSelection: selected.length > 0,
      });
      if (!act) return;
      const one = selected.length === 1 ? all.find((i) => i.id === selected[0]) : null;
      if (act === 'clearSelection') { select([]); setProps(null); return; }
      if (act === 'selectAll') { e.preventDefault(); select(all.map((i) => i.id)); return; }
      if (act === 'refresh') { e.preventDefault(); load(projectId); return; }
      if (act === 'toggleView') { setView(!asList); return; }
      if (!one) return;
      if (act === 'open') { e.preventDefault(); openItem(one); }
      if (act === 'properties') { e.preventDefault(); setProps(one.id); }
      if (act === 'rename' && !isSystemKind(one.kind)) { e.preventDefault(); setRenaming({ id: one.id, value: one.name }); }
      if (act === 'remove') { e.preventDefault(); doRemove(one); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <>
    {/* Выбор файла: у стола его не было вовсе — только перенос мышью */}
    <input
      ref={pickRef}
      type="file"
      multiple
      className="hidden"
      onChange={(e) => {
        const picked = Array.from(e.target.files || []);
        e.target.value = '';
        if (picked.length) void takeFiles(picked, null);
      }}
    />
    <div
      ref={ref}
      onPointerDown={asList ? undefined : startBand}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id: null }); }}
      onDragOver={(e) => {
        e.preventDefault();
        // Файл из Windows — это «скопировать», а не «переместить»: курсор
        // должен обещать то, что произойдёт на самом деле
        e.dataTransfer.dropEffect = carriesFiles(e.dataTransfer) ? 'copy' : 'move';
      }}
      onDragEnter={(e) => {
        // Подсветка только для чужого: своё перекладывание по столу и так видно
        try {
          if (carriesFiles(e.dataTransfer)) {
            setDropHere(true);
            // Имена файлов до отпускания браузер не отдаёт — только их число.
            // Говорим то, что знаем: сколько файлов и куда они лягут
            const n = e.dataTransfer.items ? Array.from(e.dataTransfer.items).filter((i) => i.kind === 'file').length : 0;
            setCarry(dropLabel(Array.from({ length: n }, () => ({ name: 'файл', size: 1 }))));
            return;
          }
          if (e.dataTransfer.types.includes('text/plain')) setDropHere(true);
        } catch (_) { /* некоторые источники не дают заглянуть в содержимое */ }
      }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) { setDropHere(false); setCarry(''); } }}
      onDrop={onDeskDrop}
      className={`absolute inset-0 overflow-hidden select-none ${
        dropHere ? 'ring-2 ring-inset ring-emerald-500/60 bg-emerald-500/5' : ''
      }`}
    >
      {error && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-lg text-2xs font-semibold
                        bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border border-rose-200 dark:border-rose-900">
          Стол не прочитан: {error}
        </div>
      )}

      {/* Что произойдёт, если отпустить, — сказано словами, а не одной рамкой */}
      {(!!carry || !!taking) && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 rounded-lg text-2xs font-semibold
                        bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300
                        border border-emerald-200 dark:border-emerald-900 shadow-sm">
          {/* Мегабайты, а не «файл 1 из 3»: книга на четыреста мегабайт —
              один файл, и счётчик файлов о ней молчит */}
          {taking ? `Переношу на стол… ${MB(taking.done)} из ${MB(taking.total)}` : carry}
        </div>
      )}

      {asList ? (
        <DeskList
          items={all}
          selected={selected}
          sortBy={sortBy}
          onSort={(by) => arrangeBy(by, area)}
          onSelect={select}
          onOpen={openItem}
          onMenu={(e, item) => {
            e.preventDefault(); e.stopPropagation();
            select([item.id]);
            setMenu({ x: e.clientX, y: e.clientY, id: item.id });
          }}
        />
      ) : all.map((item) => {
        const cell = view.cells.get(item.id);
        if (!cell) return null;
        const at = cellToXY(cell, metric);
        const isDragged = dragging?.id === item.id;
        return (
          <DeskIcon
            key={item.id}
            item={item}
            metric={metric}
            x={isDragged ? dragging.x : at.x}
            y={isDragged ? dragging.y : at.y}
            selected={selected.includes(item.id)}
            dragged={isDragged}
            badge={item.id === BIN_ID ? trashCount : undefined}
            renaming={renaming?.id === item.id ? renaming.value : null}
            onRenameChange={(v) => setRenaming({ id: item.id, value: v })}
            onRenameCommit={() => { if (renaming) rename(item.id, renaming.value, projectId); setRenaming(null); }}
            onRenameCancel={() => setRenaming(null)}
            draggable={!isSystemKind(item.kind)}
            onDragStart={(e) => onIconDragStart(e, item)}
            onDragEnd={() => { nativeDrag.current = false; setDragging(null); }}
            onPointerDown={(e) => { e.stopPropagation(); select([item.id]); startDrag(e as any, item); }}
            onDoubleClick={() => openItem(item)}
            onContextMenu={(e) => {
              e.preventDefault(); e.stopPropagation();
              select([item.id]);
              setMenu({ x: e.clientX, y: e.clientY, id: item.id });
            }}
          />
        );
      })}

      {band && !asList && (
        <div
          aria-hidden
          style={{
            left: Math.min(band.x1, band.x2), top: Math.min(band.y1, band.y2),
            width: Math.abs(band.x2 - band.x1), height: Math.abs(band.y2 - band.y1),
          }}
          className="absolute z-[4] rounded border border-emerald-500 bg-emerald-500/10 pointer-events-none"
        />
      )}

      {/* Что не поместилось — сказано вслух. Молча спрятать значок значит
          показать человеку пустое место там, где лежит его документ */}
      {!asList && view.overflow.length > 0 && (
        <button
          type="button"
          onClick={() => setView(true)}
          className="absolute bottom-3 right-3 z-[6] px-2.5 py-1 rounded-lg cursor-pointer text-2xs font-semibold
                     bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400
                     border border-amber-200 dark:border-amber-900 hover:brightness-95"
        >
          ещё {view.overflow.length} не поместилось — показать списком
        </button>
      )}

      {propsItem && (
        <DeskProperties
          item={propsItem}
          onClose={() => setProps(null)}
          onStatus={async (code) => {
            try { await setStatus(propsItem.id, code, projectId); }
            catch (e: any) { addToast(e?.message || 'Не удалось сменить стадию', 'error'); }
          }}
          onOpenPlace={() => {
            setProps(null);
            if (propsItem.folderId) {
              go(`/explorer?file=${encodeURIComponent(propsItem.id)}&folder=${encodeURIComponent(propsItem.folderId)}`);
            } else go(`/explorer?folder=${encodeURIComponent(propsItem.id)}`);
          }}
        />
      )}

      {folder && (() => {
        const g = groupById(groups, folder);
        if (!g) return null;
        // Из ПОЛНОГО списка: значки программ живут только в нём, а спрятанное
        // папкой из `all` уже вычищено — вместе оба промаха давали пустую папку
        const inside = folderItems(g, base);
        return (
          <DeskFolder
            group={g}
            items={inside}
            scale={scale}
            onOpen={openItem}
            onOut={(item) => unfoldIcon(g.id, item.id)}
            onRename={(name) => renameGroup(g.id, name)}
            onClose={() => setFolder(null)}
          />
        );
      })()}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={target ? itemMenu(target) : deskMenu}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
    </>
  );
}
