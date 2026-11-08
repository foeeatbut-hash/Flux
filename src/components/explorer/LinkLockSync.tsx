import React from 'react';
import { can } from '../../lib/permissions';
import { useStore } from '../../store/store';
import { refOfLink } from '../../lib/docflowFiles';
import { windowsFilesRequest, type WindowsFileRef } from '../../lib/windowsFiles';
import { useProjectDocs } from '../docflow/useProjectDocs';
import { useBindingLedger } from './useProjectFolderBindings';

/**
 * Замки связанных файлов (docs/docflow-program.md, 3.7): состояние хранит сервер, а файловый мост на этом компьютере
 * должен знать, какие пути нельзя менять. Компонент ничего не рисует: при каждом изменении связей присылает мосту
 * полный список заблокированных файлов и тех, чей замок только что сняли (им возвращается запись).
 */
/** Без входа запросы дают 401, а без моста Windows блокировать нечем: тогда компонент ничего не загружает. */
export default function LinkLockSync() {
  const user = useStore((s) => s.user);
  const hasBridge = typeof window !== 'undefined' && !!(window as any).electron?.windowsFiles;
  return user && hasBridge ? <LinkLockSyncInner /> : null;
}

function LinkLockSyncInner() {
  const user = useStore((s) => s.user);
  const mayView = can(user, 'docflow.view');
  const { bindings } = useBindingLedger(user?.id);
  const projectIds = React.useMemo(() => [...new Set(bindings.map((b) => b.projectId))], [bindings]);
  const { docs } = useProjectDocs(projectIds, mayView && projectIds.length > 0);
  const previous = React.useRef(new Map<string, WindowsFileRef>());

  React.useEffect(() => {
    if (!mayView) return;
    let alive = true;
    const timer = window.setTimeout(async () => {
      const locked = new Map<string, WindowsFileRef>();
      const free = new Map<string, WindowsFileRef>();
      for (const ctx of Object.values(docs)) {
        for (const link of ctx.links) {
          if (link.unlinkedAt) continue;
          const wasLocked = previous.current.get(link.id);
          if (!link.locked && !wasLocked) continue;
          const ref = wasLocked && !link.locked ? wasLocked : await refOfLink(link, bindings);
          if (!ref) continue;
          (link.locked ? locked : free).set(link.id, ref);
        }
      }
      if (!alive) return;
      const answer = await windowsFilesRequest({ action: 'setLinkLocks', locked: [...locked.values()], released: [...free.values()] });
      // Без моста (браузер) блокировать на этом компьютере нечем: следующая попытка будет при новом списке связей
      if (answer.ok) previous.current = locked;
    }, 400);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [docs, bindings, mayView]);
  return null;
}
