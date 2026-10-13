import type { WindowsFileEntry } from '../../lib/windowsFiles';
const entryPath = (entry: WindowsFileEntry) => `${entry.rootId || ''}\0${entry.relativePath}\0${entry.draftId || ''}`;
export function mergeDesktopEntries(previous: WindowsFileEntry[], incoming: WindowsFileEntry[]): WindowsFileEntry[] {
  const byPath = new Map(previous.map((entry) => [entryPath(entry), entry]));
  const paths = new Set<string>(), ids = new Set<string>(), merged: WindowsFileEntry[] = [];
  for (const next of incoming) {
    const path = entryPath(next);
    if (paths.has(path) || ids.has(next.fileId)) continue;
    paths.add(path); ids.add(next.fileId);
    const old = byPath.get(path);
    merged.push(old && old.fileId === next.fileId && old.name === next.name && old.kind === next.kind && old.size === next.size && old.modifiedAt === next.modifiedAt && old.hidden === next.hidden ? old : next);
  }
  return merged;
}
