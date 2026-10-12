import { useCallback, useEffect, useState } from 'react';

/** Другой участник может выпустить открытый файл: сверяем статус и переводим редактор в просмотр. */
export function useOfficeIssued(fileId: string) {
  const [state, setState] = useState({ fileId, issued: false });
  const markIssued = useCallback(() => setState({ fileId, issued: true }), [fileId]);
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      if (!fileId) return;
      try {
        const response = await fetch(`/api/office/files/${encodeURIComponent(fileId)}/meta`);
        if (!response.ok) return;
        const value = await response.json();
        if (!cancelled) setState((previous) => previous.fileId === fileId && previous.issued === (value.issued === true) ? previous : { fileId, issued: value.issued === true });
      } catch { /* Временный сбой сети не снимает уже известную заморозку. */ }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [fileId]);
  return { issued: state.fileId === fileId && state.issued, markIssued };
}
