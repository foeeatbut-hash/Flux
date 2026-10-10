/**
 * Каталог и открытая ведомость — свежие, пока окно открыто.
 *
 * Сервер рассылает «catalog:changed» и «builder:list», но на общей базе у
 * каждого сотрудника свой встроенный сервер, и событие до чужого окна не
 * доходит. Поэтому вдобавок к сокету — общий для открытых разделов опрос при
 * возврате фокуса и раз в 20 секунд, пока окно видно. Каталог перечитывается только по смене
 * метки версии (одним коротким запросом), ведомость — тихо, без «Загружаю…».
 */
import { useEffect } from 'react';
import { useRealTimeSync } from '../SocketProvider';
import { useCatalogStore } from '../../store/catalogStore';
import { useBuilderStore } from '../../store/builderStore';

const POLL_MS = 20_000;

type LiveSubscriber = { withList: boolean };
const subscribers = new Set<LiveSubscriber>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let catalogRefresh: Promise<void> | null = null;
let lastAnnouncedStamp = '';

async function refreshCatalogAndAnnounce(): Promise<void> {
  if (catalogRefresh) return catalogRefresh;
  catalogRefresh = (async () => {
    const before = useCatalogStore.getState();
    const previousStamp = before.loaded ? before.stamp : '';
    await before.load();
    const currentStamp = useCatalogStore.getState().stamp;
    if (previousStamp && currentStamp && currentStamp !== previousStamp && currentStamp !== lastAnnouncedStamp) {
      lastAnnouncedStamp = currentStamp;
      window.dispatchEvent(new CustomEvent('catalog:published', { detail: { stamp: currentStamp } }));
    }
  })().finally(() => { catalogRefresh = null; });
  return catalogRefresh;
}

function pollAllSubscribers(): void {
  if (document.visibilityState !== 'visible') return;
  void refreshCatalogAndAnnounce();
  if ([...subscribers].some((subscriber) => subscriber.withList)) void useBuilderStore.getState().refresh();
}

function subscribeToPolling(subscriber: LiveSubscriber): () => void {
  subscribers.add(subscriber);
  if (subscribers.size === 1) {
    window.addEventListener('focus', pollAllSubscribers);
    pollTimer = setInterval(pollAllSubscribers, POLL_MS);
  }
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0 && pollTimer) {
      window.removeEventListener('focus', pollAllSubscribers);
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}

export function useCatalogLive(opts: { list?: boolean } = {}): void {
  const { socket } = useRealTimeSync();
  const withList = !!opts.list;

  useEffect(() => {
    if (!socket) return;
    const onCatalog = () => {
      window.dispatchEvent(new Event('catalog:published'));
      void refreshCatalogAndAnnounce();
    };
    const onList = (p: { listId?: string; projectId?: string }) => {
      if (!withList) return;
      const state = useBuilderStore.getState();
      if (p?.projectId && p.projectId !== state.projectId) return;
      void state.refreshLists();
      if (p?.listId && p.listId === state.listId) void state.refresh();
    };
    socket.on('catalog:changed', onCatalog);
    socket.on('builder:list', onList);
    return () => { socket.off('catalog:changed', onCatalog); socket.off('builder:list', onList); };
  }, [socket, withList]);

  useEffect(() => {
    const unsubscribe = subscribeToPolling({ withList });
    void useCatalogStore.getState().load();
    return unsubscribe;
  }, [withList]);
}
