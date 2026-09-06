import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { formatName } from '../lib/docFormula';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store/store';
const SignatureEditor = React.lazy(() => import('./SignatureEditor'));
import { Database, Folder, Home, LogOut, Settings, FileText, Plus, Book, ChevronDown, ChevronRight, ChevronLeft, Menu, Tag, Sun, Moon, Users, ClipboardList, Layers, MessageSquare, ChevronUp, X, User, Loader2, Check, Terminal, MessagesSquare, NotebookPen, FolderKanban, FolderOpen, Fan, BookOpen, Briefcase, Table2, PanelLeftClose, PanelLeftOpen, PenLine, Mail, LifeBuoy, Languages, Globe, CalendarDays } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import ToastProvider from './ToastProvider';
import ModalProvider from './ModalProvider';
import CaptureReview from './CaptureReview';
import { dataService } from '../services/dataService';
import { useLogStore } from '../store/logStore';
import { useAssistantStore } from '../store/assistantStore';
import RightDock from './RightDock';
import RightRail from './RightRail';
import ShareLayer from './ShareLayer';
import CommandBar from './CommandBar';
import { useReminderStore, onReminder } from '../store/reminderStore';
import { useShellNotifyStore, toastOf } from '../store/shellNotifyStore';
import { shouldNotifySystem, notifyText, badgeCount } from '../lib/systemNotify';
import { OPEN_URL_EVENT } from '../lib/openLink';
import { useBrowserStore } from '../store/browserStore';
import { useCalendarStore } from '../store/calendarStore';
import { occurrences, isDue, untilLabel, MINUTE, HOUR } from '../lib/calendar';
import { isQuiet } from '../lib/notifCenter';
import { useWindowStore } from '../store/windowStore';
import { onFreshNotifications } from '../store/notificationStore';
import { shouldPopup, shouldSound, playNotifSound } from '../lib/notifPrefs';
import NotifyToasts from './shell/NotifyToasts';
import InsightDrawer from './insight/InsightDrawer';
import FluxLogo from './FluxLogo';
import { useNotificationStore } from '../store/notificationStore';
import Workspace from './Workspace';
import Taskbar from './Taskbar';
import WindowsLayer from './WindowsLayer';
import { BAR_H } from '../lib/metrics';
import ProjectSwitcher from './ProjectSwitcher';
import ContextMenu, { MenuItem } from './ContextMenu';
import { useWorkspaceStore, visiblePanes, openSectionWindow, rememberSectionUse } from '../store/workspaceStore';
import { useTranslateStore } from '../store/translateStore';
import QuickTranslate from './translate/QuickTranslate';
import { useModalStore } from '../store/modalStore';

// Диалоги программы вместо системных окон Windows
const { openAlert } = useModalStore.getState();

/**
 * Состояние окна: свёрнуто ли и в фокусе ли оно. В браузере окна нет —
 * считаем, что человек смотрит сюда, и наружу ничего не шлём.
 */
async function windowState(): Promise<{ minimized: boolean; focused: boolean }> {
  const api = (window as any).electron?.notify;
  if (!api?.windowState) return { minimized: false, focused: true };
  try {
    const s = await api.windowState();
    return { minimized: !!s?.minimized, focused: !!s?.focused };
  } catch (_) { return { minimized: false, focused: true }; }
}

/**
 * Уведомление на рабочий стол Windows. Решение «показывать ли» принимает
 * чистое правило (lib/systemNotify), а не это место: тихий режим, настройки
 * категории и состояние окна должны считаться в одном месте и проверяться.
 */
async function notifySystem(
  n: { title?: string; body?: string; targetRoute?: string; category?: string },
  win: { minimized: boolean; focused: boolean },
): Promise<void> {
  const api = (window as any).electron?.notify;
  const ok = shouldNotifySystem({
    minimized: win.minimized,
    focused: win.focused,
    quiet: isQuiet(useShellNotifyStore.getState().quiet),
    allowed: shouldPopup(n.category),
    desktop: !!api?.system,
  });
  if (!ok) return;
  const text = notifyText(n.title || 'Flux', n.body || '');
  try { await api.system({ ...text, route: n.targetRoute || '' }); } catch (_) { /* система отказала */ }
}

export default function Layout() {
  const { user, setUser, activeProject, theme, toggleTheme, syncStatus, sidebarCompact, toggleSidebarCompact, shell } = useStore();
  const navigate = useNavigate();
  const [eqOpen, setEqOpen] = useState(true);
  // Робот-помощник: его можно выключить в настройках — тогда он не создаётся
  // вовсе, а не прячется, чтобы не тратить ни таймеров, ни отрисовки.
  // Активный раздел активной панели рабочего стола (для подсветки меню)
  const wsLayout = useWorkspaceStore((s) => s.layout);
  const wsActivePath = useWorkspaceStore((s) => {
    const p = s.panes.find((x) => x.id === s.activePaneId);
    return p ? (p.stack.includes(p.active) ? p.active : p.stack[p.stack.length - 1]) : '/';
  });
  const openInActivePane = useWorkspaceStore((s) => s.openInActivePane);

  /**
   * Словарь и память переводов тянем один раз на проект, а не в каждом окне.
   * Перевод нужен и в Почте, и в Конструкторе, и над выделенным текстом — если
   * бы каждый грузил своё, письмо переводилось бы одними словами, а ведомость
   * другими, и заказчик получил бы два разных названия одного узла.
   */
  React.useEffect(() => {
    if (activeProject?.id) useTranslateStore.getState().load(activeProject.id);
  }, [activeProject?.id]);

  /**
   * Календарь читается оболочкой, а не только своим разделом: напоминания
   * должны приходить, пока человек работает в ведомости, — то есть тогда,
   * когда календарь закрыт. Раздел, открывшись, перечитает его сам.
   */
  React.useEffect(() => {
    void useCalendarStore.getState().load(activeProject?.id || '');
  }, [activeProject?.id]);

  /**
   * F1 — руководство по разделу, в котором человек сейчас находится.
   *
   * Открывать общее оглавление и предлагать искать себя в нём — значит
   * заставлять человека объяснять программе то, что она и так знает: он
   * стоит в Тегах, спрашивает про Теги. Путь уходит в адрес, раздел
   * «Руководство» разбирает его сам.
   */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F1') return;
      e.preventDefault();

      /**
       * В оконной оболочке справка открывается окном и встаёт в правую
       * половину стола — рядом с тем, про что она. Раньше F1 подменял содержимое
       * панели: раздел, про который спрашивают, при этом закрывался собой же, и
       * читать инструкцию приходилось по памяти о том, что было на экране.
       */
      if (useStore.getState().shell === 'windows') {
        const st = useWindowStore.getState();
        const shown = st.windows.filter((w) => !w.minimized && w.desk === st.desk && w.path !== '/handbook');
        const top = shown.length ? shown.reduce((a, b) => (b.z > a.z ? b : a)) : null;
        const path = top?.path || '/';
        st.open(`/handbook?for=${encodeURIComponent(path)}`);
        // Ставим справку в правую половину, а раздел — в левую: половина на
        // половину и есть «рядом». Уже стоявшее окно не двигаем второй раз
        const win = useWindowStore.getState().windows
          .filter((w) => w.path === '/handbook' && w.desk === st.desk)
          .reduce<any>((a, b) => (!a || b.z > a.z ? b : a), null);
        if (win) useWindowStore.getState().putInShare(win.id, { x: 0.5, y: 0, w: 0.5, h: 1 });
        if (top) useWindowStore.getState().putInShare(top.id, { x: 0, y: 0, w: 0.5, h: 1 });
        return;
      }

      const path = wsActivePath || '/';
      if (path === '/handbook') return; // уже здесь — не мешаем читать
      // Панель хранит адрес раздела отдельно от пути: сначала кладём адрес с
      // вопросом, потом открываем вкладку, иначе руководство откроется на
      // статье, которую читали до этого
      const ws = useWorkspaceStore.getState();
      const href = `/handbook?for=${encodeURIComponent(path)}`;
      ws.setFrozenHref(ws.activePaneId, '/handbook', href);
      openInActivePane('/handbook');
      navigate(href);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wsActivePath, openInActivePane]);
  // ПКМ по разделу в меню: открыть в конкретной панели / в отдельном окне
  const [navMenu, setNavMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  // Вход пользователя: восстанавливаем его сохранённую раскладку рабочего стола
  // и даём помощнику имя — он заводится раньше, чем становится известен вход
  React.useEffect(() => {
    useWorkspaceStore.getState().bindUser(user?.id || null);
    useAssistantStore.getState().greet(user as any);
  }, [user?.id, user?.name]);

  /**
   * Ширина правого рельса — на корне документа, а не на этом узле.
   * Ею пользуются и то, что внутри оболочки (боковые панели, когда на узком
   * окне ложатся поверх содержимого и должны оставить рельс открытым), и то,
   * что вне её (плавающий значок журнала живёт в App, рядом с Layout).
   * Раньше отступ был вписан числом 72 и после первой же смены ширины рельса
   * оказался бы неверным.
   */
  React.useEffect(() => {
    // Правый рельс остался только при левом меню: он был его зеркалом, и без
    // меню зеркалить нечего. В остальных оболочках его работу делает панель
    // задач, а ноль здесь означает, что раздвижные панели прижимаются к самому
    // краю окна, а не оставляют полосу пустоты шириной с исчезнувший рельс
    const railed = shell === 'menu';
    document.documentElement.style.setProperty('--flux-rail-w', railed ? (sidebarCompact ? '56px' : '96px') : '0px');
  }, [sidebarCompact, shell]);

  /**
   * Напоминания, поставленные строкой «Спросить» («/напомни завтра в 9 …»).
   * Часы заводятся здесь, потому что Layout открыт всегда: заведи их в панели
   * помощника — и напоминание не пришло бы, пока панель закрыта, то есть
   * почти никогда.
   */
  React.useEffect(() => {
    const st = useReminderStore.getState();
    const show = (r: { id: string; text: string; href?: string }) => {
      useShellNotifyStore.getState().push({
        id: r.id, title: 'Напоминание', body: r.text, route: r.href, source: 'reminder',
      });
    };
    onReminder(show);
    // Просроченные показываем сразу при запуске: программа могла быть закрыта
    for (const r of st.takeDue()) show(r);
    st.start();
    return () => useReminderStore.getState().stop();
  }, []);

  /**
   * Новое уведомление всплывает карточкой над панелью задач — с «Открыть» и
   * «Отложить». Показываем только то, что пришло впервые (см. notifCenter), и
   * только если человек не приглушил поток и не выключил эту категорию в
   * настройках: тихий режим обязан молчать, иначе он ничего не значит.
   */
  React.useEffect(() => {
    onFreshNotifications(async (list) => {
      const push = useShellNotifyStore.getState().push;
      // Состояние окна спрашиваем один раз на пачку: между двумя уведомлениями
      // одной пачки человек к окну не вернётся
      const win = await windowState();
      for (const n of list) {
        if (!shouldPopup(n.category)) continue;
        push(toastOf(n));
        if (shouldSound(n.category)) { try { playNotifSound(n.category); } catch (_) { /* без звука */ } }
        // …и на рабочий стол Windows, если человек смотрит не сюда
        void notifySystem(n, win);
      }
    });
  }, []);

  /**
   * Нажатие по уведомлению Windows возвращает окно и открывает то самое место.
   * Уведомление, после которого приходится вспоминать, о чём оно было, только
   * отнимает время.
   */
  React.useEffect(() => {
    const api = (window as any).electron?.notify;
    if (!api?.onOpen) return;
    return api.onOpen((route: string) => { if (route) navigate(route); });
  }, [navigate]);


  /**
   * Отложенное возвращается само. Раз в минуту: отложить можно на четверть
   * часа и дольше, и чаще проверять нечего
   */
  React.useEffect(() => {
    const t = setInterval(() => {
      const due = useShellNotifyStore.getState().releaseDue();
      if (!due.length) return;
      const back = useNotificationStore.getState().personal.filter((n) => due.includes(n.id));
      for (const n of back) useShellNotifyStore.getState().push(toastOf(n));
    }, 60000);
    return () => clearInterval(t);
  }, []);

  /**
   * Уведомления опрашиваются, пока программа открыта. Опрос жил в правом
   * рельсе — вместе с ним он бы и пропал, а уведомления просто перестали бы
   * приходить, ничем этого не показав. Место опроса — здесь: Layout открыт
   * всегда, в любой оболочке.
   */
  React.useEffect(() => {
    const st = useNotificationStore.getState();
    if (user?.id) st.startPolling(user.id);
    const onFocus = () => { if (user?.id) useNotificationStore.getState().fetch(user.id); };
    window.addEventListener('focus', onFocus);
    return () => { useNotificationStore.getState().stopPolling(); window.removeEventListener('focus', onFocus); };
  }, [user?.id]);

  /**
   * Высота нижней панели — переменной, а не числом в каждом месте: всё, что
   * висит у нижнего края (журнал действий, всплывающие сообщения), должно
   * подниматься над панелью, иначе она их накрывает.
   */
  React.useEffect(() => {
    document.documentElement.style.setProperty('--flux-taskbar-h', shell === 'menu' ? '0px' : `${BAR_H}px`);
  }, [shell]);
  // На Главной (/) в режиме одного окна левой панели нет; иначе она закреплена
  const sidebarHidden = shell !== 'menu' || (wsLayout === 'single' && wsActivePath === '/');
  const chatUnread = useNotificationStore((s) => s.chatUnread);
  const notifUnread = useNotificationStore((s) => s.unread);

  /**
   * Напоминания календаря.
   *
   * Часы заводятся здесь, а не в самом календаре: раздел закрыт почти всегда, и
   * напоминание из него не пришло бы никогда. Раз в полминуты — чаще незачем,
   * самый короткий срок напоминания пять минут.
   *
   * Одно напоминание звонит один раз: ключ помнит и событие, и его появление,
   * иначе еженедельная планёрка звонила бы каждые тридцать секунд.
   */
  React.useEffect(() => {
    const tick = async () => {
      const cal = useCalendarStore.getState();
      const now = Date.now();
      const list = occurrences(cal.visible(), now - 10 * MINUTE, now + 2 * HOUR);
      const win = await windowState();
      for (const o of list) {
        const remind = o.event.remindMin;
        if (!isDue(o.startsAt, remind, now)) continue;
        const key = `${o.event.id}@${o.startsAt}`;
        if (cal.fired.includes(key)) continue;
        cal.markFired(key);
        useShellNotifyStore.getState().push({
          id: key,
          title: o.event.title,
          body: `${untilLabel(o.startsAt, now)}${o.event.guests.length ? ` · ${o.event.guests.length} чел.` : ''}`,
          route: '/calendar',
          source: 'reminder',
          category: 'СИСТЕМА',
          action: o.event.joinUrl ? { label: 'Подключиться', url: o.event.joinUrl } : undefined,
        });
        // …и на рабочий стол Windows, если человек смотрит не сюда: встреча
        // через пять минут — ровно тот случай, ради которого это и делалось
        void notifySystem(
          { title: o.event.title, body: untilLabel(o.startsAt, now), targetRoute: '/calendar', category: 'СИСТЕМА' },
          win,
        );
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 30_000);
    return () => clearInterval(t);
  }, []);

  /**
   * Ссылка откуда угодно открывается вкладкой браузера, а не выбрасывает
   * человека в Windows: вернуться оттуда можно только через панель задач,
   * потеряв место.
   */
  React.useEffect(() => {
    const onOpen = (e: Event) => {
      const url = String((e as CustomEvent).detail || '');
      if (!url) return;
      useBrowserStore.getState().setPending(url);
      rememberSectionUse('/browser');
      navigate('/browser');
    };
    window.addEventListener(OPEN_URL_EVENT, onOpen as EventListener);
    return () => window.removeEventListener(OPEN_URL_EVENT, onOpen as EventListener);
  }, [navigate]);

  /** Число на значке программы в панели Windows — то же, что в трее Flux */
  React.useEffect(() => {
    const api = (window as any).electron?.notify;
    if (!api?.badge) return;
    api.badge(badgeCount(notifUnread)).catch(() => {});
  }, [notifUnread]);
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  // Окно своей подписи: открывается из профиля
  const [signOpen, setSignOpen] = useState(false);
  const addLog = useLogStore((state) => state.addLog);

  // Глобальный перехват событий для детального логирования действий пользователя.
  // Пишем КАЖДЫЙ клик (кнопка, поле, строка, пустое место) — чтобы при ошибке
  // по журналу было видно, что именно нажали и что произошло дальше.
  const describeElement = React.useCallback((el: HTMLElement, target?: HTMLElement): string => {
    const getAttr = (node: HTMLElement | undefined, attr: string): string | null => {
      if (!node) return null;
      const val = node.getAttribute(attr);
      return val && val.trim() ? val.trim() : null;
    };
    const labelOrTitle = getAttr(el, 'aria-label') || getAttr(el, 'title') || getAttr(el, 'placeholder')
      || getAttr(target, 'aria-label') || getAttr(target, 'title') || getAttr(target, 'placeholder');
    let text = '';
    if (el.textContent) {
      text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text.length > 40) text = text.substring(0, 37) + '...';
    }
    const idOrName = getAttr(el, 'id') || getAttr(el, 'name') || getAttr(target, 'id') || getAttr(target, 'name');
    const shareLabel = getAttr(el, 'data-share-label');
    return labelOrTitle || shareLabel || text || idOrName || `<${el.tagName.toLowerCase()}>`;
  }, []);

  const handleGlobalClick = React.useCallback((e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target || typeof target.tagName !== 'string') return;

    const tagName = target.tagName.toUpperCase();

    // 1. Клик в поле ввода — отдельная запись (видно, если поле «не печатает»)
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || (target as any).isContentEditable) {
      const inputEl = target as HTMLInputElement;
      if (inputEl.type === 'password') {
        addLog('INFO', 'UI_CLICK', 'Клик в поле пароля');
        return;
      }
      const state = inputEl.disabled ? ' [ПОЛЕ ОТКЛЮЧЕНО]' : (inputEl.readOnly ? ' [ТОЛЬКО ЧТЕНИЕ]' : '');
      addLog('INFO', 'UI_CLICK', `Клик в поле: "${describeElement(target)}"${state}`);
      return;
    }

    // 2. Ближайший интерактивный элемент (кнопка/ссылка/пункт списка)
    let interactive: HTMLElement | null = null;
    let current: HTMLElement | null = target;
    while (current && current !== document.body && current !== document.documentElement) {
      const tn = current.tagName.toUpperCase();
      const role = current.getAttribute('role');
      const classes = current.className || '';
      const hasCursorPointer = typeof classes === 'string' && (classes.includes('cursor-pointer') || current.classList.contains('cursor-pointer'));
      if (
        tn === 'BUTTON' ||
        tn === 'A' ||
        role === 'button' ||
        role === 'option' ||
        hasCursorPointer ||
        current.closest('[role="listbox"]') ||
        current.getAttribute('aria-haspopup') === 'listbox'
      ) {
        interactive = current;
        break;
      }
      current = current.parentElement;
    }

    if (interactive) {
      const disabledNote = (interactive as HTMLButtonElement).disabled ? ' [КНОПКА ОТКЛЮЧЕНА]' : '';
      addLog('INFO', 'UI_CLICK', `Нажата кнопка/элемент: "${describeElement(interactive, target)}"${disabledNote}`);
      return;
    }

    // 3. Прочие клики (строка, карточка, пустое место) — тоже фиксируем
    const desc = describeElement(target);
    addLog('INFO', 'UI_CLICK', `Клик: ${desc}`);
  }, [addLog, describeElement]);

  // Фокус в поле ввода: фиксируем сам факт входа в поле —
  // если дальше нет записи о вводе, значит поле не принимало текст
  const handleGlobalFocus = React.useCallback((e: FocusEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target || typeof target.tagName !== 'string') return;
    const tagName = target.tagName.toUpperCase();
    if (tagName !== 'INPUT' && tagName !== 'TEXTAREA' && tagName !== 'SELECT' && !(target as any).isContentEditable) return;
    if (tagName === 'INPUT' && (target as HTMLInputElement).type === 'password') return;
    addLog('INFO', 'UI_FOCUS', `Фокус в поле: "${describeElement(target)}"`);
  }, [addLog, describeElement]);

  const handleGlobalBlur = React.useCallback((e: FocusEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target || typeof target.tagName !== 'string') return;

    const tagName = target.tagName.toUpperCase();
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
      const element = target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

      // Исключаем пароли из соображений безопасности
      if (tagName === 'INPUT' && (element as HTMLInputElement).type === 'password') {
        return;
      }

      // Название поля по приоритетам: placeholder, связанный label, name, id
      let fieldName = '';

      if ('placeholder' in element && element.placeholder) {
        fieldName = element.placeholder;
      }

      if (!fieldName && element.id) {
        const associatedLabel = document.querySelector(`label[for="${element.id}"]`);
        if (associatedLabel && associatedLabel.textContent) {
          fieldName = associatedLabel.textContent.trim();
        }
      }

      if (!fieldName) {
        const surroundingLabel = element.closest('label');
        if (surroundingLabel && surroundingLabel.textContent) {
          fieldName = surroundingLabel.textContent.trim();
        }
      }

      if (!fieldName && element.name) {
        fieldName = element.name;
      }

      if (!fieldName && element.id) {
        fieldName = element.id;
      }

      if (!fieldName) {
        fieldName = `Поле ${tagName.toLowerCase()}`;
      }

      fieldName = fieldName.replace(/\s+/g, ' ').trim();
      if (fieldName.length > 40) {
        fieldName = fieldName.substring(0, 37) + '...';
      }

      // Получаем значение
      let value = element.value;
      if (tagName === 'SELECT') {
        const selectEl = element as HTMLSelectElement;
        if (selectEl.selectedIndex >= 0) {
          const selectedOption = selectEl.options[selectEl.selectedIndex];
          if (selectedOption && selectedOption.text) {
            value = selectedOption.text.trim();
          }
        }
      }

      if (value && value.trim()) {
        addLog('INFO', 'UI_INPUT', `В поле "${fieldName}" введено значение: "${value}"`);
      }
    }
  }, [addLog]);

  React.useEffect(() => {
    window.addEventListener('click', handleGlobalClick, true);
    window.addEventListener('blur', handleGlobalBlur, true);
    window.addEventListener('focus', handleGlobalFocus, true);

    // Ошибки JS и промисов — сразу в журнал, рядом с последним кликом
    const onError = (e: ErrorEvent) => {
      addLog('ERROR', 'JS_ERROR', `${e.message} (${e.filename?.split('/').pop() || ''}:${e.lineno})`, e.error?.stack);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason: any = e.reason;
      addLog('ERROR', 'PROMISE', String(reason?.message || reason), reason?.stack);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    return () => {
      window.removeEventListener('click', handleGlobalClick, true);
      window.removeEventListener('blur', handleGlobalBlur, true);
      window.removeEventListener('focus', handleGlobalFocus, true);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [handleGlobalClick, handleGlobalBlur, handleGlobalFocus, addLog]);

  const handleLogout = () => {
    setUser(null);
    navigate('/');
  };

  // Контроль доступа: периодически проверяем, что профиль не отключен и не просрочен.
  // Выбрасываем из сессии только при явном valid === false (а не при недоступности сервера).
  React.useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const verify = async () => {
      try {
        const res = await dataService.checkAuth(user.id);
        if (!cancelled && res && res.valid === false) {
          addLog('WARN', 'Безопасность', `Сессия завершена: ${res.reason || 'доступ отозван администратором'}`);
          void openAlert('Доступ к программе закрыт', res.reason || 'Администратор отозвал доступ к системе. Обратитесь к нему, если это ошибка.');
          handleLogout();
        }
      } catch (e) {}
    };
    verify();
    const interval = setInterval(verify, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user?.id]);

  const renderAvatar = (isTrigger: boolean = false) => {
    let borderClass = "";
    let bgClass = "";
    
    if (syncStatus === 'saving') {
      borderClass = "border-emerald-500 ring-2 ring-emerald-500/20";
      bgClass = "bg-emerald-50 dark:bg-emerald-950/40";
    } else if (syncStatus === 'success') {
      borderClass = "border-emerald-500 ring-2 ring-emerald-500/20";
      bgClass = "bg-emerald-50 dark:bg-emerald-950/40";
    } else if (syncStatus === 'error') {
      borderClass = "border-rose-500 ring-2 ring-rose-500/20 animate-pulse";
      bgClass = "bg-rose-50 dark:bg-rose-950/20";
    } else {
      if (isTrigger) {
        borderClass = "border-slate-300 dark:border-dark-border";
        bgClass = "bg-slate-200/80 dark:bg-dark-panel";
      } else {
        borderClass = "border-emerald-200 dark:border-emerald-900";
        bgClass = "bg-emerald-100 dark:bg-emerald-950";
      }
    }

    const containerClasses = `w-9 h-9 rounded-full flex items-center justify-center text-sm font-extrabold text-emerald-700 dark:text-emerald-400 border transition-ui duration-350 shrink-0 select-none ${borderClass} ${bgClass}`;

    return (
      <div className={containerClasses} id={isTrigger ? "profile-trigger-avatar" : "profile-popover-avatar"}>
        <AnimatePresence mode="wait">
          {syncStatus === 'idle' && (
            <motion.span
              key="idle"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.15 }}
              className="block"
            >
              {user?.name?.charAt(0).toUpperCase()}
            </motion.span>
          )}
          
          {syncStatus === 'saving' && (
            <motion.div
              key="saving"
              initial={{ opacity: 0, scale: 0.8, rotate: -180 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={{ opacity: 0, scale: 0.8, rotate: 180 }}
              transition={{ duration: 0.2 }}
              className="flex items-center justify-center"
            >
              <Loader2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 animate-spin" />
            </motion.div>
          )}
          
          {syncStatus === 'success' && (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
              className="flex items-center justify-center"
            >
              <Check className="w-5 h-5 text-emerald-500" />
            </motion.div>
          )}
          
          {syncStatus === 'error' && (
            <motion.div
              key="error"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.15 }}
              className="flex items-center justify-center relative font-sans text-rose-500"
              title="Ошибка синхронизации"
            >
              <span className="w-2.5 h-2.5 bg-rose-500 rounded-full" id="avatar-sync-error" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  // Разделы сгруппированы по тому, чьи в них данные (см. src/lib/projectScope.ts).
  //
  // Раньше группировка была «по смыслу», и по ней нельзя было понять главного:
  // почему Теги при переключении проекта меняются целиком, а Почта — нет.
  // Теперь это написано прямо над группой. Проводник переехал из первой группы
  // во вторую: файлы видны все, независимо от открытого проекта.
  const navGroups: { label?: string; items: { name: string; path: string; icon: any }[] }[] = [
    { items: [
      { name: 'Главная', path: '/', icon: Home },
      { name: 'Проекты', path: '/projects', icon: FolderKanban },
    ] },
    { label: 'Проект', items: [
      { name: 'Теги', path: '/registry', icon: Tag },
      { name: 'Оборудование', path: '/equipment', icon: Fan },
      { name: 'Справочник', path: '/directory', icon: BookOpen },
      { name: 'Менеджмент', path: '/management', icon: Briefcase },
      { name: 'Конструктор', path: '/constructor', icon: Table2 },
      { name: 'Переводчик', path: '/translate', icon: Languages },
    ] },
    { label: 'Общее', items: [
      { name: 'Проводник', path: '/explorer', icon: FolderOpen },
      { name: 'Блокнот', path: '/notes', icon: NotebookPen },
      { name: 'Мессенджер', path: '/chat', icon: MessagesSquare },
      { name: 'Почта', path: '/mail', icon: Mail },
      { name: 'Браузер', path: '/browser', icon: Globe },
      { name: 'Календарь', path: '/calendar', icon: CalendarDays },
      ...(user && user.role === 'ADMIN' ? [{ name: 'Сотрудники', path: '/users', icon: Users }] : []),
      { name: 'Руководство', path: '/handbook', icon: LifeBuoy },
    ] },
  ];

  const navButton = (item: { name: string; path: string; icon: any }) => {
    const active = wsActivePath === item.path;
    const chatGlow = item.path === '/chat' && chatUnread > 0 && !active;
    return (
      <button
        key={item.path}
        type="button"
        onClick={() => openInActivePane(item.path)}
        onContextMenu={(e) => { e.preventDefault(); setNavMenu({ x: e.clientX, y: e.clientY, path: item.path }); }}
        data-tour={`nav-${item.path}`}
        data-share-route={item.path}
        data-share-focus={`nav:${item.path}`}
        data-share-label={item.name}
        title={item.name}
        aria-current={active ? 'page' : undefined}
        className={`relative flex items-center cursor-pointer transition-colors duration-[120ms] ${
          sidebarCompact
            ? 'justify-center h-10 rounded-lg'
            : 'flex-col justify-center gap-0.5 py-1 rounded-xl'
        } ${
          active
            // Активный раздел — светлая плашка с зелёной меткой слева, а не
            // сплошная заливка: полный цвет остаётся за кнопками действий,
            // и длинные названия больше не упираются в края.
            ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300 font-semibold before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-1 before:rounded-r before:bg-emerald-600 dark:before:bg-emerald-400'
            : chatGlow
              ? 'text-emerald-700 dark:text-emerald-400 ring-1 ring-emerald-400/60'
              : 'text-slate-500 dark:text-dark-text-muted hover:bg-slate-100 dark:hover:bg-dark-panel hover:text-slate-900 dark:hover:text-white'
        }`}
      >
        <item.icon className="w-5 h-5 shrink-0" />
        {!sidebarCompact && (
          <span className="text-2xs font-semibold leading-none text-center break-words px-0.5">{item.name}</span>
        )}
        {item.path === '/chat' && chatUnread > 0 && (
          <span className="absolute top-0.5 right-1 min-w-4 h-4 px-1 rounded-full bg-emerald-600 text-white text-2xs font-bold flex items-center justify-center">{chatUnread}</span>
        )}
      </button>
    );
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-slate-50 dark:bg-dark-bg text-slate-800 dark:text-dark-text-main font-sans relative transition-colors duration-250">
      {/* overflow-hidden обязателен: в скрытом состоянии ширина 0, и без обрезки
          содержимое меню продолжает рисоваться поверх раздела — держалось это
          только на прозрачности. */}
      <aside className={`${sidebarHidden ? 'w-0 opacity-0 -translate-x-full pointer-events-none' : `${sidebarCompact ? 'w-14' : 'w-24'} opacity-100 translate-x-0`} overflow-hidden bg-white dark:bg-dark-surface text-slate-700 dark:text-dark-text-muted flex flex-col transition-[width,opacity,transform] duration-[240ms] shrink-0 border-r border-slate-200 dark:border-dark-border`}>
        <div className="px-1.5 pt-2 pb-1.5 flex flex-col items-center gap-1 border-b border-slate-200 dark:border-dark-border">
          <div className="flex items-center gap-1.5">
            <FluxLogo size={sidebarCompact ? 24 : 28} />
            {!sidebarCompact && <h1 className="text-sm font-extrabold tracking-tight text-slate-900 dark:text-white leading-none">Flux</h1>}
          </div>
          <ProjectSwitcher compact={sidebarCompact} />
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {/* Зазор минимальный: на ноутбуке 1366×768 все разделы должны
              помещаться без прокрутки — прокручиваемое главное меню
              прячет разделы и найти их нельзя. */}
          <nav className="flex flex-col gap-0.5 px-1.5" aria-label="Разделы программы">
            {navGroups.map((g, gi) => (
              <React.Fragment key={gi}>
                {gi > 0 && <hr className="my-1 border-slate-200 dark:border-dark-border" />}
                {/* Подпись группы. В узком меню значки идут без названий, и
                    подпись там осталась бы единственным текстом — она сжата до
                    точки-разделителя, а смысл переехал в подсказку. */}
                {g.label && (
                  <div
                    title={g.label === 'Проект' ? 'Данные открытого проекта: сменили проект — сменилось всё' : 'Общее для всей программы: от проекта не зависит'}
                    className={`text-2xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 select-none ${
                      sidebarCompact ? 'text-center leading-none pb-0.5' : 'px-1 pb-0.5'
                    }`}
                  >
                    {sidebarCompact ? g.label.slice(0, 3) : g.label}
                  </div>
                )}
                {g.items.map(navButton)}
              </React.Fragment>
            ))}
          </nav>
        </div>

        <div className="px-1.5 pt-2 pb-2.5 border-t border-slate-200 dark:border-dark-border bg-slate-50 dark:bg-dark-surface shrink-0 relative">
          {createPortal(
            <AnimatePresence>
            {isProfileMenuOpen && (
              <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-slate-950/55 backdrop-blur-md" onClick={() => setIsProfileMenuOpen(false)}>
                {/* Centered profile modal */}
                <motion.div
                  onClick={(e) => e.stopPropagation()}
                  initial={{ opacity: 0, scale: 0.96, y: 12 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96, y: 12 }}
                  transition={{ duration: 0.15, ease: 'easeOut' }}
                  className="w-[min(94vw,420px)] bg-white dark:bg-dark-panel rounded-lg border border-slate-200 dark:border-dark-border shadow-2xl p-4 flex flex-col gap-2.5 text-left select-none text-slate-800 dark:text-dark-text-main max-h-[88vh] overflow-y-auto scrollbar-none"
                >
                  {/* Header info */}
                  <div className="flex items-center gap-2.5 pb-2.5 border-b border-slate-100 dark:border-dark-border">
                    {renderAvatar(false)}
                    <div className="flex flex-col min-w-0 overflow-hidden">
                      <span className="text-xs font-bold text-slate-900 dark:text-white leading-tight truncate">{user?.name}</span>
                      <span className="text-xs uppercase tracking-wider font-extrabold text-emerald-600 dark:text-emerald-400 leading-normal">{user?.role}</span>
                    </div>
                  </div>

                  {/* Данные профиля */}
                  <div className="flex flex-col gap-1.5">
                    {[
                      ['ФИО', user?.name],
                      // Как человек подпишется в документах: собирается из
                      // фамилии, имени и отчества — «Раупов Хусрав Хуршедович»
                      // даёт «Раупов Х.Х.». Видно сразу, правильно ли заведено ФИО
                      ['В документах', formatName({
                        lastName: (user as any)?.lastName,
                        firstName: (user as any)?.firstName,
                        middleName: (user as any)?.middleName,
                        name: user?.name,
                      }, 'initialsAfter')],
                      ['Логин', user?.symbol],
                      ['Роль', user?.role],
                    ].map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between px-2.5 py-2 rounded-lg border border-slate-150 dark:border-dark-border bg-slate-50 dark:bg-dark-surface/40 text-xs">
                        <span className="text-slate-400 dark:text-dark-text-muted font-semibold">{k}</span>
                        <span className="text-slate-800 dark:text-dark-text-main font-bold truncate ml-2">{v || '—'}</span>
                      </div>
                    ))}
                  </div>

                  {/* Своя подпись — здесь, а не в «Сотрудниках»: тот раздел
                      открыт только администратору, и рядовой инженер иначе не
                      смог бы завести свою подпись вовсе */}
                  <button type="button"
                    onClick={() => { setIsProfileMenuOpen(false); setSignOpen(true); }}
                    className="flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs font-bold text-slate-700 dark:text-dark-text-main bg-slate-100 dark:bg-dark-surface hover:bg-slate-200 dark:hover:bg-dark-panel border border-slate-200 dark:border-dark-border rounded-lg transition-ui cursor-pointer"
                  >
                    <PenLine className="w-3.5 h-3.5 text-emerald-600" />
                    Моя подпись
                  </button>

                  {/* Все настройки перенесены в раздел «Настройки» (левая панель) */}
                  <button type="button"
                    onClick={() => { setIsProfileMenuOpen(false); openInActivePane('/settings'); }}
                    className="flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs font-bold text-slate-700 dark:text-dark-text-main bg-slate-100 dark:bg-dark-surface hover:bg-slate-200 dark:hover:bg-dark-panel border border-slate-200 dark:border-dark-border rounded-lg transition-ui cursor-pointer"
                  >
                    <Settings className="w-3.5 h-3.5 text-emerald-600" />
                    Настройки программы
                  </button>

                  {/* Foot Actions: Logout */}
                  <button type="button" 
                    onClick={handleLogout}
                     className="flex w-full items-center justify-center gap-1 px-2 py-2 text-xs text-rose-650 hover:text-white hover:bg-rose-600 active:scale-98 border border-rose-500/10 hover:border-transparent rounded-lg transition-ui font-bold cursor-pointer mt-0.5"
                  >
                    <LogOut className="w-3 h-3 mr-1 text-rose-500 shrink-0" />
                    Выйти из аккаунта
                  </button>
                </motion.div>
              </div>
            )}
            </AnimatePresence>,
            document.body
          )}

          {/* Через портал в body: у боковой панели свой контейнер для
              position:fixed, и окно отрисовывалось сжатым в её колонку.
              Соседнее меню профиля выводится порталом ровно поэтому же. */}
          {signOpen && user && createPortal(
            <React.Suspense fallback={null}>
              <SignatureEditor
                userId={user.id}
                userName={user.name || user.symbol}
                nameParts={{ lastName: (user as any).lastName, firstName: (user as any).firstName, middleName: (user as any).middleName, name: user.name }}
                canEdit
                onSaved={() => {}}
                onClose={() => setSignOpen(false)}
              />
            </React.Suspense>,
            document.body,
          )}

          {/* Ширина меню: только значки или значки с подписями. Выбор
              запоминается — на узком экране подписи можно убрать и
              вернуть содержимому 40 пикселей. */}
          <button
            type="button"
            onClick={toggleSidebarCompact}
            title={sidebarCompact ? 'Показать подписи разделов' : 'Убрать подписи, оставить значки'}
            aria-label={sidebarCompact ? 'Показать подписи разделов' : 'Убрать подписи, оставить значки'}
            className="w-full flex items-center justify-center h-7 mb-1 rounded-lg text-slate-400 dark:text-dark-text-muted hover:bg-slate-100 dark:hover:bg-dark-panel hover:text-slate-700 dark:hover:text-white transition-colors duration-[120ms] cursor-pointer"
          >
            {sidebarCompact ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>

          {/* Настройки программы — над профилем (перенесены из окна профиля) */}
          <button
            type="button"
            onClick={() => openInActivePane('/settings')}
            data-share-route="/settings"
            data-share-label="Настройки"
            title="Настройки программы"
            aria-current={wsActivePath === '/settings' ? 'page' : undefined}
            className={`relative w-full flex items-center cursor-pointer select-none transition-colors duration-[120ms] ${
              sidebarCompact ? 'justify-center h-10 rounded-lg mb-1' : 'flex-col justify-center gap-0.5 py-1 mb-1 rounded-xl'
            } ${
              wsActivePath === '/settings'
                ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300 font-semibold before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-1 before:rounded-r before:bg-emerald-600 dark:before:bg-emerald-400'
                : 'text-slate-500 dark:text-dark-text-muted hover:bg-slate-100 dark:hover:bg-dark-panel hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <Settings className="w-5 h-5 shrink-0" />
            {!sidebarCompact && <span className="text-2xs font-semibold leading-none">Настройки</span>}
          </button>

          {/* Interactive Profile Clickable Button (Trigger) */}
          <button
            type="button"
            data-tour="profile-btn"
            onClick={() => setIsProfileMenuOpen(!isProfileMenuOpen)}
            title={`${user?.name || ''} · ${user?.role || ''}`}
            className={`w-full flex items-center rounded-xl transition-colors duration-[120ms] cursor-pointer select-none ${
              sidebarCompact ? 'justify-center p-1' : 'flex-col gap-0.5 p-1.5'
            } ${
              isProfileMenuOpen
                ? 'bg-slate-200/70 dark:bg-dark-surface border border-slate-200 dark:border-dark-border'
                : 'hover:bg-slate-100 dark:hover:bg-dark-surface border border-transparent'
            }`}
          >
            {renderAvatar(true)}
            {!sidebarCompact && (
              <span className="text-2xs font-bold text-slate-800 dark:text-white leading-none truncate max-w-full">{(user?.name || '').split(' ')[0] || 'Профиль'}</span>
            )}
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-100 dark:bg-dark-bg relative transition-colors duration-250">
        <div className="flex-1 min-h-0">
          {shell === 'windows' ? <WindowsLayer /> : <Workspace />}
        </div>
        {shell !== 'menu' && <Taskbar />}
      </main>

      {/* ПКМ по разделу в левом меню */}
      {navMenu && (
        <ContextMenu
          x={navMenu.x}
          y={navMenu.y}
          onClose={() => setNavMenu(null)}
          items={[
            { label: 'Открыть', onClick: () => openInActivePane(navMenu.path) },
            ...visiblePanes(useWorkspaceStore.getState()).map((p, i): MenuItem => ({
              label: `Открыть в панели ${i + 1}`,
              onClick: () => useWorkspaceStore.getState().openInPane(p.id, navMenu.path),
            })).filter((_, __, arr) => arr.length > 1),
            { label: 'Открыть в отдельном окне', onClick: () => openSectionWindow(navMenu.path) },
          ]}
        />
      )}

      {/* Раздвижные панели справа сдвигают содержимое. Рельс — только при левом
          меню: без меню его работу делает трей панели задач */}
      <RightDock />
      {shell === 'menu' && <RightRail />}


      {/* Связи проекта и общий поиск — поверх всего: их зовут из любого места */}
      <InsightDrawer />
      <CommandBar />

      <NotifyToasts onOpen={(route) => navigate(route)} />

      {/* Alt+T над выделенным текстом — перевод рядом с ним, без ухода в
          программу-переводчик. Живёт в оболочке, потому что выделить текст
          можно где угодно */}
      <QuickTranslate />
      <ToastProvider />
      <ModalProvider />
      <ShareLayer />
      <CaptureReview />
    </div>
  );
}
