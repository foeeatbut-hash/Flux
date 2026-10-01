import fs from 'node:fs/promises';
import { watch as watchFolder, type FSWatcher, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { WindowsFileRef, WindowsFileEntry, WindowsFileMetadata, WindowsFilesChanged, WindowsKnownFolder } from '../../filesystem/contracts';
import { WindowsFilesError, resolveSafePath, validateWindowsName, joinRelative, isContained } from './paths';
import { inspectWindowsTree, copyWindowsTree, cleanCreatedWindowsTree } from './tree';
import { WindowsFilesState, type StoredDraft } from './state';
import { replaceWindowsFile } from './replace';

export interface WindowsFilesDependencies {
  userData: string;
  knownFolders?: Partial<Record<Exclude<WindowsKnownFolder, 'custom'>, string>>;
  trashItem: (filename: string) => Promise<void>;
  showItemInFolder: (filename: string) => void;
  openPath: (filename: string) => Promise<string>;
  onChanged?: (change: WindowsFilesChanged) => void;
}
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_LIST = 50_000;
export const hashWindowsBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function decodeBytes(base64: string): Buffer {
  if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) {
    throw new WindowsFilesError('INVALID_CONTENT', 'Содержимое файла неверно или превышает 64 МБ.');
  }
  const data = Buffer.from(base64, 'base64');
  if (data.byteLength > MAX_BYTES) throw new WindowsFilesError('FILE_TOO_LARGE', 'Для редактирования в Flux поддерживаются файлы до 64 МБ.');
  return data;
}
export class WindowsFilesService {
  private locks = new Map<string, Promise<unknown>>();
  private parentSearch = new Map<string, { expires: number; ref: WindowsFileRef | null }>();
  private watchers = new Map<string, { watcher: FSWatcher; timer?: ReturnType<typeof setTimeout>; ref: WindowsFileRef; owners: Set<number> }>();
  private constructor(private deps: WindowsFilesDependencies, readonly state: WindowsFilesState) {}
  static async create(deps: WindowsFilesDependencies) {
    const state = await WindowsFilesState.load(deps.userData);
    for (const [kind, folder] of Object.entries(deps.knownFolders || {})) {
      if (folder) await state.addRoot(folder, kind as WindowsKnownFolder, { desktop: 'Рабочий стол', documents: 'Документы', downloads: 'Загрузки' }[kind]).catch(() => undefined);
    }
    return new WindowsFilesService(deps, state);
  }
  private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (process.platform === 'win32') key = key.toLocaleLowerCase('en-US');
    const previous = this.locks.get(key) || Promise.resolve();
    const running = previous.catch(() => undefined).then(work);
    this.locks.set(key, running);
    try { return await running; } finally { if (this.locks.get(key) === running) this.locks.delete(key); }
  }
  private draft(ref: WindowsFileRef): StoredDraft {
    const draft = this.state.data.drafts[ref.draftId || ''];
    this.state.root(ref.rootId);
    if (!draft || draft.trashed) throw new WindowsFilesError('DRAFT_MISSING', 'Черновик не найден на этом устройстве.');
    return draft;
  }
  private draftFileId(id: string) { return hashWindowsBytes(Buffer.from(`${this.state.data.deviceId}:draft:${id}`)); }
  resolveRef(ref: WindowsFileRef): WindowsFileRef {
    if (!ref.draftId) return ref;
    const draft = this.draft(ref);
    return draft.publishedRef || { rootId: draft.parent.rootId, relativePath: joinRelative(draft.parent.relativePath, draft.name), draftId: draft.id };
  }
  private async filename(ref: WindowsFileRef, missing = false): Promise<string> {
    if (!ref || typeof ref !== 'object') throw new WindowsFilesError('INVALID_REQUEST', 'Не указан файл.');
    if (ref.draftId) {
      const draft = this.draft(ref);
      if (draft.publishedRef) return this.filename(draft.publishedRef, missing);
      this.state.root(ref.rootId);
      return path.join(this.deps.userData, 'windows-files-drafts', `${draft.id}.bin`);
    }
    return resolveSafePath(this.state.root(ref.rootId).path, ref.relativePath, missing);
  }
  private identityFromStat(filename: string, stat: Awaited<ReturnType<typeof fs.lstat>> | any): string {
    const identity = stat.ino !== 0n ? `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` : `path:${filename}`;
    const key = hashWindowsBytes(Buffer.from(`${this.state.data.deviceId}:${identity}`));
    return this.state.data.identity[key] || key;
  }
  private async identity(filename: string): Promise<string> { return this.identityFromStat(filename, await fs.lstat(filename, { bigint: true })); }
  private async preserveIdentity(filename: string, fileId: string, persist = true) {
    const newId = await this.identity(filename);
    if (newId !== fileId) { this.state.data.identity[newId] = fileId; if (persist) await this.state.save(); }
  }
  private async entry(ref: WindowsFileRef, allowLink = false): Promise<WindowsFileEntry> {
    ref = this.resolveRef(ref);
    const root = this.state.root(ref.rootId);
    const filename = allowLink && !ref.draftId ? path.join(root.path, ...ref.relativePath.split('/')) : await this.filename(ref);
    const stat = await fs.lstat(filename);
    return { name: path.posix.basename(ref.relativePath) || path.basename(filename), relativePath: ref.relativePath, storage: ref.draftId ? 'flux' : 'windows', ...(ref.draftId ? { draftId: ref.draftId } : {}), kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', fileId: ref.draftId ? this.draftFileId(ref.draftId) : await this.identity(filename), size: stat.size, modifiedAt: stat.mtime.toISOString(), linked: stat.isSymbolicLink() };
  }
  async roots() {
    return Promise.all(this.state.data.roots.map(async root => ({ id: root.id, name: root.name, kind: root.kind, available: await fs.stat(root.path).then(stat => stat.isDirectory()).catch(() => false) })));
  }
  async addRoot(filename: string) { const root = await this.state.addRoot(filename, 'custom'); return { id: root.id, name: root.name, kind: root.kind, available: true }; }
  async list(ref: WindowsFileRef, offset = 0, limit = 250) {
    const filename = await this.filename(ref);
    if (!(await fs.stat(filename)).isDirectory()) throw new WindowsFilesError('NOT_DIRECTORY', 'Откройте папку.');
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new WindowsFilesError('INVALID_RANGE', 'Некорректный диапазон списка.');
    const directory = await fs.opendir(filename);
    const names: string[] = [];
    for await (const item of directory) { names.push(item.name); if (names.length >= MAX_LIST) break; }
    for (const draft of Object.values(this.state.data.drafts)) if (!draft.trashed && !draft.publishedRef && draft.parent.rootId === ref.rootId) await this.reconcileDraftParent(draft).catch(() => undefined);
    const virtual = Object.values(this.state.data.drafts).filter(draft => !draft.trashed && !draft.publishedRef && draft.parent.rootId === ref.rootId && draft.parent.relativePath === ref.relativePath);
    const candidates = [...names.map(name => ({ name, draftId: undefined as string | undefined })), ...virtual.map(draft => ({ name: draft.name, draftId: draft.id }))];
    candidates.sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' }));
    const entries: WindowsFileEntry[] = [];
    for (const item of candidates.slice(offset, offset + limit)) {
      try { validateWindowsName(item.name); entries.push(await this.entry({ rootId: ref.rootId, relativePath: joinRelative(ref.relativePath, item.name), ...(item.draftId ? { draftId: item.draftId } : {}) }, true)); }
      catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'INVALID_NAME') throw error; }
    }
    return { root: (await this.roots()).find(root => root.id === ref.rootId), relativePath: ref.relativePath, entries, nextOffset: offset + limit < candidates.length ? offset + limit : null, truncated: names.length >= MAX_LIST };
  }
  async read(ref: WindowsFileRef) {
    ref = this.resolveRef(ref);
    const filename = await this.filename(ref);
    const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile()) throw new WindowsFilesError('NOT_FILE', 'Выберите обычный файл.');
      if (stat.size > BigInt(MAX_BYTES)) throw new WindowsFilesError('FILE_TOO_LARGE', 'Для редактирования в Flux поддерживаются файлы до 64 МБ.');
      const bytes = await file.readFile();
      if (bytes.length > MAX_BYTES) throw new WindowsFilesError('FILE_TOO_LARGE', 'Файл стал больше 64 МБ.');
      const after = await file.stat({ bigint: true });
      await this.filename(ref);
      const named = await fs.lstat(filename, { bigint: true });
      if (stat.ino !== named.ino || stat.dev !== named.dev || stat.mtimeNs !== after.mtimeNs || stat.size !== after.size || stat.ctimeNs !== after.ctimeNs) {
        throw new WindowsFilesError('CONFLICT', 'Файл изменился во время чтения. Повторите открытие свежей версии.');
      }
      return { name: path.posix.basename(ref.relativePath) || path.basename(filename), relativePath: ref.relativePath, storage: ref.draftId ? 'flux' as const : 'windows' as const, ...(ref.draftId ? { draftId: ref.draftId } : {}), kind: 'file' as const,
        fileId: ref.draftId ? this.draftFileId(ref.draftId) : this.identityFromStat(filename, stat), size: Number(stat.size), modifiedAt: new Date(Number(stat.mtimeMs)).toISOString(), linked: false,
        base64: bytes.toString('base64'), sha256: hashWindowsBytes(bytes) };
    } finally { await file.close(); }
  }
  private changed(ref: WindowsFileRef) { this.deps.onChanged?.({ rootId: ref.rootId, relativePath: path.posix.dirname(ref.relativePath) === '.' ? '' : path.posix.dirname(ref.relativePath), rescan: true }); }
  async write(ref: WindowsFileRef, base64: string, baseSha256: string) {
    if (ref?.draftId) return this.locked(`draft-operation:${ref.draftId}`, () => this.writeResolved(this.resolveRef(ref), base64, baseSha256));
    return this.writeResolved(ref, base64, baseSha256);
  }
  private async writeResolved(ref: WindowsFileRef, base64: string, baseSha256: string) {
    ref = this.resolveRef(ref);
    const bytes = decodeBytes(base64);
    if (!/^[a-f0-9]{64}$/u.test(baseSha256 || '')) throw new WindowsFilesError('VERSION_REQUIRED', 'Для сохранения нужна исходная версия файла.');
    const filename = await this.filename(ref);
    return this.locked(filename, async () => {
      const current = await this.read(ref);
      if (current.sha256 !== baseSha256) throw new WindowsFilesError('CONFLICT', 'Файл изменён другой программой. Откройте свежую версию или сохраните копию.');
      const temp = path.join(path.dirname(filename), `.flux-${randomUUID()}.tmp`);
      try {
        const file = await fs.open(temp, 'wx', (await fs.stat(filename)).mode);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await this.filename(ref);
        const check = await this.read(ref);
        if (check.sha256 !== baseSha256 || check.fileId !== current.fileId) throw new WindowsFilesError('CONFLICT', 'Файл изменился во время сохранения. Ваши правки не записаны поверх новой версии.');
        // Снимок рядом со свойствами сохраняет предыдущую версию при сбое процесса.
        const recovery = path.join(this.deps.userData, 'windows-files-recovery');
        await fs.mkdir(recovery, { recursive: true });
        await fs.writeFile(path.join(recovery, `${current.fileId}-${baseSha256}.bin`), Buffer.from(check.base64, 'base64'), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        await fs.utimes(path.join(recovery, `${current.fileId}-${baseSha256}.bin`), new Date(), new Date());
        await this.trimRecovery(recovery);
        if (ref.draftId) await fs.rename(temp, filename); else await replaceWindowsFile(temp, filename, baseSha256);
        await this.preserveIdentity(filename, current.fileId);
        await this.state.history(current.fileId, 'save', ref.relativePath, hashWindowsBytes(bytes));
        this.changed(ref); return await this.read(ref);
      } finally { await fs.unlink(temp).catch(() => undefined); }
    });
  }
  private async trimRecovery(directory: string) {
    const snapshots = await Promise.all((await fs.readdir(directory)).filter(name => /^[a-f0-9]{64}-[a-f0-9]{64}\.bin$/u.test(name)).map(async name => ({ name, stat: await fs.stat(path.join(directory, name)) })));
    snapshots.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    let size = 0;
    for (let index = 0; index < snapshots.length; index++) {
      const snapshot = snapshots[index]; size += snapshot.stat.size;
      if (index >= 20 || size > 256 * 1024 * 1024) await fs.unlink(path.join(directory, snapshot.name)).catch(() => undefined);
    }
  }
  async publish(parent: WindowsFileRef, name: string, base64: string, draftId: string) {
    validateWindowsName(name);
    if (typeof draftId !== 'string' || draftId.length < 1 || draftId.length > 180 || /[\u0000-\u001f]/u.test(draftId)) throw new WindowsFilesError('INVALID_DRAFT', 'Не указан черновик.');
    const bytes = decodeBytes(base64); const sha256 = hashWindowsBytes(bytes);
    return this.locked(`draft:${draftId}`, async () => {
      const previous = this.state.data.publications[draftId];
      if (previous) {
        const current = await this.read(previous.ref).catch(() => null);
        if (previous.status === 'pending') {
          if (!current) {
            delete this.state.data.publications[draftId]; await this.state.save();
          } else if (previous.fileId && current.fileId === previous.fileId && current.sha256 === previous.sha256) {
            previous.status = 'complete'; await this.state.save();
            return { ref: previous.ref, file: current, alreadyPublished: true };
          } else {
            throw new WindowsFilesError('PUBLICATION_INCOMPLETE', 'Предыдущая публикация прервалась. Черновик сохранён; проверьте файл в Windows, затем выберите другое имя для повторной публикации.');
          }
        } else {
          if (!current || current.fileId !== previous.fileId) throw new WindowsFilesError('PUBLISHED_MISSING', 'Черновик уже опубликован, но файл перенесён или удалён. Проверьте историю.');
          if (previous.sha256 !== sha256) throw new WindowsFilesError('ALREADY_PUBLISHED', 'Черновик уже опубликован. Дальнейшие правки сохраняйте в связанный файл.');
          return { ref: previous.ref, file: current, alreadyPublished: true };
        }
      }
      const parentName = await this.filename(parent);
      if (!(await fs.stat(parentName)).isDirectory()) throw new WindowsFilesError('NOT_DIRECTORY', 'Родительская папка недоступна.');
      const ref = { rootId: parent.rootId, relativePath: joinRelative(parent.relativePath, name) };
      const filename = await this.filename(ref, true);
      const journal = { ref, sha256, fileId: '', status: 'pending' as 'pending' | 'complete' };
      this.state.data.publications[draftId] = journal; await this.state.save();
      let file: Awaited<ReturnType<typeof fs.open>>;
      try { file = await fs.open(filename, 'wx', 0o600); }
      catch (error) { delete this.state.data.publications[draftId]; await this.state.save(); throw error; }
      try {
        journal.fileId = await this.identity(filename); await this.state.save();
        await file.writeFile(bytes); await file.sync();
      } catch (error) {
        await file.close(); await fs.unlink(filename).catch(() => undefined);
        delete this.state.data.publications[draftId]; await this.state.save(); throw error;
      }
      await file.close();
      const result = await this.read(ref);
      journal.fileId = result.fileId; journal.status = 'complete';
      await this.state.history(result.fileId, 'publish', ref.relativePath, sha256);
      this.changed(ref); return { ref, file: result, alreadyPublished: false };
    });
  }
  private async ensureFreeName(parent: WindowsFileRef, name: string, exceptDraft?: string) {
    validateWindowsName(name);
    const filename = await this.filename(parent);
    const names = await fs.readdir(filename);
    const match = (value: string) => value.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US');
    if (names.some(match) || Object.values(this.state.data.drafts).some(draft => !draft.trashed && !draft.publishedRef && draft.id !== exceptDraft && draft.parent.rootId === parent.rootId && draft.parent.relativePath === parent.relativePath && match(draft.name))) {
      throw new WindowsFilesError('EEXIST', 'Файл с таким именем уже есть в папке Windows или среди черновиков Flux.');
    }
  }
  private async findDirectory(rootId: string, fileId: string): Promise<WindowsFileRef | null> {
    const root = this.state.root(rootId); let visited = 0;
    const queue = [''];
    while (queue.length) {
      const relativePath = queue.shift()!; const ref = { rootId, relativePath };
      const filename = await this.filename(ref).catch(() => null);
      if (!filename) continue;
      if (++visited > 5000) throw new WindowsFilesError('PARENT_SEARCH_LIMIT', 'Не удалось быстро найти перемещённую папку. Подключите новое место вручную.');
      if (await this.identity(filename) === fileId) return ref;
      if (relativePath.split('/').length >= 64) continue;
      const directory = await fs.opendir(filename);
      for await (const entry of directory) if (entry.isDirectory() && !entry.isSymbolicLink()) {
        try { validateWindowsName(entry.name); queue.push(joinRelative(relativePath, entry.name)); } catch { /* Необычные имена Windows не становятся адресом в мосте. */ }
        if (queue.length + visited > 5000) throw new WindowsFilesError('PARENT_SEARCH_LIMIT', 'Перемещённая папка не найдена среди первых 5000 папок. Подключите новое место вручную.');
      }
    }
    return null;
  }
  private async reconcileDraftParent(draft: StoredDraft): Promise<void> {
    if (!draft.parentFileId) return;
    const existing = await this.filename(draft.parent).then(filename => this.identity(filename)).catch(() => null);
    if (existing === draft.parentFileId) return;
    const searchKey = `${draft.parent.rootId}:${draft.parentFileId}`;
    const cached = this.parentSearch.get(searchKey);
    const found = cached && cached.expires > Date.now() ? cached.ref : await this.findDirectory(draft.parent.rootId, draft.parentFileId);
    this.parentSearch.set(searchKey, { expires: Date.now() + 2000, ref: found });
    if (!found) throw new WindowsFilesError('PARENT_MISSING', 'Родитель черновика перенесён за пределы подключённой папки или удалён. Черновик сохранён в Flux.');
    draft.parent = found; await this.state.save();
  }
  async createDraft(parent: WindowsFileRef, name: string, base64: string) {
    if (parent.draftId) throw new WindowsFilesError('DRAFT_FOLDER_UNSUPPORTED', 'Черновик создаётся внутри настоящей папки Windows.');
    const bytes = decodeBytes(base64);
    const parentPath = await this.filename(parent);
    return this.locked(`draft-parent:${parentPath}`, async () => {
      await this.ensureFreeName(parent, name);
      const id = randomUUID(); const directory = path.join(this.deps.userData, 'windows-files-drafts');
      await fs.mkdir(directory, { recursive: true });
      const filename = path.join(directory, `${id}.bin`);
      await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
      this.state.data.drafts[id] = { id, parent: { rootId: parent.rootId, relativePath: parent.relativePath }, parentFileId: await this.identity(parentPath), name };
      const ref = { rootId: parent.rootId, relativePath: joinRelative(parent.relativePath, name), draftId: id };
      await this.state.history(this.draftFileId(id), 'create-draft', ref.relativePath, hashWindowsBytes(bytes)); this.changed(ref);
      return { ref, file: await this.read(ref) };
    });
  }
  async publishDraft(ref: WindowsFileRef) {
    const draft = this.draft(ref);
    return this.locked(`draft-operation:${draft.id}`, async () => {
    if (draft.publishedRef) return { ref: draft.publishedRef, file: await this.read(draft.publishedRef), alreadyPublished: true };
    await this.reconcileDraftParent(draft);
    const content = await this.read(ref);
    const published = await this.publish(draft.parent, draft.name, content.base64, draft.id);
    const fileId = this.draftFileId(draft.id);
    await this.preserveIdentity(await this.filename(published.ref), fileId);
    const publication = this.state.data.publications[draft.id]; publication.fileId = fileId;
    draft.publishedRef = published.ref;
    await this.state.history(fileId, 'publish-draft', published.ref.relativePath, content.sha256);
    return { ref: published.ref, file: await this.read(published.ref), alreadyPublished: published.alreadyPublished };
    });
  }
  async mkdir(parent: WindowsFileRef, name: string) {
    const ref = { rootId: parent.rootId, relativePath: joinRelative(parent.relativePath, name) };
    const filename = await this.filename(ref, true); await fs.mkdir(filename); this.changed(ref); return this.entry(ref);
  }
  async rename(ref: WindowsFileRef, name: string) {
    ref = this.resolveRef(ref);
    validateWindowsName(name);
    if (ref.draftId) {
      const draft = this.draft(ref); await this.ensureFreeName(draft.parent, name, draft.id); draft.name = name;
      const next = this.resolveRef(ref); await this.state.history(this.draftFileId(draft.id), 'rename', next.relativePath); this.changed(next);
      return { ref: next, file: await this.entry(next) };
    }
    if (!ref.relativePath) throw new WindowsFilesError('ROOT_OPERATION', 'Корень подключённой папки нельзя переименовать.');
    const parent = { rootId: ref.rootId, relativePath: ref.relativePath.split('/').slice(0, -1).join('/') };
    return this.move(ref, parent, name);
  }
  private async reserveTarget(parent: WindowsFileRef, name: string) {
    const ref = { rootId: parent.rootId, relativePath: joinRelative(parent.relativePath, validateWindowsName(name)) };
    const filename = await this.filename(ref, true);
    return { ref, filename };
  }
  async copy(ref: WindowsFileRef, parent: WindowsFileRef, name: string) {
    ref = this.resolveRef(ref);
    if (ref.draftId) return this.createDraft(parent, name, (await this.read(ref)).base64);
    const source = await this.filename(ref); const stat = await fs.stat(source);
    const target = await this.reserveTarget(parent, name);
    if (stat.isDirectory()) {
      if (isContained(source, target.filename)) throw new WindowsFilesError('RECURSIVE_TARGET', 'Нельзя скопировать папку внутрь неё самой.');
      const plan = await inspectWindowsTree(source);
      await copyWindowsTree(source, target.filename, plan);
    } else if (stat.isFile()) await fs.copyFile(source, target.filename, constants.COPYFILE_EXCL);
    else throw new WindowsFilesError('UNSUPPORTED_ENTRY', 'Этот тип файла копируется средствами Windows.');
    const originals = stat.isDirectory() ? Object.values(this.state.data.drafts).filter(draft => !draft.trashed && !draft.publishedRef && draft.parent.rootId === ref.rootId && (draft.parent.relativePath === ref.relativePath || draft.parent.relativePath.startsWith(`${ref.relativePath}/`))) : [];
    for (const draft of originals) {
      const copiedParent = { rootId: parent.rootId, relativePath: `${target.ref.relativePath}${draft.parent.relativePath.slice(ref.relativePath.length)}` };
      const content = await this.read({ rootId: draft.parent.rootId, relativePath: joinRelative(draft.parent.relativePath, draft.name), draftId: draft.id });
      await this.createDraft(copiedParent, draft.name, content.base64);
    }
    const result = await this.entry(target.ref); await this.state.history(result.fileId, 'copy', target.ref.relativePath); this.changed(target.ref); return { ref: target.ref, file: result };
  }
  async move(ref: WindowsFileRef, parent: WindowsFileRef, name: string, baseSha256?: string) {
    ref = this.resolveRef(ref);
    if (ref.draftId) {
      const draft = this.draft(ref);
      await this.filename(parent); await this.ensureFreeName(parent, name, draft.id);
      if (baseSha256 && (await this.read(ref)).sha256 !== baseSha256) throw new WindowsFilesError('CONFLICT', 'Черновик изменился; проверьте свежую версию.');
      const previousRef = this.resolveRef(ref); draft.parent = { rootId: parent.rootId, relativePath: parent.relativePath }; draft.parentFileId = await this.identity(await this.filename(parent)); draft.name = name;
      const next = { rootId: parent.rootId, relativePath: joinRelative(parent.relativePath, name), draftId: draft.id };
      await this.state.history(this.draftFileId(draft.id), 'move-draft', next.relativePath); this.changed(previousRef); this.changed(next);
      return { ref: next, file: await this.entry(next) };
    }
    if (!ref.relativePath) throw new WindowsFilesError('ROOT_OPERATION', 'Корень подключённой папки нельзя переместить.');
    const source = await this.filename(ref); const target = await this.reserveTarget(parent, name);
    return this.locked(source, async () => {
      const entry = await this.entry(ref);
      if (entry.kind === 'directory') return this.moveDirectory(ref, parent, name, source, target, entry.fileId);
      if (entry.kind !== 'file') throw new WindowsFilesError('UNSUPPORTED_ENTRY', 'Этот тип файла переносится средствами Windows.');
      const original = await this.read(ref);
      if (baseSha256 && original.sha256 !== baseSha256) throw new WindowsFilesError('CONFLICT', 'Файл изменился; повторите действие со свежей версией.');
      // link не заменяет существующую цель, в отличие от rename на POSIX.
      try { await fs.link(source, target.filename); }
      catch (error: any) {
        if (error.code !== 'EXDEV' && error.code !== 'EPERM' && error.code !== 'ENOTSUP') throw error;
        await fs.copyFile(source, target.filename, constants.COPYFILE_EXCL);
      }
      let removedSource = false;
      try {
        const copied = await this.read(target.ref);
        const fresh = await this.read(ref);
        if (copied.sha256 !== original.sha256 || fresh.sha256 !== original.sha256 || fresh.fileId !== original.fileId) throw new WindowsFilesError('CONFLICT', 'Исходный файл изменился при переносе. Он сохранён на прежнем месте.');
        await this.filename(ref); await fs.unlink(source); removedSource = true;
        await this.preserveIdentity(target.filename, original.fileId);
        await this.state.history(original.fileId, 'move', target.ref.relativePath, original.sha256);
        for (const publication of Object.values(this.state.data.publications)) if (publication.fileId === original.fileId) publication.ref = target.ref;
        await this.state.save();
        this.changed(ref); this.changed(target.ref); return { ref: target.ref, file: await this.entry(target.ref) };
      } catch (error) { if (!removedSource) await fs.unlink(target.filename).catch(() => undefined); throw error; }
    });
  }
  private async moveDirectory(ref: WindowsFileRef, parent: WindowsFileRef, name: string, source: string, target: { ref: WindowsFileRef; filename: string }, fileId: string) {
    if (isContained(source, target.filename)) throw new WindowsFilesError('RECURSIVE_TARGET', 'Нельзя переместить папку внутрь неё самой.');
    const plan = await inspectWindowsTree(source);
    const identities = await Promise.all(plan.map(async item => ({ item, fileId: await this.identity(item.relative ? path.join(source, ...item.relative.split('/')) : source) })));
    await this.ensureFreeName(parent, name);
    const created = await copyWindowsTree(source, target.filename, plan);
    // Корзина оставляет восстанавливаемый оригинал даже при сбое после переноса.
    // Исключительное создание копии не заменяет чужую папку с тем же именем.
    try {
      await this.filename(ref);
      const fresh = await inspectWindowsTree(source);
      if (JSON.stringify(fresh.map(item => [item.relative, item.kind, item.sha256])) !== JSON.stringify(plan.map(item => [item.relative, item.kind, item.sha256]))) {
        throw new WindowsFilesError('CONFLICT', 'Папка изменилась перед переносом. Исходная папка сохранена.');
      }
      await this.deps.trashItem(source);
    } catch (error) {
      await cleanCreatedWindowsTree(created);
      throw error;
    }
    for (const identity of identities) {
      const filename = identity.item.relative ? path.join(target.filename, ...identity.item.relative.split('/')) : target.filename;
      await this.preserveIdentity(filename, identity.fileId, false);
    }
    for (const draft of Object.values(this.state.data.drafts)) {
      if (draft.parent.rootId === ref.rootId && (draft.parent.relativePath === ref.relativePath || draft.parent.relativePath.startsWith(`${ref.relativePath}/`))) {
        const suffix = draft.parent.relativePath.slice(ref.relativePath.length);
        draft.parent = { rootId: target.ref.rootId, relativePath: `${target.ref.relativePath}${suffix}` };
      }
    }
    for (const publication of Object.values(this.state.data.publications)) if (publication.ref.rootId === ref.rootId && publication.ref.relativePath.startsWith(`${ref.relativePath}/`)) publication.ref = { rootId: target.ref.rootId, relativePath: `${target.ref.relativePath}${publication.ref.relativePath.slice(ref.relativePath.length)}` };
    for (const draft of Object.values(this.state.data.drafts)) if (draft.publishedRef && draft.publishedRef.rootId === ref.rootId && draft.publishedRef.relativePath.startsWith(`${ref.relativePath}/`)) draft.publishedRef = { rootId: target.ref.rootId, relativePath: `${target.ref.relativePath}${draft.publishedRef.relativePath.slice(ref.relativePath.length)}` };
    await this.state.history(fileId, 'move-folder', target.ref.relativePath);
    this.changed(ref); this.changed(target.ref); return { ref: target.ref, file: await this.entry(target.ref) };
  }
  async draftTrash() {
    return Object.values(this.state.data.drafts).filter(draft => draft.trashed && !draft.publishedRef).map(draft => ({
      ref: { rootId: draft.parent.rootId, relativePath: joinRelative(draft.parent.relativePath, draft.name), draftId: draft.id },
      name: draft.name, storage: 'flux' as const, fileId: this.draftFileId(draft.id), metadata: this.state.metadata(this.draftFileId(draft.id)),
    }));
  }
  async restoreDraft(ref: WindowsFileRef) {
    this.state.root(ref.rootId);
    const draft = this.state.data.drafts[ref.draftId || ''];
    if (!draft || !draft.trashed || draft.publishedRef) throw new WindowsFilesError('DRAFT_MISSING', 'Удалённый черновик не найден.');
    await this.reconcileDraftParent(draft); await this.ensureFreeName(draft.parent, draft.name, draft.id);
    draft.trashed = false;
    const restored = this.resolveRef(ref);
    await this.state.history(this.draftFileId(draft.id), 'restore-draft', restored.relativePath); this.changed(restored);
    return { ref: restored, file: await this.read(restored) };
  }
  async trash(ref: WindowsFileRef, baseSha256?: string) {
    ref = this.resolveRef(ref);
    if (ref.draftId) {
      const draft = this.draft(ref);
      if (baseSha256 && (await this.read(ref)).sha256 !== baseSha256) throw new WindowsFilesError('CONFLICT', 'Черновик изменился; проверьте свежую версию.');
      draft.trashed = true; await this.state.history(this.draftFileId(draft.id), 'trash-draft', ref.relativePath); this.changed(ref);
      return { trashed: true, fileId: this.draftFileId(draft.id), storage: 'flux' };
    }
    if (!ref.relativePath) throw new WindowsFilesError('ROOT_OPERATION', 'Подключённую папку нельзя удалить через Flux.');
    const filename = await this.filename(ref);
    return this.locked(filename, async () => {
      const entry = await this.entry(ref);
      if (baseSha256 && (await this.read(ref)).sha256 !== baseSha256) throw new WindowsFilesError('CONFLICT', 'Файл изменился; сначала проверьте свежую версию.');
      await this.deps.trashItem(filename); await this.state.history(entry.fileId, 'trash', ref.relativePath); this.changed(ref); return { trashed: true, fileId: entry.fileId };
    });
  }
  async reveal(ref: WindowsFileRef) { ref = this.resolveRef(ref); if (ref.draftId) throw new WindowsFilesError('DRAFT_NOT_PUBLISHED', 'Черновик находится только в Flux. Сначала выберите «Отобразить в Windows».'); this.deps.showItemInFolder(await this.filename(ref)); return { opened: true }; }
  async open(ref: WindowsFileRef) { ref = this.resolveRef(ref); if (ref.draftId) throw new WindowsFilesError('DRAFT_NOT_PUBLISHED', 'Черновик находится только в Flux. Откройте его редактором Flux или опубликуйте в Windows.'); const error = await this.deps.openPath(await this.filename(ref)); if (error) throw new WindowsFilesError('OPEN_FAILED', error); return { opened: true }; }
  async metadata(ref: WindowsFileRef) { const entry = await this.entry(ref); return this.state.metadata(entry.fileId); }
  async setMetadata(ref: WindowsFileRef, data: Pick<WindowsFileMetadata, 'tags' | 'projectIds' | 'revision' | 'responsible'>) {
    if (!data || !Array.isArray(data.tags) || !Array.isArray(data.projectIds) || data.tags.length > 100 || data.projectIds.length > 100
      || [...data.tags, ...data.projectIds, data.revision, data.responsible].some(value => typeof value !== 'string' || value.length > 200)) throw new WindowsFilesError('INVALID_METADATA', 'Некорректные свойства файла.');
    const entry = await this.entry(ref); const metadata = this.state.metadata(entry.fileId);
    metadata.tags = [...new Set(data.tags)]; metadata.projectIds = [...new Set(data.projectIds)]; metadata.revision = data.revision; metadata.responsible = data.responsible;
    await this.state.history(entry.fileId, 'metadata', ref.relativePath); return metadata;
  }
  async watch(ref: WindowsFileRef, owner: number) {
    const filename = await this.filename(ref);
    if (!(await fs.stat(filename)).isDirectory()) throw new WindowsFilesError('NOT_DIRECTORY', 'Наблюдение подключается к папке.');
    const existing = this.watchers.get(filename);
    if (existing) { existing.owners.add(owner); return { watching: true }; }
    if (this.watchers.size >= 64) throw new WindowsFilesError('WATCH_LIMIT', 'Открыто слишком много наблюдаемых папок. Закройте лишние окна.');
    const record = { watcher: null as FSWatcher | null, timer: undefined as ReturnType<typeof setTimeout> | undefined, ref, owners: new Set([owner]) };
    const emit = () => { if (!record.timer) record.timer = setTimeout(() => { record.timer = undefined; this.deps.onChanged?.({ ...ref, rescan: true }); }, 150); };
    record.watcher = watchFolder(filename, { persistent: false }, emit);
    record.watcher.on('error', emit);
    this.watchers.set(filename, record as NonNullable<ReturnType<typeof this.watchers.get>>);
    return { watching: true };
  }
  async unwatch(ref: WindowsFileRef, owner: number) {
    const filename = await this.filename(ref).catch(() => null);
    for (const [key, record] of this.watchers) if (key === filename || (record.ref.rootId === ref.rootId && record.ref.relativePath === ref.relativePath)) {
      record.owners.delete(owner); if (!record.owners.size) { record.watcher.close(); if (record.timer) clearTimeout(record.timer); this.watchers.delete(key); }
    }
    return { watching: false };
  }
  closeOwner(owner: number) { for (const [key, record] of this.watchers) { record.owners.delete(owner); if (!record.owners.size) { record.watcher.close(); if (record.timer) clearTimeout(record.timer); this.watchers.delete(key); } } }
  close() { for (const record of this.watchers.values()) { record.watcher.close(); if (record.timer) clearTimeout(record.timer); } this.watchers.clear(); }
}
