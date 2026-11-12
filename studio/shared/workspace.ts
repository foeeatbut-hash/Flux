/**
 * Папка проекта на диске: безопасные пути, правила исключения, сборка пакета и слежение за изменениями снаружи.
 *
 * Проект в Studio — это сама папка с обычными файлами (решение владельца 12 ноября 2026): её можно править любым
 * редактором и git'ом, Studio это видит. Окно получает только пути внутри выбранной папки: выход через `..`, абсолютный
 * путь, обратную косую, символическую ссылку или junction наружу отвергается здесь, а не в окне.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MODULE_BUNDLE_MAX } from '../../modules/trust/claims';
import { validBundlePath } from '../../modules/trust/bundle';
import type { ProjectFiles } from './templates';

export class WorkspaceFailure extends Error {}

export const MAX_FILES = 400;
/** Каталоги, которые не показываются в дереве совсем: служебные чужих инструментов */
const HIDDEN_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn']);
/** В пакет не попадают никогда: сборочные каталоги и мусор систем */
const PACK_DIRS = new Set(['build', 'dist', 'out', 'target', '.vscode', '.idea', '__pycache__']);
const PACK_FILES = /^(?:\.DS_Store|Thumbs\.db|desktop\.ini)$|\.(?:tmp|log|swp|bak)$|~$/i;
export const IGNORE_FILE = '.fluxignore';

/** Правила .fluxignore: строка — имя файла, `имя/` — каталог, `*.расш` — по расширению; `#` — комментарий */
export function parseIgnore(text: string): Array<(rel: string, isDir: boolean) => boolean> {
  const rules: Array<(rel: string, isDir: boolean) => boolean> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.length > 200) continue;
    const dirOnly = line.endsWith('/'), body = line.replace(/^\/+|\/+$/g, '');
    if (!body) continue;
    const re = new RegExp(`^${body.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    const anchored = line.startsWith('/') || body.includes('/');
    rules.push((rel, isDir) => {
      if (dirOnly && !isDir) return false;
      return anchored ? re.test(rel) : re.test(rel.split('/').pop() || '');
    });
  }
  return rules;
}

export interface TreeEntry { path: string; dir: boolean; size: number; mtime: number; text?: boolean; ignored: boolean }

export class Workspace {
  readonly root: string;
  constructor(folder: string) {
    let real: string;
    try { real = fs.realpathSync(folder); } catch { throw new WorkspaceFailure('Папка проекта не найдена.'); }
    if (!fs.statSync(real).isDirectory()) throw new WorkspaceFailure('Это не папка.');
    this.root = real;
  }

  /** Полный путь внутри папки. Самый глубокий существующий предок проверяется через realpath: ссылка наружу не пройдёт */
  resolve(rel: string, allowRoot = false): string {
    if (typeof rel !== 'string' || rel.length > 400 || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw new WorkspaceFailure(`Недопустимое имя файла: ${String(rel).slice(0, 80)}`);
    const parts = rel.split('/').filter(Boolean);
    if (!allowRoot && !parts.length) throw new WorkspaceFailure('Не указан файл.');
    if (parts.some(p => p === '..' || p === '.' || /[<>:"|?*]/.test(p) || /[. ]$/.test(p))) throw new WorkspaceFailure(`Недопустимое имя файла: ${rel}`);
    if (parts.some(p => HIDDEN_DIRS.has(p))) throw new WorkspaceFailure('Служебные каталоги (.git, node_modules) Studio не открывает.');
    const full = path.resolve(this.root, ...parts);
    let probe = full;
    while (!fs.existsSync(probe) && probe !== this.root) probe = path.dirname(probe);
    let real: string;
    try { real = fs.realpathSync(probe); } catch { throw new WorkspaceFailure('Файл вне проекта.'); }
    if (real !== this.root && !real.startsWith(this.root + path.sep)) throw new WorkspaceFailure('Файл вне проекта.');
    // Сам файл-ссылка тоже не открываем: он мог указывать наружу, а проверка выше смотрела на родителя
    try { if (fs.lstatSync(full).isSymbolicLink()) throw new WorkspaceFailure('Ссылки внутри проекта не открываются.'); } catch (e) { if (e instanceof WorkspaceFailure) throw e; }
    return full;
  }

  private rules(): Array<(rel: string, isDir: boolean) => boolean> {
    try { return parseIgnore(fs.readFileSync(path.join(this.root, IGNORE_FILE), 'utf8')); } catch { return []; }
  }
  private packIgnored(rel: string, name: string, isDir: boolean, rules: ReturnType<Workspace['rules']>): boolean {
    return isDir ? PACK_DIRS.has(name) || rules.some(r => r(rel, true)) : PACK_FILES.test(name) || name === IGNORE_FILE || rules.some(r => r(rel, false));
  }

  /** Дерево для окна: каталоги и файлы, без служебных; `ignored` — в пакет не пойдёт */
  tree(textLimit = 512 * 1024, isText: (p: string) => boolean = () => true): TreeEntry[] {
    const out: TreeEntry[] = [], rules = this.rules();
    const walk = (dir: string, prefix: string, ignoredAbove: boolean) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink() || out.length > 5000) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (HIDDEN_DIRS.has(entry.name)) continue;
          const ignored = ignoredAbove || this.packIgnored(rel, entry.name, true, rules);
          out.push({ path: rel, dir: true, size: 0, mtime: 0, ignored });
          walk(path.join(dir, entry.name), rel, ignored);
        } else if (entry.isFile()) {
          let st: fs.Stats;
          try { st = fs.statSync(path.join(dir, entry.name)); } catch { continue; }
          out.push({ path: rel, dir: false, size: st.size, mtime: Math.floor(st.mtimeMs), text: isText(rel) && st.size <= textLimit,
            ignored: ignoredAbove || !validBundlePath(rel) || this.packIgnored(rel, entry.name, false, rules) });
        }
      }
    };
    walk(this.root, '', false);
    return out;
  }

  /** Файлы пакета: по правилам исключения и пределам; лишнее в пакет не попадает, но и проект не ломает */
  pack(): ProjectFiles {
    const out: ProjectFiles = {};
    let total = 0;
    for (const entry of this.tree()) {
      if (entry.dir || entry.ignored) continue;
      if (Object.keys(out).length >= MAX_FILES) throw new WorkspaceFailure(`В проекте больше ${MAX_FILES} файлов для пакета. Уберите лишнее или перечислите в ${IGNORE_FILE}.`);
      total += entry.size;
      if (total > MODULE_BUNDLE_MAX) throw new WorkspaceFailure('Пакет станет больше 32 МиБ. Уберите лишнее или перечислите в ' + IGNORE_FILE + '.');
      out[entry.path] = new Uint8Array(fs.readFileSync(this.resolve(entry.path)));
    }
    return out;
  }

  /** Запись через временный файл: оборванная запись не оставляет полфайла */
  write(rel: string, data: Uint8Array | string): void {
    const full = this.resolve(rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    this.resolve(rel); // каталоги созданы — проверить ещё раз, уже по настоящим путям
    const temp = `${full}.${process.pid}.tmp`;
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, full);
  }
  mkdir(rel: string): void { fs.mkdirSync(this.resolve(rel), { recursive: true }); this.resolve(rel); }
  read(rel: string): Uint8Array { try { return new Uint8Array(fs.readFileSync(this.resolve(rel))); } catch (e) { if (e instanceof WorkspaceFailure) throw e; throw new WorkspaceFailure('Файла нет в проекте.'); } }
  exists(rel: string): boolean { return fs.existsSync(this.resolve(rel)); }
  /** Переименование и перенос — одна операция; существующее не затирается */
  move(from: string, to: string): void {
    const a = this.resolve(from), b = this.resolve(to);
    if (!fs.existsSync(a)) throw new WorkspaceFailure('Исходного файла нет.');
    if (fs.existsSync(b)) throw new WorkspaceFailure(`«${to}» уже есть.`);
    if (b.startsWith(a + path.sep)) throw new WorkspaceFailure('Папку нельзя переместить внутрь себя.');
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
  }
  remove(rel: string): void { fs.rmSync(this.resolve(rel), { recursive: true, force: true }); }

  /** Поиск по тексту файлов проекта: путь, строка, фрагмент */
  search(query: string, isText: (p: string) => boolean, limit = 200): Array<{ path: string; line: number; text: string }> {
    const hits: Array<{ path: string; line: number; text: string }> = [], needle = query.toLowerCase();
    if (!needle) return hits;
    for (const entry of this.tree(512 * 1024, isText)) {
      if (entry.dir || !entry.text) continue;
      const lines = Buffer.from(this.read(entry.path)).toString('utf8').split('\n');
      for (let i = 0; i < lines.length && hits.length < limit; i++) if (lines[i].toLowerCase().includes(needle)) hits.push({ path: entry.path, line: i + 1, text: lines[i].trim().slice(0, 200) });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** Отпечаток дерева: по нему находят, что изменилось снаружи */
  signature(): Map<string, string> {
    const map = new Map<string, string>();
    for (const e of this.tree()) map.set(e.path, e.dir ? 'd' : `${e.size}:${e.mtime}`);
    return map;
  }
}

export interface FolderChange { path: string; kind: 'added' | 'changed' | 'removed' }
export function diffSignatures(before: Map<string, string>, after: Map<string, string>): FolderChange[] {
  const out: FolderChange[] = [];
  for (const [p, s] of after) { const was = before.get(p); if (was === undefined) out.push({ path: p, kind: 'added' }); else if (was !== s) out.push({ path: p, kind: 'changed' }); }
  for (const p of before.keys()) if (!after.has(p)) out.push({ path: p, kind: 'removed' });
  return out;
}

/**
 * Слежение за папкой. fs.watch на Windows и сетевых папках теряет события, поэтому он служит только
 * «будильником»: решение принимает сравнение отпечатков, которое делается и по таймеру (запасной опрос).
 */
export class FolderWatcher {
  private last: Map<string, string>;
  private timer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private pendingScan: NodeJS.Timeout | null = null;
  constructor(private readonly space: Workspace, private readonly onChange: (changes: FolderChange[]) => void, private readonly pollMs = 1500) {
    this.last = space.signature();
  }
  start(): void {
    try { this.watcher = fs.watch(this.space.root, { recursive: true }, () => this.soon()); this.watcher.on('error', () => {}); } catch { /* только опрос */ }
    this.timer = setInterval(() => this.scan(), this.pollMs);
    this.timer.unref?.();
  }
  private soon() { if (this.pendingScan) return; this.pendingScan = setTimeout(() => { this.pendingScan = null; this.scan(); }, 120); this.pendingScan.unref?.(); }
  /** Свои записи Studio отмечаются заранее: они не считаются «изменением снаружи» */
  acknowledge(): void { this.last = this.space.signature(); }
  scan(): FolderChange[] {
    let next: Map<string, string>;
    try { next = this.space.signature(); } catch { return []; }
    const changes = diffSignatures(this.last, next);
    this.last = next;
    if (changes.length) this.onChange(changes);
    return changes;
  }
  stop(): void { if (this.timer) clearInterval(this.timer); if (this.pendingScan) clearTimeout(this.pendingScan); this.watcher?.close(); this.timer = this.pendingScan = null; this.watcher = null; }
}
