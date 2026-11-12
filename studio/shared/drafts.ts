/**
 * Проекты программ: лежат на компьютере разработчика, в общую базу не уходят.
 *
 * Проект — обычная папка на диске (studio/shared/workspace.ts): `folder.json` в `drafts/<идентификатор>/` указывает на неё,
 * `state.json` рядом — версия-основа, предыдущий запрос, «что нового», канал (в папке проекта служебных файлов нет).
 * Прежние черновики (`drafts/<идентификатор>/project/…`) остаются открываемыми, а `migrate` переносит их в папки копией.
 * Имя, которое нельзя положить в пакет (validBundlePath), в пакет не попадает. Папка пользователя при удалении проекта
 * из списка не удаляется никогда: стирается только служебная запись `drafts/<идентификатор>`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MODULE_BUNDLE_MAX, MODULE_ID, type ModuleChannel } from '../../modules/trust/claims';
import { validBundlePath } from '../../modules/trust/bundle';
import type { ProjectFiles } from './templates';
import { MAX_FILES, Workspace, WorkspaceFailure, type TreeEntry } from './workspace';

export interface DraftState {
  /** Запрос, который этот черновик исправляет: «исправить и отправить заново» */
  parentRequest: string | null;
  /** Выпуск, от которого владелец видит разницу; null — программа новая */
  baseRelease: string | null;
  changelog: string; comment: string; channel: ModuleChannel;
  template: string; createdAt: number; updatedAt: number;
}
export interface DraftSummary { id: string; name: string; version: string; language: string; updatedAt: number; parentRequest: string | null; folder: string }

export class DraftFailure extends Error {}
/** Текстовые файлы, которые открываются в редакторе */
export const TEXT_FILE = /\.(json|ts|tsx|js|mjs|html|css|svg|py|c|cpp|h|rs|go|cs|csproj|toml|mod|sh|md|txt)$|^(Cargo\.lock|go\.sum)$/i;

export class Drafts {
  private readonly root: string;
  private readonly home: string;
  constructor(dir: string, home?: string) { this.root = path.join(dir, 'drafts'); this.home = home || path.join(dir, 'projects'); }

  private dir(id: string): string {
    if (!MODULE_ID.test(id)) throw new DraftFailure('Некорректный идентификатор программы.');
    return path.join(this.root, id);
  }
  private statePath(id: string) { return path.join(this.dir(id), 'state.json'); }
  private folderPath(id: string) { return path.join(this.dir(id), 'folder.json'); }
  /** Папка проекта: из folder.json, иначе прежнее скрытое хранилище */
  folder(id: string): string {
    try { const f = JSON.parse(fs.readFileSync(this.folderPath(id), 'utf8')).folder; if (typeof f === 'string' && f) return f; } catch { /* прежний черновик */ }
    return path.join(this.dir(id), 'project');
  }
  space(id: string): Workspace {
    if (!this.exists(id)) throw new DraftFailure('Проект не найден.');
    try { return new Workspace(this.folder(id)); } catch (e) { throw new DraftFailure(e instanceof WorkspaceFailure ? `${e.message} Папка: ${this.folder(id)}` : String(e)); }
  }
  private guard<T>(fn: () => T): T { try { return fn(); } catch (e) { if (e instanceof WorkspaceFailure) throw new DraftFailure(e.message); throw e; } }

  private write(file: string, data: Uint8Array | string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, file);
  }

  exists(id: string): boolean { return fs.existsSync(this.statePath(id)); }

  /** Новый проект: пустая или несуществующая папка (по умолчанию «projects/<id>» в данных Studio) */
  create(id: string, files: ProjectFiles, state: Partial<DraftState> & { template: string }, folder?: string): void {
    if (this.exists(id)) throw new DraftFailure(`Проект «${id}» уже есть на этом компьютере.`);
    const total = Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0);
    if (total > MODULE_BUNDLE_MAX || Object.keys(files).length > MAX_FILES) throw new DraftFailure('Проект слишком большой.');
    const target = folder ? path.resolve(folder) : path.join(this.home, id);
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw new DraftFailure(`Папка «${target}» не пуста: выберите пустую или несуществующую.`);
    fs.mkdirSync(target, { recursive: true });
    const space = this.guard(() => new Workspace(target));
    for (const [name, bytes] of Object.entries(files)) this.guard(() => space.write(this.checked(name), bytes));
    this.register(id, space.root, state);
  }
  private checked(name: string): string {
    if (!validBundlePath(name) || name.startsWith('build/')) throw new DraftFailure(`Недопустимое имя файла: ${name}`);
    return name;
  }
  private register(id: string, folder: string, state: Partial<DraftState>) {
    this.write(this.folderPath(id), JSON.stringify({ folder }));
    const now = Date.now();
    this.write(this.statePath(id), JSON.stringify({
      parentRequest: null, baseRelease: null, changelog: '', comment: '', channel: 'test', template: 'folder', createdAt: now, ...state, updatedAt: now,
    }));
  }

  /** «Открыть папку как проект»: manifest.json в ней задаёт идентификатор; уже открытый проект возвращается как есть */
  openFolder(folder: string): { id: string; fresh: boolean } {
    const space = this.guard(() => new Workspace(folder));
    let manifest: any;
    try { manifest = JSON.parse(Buffer.from(space.read('manifest.json')).toString('utf8')); } catch { throw new DraftFailure('В папке нет manifest.json: это не проект программы Flux.'); }
    const id = String(manifest?.id || '');
    if (!MODULE_ID.test(id)) throw new DraftFailure('В manifest.json нет корректного идентификатора программы (id).');
    if (this.exists(id)) {
      if (this.folder(id) === space.root) return { id, fresh: false };
      throw new DraftFailure(`Программа «${id}» уже открыта из другой папки (${this.folder(id)}). Уберите её из списка или откройте ту папку.`);
    }
    this.register(id, space.root, { template: 'folder' });
    return { id, fresh: true };
  }

  writeFile(id: string, name: string, data: Uint8Array | string): void {
    const space = this.space(id);
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (bytes.length > MODULE_BUNDLE_MAX) throw new DraftFailure('Файл слишком большой.');
    this.checked(name);
    // Предел проекта действует и при правке, а не только при создании: иначе проект разрастается до отказа при отправке
    const files = this.files(id);
    const existed = !!files[name];
    const total = Object.values(files).reduce((sum, b) => sum + b.length, 0) - (files[name]?.length || 0) + bytes.length;
    if (!existed && Object.keys(files).length >= MAX_FILES) throw new DraftFailure(`В проекте не больше ${MAX_FILES} файлов.`);
    if (total > MODULE_BUNDLE_MAX) throw new DraftFailure('Проект станет больше 32 МиБ: уберите лишние файлы.');
    this.guard(() => space.write(name, bytes));
    this.touch(id);
  }

  /** Файл или папка: manifest.json и form.json удалять нельзя */
  deleteFile(id: string, name: string): void {
    if (['manifest.json', 'form.json'].includes(name)) throw new DraftFailure('manifest.json и form.json удалять нельзя.');
    this.guard(() => this.space(id).remove(name));
    this.touch(id);
  }
  makeDir(id: string, name: string): void { this.guard(() => this.space(id).mkdir(name)); }
  /** Переименование и перенос; manifest.json и form.json остаются на месте */
  rename(id: string, from: string, to: string): void {
    if (['manifest.json', 'form.json'].includes(from)) throw new DraftFailure('manifest.json и form.json переименовывать нельзя.');
    this.guard(() => this.space(id).move(from, to));
    this.touch(id);
  }

  tree(id: string): TreeEntry[] { return this.guard(() => this.space(id).tree(512 * 1024, p => TEXT_FILE.test(p))); }
  readAny(id: string, name: string): Uint8Array { return this.guard(() => this.space(id).read(name)); }
  search(id: string, query: string) { return this.guard(() => this.space(id).search(query.slice(0, 200), p => TEXT_FILE.test(p))); }

  /** Файлы пакета: по правилам исключения (.fluxignore, сборочные каталоги) и пределам */
  files(id: string): ProjectFiles { return this.guard(() => this.space(id).pack()); }

  state(id: string): DraftState {
    try { return JSON.parse(fs.readFileSync(this.statePath(id), 'utf8')); } catch { throw new DraftFailure('Проект не найден.'); }
  }
  setState(id: string, patch: Partial<DraftState>): DraftState {
    const next = { ...this.state(id), ...patch, updatedAt: Date.now() };
    this.write(this.statePath(id), JSON.stringify(next));
    return next;
  }
  private touch(id: string) { this.setState(id, {}); }

  /** Убирает проект из списка: стирается только запись в данных Studio (и прежняя скрытая копия), папка пользователя остаётся целой */
  remove(id: string): void { fs.rmSync(this.dir(id), { recursive: true, force: true }); }

  /** Прежние скрытые черновики → папки. Копией и один раз: оригинал остаётся, при сбое ничего не теряется */
  migrate(): string[] {
    const moved: string[] = [];
    if (!fs.existsSync(this.root)) return moved;
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !MODULE_ID.test(entry.name) || fs.existsSync(this.folderPath(entry.name))) continue;
      const legacy = path.join(this.dir(entry.name), 'project'), target = path.join(this.home, entry.name);
      if (!fs.existsSync(legacy) || fs.existsSync(target)) continue;
      try { fs.cpSync(legacy, target, { recursive: true }); this.write(this.folderPath(entry.name), JSON.stringify({ folder: fs.realpathSync(target) })); moved.push(entry.name); }
      catch { fs.rmSync(target, { recursive: true, force: true }); }
    }
    return moved;
  }

  list(): DraftSummary[] {
    if (!fs.existsSync(this.root)) return [];
    const out: DraftSummary[] = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !MODULE_ID.test(entry.name)) continue;
      try {
        const folder = this.folder(entry.name);
        const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
        const state = this.state(entry.name);
        out.push({ id: entry.name, name: String(manifest.name || entry.name), version: String(manifest.version || ''), language: String(manifest.sourceLanguage || manifest.language || 'typescript'),
          updatedAt: state.updatedAt, parentRequest: state.parentRequest, folder });
      } catch { /* повреждённый черновик или удалённая папка в списке не показываем: открыть их всё равно нечем */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
