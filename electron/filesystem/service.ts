import fs from 'node:fs/promises';
import { watch as watchFolder, type FSWatcher, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { WindowsFileRef, WindowsFileEntry, WindowsFileMetadata, WindowsFilesChanged, WindowsKnownFolder } from '../../filesystem/contracts';
import { WindowsFilesError, resolveSafePath, validateWindowsName, joinRelative, isContained } from './paths';
import { inspectWindowsTree, copyWindowsTree, cleanCreatedWindowsTree } from './tree';
import { WindowsFilesState, type StoredDraft } from './state';
import { replaceWindowsFile } from './replace';
import { isNetworkFolder } from './network';
import { existingAt, freeNameIn, mergeDraftMetadata, parseChoices } from './publishing';
import type { WindowsPublishChoices } from '../../filesystem/contracts';
import { UndoJournal, fingerprint, type TrashInfo, type UndoOp, type Place } from './undo';

export interface WindowsFilesDependencies {
  userData: string;
  knownFolders?: Partial<Record<Exclude<WindowsKnownFolder, 'custom'>, string>>;
  trashItem: (filename: string) => Promise<void>;
  showItemInFolder: (filename: string) => void;
  openPath: (filename: string) => Promise<string>;
  onChanged?: (change: WindowsFilesChanged) => void;
  /** Возвращает объект из корзины Windows по исходному пути. Без неё отмена удаления честно отказывает. */
  restoreFromTrash?: (info: { path: string; deletedAfter: number; size: number | null; name: string }) => Promise<void>;
  /** Запускает перетаскивание файлов наружу из окна owner. Пути отдаются только main-процессу. */
  startDrag?: (owner: number, files: string[]) => void | Promise<void>;
}
/** Общие параметры изменяющих команд: группа отмены и «не записывать в журнал» (внутренние вызовы одной операции). */
export interface OpOptions { group?: string; silent?: boolean }
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
async function copyDraftFile(source: string, target: string): Promise<number> {
  const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let output: Awaited<ReturnType<typeof fs.open>> | null = null;
  let owned: { dev: bigint; ino: bigint } | null = null;
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_BYTES)) throw new WindowsFilesError('FILE_TOO_LARGE', 'Файл черновика недоступен или превышает 64 МБ.');
    output = await fs.open(target, 'wx', 0o600);
    const created = await output.stat({ bigint: true }); owned = { dev: created.dev, ino: created.ino };
    const buffer = Buffer.alloc(256 * 1024); let position = 0;
    for (;;) {
      const read = await input.read(buffer, 0, buffer.length, position);
      if (!read.bytesRead) break;
      let written = 0;
      while (written < read.bytesRead) {
        const result = await output.write(buffer, written, read.bytesRead - written, position + written);
        if (!result.bytesWritten) throw new WindowsFilesError('WRITE_FAILED', 'Не удалось записать файл. Черновик Flux сохранён.');
        written += result.bytesWritten;
      }
      position += read.bytesRead;
    }
    const after = await input.stat({ bigint: true });
    const named = await fs.lstat(source, { bigint: true });
    if (position !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink()) throw new WindowsFilesError('CONFLICT', 'Черновик изменился при публикации. Исходный файл сохранён.');
    await output.sync();
    return position;
  } catch (error) {
    if (owned) {
      const current = await fs.lstat(target, { bigint: true }).catch(() => null);
      if (current && current.dev === owned.dev && current.ino === owned.ino) await fs.unlink(target).catch(() => undefined);
    }
    throw error;
  } finally { await input.close(); await output?.close(); }
}
export class WindowsFilesService {
  private locks = new Map<string, Promise<unknown>>();
  private parentSearch = new Map<string, { expires: number; ref: WindowsFileRef | null }>();
  private watchers = new Map<string, { watcher: FSWatcher; timer?: ReturnType<typeof setTimeout>; ref: WindowsFileRef; owners: Set<number> }>();
  private constructor(private deps: WindowsFilesDependencies, readonly state: WindowsFilesState, readonly journal: UndoJournal) {}
  static async create(deps: WindowsFilesDependencies) {
    const state = await WindowsFilesState.load(deps.userData);
    for (const [kind, folder] of Object.entries(deps.knownFolders || {})) {
      if (folder) await state.addRoot(folder, kind as WindowsKnownFolder, { desktop: 'Рабочий стол', documents: 'Документы', downloads: 'Загрузки' }[kind]).catch(() => undefined);
    }
    return new WindowsFilesService(deps, state, await UndoJournal.load(deps.userData));
  }
  /** Запись в журнал отмены. Сбой журнала не вправе ломать саму операцию: файл уже изменён. */
  async record(label: string, op: UndoOp, opts: OpOptions = {}) {
    if (opts.silent) return;
    try { await this.journal.record({ label, op, ...(opts.group ? { group: opts.group } : {}) }); } catch { /* журнал — удобство, а не часть записи */ }
  }
  async restoreFromTrash(info: TrashInfo & { deletedAfter: number } | { path: string; deletedAfter: number; size: number | null; name: string }) {
    if (!this.deps.restoreFromTrash) throw new WindowsFilesError('UNDO_UNAVAILABLE', 'Возврат из корзины Windows недоступен на этом компьютере.');
    await this.deps.restoreFromTrash(info);
  }
  /** Теги и проекты переносятся копии как есть; ревизия и история остаются за оригиналом — у копии они начинаются заново. */
  private carryMetadata(fromId: string, toId: string) {
    const source = this.state.data.metadata[fromId];
    if (!source || fromId === toId || (!source.tags.length && !source.projectIds.length)) return;
    const target = this.state.metadata(toId);
    target.tags = [...new Set([...target.tags, ...source.tags])]; target.projectIds = [...new Set([...target.projectIds, ...source.projectIds])];
  }
  /** Блокировка по ключу — и для соседних модулей моста, которые правят те же файлы. */
  async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (process.platform === 'win32') key = key.toLocaleLowerCase('en-US');
    const previous = this.locks.get(key) || Promise.resolve();
    const running = previous.catch(() => undefined).then(work);
    this.locks.set(key, running);
    try { return await running; } finally { if (this.locks.get(key) === running) this.locks.delete(key); }
  }
  draft(ref: WindowsFileRef): StoredDraft {
    const draft = this.state.data.drafts[ref.draftId || ''];
    this.state.root(ref.rootId);
    if (!draft || draft.trashed) throw new WindowsFilesError('DRAFT_MISSING', 'Черновик не найден на этом устройстве.');
    return draft;
  }
  draftFileId(id: string) { return hashWindowsBytes(Buffer.from(`${this.state.data.deviceId}:draft:${id}`)); }
  resolveRef(ref: WindowsFileRef): WindowsFileRef {
    if (!ref.draftId) return ref;
    const draft = this.draft(ref);
    return draft.publishedRef || { rootId: draft.parent.rootId, relativePath: joinRelative(draft.parent.relativePath, draft.name), draftId: draft.id };
  }
  /** Абсолютный путь по проверенному capability. Наружу из main не выходит. */
  async filename(ref: WindowsFileRef, missing = false): Promise<string> {
    if (!ref || typeof ref !== 'object') throw new WindowsFilesError('INVALID_REQUEST', 'Не указан файл.');
    if (ref.draftId) {
      const draft = this.draft(ref);
      if (draft.publishedRef) return this.filename(draft.publishedRef, missing);
      if (draft.kind === 'directory') throw new WindowsFilesError('IS_DIRECTORY', 'Черновик является папкой.');
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
  async identity(filename: string): Promise<string> { return this.identityFromStat(filename, await fs.lstat(filename, { bigint: true })); }
  private async preserveIdentity(filename: string, fileId: string, persist = true) {
    const newId = await this.identity(filename);
    if (newId !== fileId) { this.state.data.identity[newId] = fileId; if (persist) await this.state.save(); }
  }
  async entry(ref: WindowsFileRef, allowLink = false): Promise<WindowsFileEntry> {
    if (ref.draftId) {
      const draft = this.draft(ref);
      if (draft.publishedRef) return this.entry(draft.publishedRef);
      if (draft.kind === 'directory') return { name: draft.name, relativePath: ref.relativePath, storage: 'flux', draftId: draft.id, kind: 'directory', fileId: this.draftFileId(draft.id), size: 0, modifiedAt: new Date().toISOString(), linked: false };
    }
    ref = this.resolveRef(ref);
    const root = this.state.root(ref.rootId);
    const filename = allowLink && !ref.draftId ? path.join(root.path, ...ref.relativePath.split('/')) : await this.filename(ref);
    const stat = await fs.lstat(filename);
    return { name: path.posix.basename(ref.relativePath) || path.basename(filename), relativePath: ref.relativePath, storage: ref.draftId ? 'flux' : 'windows', ...(ref.draftId ? { draftId: ref.draftId } : {}), kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', fileId: ref.draftId ? this.draftFileId(ref.draftId) : await this.identity(filename), size: stat.size, modifiedAt: stat.mtime.toISOString(), linked: stat.isSymbolicLink() };
  }
  async roots() {
    return Promise.all(this.state.data.roots.map(async root => ({ id: root.id, name: root.name, kind: root.kind, network:await isNetworkFolder(root.path), available: await fs.stat(root.path).then(stat => stat.isDirectory()).catch(() => false) })));
  }
  /** Только проверенный capability может запрашивать системный значок. */
  async iconPath(ref: WindowsFileRef): Promise<string | null> {
    const resolved = this.resolveRef(ref);
    if (resolved.draftId) return null;
    return this.filename(resolved);
  }
  async addRoot(filename: string, name?: string) { const root = await this.state.addRoot(filename, 'custom', name); return { id: root.id, name: root.name, kind: root.kind, network:await isNetworkFolder(root.path), available: true }; }
  /** Только main передаёт путь из Shell; renderer не умеет выдавать себе новый корень. */
  async refForShellPath(filename: string): Promise<WindowsFileRef | null> {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.length > 32767 || /[\u0000-\u001f]/u.test(filename)) return null;
    for (const root of this.state.data.roots) {
      if (!isContained(root.path, filename)) continue;
      const relativePath = path.relative(root.path, filename).split(path.sep).join('/');
      const ref = { rootId: root.id, relativePath };
      try {
        const safe = await this.filename(ref);
        const stat = await fs.lstat(safe);
        if (stat.isFile() || stat.isDirectory()) return ref;
      } catch { /* Junction и изменённый корень не получают capability даже из Shell. */ }
    }
    return null;
  }
  /** Неопубликованные черновики, лежащие непосредственно в этой папке (настоящей или черновой). */
  draftsIn(ref: WindowsFileRef): StoredDraft[] {
    return Object.values(this.state.data.drafts).filter(draft => {
      if (draft.trashed || draft.publishedRef || draft.parent.rootId !== ref.rootId) return false;
      if (draft.parent.draftId === ref.draftId && draft.parent.relativePath === ref.relativePath) return true;
      const parent = draft.parent.draftId ? this.state.data.drafts[draft.parent.draftId] : null;
      return !!parent?.publishedRef && parent.publishedRef.rootId === ref.rootId && parent.publishedRef.relativePath === ref.relativePath;
    });
  }
  async list(ref: WindowsFileRef, offset = 0, limit = 250) {
    ref = this.resolveRef(ref);
    const parentDraft = ref.draftId ? this.draft(ref) : null;
    if (parentDraft && parentDraft.kind !== 'directory') throw new WindowsFilesError('NOT_DIRECTORY', 'Откройте папку.');
    const filename = parentDraft && !parentDraft.publishedRef ? null : await this.filename(ref);
    if (filename && !(await fs.stat(filename)).isDirectory()) throw new WindowsFilesError('NOT_DIRECTORY', 'Откройте папку.');
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new WindowsFilesError('INVALID_RANGE', 'Некорректный диапазон списка.');
    const names: string[] = [];
    if (filename) {
      const directory = await fs.opendir(filename);
      for await (const item of directory) {
        if (/^\.flux-write-[0-9a-f]{64}\.lock$/u.test(item.name)) continue;
        names.push(item.name); if (names.length >= MAX_LIST) break;
      }
    }
    for (const draft of Object.values(this.state.data.drafts)) if (!draft.trashed && !draft.publishedRef && draft.parent.rootId === ref.rootId) await this.reconcileDraftParent(draft).catch(() => undefined);
    const virtual = this.draftsIn(ref);
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
  changed(ref: WindowsFileRef) { this.deps.onChanged?.({ rootId: ref.rootId, relativePath: path.posix.dirname(ref.relativePath) === '.' ? '' : path.posix.dirname(ref.relativePath), rescan: true }); }
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
    if (parent.draftId && this.draft(parent).kind !== 'directory') throw new WindowsFilesError('NOT_DIRECTORY', 'Родитель черновика не является папкой.');
    const filename = parent.draftId ? null : await this.filename(parent);
    const names = filename ? await fs.readdir(filename) : [];
    const match = (value: string) => value.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US');
    if (names.some(match) || Object.values(this.state.data.drafts).some(draft => !draft.trashed && !draft.publishedRef && draft.id !== exceptDraft && draft.parent.rootId === parent.rootId && draft.parent.relativePath === parent.relativePath && draft.parent.draftId === parent.draftId && match(draft.name))) {
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
  async reconcileDraftParent(draft: StoredDraft): Promise<void> {
    if (!draft.parentFileId) return;
    const existing = await this.filename(draft.parent).then(filename => this.identity(filename)).catch(() => null);
    if (existing === draft.parentFileId) return;
    const searchKey = `${draft.parent.rootId}:${draft.parentFileId}`;
    const cached = this.parentSearch.get(searchKey);
    const found = cached && cached.expires > Date.now() ? cached.ref : await this.findDirectory(draft.parent.rootId, draft.parentFileId);
    this.parentSearch.set(searchKey, { expires: Date.now() + 2000, ref: found });
    if (!found) throw new WindowsFilesError('PARENT_MISSING', 'Родитель черновика перенесён за пределы подключённой папки или удалён. Черновик сохранён в Flux.');
    draft.parent = found;
    // Every nested virtual folder keeps a display path as well as a draftId.
    // Rebase that path when Windows moved the real parent so old draft refs
    // and subsequent publication point at the same tree.
    for (const child of Object.values(this.state.data.drafts)) {
      if (!child.trashed && child.parent.draftId === draft.id) child.parent.relativePath = joinRelative(found.relativePath, draft.name);
    }
    if (draft.kind === 'directory') this.rebaseDraftChildren(draft.id, joinRelative(found.relativePath, draft.name));
    await this.state.save();
  }
  private rebaseDraftChildren(folderId: string, relativePath: string, depth = 0): void {
    if (depth > 64) throw new WindowsFilesError('TREE_TOO_LARGE', 'Вложенность черновиков превышает 64 папки.');
    for (const child of Object.values(this.state.data.drafts)) {
      if (child.trashed || child.parent.draftId !== folderId) continue;
      child.parent.relativePath = relativePath;
      if (child.kind === 'directory') this.rebaseDraftChildren(child.id, joinRelative(relativePath, child.name), depth + 1);
    }
  }
  async createDraft(parent: WindowsFileRef, name: string, base64: string, opts: OpOptions = {}) {
    parent = this.resolveRef(parent);
    validateWindowsName(name);
    if (parent.draftId && this.draft(parent).kind !== 'directory') throw new WindowsFilesError('NOT_DIRECTORY', 'Создайте файл внутри папки.');
    const bytes = decodeBytes(base64);
    if (!parent.draftId) await this.filename(parent);
    return this.locked(`draft-parent:${parent.rootId}:${parent.relativePath}:${parent.draftId || ''}`, async () => {
      await this.ensureFreeName(parent, name);
      const id = randomUUID(); const directory = path.join(this.deps.userData, 'windows-files-drafts');
      await fs.mkdir(directory, { recursive: true });
      const filename = path.join(directory, `${id}.bin`);
      await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
      this.state.data.drafts[id] = { id, kind: 'file', parent: { rootId: parent.rootId, relativePath: parent.relativePath, ...(parent.draftId ? { draftId: parent.draftId } : {}) }, ...(!parent.draftId ? { parentFileId: await this.identity(await this.filename(parent)) } : {}), name };
      const ref = { rootId: parent.rootId, relativePath: joinRelative(parent.relativePath, name), draftId: id };
      await this.state.history(this.draftFileId(id), 'create-draft', ref.relativePath, hashWindowsBytes(bytes)); this.changed(ref);
      if (!opts.silent) await this.record(`Создание «${name}»`, { kind: 'create', at: ref, fingerprint: await fingerprint(this, ref) }, opts);
      return { ref, file: await this.read(ref) };
    });
  }
  async createDraftFolder(parent: WindowsFileRef, name: string, opts: OpOptions = {}) {
    parent = this.resolveRef(parent);
    validateWindowsName(name);
    if (parent.draftId && this.draft(parent).kind !== 'directory') throw new WindowsFilesError('NOT_DIRECTORY', 'Создайте папку внутри папки.');
    if (!parent.draftId) await this.filename(parent);
    return this.locked(`draft-parent:${parent.rootId}:${parent.relativePath}:${parent.draftId || ''}`, async () => {
      await this.ensureFreeName(parent, name);
      const id = randomUUID();
      this.state.data.drafts[id] = { id, kind: 'directory', parent: { rootId: parent.rootId, relativePath: parent.relativePath, ...(parent.draftId ? { draftId: parent.draftId } : {}) }, ...(!parent.draftId ? { parentFileId: await this.identity(await this.filename(parent)) } : {}), name };
      const ref = { rootId: parent.rootId, relativePath: joinRelative(parent.relativePath, name), draftId: id };
      await this.state.save(); this.changed(ref);
      if (!opts.silent) await this.record(`Создание папки «${name}»`, { kind: 'create', at: ref, fingerprint: await fingerprint(this, ref) }, opts);
      return { ref, file: await this.entry(ref) };
    });
  }
  async publishDraft(ref: WindowsFileRef, rawChoices?: unknown) {
    const draft = this.draft(ref);
    if (draft.kind === 'directory') return this.publishDraftTree(ref, rawChoices);
    const choices = parseChoices(rawChoices);
    return this.locked(`draft-operation:${draft.id}`, async () => {
    if (draft.publishedRef) return { ref: draft.publishedRef, file: await this.read(draft.publishedRef), alreadyPublished: true };
    if (!draft.parent.draftId) await this.reconcileDraftParent(draft);
    const content = await this.read(ref);
    const realParent = draft.parent.draftId ? this.state.data.drafts[draft.parent.draftId]?.publishedRef : undefined;
    if (draft.parent.draftId && !realParent) throw new WindowsFilesError('DRAFT_PARENT_UNPUBLISHED', 'Сначала опубликуйте родительскую папку. Черновик сохранён в Flux.');
    const parentRef = realParent || draft.parent;
    let publishName = draft.name;
    const choice = choices[draft.id];
    // Выбор имеет смысл, только когда имя действительно занято; свободное место публикуется как обычно.
    const occupied = choice ? await existingAt(this, { rootId: parentRef.rootId, relativePath: joinRelative(parentRef.relativePath, draft.name) }) : null;
    if (choice && occupied) {
      if (choice === 'skip') return { skipped: true, draftId: draft.id };
      if (choice === 'keepBoth') publishName = await freeNameIn(this, parentRef, draft.name, false);
      else {
        // «Заменить» идёт через обычное сохранение: проверка версии, снимок прежнего содержимого и ReplaceFile.
        if (occupied.kind !== 'file') throw new WindowsFilesError('KIND_MISMATCH', 'На месте файла лежит папка. Выберите «Оставить оба» или «Пропустить».');
        const target = { rootId: parentRef.rootId, relativePath: joinRelative(parentRef.relativePath, draft.name) };
        const current = await this.read(target);
        const written = await this.write(target, content.base64, current.sha256);
        this.state.data.publications[draft.id] = { ref: target, sha256: content.sha256, fileId: current.fileId, status: 'complete' };
        mergeDraftMetadata(this.state, this.draftFileId(draft.id), current.fileId);
        draft.publishedRef = target;
        await this.state.history(current.fileId, 'publish-replace', target.relativePath, content.sha256);
        return { ref: target, file: written, alreadyPublished: false, replaced: true };
      }
    }
    const published = await this.publish(parentRef, publishName, content.base64, draft.id);
    const fileId = this.draftFileId(draft.id);
    await this.preserveIdentity(await this.filename(published.ref), fileId);
    const publication = this.state.data.publications[draft.id]; publication.fileId = fileId;
    draft.publishedRef = published.ref;
    await this.state.history(fileId, 'publish-draft', published.ref.relativePath, content.sha256);
    return { ref: published.ref, file: await this.read(published.ref), alreadyPublished: published.alreadyPublished };
    });
  }
  async publishDraftTree(ref: WindowsFileRef, rawChoices?: unknown) {
    const rootDraft = this.draft(ref);
    if (rootDraft.kind !== 'directory') return this.publishDraft(ref, rawChoices);
    const choices = parseChoices(rawChoices);
    return this.locked(`draft-operation:${rootDraft.id}`, () => this.publishDraftTreeResolved(ref, rootDraft, choices));
  }
  private async publishDraftTreeResolved(ref: WindowsFileRef, rootDraft: StoredDraft, choices: WindowsPublishChoices) {
    if (!rootDraft.parent.draftId) await this.reconcileDraftParent(rootDraft);
    const parent = rootDraft.parent;
    const physicalParent = parent.draftId ? this.state.data.drafts[parent.draftId]?.publishedRef : undefined;
    if (parent.draftId && !physicalParent) throw new WindowsFilesError('DRAFT_PARENT_UNPUBLISHED', 'Сначала опубликуйте родительскую папку. Черновик сохранён в Flux.');
    const destinationParent = physicalParent || parent;
    let destination = rootDraft.publishedRef || { rootId: destinationParent.rootId, relativePath: joinRelative(destinationParent.relativePath, rootDraft.name) };
    let rootFilename = await this.filename(destination, true);
    // «Заменить» для папки — слияние, как в Windows: существующая папка остаётся, а совпадения внутри решаются по каждому объекту.
    let mergeRoot = false; let skipped = 0;
    const rootChoice = choices[rootDraft.id];
    if (rootChoice && !rootDraft.publishedRef) {
      const occupied = await existingAt(this, destination);
      if (occupied) {
        if (rootChoice === 'skip') return { ref: destination, published: 0, failed: [] as string[], complete: true, skipped: 1 };
        if (rootChoice === 'keepBoth') {
          destination = { rootId: destinationParent.rootId, relativePath: joinRelative(destinationParent.relativePath, await freeNameIn(this, destinationParent, rootDraft.name, true)) };
          rootFilename = await this.filename(destination, true);
        } else if (occupied.kind !== 'directory') throw new WindowsFilesError('KIND_MISMATCH', 'На месте папки лежит файл. Выберите «Оставить оба» или «Пропустить».');
        else mergeRoot = true;
      }
    }
    const directChildren = (id: string) => Object.values(this.state.data.drafts).filter(item => !item.trashed && item.parent.draftId === id && (item.kind === 'directory' || !item.publishedRef));
    let published = 0; let totalBytes = 0; let totalEntries = 1; const failed: string[] = [];
    try {
      if (mergeRoot) {
        rootDraft.publishedRef = destination;
        mergeDraftMetadata(this.state, this.draftFileId(rootDraft.id), await this.identity(rootFilename));
        await this.state.save();
      } else {
        await fs.mkdir(rootFilename);
        rootDraft.publishedRef = destination;
        await this.preserveIdentity(rootFilename, this.draftFileId(rootDraft.id), false);
        await this.state.save();
      }
    }
    catch (error: any) { if (error.code === 'EEXIST' && !rootDraft.publishedRef) throw new WindowsFilesError('EEXIST', 'Папка назначения уже существует. Выберите другое имя; Windows-файлы не заменяются.'); if (error.code !== 'EEXIST') throw error; }
    const rootStat = await fs.lstat(rootFilename);
    const publishChildren = async (folderDraftId: string, physicalFolder: WindowsFileRef, depth: number): Promise<boolean> => {
      if (depth > 64 || published + failed.length > 5000) { failed.push(rootDraft.name); return false; }
      let complete = true;
      for (const child of directChildren(folderDraftId)) {
        if (++totalEntries > 5000) { failed.push(`${child.name}: превышен предел 5000 объектов`); complete = false; break; }
        const childRef = { rootId: child.parent.rootId, relativePath: joinRelative(child.parent.relativePath, child.name), draftId: child.id };
        let target = { rootId: physicalFolder.rootId, relativePath: joinRelative(physicalFolder.relativePath, child.name) };
        try {
          // Выбор по объекту применяется только при настоящем совпадении имени; без выбора совпадение — отказ, как раньше.
          let mode: 'new' | 'replace' | 'merge' = 'new';
          const choice = choices[child.id];
          if (choice && !child.publishedRef) {
            validateWindowsName(child.name);
            const occupied = await existingAt(this, target);
            if (occupied) {
              if (choice === 'skip') { skipped++; continue; }
              if (choice === 'keepBoth') {
                const others = directChildren(folderDraftId).filter(item => item.id !== child.id).map(item => item.name);
                target = { rootId: target.rootId, relativePath: joinRelative(physicalFolder.relativePath, await freeNameIn(this, physicalFolder, child.name, child.kind === 'directory', others)) };
              } else if (child.kind === 'directory') {
                if (occupied.kind !== 'directory') throw new WindowsFilesError('KIND_MISMATCH', 'На месте папки лежит файл.');
                mode = 'merge';
              } else {
                if (occupied.kind !== 'file') throw new WindowsFilesError('KIND_MISMATCH', 'На месте файла лежит папка.');
                mode = 'replace';
              }
            }
          }
          if (child.kind === 'directory') {
            validateWindowsName(child.name);
            const childTarget = child.publishedRef || target;
            if (!child.publishedRef) {
              const childFilename = await this.filename(target, true);
              if (mode === 'merge') mergeDraftMetadata(this.state, this.draftFileId(child.id), await this.identity(childFilename));
              else { await fs.mkdir(childFilename); await this.preserveIdentity(childFilename, this.draftFileId(child.id), false); }
              child.publishedRef = target;
              await this.state.save(); published++;
            }
            const ok = await publishChildren(child.id, childTarget, depth + 1); complete &&= ok;
          } else {
            validateWindowsName(child.name);
            const source = await this.filename(childRef); const stat = await fs.lstat(source);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BYTES) throw new WindowsFilesError('FILE_TOO_LARGE', 'Файл черновика недоступен или превышает 64 МБ.');
            totalBytes += stat.size;
            if (totalBytes > 512 * 1024 * 1024) throw new WindowsFilesError('TREE_TOO_LARGE', 'Публикация папки ограничена 512 МБ. Черновики Flux сохранены.');
            if (mode === 'replace') {
              // Содержимое заменяется обычным сохранением: снимок прежней версии и ReplaceFile с правами исходника.
              const current = await this.read(target); const draftContent = await this.read(childRef);
              await this.write(target, draftContent.base64, current.sha256);
              mergeDraftMetadata(this.state, this.draftFileId(child.id), current.fileId);
              child.publishedRef = target; await this.state.history(current.fileId, 'publish-replace', target.relativePath, draftContent.sha256); await this.state.save();
              published++; continue;
            }
            const targetName = await this.filename(target, true);
            await copyDraftFile(source, targetName);
            const result = await this.read(target);
            await this.preserveIdentity(targetName, this.draftFileId(child.id), false);
            child.publishedRef = target; await this.state.history(this.draftFileId(child.id), 'publish-draft', target.relativePath, result.sha256); await this.state.save();
            published++;
          }
        } catch (error: any) { failed.push(`${child.name}: ${error?.message || 'ошибка записи'}`); complete = false; }
      }
      return complete;
    };
    const complete = await publishChildren(rootDraft.id, destination, 1);
    const currentRoot = await fs.lstat(rootFilename);
    if (currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino || currentRoot.isSymbolicLink()) throw new WindowsFilesError('CONFLICT', 'Папка назначения заменена во время публикации. Исходные черновики Flux сохранены.');
    if (complete) await this.state.history(this.draftFileId(rootDraft.id), 'publish-draft-tree', destination.relativePath);
    await this.state.save(); this.changed(destination);
    return { ref: destination, published, failed, complete, skipped };
  }
  async mkdir(parent: WindowsFileRef, name: string, opts: OpOptions = {}) {
    parent = this.resolveRef(parent);
    if (parent.draftId) throw new WindowsFilesError('DRAFT_FOLDER_UNSUPPORTED', 'Для черновой папки используйте «Создать в Flux».');
    const ref = { rootId: parent.rootId, relativePath: joinRelative(parent.relativePath, name) };
    const filename = await this.filename(ref, true); await fs.mkdir(filename); this.changed(ref);
    await this.record(`Создание папки «${name}»`, { kind: 'create', at: ref, fingerprint: await fingerprint(this, ref) }, opts);
    return this.entry(ref);
  }
  async rename(ref: WindowsFileRef, name: string, opts: OpOptions = {}) {
    ref = this.resolveRef(ref);
    validateWindowsName(name);
    if (ref.draftId) {
      const draft = this.draft(ref); await this.ensureFreeName(draft.parent, name, draft.id);
      const before: Place = { parent: { ...draft.parent }, name: draft.name };
      draft.name = name;
      const next = this.resolveRef(ref); await this.state.history(this.draftFileId(draft.id), 'rename', next.relativePath); this.changed(next);
      if (draft.kind === 'directory') this.rebaseDraftChildren(draft.id, next.relativePath);
      await this.state.save();
      await this.record(`Переименование «${before.name}» в «${name}»`, { kind: 'move', from: before, to: { parent: { ...draft.parent }, name }, fileId: this.draftFileId(draft.id), draftId: draft.id }, opts);
      return { ref: next, file: await this.entry(next) };
    }
    if (!ref.relativePath) throw new WindowsFilesError('ROOT_OPERATION', 'Корень подключённой папки нельзя переименовать.');
    const parent = { rootId: ref.rootId, relativePath: ref.relativePath.split('/').slice(0, -1).join('/') };
    const before: Place = { parent, name: ref.relativePath.split('/').pop()! };
    const result = await this.moveCore(ref, parent, name);
    await this.record(`Переименование «${before.name}» в «${name}»`, { kind: 'move', from: before, to: { parent, name }, fileId: result.file.fileId }, opts);
    return result;
  }
  private async reserveTarget(parent: WindowsFileRef, name: string) {
    const ref = { rootId: parent.rootId, relativePath: joinRelative(parent.relativePath, validateWindowsName(name)) };
    const filename = await this.filename(ref, true);
    return { ref, filename };
  }
  async copy(ref: WindowsFileRef, parent: WindowsFileRef, name: string, opts: OpOptions & { carryMeta?: boolean } = {}) {
    const result = await this.copyCore(ref, parent, name, opts.carryMeta === true);
    await this.record(`Копирование «${name}»`, { kind: 'create', at: result.ref, fingerprint: await fingerprint(this, result.ref) }, opts);
    return result;
  }
  private async copyCore(ref: WindowsFileRef, parent: WindowsFileRef, name: string, carry: boolean) {
    ref = this.resolveRef(ref);
    if (ref.draftId) {
      const draft = this.draft(ref);
      if (draft.kind !== 'directory') {
        const copiedFile = await this.createDraft(parent, name, (await this.read(ref)).base64, { silent: true });
        if (carry) { this.carryMetadata(this.draftFileId(draft.id), this.draftFileId(copiedFile.ref.draftId!)); await this.state.save(); }
        return copiedFile;
      }
      let ancestor = parent.draftId; const seen = new Set<string>();
      while (ancestor) {
        if (ancestor === draft.id) throw new WindowsFilesError('RECURSIVE_TARGET', 'Нельзя скопировать папку Flux внутрь неё самой.');
        if (seen.has(ancestor)) throw new WindowsFilesError('DRAFT_TREE_INVALID', 'Структура черновиков повреждена; копирование остановлено.');
        seen.add(ancestor); ancestor = this.state.data.drafts[ancestor]?.parent.draftId;
      }
      const copied = await this.createDraftFolder(parent, name, { silent: true }); let count = 1; let bytesTotal = 0;
      if (carry) this.carryMetadata(this.draftFileId(draft.id), this.draftFileId(copied.ref.draftId!));
      const clone = async (sourceId: string, target: WindowsFileRef, depth: number): Promise<void> => {
        if (depth > 64) throw new WindowsFilesError('TREE_TOO_LARGE', 'Вложенность черновиков превышает 64 папки.');
        const children = Object.values(this.state.data.drafts).filter(item => !item.trashed && !item.publishedRef && item.parent.draftId === sourceId);
        for (const child of children) {
          if (++count > 5000) throw new WindowsFilesError('TREE_TOO_LARGE', 'Копирование ограничено 5000 объектами.');
          if (child.kind === 'directory') {
            const folder = await this.createDraftFolder(target, child.name, { silent: true });
            if (carry) this.carryMetadata(this.draftFileId(child.id), this.draftFileId(folder.ref.draftId!));
            await clone(child.id, folder.ref, depth + 1);
          } else {
            const ref = { rootId: child.parent.rootId, relativePath: joinRelative(child.parent.relativePath, child.name), draftId: child.id };
            const content = await this.read(ref); bytesTotal += content.size;
            if (bytesTotal > 512 * 1024 * 1024) throw new WindowsFilesError('TREE_TOO_LARGE', 'Копирование ограничено 512 МБ.');
            const copiedChild = await this.createDraft(target, child.name, content.base64, { silent: true });
            if (carry) this.carryMetadata(this.draftFileId(child.id), this.draftFileId(copiedChild.ref.draftId!));
          }
        }
      };
      await clone(draft.id, copied.ref, 1);
      if (carry) await this.state.save();
      return copied;
    }
    const source = await this.filename(ref); const stat = await fs.stat(source);
    const target = await this.reserveTarget(parent, name);
    if (stat.isDirectory()) {
      if (isContained(source, target.filename)) throw new WindowsFilesError('RECURSIVE_TARGET', 'Нельзя скопировать папку внутрь неё самой.');
      const plan = await inspectWindowsTree(source);
      // Идентичность исходных файлов снимается до копирования: потом они остаются на месте, но это дешевле, чем гадать.
      const sourceIds = carry ? await Promise.all(plan.map(async item => ({ relative: item.relative, fileId: await this.identity(item.relative ? path.join(source, ...item.relative.split('/')) : source) }))) : [];
      await copyWindowsTree(source, target.filename, plan);
      for (const item of sourceIds) this.carryMetadata(item.fileId, await this.identity(item.relative ? path.join(target.filename, ...item.relative.split('/')) : target.filename));
    } else if (stat.isFile()) {
      const sourceId = carry ? await this.identity(source) : '';
      await fs.copyFile(source, target.filename, constants.COPYFILE_EXCL);
      if (carry) this.carryMetadata(sourceId, await this.identity(target.filename));
    }
    else throw new WindowsFilesError('UNSUPPORTED_ENTRY', 'Этот тип файла копируется средствами Windows.');
    const originals = stat.isDirectory() ? Object.values(this.state.data.drafts).filter(draft => !draft.trashed && !draft.publishedRef && draft.parent.rootId === ref.rootId && (draft.parent.relativePath === ref.relativePath || draft.parent.relativePath.startsWith(`${ref.relativePath}/`))) : [];
    for (const draft of originals) {
      const copiedParent = { rootId: parent.rootId, relativePath: `${target.ref.relativePath}${draft.parent.relativePath.slice(ref.relativePath.length)}` };
      const content = await this.read({ rootId: draft.parent.rootId, relativePath: joinRelative(draft.parent.relativePath, draft.name), draftId: draft.id });
      const copiedDraft = await this.createDraft(copiedParent, draft.name, content.base64, { silent: true });
      if (carry) this.carryMetadata(this.draftFileId(draft.id), this.draftFileId(copiedDraft.ref.draftId!));
    }
    const result = await this.entry(target.ref); await this.state.history(result.fileId, 'copy', target.ref.relativePath); this.changed(target.ref); return { ref: target.ref, file: result };
  }
  async move(ref: WindowsFileRef, parent: WindowsFileRef, name: string, baseSha256?: string, opts: OpOptions = {}) {
    const source = this.resolveRef(ref); const target = this.resolveRef(parent);
    const draft = source.draftId ? this.draft(source) : null;
    const before: Place = draft ? { parent: { ...draft.parent }, name: draft.name } : { parent: { rootId: source.rootId, relativePath: source.relativePath.split('/').slice(0, -1).join('/') }, name: source.relativePath.split('/').pop() || '' };
    const result = await this.moveCore(ref, parent, name, baseSha256);
    const parentAfter: WindowsFileRef = draft ? { ...draft.parent } : { rootId: target.rootId, relativePath: target.relativePath };
    await this.record(`Перемещение «${before.name}»`, { kind: 'move', from: before, to: { parent: parentAfter, name }, fileId: result.file.fileId, ...(draft ? { draftId: draft.id } : {}) }, opts);
    return result;
  }
  /** Сам перенос, без записи в журнал: им же пользуется отмена, чтобы не записывать собственные шаги. */
  async moveCore(ref: WindowsFileRef, parent: WindowsFileRef, name: string, baseSha256?: string) {
    ref = this.resolveRef(ref);
    parent = this.resolveRef(parent);
    if (ref.draftId) {
      const draft = this.draft(ref);
      if (draft.kind === 'directory') {
        let ancestor = parent.draftId; const seen = new Set<string>(); let depth = 0;
        while (ancestor) {
          if (ancestor === draft.id) throw new WindowsFilesError('RECURSIVE_TARGET', 'Нельзя переместить папку Flux внутрь неё самой.');
          if (seen.has(ancestor) || ++depth > 64) throw new WindowsFilesError('DRAFT_TREE_INVALID', 'Структура черновиков повреждена; перемещение остановлено.');
          seen.add(ancestor); ancestor = this.state.data.drafts[ancestor]?.parent.draftId;
        }
      }
      if (!parent.draftId) await this.filename(parent); else if (this.draft(parent).kind !== 'directory') throw new WindowsFilesError('NOT_DIRECTORY', 'Откройте папку для перемещения черновика.');
      await this.ensureFreeName(parent, name, draft.id);
      if (baseSha256 && (await this.read(ref)).sha256 !== baseSha256) throw new WindowsFilesError('CONFLICT', 'Черновик изменился; проверьте свежую версию.');
      const previousRef = this.resolveRef(ref); draft.parent = { rootId: parent.rootId, relativePath: parent.relativePath, ...(parent.draftId ? { draftId: parent.draftId } : {}) }; draft.parentFileId = parent.draftId ? undefined : await this.identity(await this.filename(parent)); draft.name = name;
      const next = { rootId: parent.rootId, relativePath: joinRelative(parent.relativePath, name), draftId: draft.id };
      if (draft.kind === 'directory') this.rebaseDraftChildren(draft.id, next.relativePath);
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
    return { ref: restored, file: draft.kind === 'directory' ? await this.entry(restored) : await this.read(restored) };
  }
  async trash(ref: WindowsFileRef, baseSha256?: string, opts: OpOptions = {}) {
    const resolved = this.resolveRef(ref);
    // Признаки объекта снимаются до удаления: по ним отмена убедится, что возвращает тот же объект.
    // Корень подключённой папки удалять нельзя: хешировать его дерево ради отказа, который наступит следом, незачем.
    const before = opts.silent || (!resolved.draftId && !resolved.relativePath) ? null : await fingerprint(this, resolved);
    const { nativePath, ...result } = await this.trashCore(ref, baseSha256);
    if (!opts.silent) {
      const trashed: TrashInfo | undefined = nativePath ? { path: nativePath, at: Date.now(), size: before?.kind === 'file' ? before.size : null, name: path.basename(nativePath) } : undefined;
      await this.record(`Удаление «${resolved.relativePath.split('/').pop() || ''}»`, { kind: 'trash', at: resolved, fingerprint: before, ...(trashed ? { trashed } : {}) }, opts);
    }
    return result;
  }
  /** Само удаление в корзину без записи в журнал; nativePath — только для main, в ответ renderer'у не попадает. */
  async trashCore(ref: WindowsFileRef, baseSha256?: string): Promise<{ trashed: true; fileId: string; storage?: 'flux'; nativePath?: string }> {
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
      await this.deps.trashItem(filename); await this.state.history(entry.fileId, 'trash', ref.relativePath); this.changed(ref); return { trashed: true, fileId: entry.fileId, nativePath: filename };
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
  /** Путь файла для нативного помощника Windows (миниатюры, «Открыть с помощью», меню). Остаётся в main; у черновика его нет. */
  async nativePath(ref: WindowsFileRef): Promise<string> {
    const resolved = this.resolveRef(ref);
    if (resolved.draftId) throw new WindowsFilesError('DRAFT_NOT_PUBLISHED', 'Черновик находится только в Flux. Сначала выберите «Отобразить в Windows».');
    return this.filename(resolved);
  }
  /**
   * Вытаскивание файлов из Flux в Проводник Windows. Наружу уходят только
   * опубликованные объекты: у черновика нет файла, который Windows могла бы
   * принять, и «вытащить» его значило бы тихо опубликовать в чужую папку.
   */
  async startDrag(owner: number, refs: WindowsFileRef[]) {
    if (!Array.isArray(refs) || !refs.length || refs.length > 100) throw new WindowsFilesError('INVALID_REQUEST', 'Выберите от 1 до 100 объектов.');
    if (!this.deps.startDrag) throw new WindowsFilesError('NOT_SUPPORTED', 'Перетаскивание наружу доступно только в приложении Flux.');
    const resolved = refs.map(ref => { if (!ref || typeof ref !== 'object') throw new WindowsFilesError('INVALID_REQUEST', 'Не указан файл.'); return this.resolveRef(ref); });
    // Сначала проверяются все: перетаскивание «наполовину» хуже отказа.
    if (resolved.some(ref => ref.draftId)) throw new WindowsFilesError('DRAFT_NOT_PUBLISHED', 'Черновик находится только в Flux. Сначала выберите «Отобразить в Windows».');
    const files: string[] = [];
    for (const ref of resolved) {
      const filename = await this.filename(ref);
      const stat = await fs.lstat(filename);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new WindowsFilesError('UNSUPPORTED_ENTRY', 'Этот объект нельзя перетащить из Flux.');
      files.push(filename);
    }
    await this.deps.startDrag(owner, files);
    return { dragging: true, count: files.length };
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
