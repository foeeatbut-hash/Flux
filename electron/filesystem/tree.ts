import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { WindowsFilesError, validateWindowsName } from './paths';

interface TreeEntry { relative: string; kind: 'file' | 'directory'; size: number; sha256?: string; dev: bigint; ino: bigint; modifiedNs: bigint }
const MAX_TREE_ENTRIES = 5000;
const MAX_TREE_BYTES = 512 * 1024 * 1024;
async function hashFile(filename: string): Promise<string> {
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile()) throw new WindowsFilesError('UNSUPPORTED_ENTRY', 'В дереве обнаружен необычный файл.');
    const hash = createHash('sha256'); const buffer = Buffer.alloc(256 * 1024);
    let bytes = 0;
    for (;;) { const result = await handle.read(buffer, 0, buffer.length, null); if (!result.bytesRead) break; bytes += result.bytesRead; if (bytes > MAX_TREE_BYTES) throw new WindowsFilesError('TREE_TOO_LARGE', 'Копирование папки ограничено 512 МБ.'); hash.update(buffer.subarray(0, result.bytesRead)); }
    const current = await handle.stat({ bigint: true });
    const named = await fs.lstat(filename, { bigint: true });
    if (initial.ino !== named.ino || initial.dev !== named.dev || initial.size !== current.size || initial.mtimeNs !== current.mtimeNs || initial.ctimeNs !== current.ctimeNs) throw new WindowsFilesError('CONFLICT', 'Файл изменился при проверке папки.');
    return hash.digest('hex');
  } finally { await handle.close(); }
}
export async function inspectWindowsTree(folder: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = []; let total = 0;
  async function walk(relative: string, depth: number) {
    if (depth > 64 || entries.length >= MAX_TREE_ENTRIES) throw new WindowsFilesError('TREE_TOO_LARGE', 'Папка содержит слишком много файлов или уровней: предел 5000 элементов и 64 уровня.');
    const filename = relative ? path.join(folder, ...relative.split('/')) : folder;
    const stat = await fs.lstat(filename, { bigint: true });
    if (stat.isSymbolicLink()) throw new WindowsFilesError('LINK_BLOCKED', 'В папке есть ссылка или junction. Подключите её отдельно; автоматический обход запрещён.');
    if (!stat.isDirectory() && !stat.isFile()) throw new WindowsFilesError('UNSUPPORTED_ENTRY', 'В папке есть необычный файл. Перенесите его средствами Windows.');
    total += stat.isFile() ? Number(stat.size) : 0;
    if (total > MAX_TREE_BYTES) throw new WindowsFilesError('TREE_TOO_LARGE', 'Копирование папки ограничено 512 МБ.');
    entries.push({ relative, kind: stat.isDirectory() ? 'directory' : 'file', size: Number(stat.size), dev: stat.dev, ino: stat.ino, modifiedNs: stat.mtimeNs, ...(stat.isFile() ? { sha256: await hashFile(filename) } : {}) });
    if (stat.isDirectory()) {
      const names: string[] = []; const directory = await fs.opendir(filename);
      for await (const entry of directory) { names.push(entry.name); if (names.length + entries.length >= MAX_TREE_ENTRIES) throw new WindowsFilesError('TREE_TOO_LARGE', 'В папке больше 5000 элементов.'); }
      names.sort();
      for (const name of names) { validateWindowsName(name); await walk(relative ? `${relative}/${name}` : name, depth + 1); }
    }
  }
  await walk('', 0); return entries;
}
interface CreatedTreeEntry { filename: string; kind: 'file' | 'directory'; dev: bigint; ino: bigint; sha256?: string }
export async function cleanCreatedWindowsTree(created: CreatedTreeEntry[]): Promise<void> {
  for (const item of [...created].reverse()) {
    try {
      const stat = await fs.lstat(item.filename, { bigint: true });
      if (stat.isSymbolicLink() || stat.dev !== item.dev || stat.ino !== item.ino) continue;
      if (item.kind === 'directory') await fs.rmdir(item.filename);
      else if (await hashFile(item.filename) === item.sha256) await fs.unlink(item.filename);
    } catch { /* Чужие новые файлы и изменённые копии остаются на месте. */ }
  }
}
export async function copyWindowsTree(source: string, target: string, plan: TreeEntry[]): Promise<CreatedTreeEntry[]> {
  const created: CreatedTreeEntry[] = [];
  let canonicalTarget: string | null = null;
  try {
    for (const item of plan) {
      const from = item.relative ? path.join(source, ...item.relative.split('/')) : source;
      const to = item.relative ? path.join(target, ...item.relative.split('/')) : target;
      const sourceStat = await fs.lstat(from, { bigint: true });
      if (sourceStat.isSymbolicLink() || sourceStat.dev !== item.dev || sourceStat.ino !== item.ino || sourceStat.mtimeNs !== item.modifiedNs) throw new WindowsFilesError('CONFLICT', 'Папка изменилась после проверки. Исходники сохранены.');
      if (item.relative) {
        const root = await fs.lstat(target, { bigint: true });
        const ownedRoot = created[0];
        if (root.isSymbolicLink() || root.dev !== ownedRoot.dev || root.ino !== ownedRoot.ino) throw new WindowsFilesError('CONFLICT', 'Папка назначения заменена во время копирования.');
        const parent = path.dirname(to);
        const actualParent = await fs.realpath(parent);
        const relativeParent = path.relative(canonicalTarget!, actualParent);
        if (relativeParent === '..' || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) throw new WindowsFilesError('OUTSIDE_ROOT', 'Папка назначения заменена ссылкой.');
      }
      if (item.kind === 'directory') await fs.mkdir(to);
      else await fs.copyFile(from, to, constants.COPYFILE_EXCL);
      const actual = await fs.lstat(to, { bigint: true });
      created.push({ filename: to, kind: item.kind, dev: actual.dev, ino: actual.ino, ...(item.sha256 ? { sha256: item.sha256 } : {}) });
      // TEMP на Windows может содержать 8.3-имя RUNNER~1: обе стороны
      // containment сравниваются после realpath, проверка inode выше остаётся.
      if (!item.relative) canonicalTarget = await fs.realpath(target);
      if (item.kind === 'file' && await hashFile(to) !== item.sha256) throw new WindowsFilesError('CONFLICT', 'Копия файла не совпала с исходником.');
    }
    const current = await inspectWindowsTree(source);
    if (JSON.stringify(current.map(item => [item.relative, item.kind, item.sha256])) !== JSON.stringify(plan.map(item => [item.relative, item.kind, item.sha256]))) throw new WindowsFilesError('CONFLICT', 'Исходная папка изменилась во время копирования.');
    return created;
  } catch (error) {
    await cleanCreatedWindowsTree(created);
    throw error;
  }
}
