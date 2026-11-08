/**
 * Слежение за связанными файлами: отпечаток считается только у файла, у которого изменились размер или
 * время изменения с прошлого прохода (docs/docflow-program.md, 3.5). Иначе каждый пере-листинг папки
 * и каждое vdr:changed читали бы с диска до 20 файлов целиком.
 */
export interface SeenFile { size: number; mtime: string; sha256: string }

export const needsHash = (prev: SeenFile | undefined, now: { size: number; modifiedAt?: string }): boolean =>
  !prev || prev.size !== now.size || prev.mtime !== (now.modifiedAt || '');

/** Память прохода: ключ связи → что видели в прошлый раз. Ограничена, чтобы не расти вместе с историей сеанса. */
export class HashMemory {
  private seen = new Map<string, SeenFile>();
  constructor(private limit = 5000) {}
  get(key: string): SeenFile | undefined { return this.seen.get(key); }
  /** Отпечаток файла: из памяти, если размер и время не менялись, иначе читается `read` (его вызывают только тогда). */
  async fingerprint(key: string, now: { size: number; modifiedAt?: string }, read: () => Promise<{ sha256: string; size: number } | null>): Promise<{ sha256: string; size: number; read: boolean } | null> {
    const prev = this.seen.get(key);
    if (prev && !needsHash(prev, now)) return { sha256: prev.sha256, size: prev.size, read: false };
    const fresh = await read();
    if (!fresh) return null;
    if (this.seen.size >= this.limit) this.seen.delete(this.seen.keys().next().value as string);
    this.seen.set(key, { size: fresh.size, mtime: now.modifiedAt || '', sha256: fresh.sha256 });
    return { ...fresh, read: true };
  }
}
