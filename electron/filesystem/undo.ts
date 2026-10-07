import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { WindowsFileRef, WindowsUndoLabel, WindowsUndoResult, WindowsUndoState } from '../../filesystem/contracts';
import { WindowsFilesError } from './paths';
import type { WindowsFilesService } from './service';

const MAX_ENTRIES = 100;
const HASH_LIMIT = 16 * 1024 * 1024;
const TREE_LIMIT = 2000;
const FILE = 'windows-files-undo.json';

/**
 * «Тот же объект»: по этим признакам решается, можно ли отменять действие, не
 * затронув чужих правок. Для создания и удаления сверяется и содержимое — их
 * отмена уносит данные в корзину; для переименования и переноса достаточно
 * идентичности файла, потому что возврат имени правки не трогает.
 */
export interface Fingerprint { kind: 'file' | 'directory'; fileId: string; size: number; mtimeMs: number; sha256?: string; tree?: string }
export interface TrashInfo { path: string; at: number; size: number | null; name: string }
/** Место объекта: папка (capability) и имя в ней. Черновик узнаётся по draftId — его путь для показа может меняться. */
export interface Place { parent: WindowsFileRef; name: string }
export type UndoOp =
  | { kind: 'move'; from: Place; to: Place; fileId: string; draftId?: string }
  /** Создание, копирование, импорт: отмена — в корзину, повтор — обратно из корзины. */
  | { kind: 'create'; at: WindowsFileRef; fingerprint: Fingerprint | null; trashed?: TrashInfo }
  /** Удаление в корзину: отмена — восстановление, повтор — снова в корзину. */
  | { kind: 'trash'; at: WindowsFileRef; fingerprint: Fingerprint | null; trashed?: TrashInfo };
export interface UndoEntry { id: string; at: string; label: string; group?: string; op: UndoOp }
interface Stored { version: 1; entries: UndoEntry[]; cursor: number }

export class UndoJournal {
  private data: Stored = { version: 1, entries: [], cursor: 0 };
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private filename: string) {}
  /** Журнал лежит в userData и переживает перезапуск; повреждённый файл откладывается в сторону, а журнал начинается заново. */
  static async load(userData: string): Promise<UndoJournal> {
    const journal = new UndoJournal(path.join(userData, FILE));
    try {
      const parsed = JSON.parse(await fs.readFile(journal.filename, 'utf8'));
      if (parsed?.version === 1 && Array.isArray(parsed.entries) && Number.isInteger(parsed.cursor) && parsed.cursor >= 0 && parsed.cursor <= parsed.entries.length) journal.data = parsed;
    } catch (error: any) {
      if (error.code !== 'ENOENT') await fs.rename(journal.filename, `${journal.filename}.broken-${Date.now()}`).catch(() => undefined);
    }
    return journal;
  }
  private label(entry: UndoEntry | undefined): WindowsUndoLabel | null { return entry ? { id: entry.id, label: entry.label, at: entry.at } : null; }
  state(): WindowsUndoState { return { undo: this.label(this.data.entries[this.data.cursor - 1]), redo: this.label(this.data.entries[this.data.cursor]) }; }
  async record(entry: Omit<UndoEntry, 'id' | 'at'>): Promise<void> {
    // Новое действие обрывает цепочку повтора: «вперёд» после новой правки означало бы вернуть то, чего уже нет.
    this.data.entries.splice(this.data.cursor);
    this.data.entries.push({ id: randomUUID(), at: new Date().toISOString(), ...entry });
    if (this.data.entries.length > MAX_ENTRIES) this.data.entries.splice(0, this.data.entries.length - MAX_ENTRIES);
    this.data.cursor = this.data.entries.length;
    await this.save();
  }
  /** Записи одного пакета (вставка нескольких файлов, перенос выделения) отменяются вместе, как одно действие. */
  batch(direction: 'undo' | 'redo'): UndoEntry[] {
    const { entries, cursor } = this.data;
    const first = direction === 'undo' ? entries[cursor - 1] : entries[cursor];
    if (!first) return [];
    const result: UndoEntry[] = [];
    for (let i = direction === 'undo' ? cursor - 1 : cursor; i >= 0 && i < entries.length; i += direction === 'undo' ? -1 : 1) {
      const entry = entries[i];
      if (entry.group !== first.group || (!first.group && result.length)) break;
      result.push(entry);
    }
    return result;
  }
  async step(direction: 'undo' | 'redo'): Promise<void> { this.data.cursor += direction === 'undo' ? -1 : 1; await this.save(); }
  /** Запись, которую уже нельзя выполнить (объект исчез), убирается, чтобы не загораживать более ранние действия. */
  async drop(entry: UndoEntry): Promise<void> {
    const index = this.data.entries.indexOf(entry);
    if (index < 0) return;
    this.data.entries.splice(index, 1);
    if (index < this.data.cursor) this.data.cursor--;
    await this.save();
  }
  async save(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    const operation = this.queue.then(async () => {
      const temp = `${this.filename}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, snapshot, { flag: 'wx', mode: 0o600 }); await fs.rename(temp, this.filename); }
      finally { await fs.unlink(temp).catch(() => undefined); }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}

async function treeSignature(root: string): Promise<string> {
  const lines: string[] = []; const stack = [''];
  while (stack.length) {
    const relative = stack.pop()!;
    const entries = await fs.readdir(relative ? path.join(root, ...relative.split('/')) : root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (lines.length >= TREE_LIMIT) return `limit:${lines.length}`;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { lines.push(`${child}|link`); continue; }
      if (entry.isDirectory()) { lines.push(`${child}/`); stack.push(child); continue; }
      const stat = await fs.lstat(path.join(root, ...child.split('/'))).catch(() => null);
      lines.push(`${child}|${stat?.size ?? -1}|${stat ? Math.trunc(stat.mtimeMs) : -1}`);
    }
  }
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}

/** Снимок признаков объекта. null — объекта нет или он стал ссылкой. */
export async function fingerprint(service: WindowsFilesService, ref: WindowsFileRef, deep = true): Promise<Fingerprint | null> {
  try {
    if (ref.draftId) {
      const draft = service.state.data.drafts[ref.draftId];
      if (!draft || draft.trashed) return null;
      if (draft.kind === 'directory') {
        const names: string[] = []; const walk = (id: string, depth: number) => {
          if (depth > 64 || names.length > TREE_LIMIT) return;
          for (const child of Object.values(service.state.data.drafts)) if (!child.trashed && child.parent.draftId === id) { names.push(`${child.id}|${child.name}`); if (child.kind === 'directory') walk(child.id, depth + 1); }
        };
        walk(draft.id, 0);
        return { kind: 'directory', fileId: service.draftFileId(draft.id), size: 0, mtimeMs: 0, tree: createHash('sha256').update(names.sort().join('\n')).digest('hex') };
      }
      const content = await service.read({ ...ref, relativePath: ref.relativePath });
      return { kind: 'file', fileId: content.fileId, size: content.size, mtimeMs: 0, sha256: content.sha256 };
    }
    const filename = await service.filename(ref);
    const stat = await fs.lstat(filename, { bigint: true });
    if (stat.isSymbolicLink()) return null;
    const fileId = await service.identity(filename);
    // Для переноса нужна лишь идентичность: хешировать содержимое папки перед каждым возвратом имени незачем.
    if (!deep) return stat.isDirectory() || stat.isFile() ? { kind: stat.isDirectory() ? 'directory' : 'file', fileId, size: 0, mtimeMs: 0 } : null;
    if (stat.isDirectory()) return { kind: 'directory', fileId, size: 0, mtimeMs: 0, tree: await treeSignature(filename) };
    if (!stat.isFile()) return null;
    return { kind: 'file', fileId, size: Number(stat.size), mtimeMs: Math.trunc(Number(stat.mtimeNs) / 1e6),
      ...(stat.size <= BigInt(HASH_LIMIT) ? { sha256: createHash('sha256').update(await fs.readFile(filename)).digest('hex') } : {}) };
  } catch { return null; }
}

const sameFingerprint = (a: Fingerprint | null, b: Fingerprint | null): boolean => !!a && !!b && a.kind === b.kind && a.size === b.size
  && (a.kind === 'directory' || a.fileId === b.fileId)
  && (a.sha256 === undefined || b.sha256 === undefined ? a.mtimeMs === b.mtimeMs : a.sha256 === b.sha256)
  && (a.tree === undefined || b.tree === undefined || a.tree === b.tree);

const changed = (label: string) => new WindowsFilesError('UNDO_CHANGED', `Нельзя отменить «${label}»: объект изменился после этого действия. Данные не тронуты.`);
const missing = (label: string) => new WindowsFilesError('UNDO_MISSING', `Нельзя отменить «${label}»: объект перенесён или удалён.`);

async function toTrash(service: WindowsFilesService, entry: UndoEntry, at: WindowsFileRef, expected: Fingerprint | null): Promise<TrashInfo | undefined> {
  const current = await fingerprint(service, at);
  if (!current) throw missing(entry.label);
  if (expected && !sameFingerprint(current, expected)) throw changed(entry.label);
  const trashed = await service.trashCore(at);
  return trashed.nativePath ? { path: trashed.nativePath, at: Date.now(), size: current.kind === 'file' ? current.size : null, name: path.basename(trashed.nativePath) } : undefined;
}
async function fromTrash(service: WindowsFilesService, entry: UndoEntry, at: WindowsFileRef, info: TrashInfo | undefined): Promise<void> {
  if (at.draftId) { await service.restoreDraft(at); return; }
  if (!info) throw missing(entry.label);
  // Допуск по времени: часы файловой системы и процесса расходятся на секунды.
  await service.restoreFromTrash({ path: info.path, deletedAfter: info.at - 10_000, size: info.size, name: info.name });
}

const refAt = (place: Place, draftId?: string): WindowsFileRef => ({
  rootId: place.parent.rootId, relativePath: place.parent.relativePath ? `${place.parent.relativePath}/${place.name}` : place.name, ...(draftId ? { draftId } : {}),
});

/** Перенос и переименование идут одним путём: отличается лишь, откуда и куда. */
async function shift(service: WindowsFilesService, entry: UndoEntry, op: Extract<UndoOp, { kind: 'move' }>, source: Place, target: Place): Promise<void> {
  const ref = refAt(source, op.draftId);
  const now = await fingerprint(service, ref, false);
  if (!now) throw missing(entry.label);
  // Тот же объект — по идентичности файла: правки содержимого переименованию не мешают.
  if (!op.draftId && now.fileId !== op.fileId) throw changed(entry.label);
  await service.moveCore(ref, target.parent, target.name);
}

async function undoOne(service: WindowsFilesService, entry: UndoEntry): Promise<void> {
  const op = entry.op;
  if (op.kind === 'move') await shift(service, entry, op, op.to, op.from);
  else if (op.kind === 'create') op.trashed = await toTrash(service, entry, op.at, op.fingerprint);
  else await fromTrash(service, entry, op.at, op.trashed);
}
async function redoOne(service: WindowsFilesService, entry: UndoEntry): Promise<void> {
  const op = entry.op;
  if (op.kind === 'move') await shift(service, entry, op, op.from, op.to);
  else if (op.kind === 'create') await fromTrash(service, entry, op.at, op.trashed);
  else op.trashed = await toTrash(service, entry, op.at, op.fingerprint);
}

async function run(service: WindowsFilesService, direction: 'undo' | 'redo'): Promise<WindowsUndoResult> {
  const journal = service.journal;
  const batch = journal.batch(direction);
  if (!batch.length) throw new WindowsFilesError(direction === 'undo' ? 'NOTHING_TO_UNDO' : 'NOTHING_TO_REDO', direction === 'undo' ? 'Нечего отменять.' : 'Нечего повторять.');
  for (const entry of batch) {
    try {
      if (direction === 'undo') await undoOne(service, entry); else await redoOne(service, entry);
    } catch (error: any) {
      if (error?.code === 'UNDO_CHANGED' || error?.code === 'UNDO_MISSING') await journal.drop(entry); // иначе эта запись навсегда закрыла бы дорогу более ранним
      else if (error?.code === 'EEXIST') throw new WindowsFilesError('UNDO_BLOCKED', `Нельзя ${direction === 'undo' ? 'отменить' : 'повторить'} «${entry.label}»: на этом месте уже есть объект с таким именем.`);
      throw error;
    }
    await journal.step(direction);
  }
  return { label: batch[0].label, state: journal.state() };
}
export const undoLast = (service: WindowsFilesService) => run(service, 'undo');
export const redoLast = (service: WindowsFilesService) => run(service, 'redo');
