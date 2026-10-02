import { useEffect } from 'react';
import { useStore } from '../../store/store';
import { syncOwnedSources } from '../../services/fileSharingService';

/** Один владелец на окно: смена входа останавливает запись его локальных исходников. */
export default function OwnedFileShareSync() {
  const actorId = useStore((state) => state.user?.id);
  useEffect(() => {
    if (!actorId) return;
    let alive = true;
    let running = false;
    const isCurrent = () => alive && useStore.getState().user?.id === actorId;
    const sync = async () => {
      if (running || !isCurrent() || !navigator.onLine || document.visibilityState !== 'visible') return;
      running = true;
      try { await syncOwnedSources(actorId, isCurrent); }
      finally { running = false; }
    };
    void sync();
    const timer = setInterval(() => void sync(), 5000);
    const resume = () => void sync();
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume); };
  }, [actorId]);
  return null;
}
