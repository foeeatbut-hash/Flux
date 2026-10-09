/** Повторяет одну загрузку, если новые события пришли, пока она выполнялась. */
export function createCoalescedRefresh(run: () => Promise<void>): () => Promise<void> {
  let pending = false;
  let active: Promise<void> | null = null;

  return () => {
    if (active) { pending = true; return active; }
    const work = async () => {
      do {
        pending = false;
        await run();
      } while (pending);
    };
    const current = work();
    active = current;
    return current.finally(() => { if (active === current) active = null; });
  };
}

/** Старое событие без projectId применяем, проектное — только к своему проекту. */
export function belongsToProject(detail: { projectId?: string } | null | undefined, projectId: string): boolean {
  return !detail?.projectId || detail.projectId === projectId;
}
