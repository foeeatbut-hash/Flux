import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WindowsFileMetadata, WindowsKnownFolder } from '../../filesystem/contracts';
import { WindowsFilesError } from './paths';

export interface StoredRoot { id: string; path: string; name: string; kind: WindowsKnownFolder }
export interface StoredPublication { ref: { rootId: string; relativePath: string }; sha256: string; fileId: string; status?: 'pending' | 'complete' }
export interface StoredDraft { id: string; parent: { rootId: string; relativePath: string; draftId?: string }; name: string; kind?: 'file' | 'directory'; parentFileId?: string; publishedRef?: { rootId: string; relativePath: string }; trashed?: boolean }
interface StoredState {
  version: 1; deviceId: string; roots: StoredRoot[];
  metadata: Record<string, WindowsFileMetadata>; identity: Record<string, string>;
  publications: Record<string, StoredPublication>; drafts: Record<string, StoredDraft>;
}
export class WindowsFilesState {
  data: StoredState;
  private queue = Promise.resolve();
  private constructor(private filename: string, data: StoredState) { this.data = data; }
  static async load(userData: string): Promise<WindowsFilesState> {
    await fs.mkdir(userData, { recursive: true });
    const filename = path.join(userData, 'windows-files-state.json');
    let data: StoredState;
    try {
      data = JSON.parse(await fs.readFile(filename, 'utf8'));
      data.drafts ||= {};
      for (const draft of Object.values(data.drafts)) draft.kind ||= 'file';
      if (data.version !== 1 || !data.deviceId || !Array.isArray(data.roots) || !data.metadata || !data.identity || !data.publications) throw new Error('format');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw new WindowsFilesError('STATE_UNREADABLE', 'Не удалось открыть свойства файлов Flux. Существующий файл свойств сохранён.');
      data = { version: 1, deviceId: randomUUID(), roots: [], metadata: {}, identity: {}, publications: {}, drafts: {} };
    }
    const state = new WindowsFilesState(filename, data);
    await state.save();
    return state;
  }
  save(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    const operation = this.queue.then(async () => {
      const temp = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, snapshot, { flag: 'wx', mode: 0o600 });
        await fs.rename(temp, this.filename);
      } finally { await fs.unlink(temp).catch(() => undefined); }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  root(id: string): StoredRoot {
    if (typeof id !== 'string') throw new WindowsFilesError('UNKNOWN_ROOT', 'Папка не подключена.');
    const root = this.data.roots.find(item => item.id === id);
    if (!root) throw new WindowsFilesError('UNKNOWN_ROOT', 'Папка не подключена на этом устройстве.');
    return root;
  }
  async addRoot(folder: string, kind: WindowsKnownFolder, name?: string): Promise<StoredRoot> {
    const actual = await fs.realpath(folder);
    if (!(await fs.stat(actual)).isDirectory()) throw new WindowsFilesError('NOT_DIRECTORY', 'Выберите папку.');
    const existing = this.data.roots.find(item => item.path === actual);
    if (existing) return existing;
    const root = { id: randomUUID(), path: actual, name: name || path.basename(actual), kind };
    this.data.roots.push(root); await this.save(); return root;
  }
  metadata(fileId: string): WindowsFileMetadata {
    return this.data.metadata[fileId] ||= { fileId, tags: [], projectIds: [], revision: '', responsible: '', history: [] };
  }
  async history(fileId: string, action: string, relativePath: string, sha256?: string): Promise<void> {
    const metadata = this.metadata(fileId);
    metadata.history.push({ at: new Date().toISOString(), action, relativePath, ...(sha256 ? { sha256 } : {}) });
    if (metadata.history.length > 250) metadata.history.splice(0, metadata.history.length - 250);
    await this.save();
  }
}
