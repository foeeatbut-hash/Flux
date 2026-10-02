/** Опрос и ручное обновление одной доски делят один незавершённый запрос. */
export function coalesceRequest() {
  let pending: Promise<void> | null = null;
  let queuedFresh: Promise<void> | null = null;
  const start = (operation: () => Promise<void>) => {
    const current = operation().finally(() => {
      if (pending === current) pending = null;
    });
    pending = current;
    return current;
  };
  return {
    run(operation: () => Promise<void>): Promise<void> {
      if (pending) return pending;
      return start(operation);
    },
    runFresh(operation: () => Promise<void>): Promise<void> {
      if (queuedFresh) return queuedFresh;
      if (!pending) return start(operation);
      const current = pending.catch(() => {}).then(operation).finally(() => {
        if (pending === current) pending = null;
        if (queuedFresh === current) queuedFresh = null;
      });
      pending = current;
      queuedFresh = current;
      return current;
    },
  };
}
