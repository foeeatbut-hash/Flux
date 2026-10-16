import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WINDOWS_IMPORT_READ_BYTES, WINDOWS_IMPORT_REFS_PER_PICK, type SelectionProvenance, type WindowsFileRef } from '../../filesystem/contracts';
import { WindowsFilesError } from './paths';
import type { WindowsFilesService } from './service';

export interface WindowsImportRef { ticket: string; name: string; size: number; lastModified: number; provenance?: SelectionProvenance }
const IDLE_TTL_MS = 5 * 60 * 1000;
const MAX_TICKETS_PER_OWNER = WINDOWS_IMPORT_REFS_PER_PICK;
export const MAX_IMPORT_READ_BYTES = WINDOWS_IMPORT_READ_BYTES;

type Entry = {
  owner: number; path: string; name: string; size: number; lastModified: number; dev: bigint; ino: bigint;
  birthtimeNs: bigint; mtimeNs: bigint; ctimeNs: bigint; expiresAt: number;
};

/** Краткоживущие билеты дают странице доступ к диапазонам, не раскрывая путь Windows. */
export class ImportRefStore {
  private entries = new Map<string, Entry>();

  private cleanup(owner?: number) {
    const now = Date.now();
    for (const [ticket, entry] of this.entries) if (entry.expiresAt <= now || (owner != null && entry.owner === owner && entry.expiresAt <= now)) this.entries.delete(ticket);
  }

  private async snapshot(owner: number, filename: string, name: string, provenance?: SelectionProvenance): Promise<WindowsImportRef> {
    this.cleanup(owner);
    if ([...this.entries.values()].filter(item => item.owner === owner).length >= MAX_TICKETS_PER_OWNER) throw new WindowsFilesError('TOO_MANY_IMPORTS', 'Закройте окно выбора файлов и начните заново.');
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await handle.stat({ bigint: true });
      const named = await fs.lstat(filename, { bigint: true });
      if (!stat.isFile() || named.isSymbolicLink() || stat.dev !== named.dev || stat.ino !== named.ino) throw new WindowsFilesError('NOT_FILE', 'Выберите обычный файл без символической ссылки.');
      if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new WindowsFilesError('FILE_TOO_LARGE', 'Размер файла превышает поддерживаемый диапазон.');
      const ticket = randomUUID();
      const lastModified = Math.trunc(Number(stat.mtimeNs) / 1e6);
      this.entries.set(ticket, { owner, path: filename, name: path.basename(name), size: Number(stat.size), lastModified, dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, expiresAt: Date.now() + IDLE_TTL_MS });
      return { ticket, name: path.basename(name), size: Number(stat.size), lastModified, ...(provenance ? { provenance } : {}) };
    } finally { await handle?.close(); }
  }

  async registerPaths(owner: number, paths: string[], provenanceForPath?: (filename: string) => Promise<SelectionProvenance | undefined>): Promise<WindowsImportRef[]> {
    if (!Array.isArray(paths) || !paths.length || paths.length > WINDOWS_IMPORT_REFS_PER_PICK) throw new WindowsFilesError('INVALID_REQUEST', `Выберите от 1 до ${WINDOWS_IMPORT_REFS_PER_PICK} файлов.`);
    const result: WindowsImportRef[] = [];
    try {
      for (const filename of paths) {
        let provenance: SelectionProvenance | undefined;
        try { provenance = await provenanceForPath?.(filename); } catch { /* Привязка необязательна: при её ошибке файл всё равно можно выбрать. */ }
        result.push(await this.snapshot(owner, filename, path.basename(filename), provenance));
      }
      return result;
    } catch (error) { this.release(owner, result.map(item => item.ticket)); throw error; }
  }

  async registerRefs(owner: number, service: WindowsFilesService, refs: WindowsFileRef[], provenanceForFolder?: (folder: WindowsFileRef, file: WindowsFileRef) => Promise<SelectionProvenance>): Promise<WindowsImportRef[]> {
    if (!Array.isArray(refs) || !refs.length || refs.length > WINDOWS_IMPORT_REFS_PER_PICK) throw new WindowsFilesError('INVALID_REQUEST', `Выберите от 1 до ${WINDOWS_IMPORT_REFS_PER_PICK} файлов.`);
    const result: WindowsImportRef[] = [];
    try {
      for (const ref of refs) {
        const entry = await service.entry(ref);
        if (entry.kind !== 'file') throw new WindowsFilesError('NOT_FILE', 'Выберите файл, а не папку.');
        const folder = { rootId: ref.rootId, relativePath: ref.relativePath.split('/').slice(0, -1).join('/'), ...(ref.draftId ? { draftId: ref.draftId } : {}) };
        let provenance: SelectionProvenance | undefined;
        try { provenance = await provenanceForFolder?.(folder, ref); } catch { /* Привязка необязательна: при её ошибке файл всё равно можно выбрать. */ }
        result.push(await this.snapshot(owner, await service.filename(ref), entry.name, provenance));
      }
      return result;
    } catch (error) { this.release(owner, result.map(item => item.ticket)); throw error; }
  }

  async read(owner: number, ticket: string, offset: number, length: number): Promise<{ name: string; size: number; offset: number; base64: string }> {
    this.cleanup(owner);
    const entry = this.entries.get(ticket);
    if (!entry || entry.owner !== owner) throw new WindowsFilesError('IMPORT_REF_EXPIRED', 'Билет чтения истёк. Выберите файл повторно.');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_IMPORT_READ_BYTES || offset > entry.size) throw new WindowsFilesError('INVALID_REQUEST', 'Некорректный диапазон чтения.');
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const before = await handle.stat({ bigint: true });
      const named = await fs.lstat(entry.path, { bigint: true });
      if (named.isSymbolicLink() || !before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino || before.size !== BigInt(entry.size) || before.birthtimeNs !== entry.birthtimeNs || before.mtimeNs !== entry.mtimeNs || before.ctimeNs !== entry.ctimeNs || named.dev !== entry.dev || named.ino !== entry.ino) {
        this.entries.delete(ticket);
        throw new WindowsFilesError('CONFLICT', 'Файл изменился после выбора. Выберите его повторно.');
      }
      const bytes = Buffer.allocUnsafe(Math.min(length, entry.size - offset));
      let position = 0;
      while (position < bytes.length) {
        const part = await handle.read(bytes, position, bytes.length - position, offset + position);
        if (!part.bytesRead) throw new WindowsFilesError('CONFLICT', 'Файл изменился во время чтения. Выберите его повторно.');
        position += part.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
        this.entries.delete(ticket);
        throw new WindowsFilesError('CONFLICT', 'Файл изменился во время чтения. Выберите его повторно.');
      }
      // Продлеваем билет только после успешного чтения: долгая передача живёт, а простаивающий мусор истекает.
      entry.expiresAt = Date.now() + IDLE_TTL_MS;
      return { name: entry.name, size: entry.size, offset, base64: bytes.toString('base64') };
    } finally { await handle?.close(); }
  }

  release(owner: number, tickets: string[]) { for (const ticket of tickets) if (this.entries.get(ticket)?.owner === owner) this.entries.delete(ticket); }
  closeOwner(owner: number) { for (const [ticket, entry] of this.entries) if (entry.owner === owner) this.entries.delete(ticket); }
}
