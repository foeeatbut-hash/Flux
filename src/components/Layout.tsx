import React, { useState, useEffect } from 'react';
import { formatName } from '../lib/docFormula';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store/store';
import { Database, Folder, Home, LogOut, Settings, FileText, Plus, Book, ChevronDown, ChevronRight, ChevronLeft, Menu, Tag, Sun, Moon, Users, ClipboardList, Layers, MessageSquare, ChevronUp, X, User, Loader2, Check, Terminal, MessagesSquare, NotebookPen, FolderKanban, FolderOpen, Fan, BookOpen, Briefcase, Table2, PanelLeftClose, PanelLeftOpen, PenLine, Mail, LifeBuoy, Languages, Globe, CalendarDays } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import ToastProvider from './ToastProvider';
import ModalProvider from './ModalProvider';
import CaptureReview from './CaptureReview';
import { dataService } from '../services/dataService';
import { useLogStore } from '../store/logStore';
import { useAssistantStore } from '../store/assistantStore';
import RightDock from './RightDock';
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
import { useFeedbackStore } from '../store/feedbackStore';
import { resumeQueue, submissionQueue } from '../feedback/submissionQueue';
import { getMeta } from '../feedback/feedbackApi';
import Taskbar from './Taskbar';
import WindowsLayer from './WindowsLayer';
import { BAR_H } from '../lib/metrics';
import ProjectSwitcher from './ProjectSwitcher';
import ContextMenu, { MenuItem } from './ContextMenu';
import { useWorkspaceStore, rememberSectionUse } from '../store/workspaceStore';
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
  const { user, setUser, activeProject, theme, toggleTheme, syncStatus } = useStore();
  const navigate = useNavigate();
  const [eqOpen, setEqOpen] = useState(true);
  // Робот-помощник: его можно выключить в настройках — тогда он не создаётся
  // вовсе, а не прячется, чтобы не тратить ни таймеров, ни отрисовки.

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
       * Справка открывается окном и встаёт в правую половину стола — рядом с
       * тем, про что она. Раньше F1 подменял содержимое панели: раздел, про
       * который спрашивают, при этом закрывался собой же, и читать инструкцию
       * приходилось по памяти о том, что было на экране.
       */
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
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
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
   * Счётчик обращений — здесь же и по той же причине.
   *
   * Число живёт в общей базе: у каждого сотрудника свой встроенный сервер, и
   * «сколько ждёт ответа» — вопрос к базе, а не к своему процессу. При выходе
   * очередь отправки распускается: начатое одним сотрудником не должно уехать
   * под именем следующего за тем же компьютером.
   */
  React.useEffect(() => {
    const feedback = useFeedbackStore.getState();
    if (!user?.id) {
      feedback.reset();
      // Очередь распускается вместе с уходом человека: начатое одним
      // сотрудником не должно уехать под именем следующего за тем же
      // компьютером. Черновики при этом остаются — это его несданный текст, и
      // стирать его при выходе значит терять работу тех, кто выходит по
      // окончании смены
      submissionQueue.clear();
      return;
    }
    feedback.startPolling();

    /**
     * Продолжить отправку, начатую до перезапуска программы.
     *
     * Пакет лежит в черновике вместе с ключом запроса, поэтому продолжение
     * безопасно: если карточка успела создаться, повтор вернёт её же. Контур
     * спрашивается у сервера — под чужим `deploymentId` очередь не поедет.
     */
    let alive = true;
    getMeta()
      .then((meta) => { if (alive && meta?.deploymentId) void resumeQueue(meta.deploymentId, user.id); })
      .catch(() => { /* сервер не ответил — очередь подождёт следующего входа */ });

    return () => {
      alive = false;
      useFeedbackStore.getState().stopPolling();
    };
  }, [user?.id]);

  /**
   * Высота нижней панели — переменной, а не числом в каждом месте: всё, что
   * висит у нижнего края (журнал действий, всплывающие сообщения), должно
   * подниматься над панелью, иначе она их накрывает.
   */
  React.useEffect(() => {
    document.documentElement.style.setProperty('--flux-taskbar-h', `${BAR_H}px`);
  }, []);
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

  return (
    <div className="flex h-full w-full overflow-hidden bg-slate-50 dark:bg-dark-bg text-slate-800 dark:text-dark-text-main font-sans relative transition-colors duration-250">

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-100 dark:bg-dark-bg relative transition-colors duration-250">
        <div className="flex-1 min-h-0">
          <WindowsLayer />
        </div>
        <Taskbar />
      </main>

      {/* Раздвижные панели справа сдвигают содержимое */}
      <RightDock />


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
