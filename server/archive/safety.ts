/** Archive paths are untrusted names, never host filesystem paths. */
export interface ArchiveEntry {
  path: string;
  size: number;
  directory: boolean;
  encrypted: boolean;
}

const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;

export function safeArchivePath(raw: string): string {
  if (typeof raw !== 'string' || !raw || raw.length > 1024) throw new Error('Небезопасное имя в архиве');
  const value = raw.replace(/\\/g, '/');
  if (value.startsWith('/') || /^[a-z]:/i.test(value) || value.startsWith('//') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Небезопасное имя в архиве');
  }
  const parts = value.split('/');
  if (parts.at(-1) === '') parts.pop();
  if (!parts.length || parts.length > 64 || parts.some((p) => {
    const device = p.split('.')[0].replace(/[ .]+$/g, '');
    return !p || p === '.' || p === '..' || /[<>:"|?*]/.test(p) || p.length > 255 || p.endsWith('.') || p.endsWith(' ') || RESERVED.test(device);
  })) {
    throw new Error('Небезопасное имя в архиве');
  }
  return parts.join('/');
}

/** Parse the stable key/value blocks emitted by 7-Zip `l -slt`. */
export function parse7zListing(text: string): ArchiveEntry[] {
  const rows: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  let listingStarted = false;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line === '----------') { listingStarted = true; current = {}; rows.push(current); continue; }
    if (listingStarted && !current && line.startsWith('Path = ')) { current = {}; rows.push(current); }
    if (!current) continue;
    if (!line.trim()) { current = null; continue; }
    const at = line.indexOf(' = ');
    if (at > 0) current[line.slice(0, at)] = line.slice(at + 3);
  }
  const out: ArchiveEntry[] = [];
  const seen = new Set<string>();
  const kinds = new Map<string, boolean>();
  for (const row of rows) {
    if (!row.Path || row.Path === row.Archive) continue;
    if ('Symbolic Link' in row || 'Hard Link' in row) throw new Error('Архив содержит ссылки; распаковка запрещена');
    const directory = row.Folder === '+' || row.Attributes?.includes('D') === true;
    const path = safeArchivePath(row.Path);
    const key = path.toLocaleLowerCase('en-US');
    if (seen.has(key)) throw new Error('В архиве повторяются имена файлов');
    const ancestors = key.split('/'); ancestors.pop();
    for (let i = 1; i <= ancestors.length; i++) {
      const parent = ancestors.slice(0, i).join('/');
      if (kinds.get(parent) === false) throw new Error('Архив содержит несовместимые пути');
    }
    if (!directory && [...kinds.keys()].some((x) => x.startsWith(`${key}/`))) throw new Error('Архив содержит несовместимые пути');
    seen.add(key);
    kinds.set(key, directory);
    const size = directory ? 0 : Number(row.Size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Повреждённое содержимое архива');
    out.push({ path, size, directory, encrypted: row.Encrypted === '+' });
  }
  return out;
}

export function checkArchiveLimits(entries: ArchiveEntry[], maxEntries = 5000, maxOutput = 512 * 1024 * 1024): void {
  if (entries.length > maxEntries) throw new Error('В архиве слишком много элементов');
  let total = 0;
  for (const entry of entries) {
    total += entry.size;
    if (total > maxOutput) throw new Error('Распакованный архив превышает предел 512 МБ');
  }
}
