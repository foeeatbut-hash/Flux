type Revisioned = { sourceRevision?: string };
type QueryResult = { revision: string; rows: Array<{ entityId: string }> };

export class OfficeRequestGeneration {
  private value = 0;
  next(): number { return ++this.value; }
  invalidate(): void { this.value++; }
  isCurrent(generation: number): boolean { return generation === this.value; }
}

export const isOfficeRevisionConflict = (reason: unknown): boolean =>
  (reason as { status?: number } | null)?.status === 409;

/** Повторяет запрос один раз без метки ревизии; запись здесь невозможна. */
export async function queryWithRevisionRecovery<T extends Revisioned, R>(
  query: T,
  run: (query: T) => Promise<R>,
): Promise<{ result: R; refreshed: boolean }> {
  try { return { result: await run(query), refreshed: false }; }
  catch (reason) {
    if (!isOfficeRevisionConflict(reason)) throw reason;
    const fresh = { ...query, sourceRevision: undefined };
    return { result: await run(fresh), refreshed: true };
  }
}

/** При 409 перечитывает данные, сохраняет доступный выбор и строит новый предпросмотр. */
export async function previewWithRevisionRecovery<P, R extends QueryResult>(options: {
  sourceRevision: string;
  selectedIds: string[];
  preview: (revision: string, selectedIds: string[]) => Promise<P>;
  reload: () => Promise<R>;
}): Promise<{ plan: P | null; refreshed?: { result: R; selectedIds: string[] } }> {
  try { return { plan: await options.preview(options.sourceRevision, options.selectedIds) }; }
  catch (reason) {
    if (!isOfficeRevisionConflict(reason)) throw reason;
    const result = await options.reload();
    const selectedIds = options.selectedIds.filter((id) => result.rows.some((row) => row.entityId === id));
    if (!selectedIds.length) return { plan: null, refreshed: { result, selectedIds } };
    const plan = await options.preview(result.revision, selectedIds);
    return { plan, refreshed: { result, selectedIds } };
  }
}
