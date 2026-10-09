/**
 * Каталог и открытая ведомость — свежие, пока окно открыто.
 *
 * Сервер рассылает «catalog:changed» и «builder:list», но на общей базе у
 * каждого сотрудника свой встроенный сервер, и событие до чужого окна не
 * доходит. Поэтому вдобавок к сокету — перечитывание при возврате фокуса и
 * раз в 20 секунд, пока окно видно. Каталог перечитывается только по смене
 * метки версии (одним коротким запросом), ведомость — тихо, без «Загружаю…».
 */
import { useEffect } from 'react';
import { useRealTimeSync } from '../SocketProvider';
import { useCatalogStore } from '../../store/catalogStore';
import { useBuilderStore } from '../../store/builderStore';

const POLL_MS = 20_000;

export function useCatalogLive(opts: { list?: boolean } = {}): void {
  const { socket } = useRealTimeSync();
  const withList = !!opts.list;

  useEffect(() => {
    if (!socket) return;
    const onCatalog = () => { void useCatalogStore.getState().load(); };
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
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      void useCatalogStore.getState().load();
      if (withList) void useBuilderStore.getState().refresh();
    };
    window.addEventListener('focus', tick);
    const t = setInterval(tick, POLL_MS);
    return () => { window.removeEventListener('focus', tick); clearInterval(t); };
  }, [withList]);
}
