/**
 * Фоновая сверка Store: при входе, при возвращении в окно, по событиям
 * сервера (выпуск, отзыв, решение администратора) и раз в десять минут.
 * Автообновление срабатывает только при первой сверке после запуска Flux.
 */
import { useEffect } from 'react';
import { useRealTimeSync } from '../SocketProvider';
import { useStore } from '../../store/store';
import { flushModuleCrashes } from '../../services/moduleCrashQueue';
import { refreshStore } from '../../services/moduleStoreActions';

export default function StoreSync() {
  const { socket } = useRealTimeSync();
  const userId = (useStore((s) => s.user) as any)?.id;
  useEffect(() => {
    if (!userId) return;
    const run = () => { void refreshStore(); void flushModuleCrashes(); };
    run();
    const timer = setInterval(run, 10 * 60 * 1000);
    window.addEventListener('focus', run);
    window.addEventListener('online', run);
    return () => { clearInterval(timer); window.removeEventListener('focus', run); window.removeEventListener('online', run); };
  }, [userId]);
  useEffect(() => {
    if (!socket || !userId) return;
    const run = () => { void refreshStore(); void flushModuleCrashes(); };
    const events = ['modules:released', 'modules:revoked', 'modules:installs', 'modules:channels'];
    events.forEach((e) => socket.on(e, run));
    return () => { events.forEach((e) => socket.off(e, run)); };
  }, [socket, userId]);
  return null;
}
