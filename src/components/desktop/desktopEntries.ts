import type { WindowsFileEntry } from '../../lib/windowsFiles';
const entryPath = (entry: WindowsFileEntry) => `${entry.rootId || ''}\0${entry.relativePath}\0${entry.draftId || ''}`;
export function mergeDesktopEntries(previous: WindowsFileEntry[], incoming: WindowsFileEntry[]): WindowsFileEntry[] {
  const byPath = new Map(previous.map((entry) => [entryPath(entry), entry]));
  for (const next of incoming) {
    const path = entryPath(next);
    const old = byPath.get(path);
    byPath.set(path, old && JSON.stringify(old) === JSON.stringify(next) ? old : next);
  }
  return dedupe([...byPath.values()]);
}

/** A completed scan is authoritative, so stale paths are dropped. */
export function replaceDesktopEntries(previous: WindowsFileEntry[], scanned: WindowsFileEntry[]): WindowsFileEntry[] {
  const oldByPath = new Map(previous.map((entry) => [entryPath(entry), entry]));
  const refreshed = scanned.map((entry) => {
    const old = oldByPath.get(entryPath(entry));
    return old && JSON.stringify(old) === JSON.stringify(entry) ? old : entry;
  });
  return dedupe(refreshed);
}

function dedupe(entries: WindowsFileEntry[]): WindowsFileEntry[] {
  const paths = new Set<string>(), ids = new Set<string>(), result: WindowsFileEntry[] = [];
  for (const entry of entries) {
    const path = entryPath(entry);
    if (paths.has(path) || ids.has(entry.fileId)) continue;
    paths.add(path); ids.add(entry.fileId); result.push(entry);
  }
  return result;
}
