import React from 'react';
import type { WindowsDraftEntry } from '../../../filesystem/contracts';
import { resolveBoundProject } from '../../lib/projectFolderBindings';
import { useStore } from '../../store/store';
import { useBindingLedger, useLocationChains } from '../explorer/useProjectFolderBindings';

/** Проект черновика наследуется от ближайшей привязанной папки Windows. */
export function useDraftProjects(entries: readonly WindowsDraftEntry[]) {
  const userId = useStore((state) => state.user?.id);
  const { bindings } = useBindingLedger(userId);
  // У сотен черновиков часто один родитель: его цепочку достаточно запросить один раз.
  const refs = React.useMemo(() => [...new Map(entries.map(({ parent }) => [
    `${parent.rootId}\0${parent.relativePath}`, { rootId: parent.rootId, relativePath: parent.relativePath },
  ])).values()], [entries]);
  const { chainOf } = useLocationChains(refs, bindings.length > 0);
  return React.useCallback((entry: WindowsDraftEntry) => resolveBoundProject(bindings, chainOf({ rootId: entry.parent.rootId, relativePath: entry.parent.relativePath })), [bindings, chainOf]);
}
