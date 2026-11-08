import React from 'react';
import { can } from '../../lib/permissions';
import { useStore } from '../../store/store';
import { windowsFilesRequest } from '../../lib/windowsFiles';
import { useBindingLedger } from './useProjectFolderBindings';

/**
 * Замки связанных файлов (docs/docflow-program.md, 3.7): список замков и привязки папок главный процесс берёт у
 * сервера сам, под сессией пользователя. Страница ничего не диктует: при изменении связей (событие vdr:changed),
 * привязок и при входе она только просит мост «обновить» (syncLinkLocks). Компонент ничего не рисует.
 */
export default function LinkLockSync() {
  const user = useStore((s) => s.user);
  const hasBridge = typeof window !== 'undefined' && !!(window as any).electron?.windowsFiles;
  return user && hasBridge ? <LinkLockSyncInner /> : null;
}

function LinkLockSyncInner() {
  const user = useStore((s) => s.user);
  const mayView = can(user, 'docflow.view');
  const { bindings } = useBindingLedger(user?.id);
  const bindingsKey = bindings.map((b) => `${b.locationKey}:${b.projectId}`).join('|');
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    let timer = 0;
    const onChanged = () => { window.clearTimeout(timer); timer = window.setTimeout(() => setTick((n) => n + 1), 400); };
    window.addEventListener('socket:vdr:changed', onChanged);
    return () => { window.clearTimeout(timer); window.removeEventListener('socket:vdr:changed', onChanged); };
  }, []);
  React.useEffect(() => {
    if (!mayView || !bindingsKey) return;
    const timer = window.setTimeout(() => { void windowsFilesRequest({ action: 'syncLinkLocks' }); }, 400);
    return () => window.clearTimeout(timer);
  }, [mayView, bindingsKey, tick]);
  return null;
}
