import React from 'react';
import { getKitDocuments, type KitDocumentsView } from '../../lib/docflowKitApi';

export function useKitDocuments(projectId: string, tagId?: string, stage?: string, enabled = true) {
  const [view, setView] = React.useState<KitDocumentsView | null>(null);
  const [error, setError] = React.useState('');
  const [stamp, reload] = React.useReducer(n => n + 1, 0);
  React.useEffect(() => { setView(null); setError(''); }, [projectId, tagId, stage, enabled]);
  React.useEffect(() => {
    let alive = true;
    setError('');
    if (enabled) void getKitDocuments(projectId, tagId, stage).then(answer => {
      if (!alive) return;
      if (answer.ok) setView(answer.data); else setError(answer.data.error || 'Не удалось прочитать документы тега');
    });
    return () => { alive = false; };
  }, [projectId, tagId, stage, stamp, enabled]);
  React.useEffect(() => {
    if (!enabled) return;
    const changed = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (!data?.projectId || data.projectId === projectId) reload();
    };
    window.addEventListener('socket:vdr:changed', changed);
    window.addEventListener('socket:entity:changed', changed);
    return () => { window.removeEventListener('socket:vdr:changed', changed); window.removeEventListener('socket:entity:changed', changed); };
  }, [projectId, enabled]);
  return { view, error, reload };
}
