import type { WindowsDraftEntry, WindowsDraftListing } from '../../filesystem/contracts';
import type { WindowsFilesService } from './service';

// Реестр один для поиска и панели: переименование и корзина не могут
// оставить устаревшую копию списка в другом хранилище.
export function unpublishedDrafts(service: Pick<WindowsFilesService, 'state'>) {
  return Object.values(service.state.data.drafts).filter(draft => !draft.trashed && !draft.publishedRef);
}
export async function listDrafts(service: WindowsFilesService, offset = 0, limit = 500): Promise<WindowsDraftListing> {
  offset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  limit = Number.isFinite(limit) ? Math.min(500, Math.max(1, Math.floor(limit))) : 500;
  const drafts = unpublishedDrafts(service).sort((a, b) => a.id.localeCompare(b.id));
  const entries: WindowsDraftEntry[] = [];
  let unreadableCount = 0;
  for (const draft of drafts.slice(offset, offset + limit)) {
    const ref = { rootId: draft.parent.rootId,
      relativePath: [draft.parent.relativePath, draft.name].filter(Boolean).join('/'), draftId: draft.id };
    try {
      const entry = await service.entry(ref);
      const metadata = await service.metadata(ref);
      // Для старой виртуальной папки неизвестная дата честнее сегодняшней.
      const createdAt = entry.kind === 'directory' ? draft.createdAt || metadata.history[0]?.at || '' : entry.createdAt;
      const modifiedAt = entry.kind === 'directory' ? metadata.history.at(-1)?.at || createdAt || '' : entry.modifiedAt;
      entries.push({ ...entry, rootId: ref.rootId, createdAt, modifiedAt,
        parent: { ...draft.parent }, metadata: { ...metadata, history: [] } });
    } catch { unreadableCount++; }
  }
  return { entries, total: drafts.length, unreadableCount, nextOffset: offset + limit < drafts.length ? offset + limit : null };
}
