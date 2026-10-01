import { useEffect, useState } from 'react';
import { useStore } from '../store/store';

/** Проект документа закреплён за файлом и не меняется при переключении рабочего стола. */
export function useFileProject(fileId: string): string {
  const active = useStore(s => s.activeProject?.id || '');
  const [context, setContext] = useState({ fileId, projectId: active });
  useEffect(() => {
    let live = true;
    setContext({ fileId, projectId: active });
    if (fileId) void fetch(`/api/office/files/${encodeURIComponent(fileId)}/meta`).then(r => r.ok ? r.json() : null).then(meta => {
      if (live && meta?.projectId) setContext({ fileId, projectId: meta.projectId });
    }).catch(() => undefined);
    return () => { live = false; };
    // active — только исходный контекст нового файла, не причина менять проект открытого.
  }, [fileId]);
  return context.fileId === fileId ? context.projectId : active;
}
