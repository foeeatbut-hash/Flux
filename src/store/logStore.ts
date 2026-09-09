import { create } from 'zustand';
import { diagnostic } from '../lib/diagnostics';

export interface LogItem {
  id: string;
  timestamp: string; // Formatting or ISO string
  type: 'INFO' | 'WARN' | 'ERROR';
  context: string;
  message: string;
  stack?: string;
}

interface LogState {
  logs: LogItem[];
  hasUnreadError: boolean;
  widgetOpen: boolean;
  addLog: (type: 'INFO' | 'WARN' | 'ERROR', context: string, message: string, stack?: string) => void;
  clearLogs: () => void;
  setWidgetOpen: (open: boolean) => void;
  setHasUnreadError: (val: boolean) => void;
}

// Журнал ограничен по размеру: без лимита каждый клик/запрос копил записи
// бесконечно, массив копировался целиком и программа начинала фризить
const MAX_LOGS = 800;

// Буфер накопленных записей и таймер сброса живут вне хранилища:
// пока запись лежит здесь, подписчики не перерисовываются.
let pending: LogItem[] = [];
let flushTimer: any = null;
const FLUSH_MS = 700;

let flushLogs = () => {};
let scheduleFlush = () => {};

export const useLogStore = create<LogState>((set, get) => ({
  logs: [],
  hasUnreadError: false,
  widgetOpen: false,

  addLog: (type, context, message, stack) => {
    // В подробную запись уходит место и кадры стека, но НЕ текст сообщения:
    // в нём бывает имя документа, строка поиска и ответ сервера целиком
    if (type !== 'INFO') {
      const frames = String(stack || '').split('\n').slice(1, 4).map((l) => l.trim());
      diagnostic(type === 'ERROR' ? 'log.error' : 'log.warn', {
        context,
        ...(frames[0] ? { frame1: frames[0] } : {}),
        ...(type === 'ERROR' && frames[1] ? { frame2: frames[1] } : {}),
        ...(type === 'ERROR' && frames[2] ? { frame3: frames[2] } : {}),
      });
    }
    const id = Math.random().toString(36).substring(2, 9) + '-' + Date.now();
    const timestamp = new Date().toLocaleTimeString('ru-RU', { hour12: false });

    const newLog: LogItem = { id, timestamp, type, context, message, stack };

    // Ошибки и предупреждения показываем сразу — их ждут. Обычные записи
    // (а это каждый клик и каждый запрос) копим и отдаём пачкой: раньше
    // любой клик по интерфейсу копировал весь массив журнала и
    // перерисовывал всех подписчиков, отсюда ощущение вязкости.
    pending.push(newLog);
    if (type === 'ERROR' || type === 'WARN') {
      flushLogs();
    } else {
      scheduleFlush();
    }
  },

  clearLogs: () => {
    pending = [];
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    set({ logs: [], hasUnreadError: false });
  },

  setWidgetOpen: (open) => {
    if (open) flushLogs();
    set({ 
      widgetOpen: open, 
      ...(open ? { hasUnreadError: false } : {}) // Reset when opened
    });
  },

  setHasUnreadError: (val) => {
    set({ hasUnreadError: val });
  }
}));

flushLogs = () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  useLogStore.setState((state) => {
    const merged = [...state.logs, ...batch];
    const trimmed = merged.length > MAX_LOGS ? merged.slice(merged.length - MAX_LOGS) : merged;
    const hasError = batch.some((l) => l.type === 'ERROR');
    return {
      logs: trimmed,
      hasUnreadError: hasError && !state.widgetOpen ? true : state.hasUnreadError,
    };
  });
};

scheduleFlush = () => {
  if (flushTimer) return;
  flushTimer = setTimeout(flushLogs, FLUSH_MS);
};

// Делаем журнал доступным глобальной обёртке fetch (config/env.ts) для
// подробного логирования запросов/ответов без циклических импортов.
if (typeof window !== 'undefined') {
  (window as any).__pdmLogStore = useLogStore;
}
