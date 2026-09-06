/**
 * Меню «Пуск»: строка поиска, все программы, недавние и подвал с профилем.
 *
 * Раньше кнопка «Пуск» открывала общий поиск — это отвечало на «найди мне», но
 * не на «что тут вообще есть». Меню отвечает на второй вопрос: разделы видно
 * списком, включая те, что не влезли на панель задач.
 *
 * Отбор по правам, поиск по названию и список недавних считает
 * src/lib/startMenu.ts — там же они и проверяются.
 */
import React from 'react';
import { useOverlay } from '../store/overlayStore';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Search, Settings, LogOut, Sun, Moon, ArrowRight, Pin, PinOff, FolderOpen, Power, FileClock, PenLine } from 'lucide-react';
import { SECTIONS } from '../workspace/sections';
import { useStore } from '../store/store';
import { rememberSectionUse } from '../store/workspaceStore';
import { useDesktopStore } from '../store/desktopStore';
import { useInsightStore } from '../store/insightStore';
import { groupSections, countFound, pinnedTiles, stepFocus } from '../lib/startMenu';
import { useRecentStore } from '../store/recentStore';
import { visibleRecentDocs, whenLabel, kindName } from '../lib/recentDocs';
import { BAR_H, START_W, START_COLS, TILE_BOX, TILE_ICON } from '../lib/metrics';
import { Z } from '../lib/layers';
import ContextMenu, { MenuItem } from './ContextMenu';
import { can } from '../lib/permissions';
import { useToastStore } from '../store/toastStore';
import { hiddenIds } from '../lib/deskGroups';
import { openSignature } from '../lib/signEvent';

export default function StartMenu({ onClose }: { onClose: () => void }) {
  // Пока это открыто, страница браузера уступает место: родной слой Chromium
  // выше любой разметки, и без этого панель оказалась бы под страницей
  useOverlay(true);
  const user = useStore((s) => s.user);
  const setUser = useStore((s) => s.setUser);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const togglePalette = useInsightStore((s) => s.togglePalette);
  const addToast = useToastStore((s) => s.addToast);
  const navigate = useNavigate();
  const apps = useDesktopStore((s) => s.apps);
  const pinApp = useDesktopStore((s) => s.pinApp);
  const unpinApp = useDesktopStore((s) => s.unpinApp);
  const moveApp = useDesktopStore((s) => s.moveApp);
  const deskFolders = useDesktopStore((s) => s.groups);
  const bar = useDesktopStore((s) => s.bar);
  const pinBar = useDesktopStore((s) => s.pinBar);
  const unpinBar = useDesktopStore((s) => s.unpinBar);
  const [q, setQ] = React.useState('');
  const [menu, setMenu] = React.useState<{ x: number; y: number; path: string } | null>(null);
  /** Клавиатура: какая плитка сейчас под выделением */
  const [focus, setFocus] = React.useState(-1);
  /** Откуда тянут закреплённую плитку — для перестановки внутри Пуска */
  const dragFrom = React.useRef(-1);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  /** Пока значок тянут из меню, закрывать его нельзя: ронять будет некуда */
  const dragging = React.useRef(false);
  const isAdmin = user?.role === 'ADMIN';

  React.useEffect(() => { inputRef.current?.focus(); }, []);

  // Закрытие по Esc и по нажатию мимо меню: и то и другое ожидаемо
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    const onDown = (e: MouseEvent) => {
      if (dragging.current) return;
      // Своё же меню правой кнопки — портал в body, и без этой оговорки
      // нажатие по его пункту считалось нажатием мимо Пуска: Пуск закрывался,
      // меню исчезало вместе с ним, и ни «Закрепить на рабочем столе», ни
      // «Закрепить на панели задач» не срабатывали никогда
      if ((e.target as Element)?.closest?.('[data-context-menu]')) return;
      if (!boxRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    // capture: иначе кнопка «Пуск» успеет закрыть и тут же открыть меню заново
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose]);

  const groups = React.useMemo(
    // Разделы, закрытые правом, в Пуске не показываются: видный в меню, но
    // закрытый раздел — обещание, которое программа не выполнит
    () => groupSections(SECTIONS as any, isAdmin, q, (f) => can(user as any, f)),
    [isAdmin, q, user],
  );
  const found = countFound(groups);
  // «Рекомендуем» — недавние ВЕЩИ, а не разделы: человек и так помнит, что
  // работает в Конструкторе; он не помнит, как называлась вчерашняя записка
  const project = useStore((s) => s.activeProject);
  const recentDocs = useRecentStore((s) => s.docs);
  const suggested = React.useMemo(
    () => (q ? [] : visibleRecentDocs(recentDocs, project?.id || null).slice(0, 4)),
    [recentDocs, project?.id, q],
  );

  // Свой набор человека идёт первым: искать его в общем списке каждый раз незачем
  const pinnedList = React.useMemo(
    () => (q ? [] : pinnedTiles(apps, SECTIONS as any, isAdmin, (f) => can(user as any, f))),
    [apps, isAdmin, q, user],
  );

  /**
   * Плоский порядок плиток — по нему ходят стрелки.
   *
   * Считается ровно из того, что сейчас на экране: список, посчитанный «как
   * должно быть», однажды разойдётся с нарисованным, и Enter откроет не то,
   * что подсвечено.
   */
  const order = React.useMemo(
    () => [...pinnedList.map((s) => s.path), ...groups.flatMap((g) => g.items.map((i) => i.path))],
    [pinnedList, groups],
  );
  React.useEffect(() => { setFocus(-1); }, [q]);

  // Открыть — только перейти по адресу. Окно или вкладку панели заводит сама
  // оболочка: она одна знает, в каком виде сейчас показываются разделы, и
  // меню не должно об этом гадать. Раньше здесь звали панели напрямую, и в
  // оконной оболочке нажатие в Пуске не открывало ничего
  const go = (path: string) => { rememberSectionUse(path); navigate(path); onClose(); };
  const iconOf = (path: string) => SECTIONS.find((s) => s.path === path)?.icon;
  const titleOf = (path: string) => SECTIONS.find((s) => s.path === path)?.title || path;

  /**
   * «Закреплено на столе» — это ВИДНО на столе, а не «есть в списке».
   *
   * Значок программы можно снять со стола — значит, его надо уметь вернуть, и
   * место возврата очевидное: там же, где программы и перечислены.
   *
   * Значок, убранный в папку, из списка не исчезает: стол прячет его отдельно,
   * по составу папок. Пока здесь смотрели только в список, меню предлагало
   * «Убрать с рабочего стола» для значка, которого на столе нет, — то есть
   * единственное действие, которое человеку было не нужно, а нужного не
   * предлагало вовсе.
   */
  const inFolder = React.useMemo(() => hiddenIds(deskFolders), [deskFolders]);
  const pinned = (path: string) => apps.includes(path) && !inFolder.has(`app:${path}`);
  const onBar = (path: string) => bar.includes(path);
  /**
   * Закрепление закрывает Пуск и говорит словами, что случилось.
   *
   * Стол Пуск закрывает собой: значок появлялся за меню, человек ничего не
   * видел и нажимал ещё раз. Действие, которого не видно и о котором не
   * сказано, для человека просто не произошло.
   */
  const desk = (path: string, title: string) => {
    pinApp(path);
    addToast(`«${title}» на рабочем столе`, 'success');
    onClose();
  };
  const toBar = (path: string, title: string) => {
    pinBar(path);
    addToast(`«${title}» на панели задач`, 'success');
    onClose();
  };
  const menuItems: MenuItem[] = menu ? [
    { label: 'Открыть', icon: <FolderOpen className="w-3.5 h-3.5" />, onClick: () => go(menu.path) },
    pinned(menu.path)
      ? {
        label: 'Убрать с рабочего стола',
        icon: <PinOff className="w-3.5 h-3.5" />,
        onClick: () => { unpinApp(menu.path); addToast(`«${titleOf(menu.path)}» убрана со стола`, 'info'); },
      }
      : {
        label: 'Закрепить на рабочем столе',
        icon: <Pin className="w-3.5 h-3.5" />,
        onClick: () => desk(menu.path, titleOf(menu.path)),
      },
    onBar(menu.path)
      ? {
        label: 'Открепить от панели задач',
        icon: <PinOff className="w-3.5 h-3.5" />,
        onClick: () => { unpinBar(menu.path); addToast(`«${titleOf(menu.path)}» откреплена от панели`, 'info'); },
      }
      : {
        label: 'Закрепить на панели задач',
        icon: <Pin className="w-3.5 h-3.5" />,
        onClick: () => toBar(menu.path, titleOf(menu.path)),
      },
  ] : [];

  const Tile = ({ path, title, at }: { path: string; title: string; at?: number }) => {
    const Icon = iconOf(path) as any;
    const active = order[focus] === path;
    return (
      <button
        type="button"
        onClick={() => go(path)}
        onMouseEnter={() => setFocus(order.indexOf(path))}
        /* Программу тянут отсюда на стол и на панель задач — это и есть
           «закрепить». Пуск при этом не закрывается по первому нажатию: пока
           тянут, меню обязано остаться, иначе значок ронять некуда */
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'copyMove';
          e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'app_pin', path }));
          dragging.current = true;
          dragFrom.current = at ?? -1;
        }}
        /* Закреплённые меняются местами перетаскиванием — как плитки в системе.
           Тянуть на стол и на панель задач это не мешает: там ронять во что,
           а здесь роняют В плитку */
        onDragOver={at === undefined || dragFrom.current < 0 ? undefined : (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
        onDrop={at === undefined ? undefined : (e) => {
          if (dragFrom.current < 0) return;
          e.preventDefault(); e.stopPropagation();
          moveApp(dragFrom.current, at);
          dragFrom.current = -1;
          dragging.current = false;
        }}
        onDragEnd={() => { dragging.current = false; if (dragFrom.current >= 0) { dragFrom.current = -1; return; } onClose(); }}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, path }); }}
        /* Та же метка, что у пункта меню и кнопки на панели задач: демонстрация
           показывает раздел там, где он есть в этой оболочке, а не там, где его
           когда-то нарисовали */
        data-tour={`nav-${path}`}
        title={pinned(path) ? `${title} — на рабочем столе` : `${title} — потяните на стол или панель, чтобы закрепить`}
        /* Область наведения ужата до значка с подписью: раньше плитка была
           блоком с отступом в 12 пикселей со всех сторон, и шесть таких в ряд
           смотрелись стеной. Воздух теперь МЕЖДУ плитками, а не внутри них */
        className={`flex flex-col items-center gap-1.5 px-1 py-1.5 rounded-lg cursor-pointer min-w-0
                   text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850
                   transition-colors ${active ? 'bg-slate-100 dark:bg-slate-850 ring-1 ring-emerald-500' : ''}`}
      >
        <span
          style={{ width: TILE_BOX, height: TILE_BOX }}
          className="rounded-lg bg-slate-100 dark:bg-slate-850 flex items-center justify-center
                     text-emerald-700 dark:text-emerald-400 shrink-0"
        >
          {Icon && <Icon size={TILE_ICON} />}
        </span>
        <span className="text-2xs leading-tight text-center w-full line-clamp-2 break-words">{title}</span>
      </button>
    );
  };

  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-label="Пуск"
      /* Над панелью, у левого края — оттуда же, откуда его позвали.
         Портал в body и слой из lib/layers: раньше меню рисовалось внутри
         панели задач и потому оказывалось ПОД окнами программ — Пуск,
         перекрытый окном, читается как «это не система» вернее всего
         остального */
      style={{ left: 8, bottom: BAR_H + 6, zIndex: Z.start, width: START_W }}
      className="fixed max-w-[calc(100vw-1rem)]
                 rounded-2xl border border-slate-200 dark:border-dark-border
                 bg-white dark:bg-dark-surface shadow-2xl overflow-hidden"
    >
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-slate-200 dark:border-dark-border">
        <Search className="w-4 h-4 text-slate-400 shrink-0" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key.startsWith('Arrow')) {
              // Стрелки водят по плиткам, не по тексту в поле: искать буквой
              // человек уже закончил, если потянулся к стрелке
              e.preventDefault();
              setFocus((i) => stepFocus(order.length, i, e.key, START_COLS));
              return;
            }
            if (e.key !== 'Enter') return;
            // Подсвеченная плитка важнее строки поиска: человек её выбрал
            if (focus >= 0 && order[focus]) { go(order[focus]); return; }
            // Enter с запросом уводит в общий поиск: там ищется не только по
            // названиям разделов, но и по тегам, оборудованию и письмам
            if (q.trim()) { onClose(); togglePalette(); }
          }}
          placeholder="Найти раздел, а по Enter — искать везде"
          className="flex-1 min-w-0 bg-transparent outline-none text-sm
                     text-slate-800 dark:text-slate-150 placeholder:text-slate-400"
        />
        {q && (
          <button
            type="button"
            onClick={() => { onClose(); togglePalette(); }}
            className="shrink-0 flex items-center gap-1 text-2xs text-emerald-700 dark:text-emerald-400 cursor-pointer"
          >
            искать везде <ArrowRight className="w-3 h-3" />
          </button>
        )}
      </div>

      <div className="max-h-[52vh] overflow-y-auto">
        {found === 0 && (
          <p className="px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            Раздела с таким названием нет. Enter — искать по тегам, оборудованию и письмам.
          </p>
        )}

        {suggested.length > 0 && (
          <section>
            <h3 className="px-4 pt-3 pb-1 text-2xs font-bold uppercase tracking-wider text-slate-400">Рекомендуем</h3>
            <div className="px-2 pb-2">
              {suggested.map((d) => (
                <button
                  key={d.href}
                  type="button"
                  onClick={() => { navigate(d.href); onClose(); }}
                  title={`${kindName(d.kind)} · открывали ${whenLabel(d.at)}`}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer text-left
                             hover:bg-slate-100 dark:hover:bg-slate-850 transition-colors"
                >
                  <FileClock className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-slate-700 dark:text-slate-300 truncate">{d.title}</span>
                    <span className="block text-2xs text-slate-400">{kindName(d.kind)} · {whenLabel(d.at)}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {pinnedList.length > 0 && (
          <section className={suggested.length > 0 ? 'border-t border-slate-200 dark:border-dark-border' : undefined}>
            <h3 className="px-4 pt-3 pb-1 text-2xs font-bold uppercase tracking-wider text-slate-400">Закреплено</h3>
            <div className="grid gap-x-2 gap-y-3 px-3 pb-3" style={{ gridTemplateColumns: `repeat(${START_COLS}, minmax(0, 1fr))` }}>
              {pinnedList.map((s, i) => <Tile key={s.path} path={s.path} title={s.title} at={i} />)}
            </div>
          </section>
        )}

        {/* Полный список всегда раскрыт. Он был свёрнут за кнопку «Все
            программы», и человек, не нашедший раздела среди закреплённых, видел
            вместо него полосу, по которой ещё надо догадаться нажать. Список
            программ — то, ради чего Пуск и открывают */}
        {groups.map((g) => (
          <section key={g.id} className={g.id === groups[0].id && (suggested.length > 0 || pinnedList.length > 0) ? 'border-t border-slate-200 dark:border-dark-border' : undefined}>
            <h3 className="px-4 pt-3 pb-1 text-2xs font-bold uppercase tracking-wider text-slate-400">{g.title}</h3>
            <div className="grid gap-x-2 gap-y-3 px-3 pb-3" style={{ gridTemplateColumns: `repeat(${START_COLS}, minmax(0, 1fr))` }}>
              {g.items.map((s) => <Tile key={s.path} path={s.path} title={s.title} />)}
            </div>
          </section>
        ))}

      </div>

      {/* Подвал: кто вошёл и то, что раньше жило в подвале левого меню */}
      <div className="flex items-center gap-3 px-4 py-3 border-t border-slate-200 dark:border-dark-border
                      bg-slate-50 dark:bg-dark-bg">
        <span
          style={{ width: TILE_BOX, height: TILE_BOX }}
          className="rounded-full shrink-0 flex items-center justify-center text-2xs font-bold
                     bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400"
        >
          {(user?.name || '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?'}
        </span>
        <span className="min-w-0 flex-1">
          <b className="block text-sm font-semibold text-slate-800 dark:text-slate-150 truncate">{user?.name || 'Профиль'}</b>
          <span className="block text-2xs text-slate-500 dark:text-slate-400 truncate">
            {isAdmin ? 'Администратор' : 'Сотрудник'}
          </span>
        </span>
        <button
          type="button" onClick={toggleTheme} title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          style={{ width: TILE_BOX, height: TILE_BOX }}
          className="rounded-lg cursor-pointer flex items-center justify-center text-slate-500
                     hover:bg-slate-200 dark:hover:bg-slate-850 transition-colors"
        >
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
        {/* Своя подпись. Единственный вход в редактор был в подвале левого
            меню — а меню больше нет; учётная запись живёт здесь */}
        <button
          type="button" onClick={() => { onClose(); openSignature(); }} title="Моя подпись в документах"
          style={{ width: TILE_BOX, height: TILE_BOX }}
          className="rounded-lg cursor-pointer flex items-center justify-center text-slate-500
                     hover:bg-slate-200 dark:hover:bg-slate-850 transition-colors"
        >
          <PenLine className="w-4 h-4" />
        </button>
        <button
          type="button" onClick={() => go('/settings')} title="Параметры программы"
          style={{ width: TILE_BOX, height: TILE_BOX }}
          className="rounded-lg cursor-pointer flex items-center justify-center text-slate-500
                     hover:bg-slate-200 dark:hover:bg-slate-850 transition-colors"
        >
          <Settings className="w-4 h-4" />
        </button>
        <button
          type="button" onClick={() => { onClose(); setUser(null); }} title="Выйти из учётной записи"
          style={{ width: TILE_BOX, height: TILE_BOX }}
          className="rounded-lg cursor-pointer flex items-center justify-center text-slate-500
                     hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-600 transition-colors"
        >
          <LogOut className="w-4 h-4" />
        </button>
        {/* Завершение работы — только в оболочке: во вкладке браузера закрывать
            нечего, и кнопка обещала бы то, чего не сделает */}
        {!!(window as any).electron?.windowControls && (
          <button
            type="button" onClick={() => (window as any).electron.windowControls.close()} title="Завершить работу"
            style={{ width: TILE_BOX, height: TILE_BOX }}
            className="rounded-lg cursor-pointer flex items-center justify-center text-slate-500
                       hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-600 transition-colors"
          >
            <Power className="w-4 h-4" />
          </button>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>,
    document.body,
  );
}
