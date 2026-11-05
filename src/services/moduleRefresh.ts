import { invalidateModuleReads } from './moduleReadCache';

export const MODULE_FALLBACK_MS = 120_000;
const events = [
  'socket:entity:changed', 'socket:tag:updated', 'socket:tag:linked',
  'catalog:published', 'flux:session-changed', 'focus',
];
const subscribers = new Set<{ notify: () => void; connected: () => boolean }>();
let pending: ReturnType<typeof setTimeout> | undefined;
let fallback: ReturnType<typeof setInterval> | undefined;
export function requestModuleRefresh() {
  clearTimeout(pending);
  pending = setTimeout(() => {
    invalidateModuleReads();
    for (const subscriber of subscribers) subscriber.notify();
  }, 80);
}
export function subscribeModuleRefresh(notify: () => void, connected: () => boolean) {
  const subscriber = { notify, connected };
  if (!subscribers.size) {
    for (const event of events) window.addEventListener(event, requestModuleRefresh);
    // Один редкий опрос на все модули. При живом сокете общая база не
    // опрашивается: изменения приходят событиями и при возвращении в окно.
    fallback = setInterval(() => {
      if (![...subscribers].some(item => item.connected())) requestModuleRefresh();
    }, MODULE_FALLBACK_MS);
  }
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
    if (!subscribers.size) {
      clearTimeout(pending); clearInterval(fallback);
      for (const event of events) window.removeEventListener(event, requestModuleRefresh);
      invalidateModuleReads();
    }
  };
}
