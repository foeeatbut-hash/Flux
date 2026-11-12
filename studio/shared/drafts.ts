/**
 * Черновики проектов программ: лежат на компьютере разработчика, в общую базу не уходят.
 *
 * Каталог `drafts/<идентификатор>/project/…` — файлы проекта ровно в том виде, как они попадут в пакет;
 * `state.json` рядом — версия-основа, предыдущий запрос, «что нового», канал. Пути проверяются теми же
 * правилами, что у пакета (validBundlePath): имя, которое нельзя положить в пакет, нельзя и сохранить.
 * Запись через временный файл: оборванная запись не оставляет полфайла.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MODULE_BUNDLE_MAX, MODULE_ID, type ModuleChannel } from '../../modules/trust/claims';
import { validBundlePath } from '../../modules/trust/bundle';
import type { ProjectFiles } from './templates';

export interface DraftState {
  /** Запрос, который этот черновик исправляет: «исправить и отправить заново» */
  parentRequest: string | null;
  /** Выпуск, от которого владелец видит разницу; null — программа новая */
  baseRelease: string | null;
  changelog: string; comment: string; channel: ModuleChannel;
  template: string; createdAt: number; updatedAt: number;
}
export interface DraftSummary { id: string; name: string; version: string; language: string; updatedAt: number; parentRequest: string | null }

export class DraftFailure extends Error {}
const MAX_FILES = 400;

export class Drafts {
  private readonly root: string;
  constructor(dir: string) { this.root = path.join(dir, 'drafts'); }

  private dir(id: string): string {
    if (!MODULE_ID.test(id)) throw new DraftFailure('Некорректный идентификатор программы.');
    return path.join(this.root, id);
  }
  private projectDir(id: string) { return path.join(this.dir(id), 'project'); }
  private statePath(id: string) { return path.join(this.dir(id), 'state.json'); }

  private write(file: string, data: Uint8Array | string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, file);
  }

  exists(id: string): boolean { return fs.existsSync(this.statePath(id)); }

  create(id: string, files: ProjectFiles, state: Partial<DraftState> & { template: string }): void {
    if (this.exists(id)) throw new DraftFailure(`Проект «${id}» уже есть на этом компьютере.`);
    const total = Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0);
    if (total > MODULE_BUNDLE_MAX || Object.keys(files).length > MAX_FILES) throw new DraftFailure('Проект слишком большой.');
    for (const [name, bytes] of Object.entries(files)) this.writeFile(id, name, bytes, true);
    const now = Date.now();
    this.write(this.statePath(id), JSON.stringify({
      parentRequest: null, baseRelease: null, changelog: '', comment: '', channel: 'test', createdAt: now, ...state, updatedAt: now,
    }));
  }

  private target(id: string, name: string): string {
    if (!validBundlePath(name) || name.startsWith('build/')) throw new DraftFailure(`Недопустимое имя файла: ${name}`);
    const base = this.projectDir(id), full = path.resolve(base, ...name.split('/'));
    if (!full.startsWith(base + path.sep)) throw new DraftFailure('Файл вне проекта.');
    return full;
  }

  writeFile(id: string, name: string, data: Uint8Array | string, creating = false): void {
    if (!creating && !this.exists(id)) throw new DraftFailure('Проект не найден.');
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (bytes.length > MODULE_BUNDLE_MAX) throw new DraftFailure('Файл слишком большой.');
    const target = this.target(id, name);
    // Предел проекта действует и при правке, а не только при создании: иначе проект разрастается до отказа при отправке
    if (!creating) {
      const files = this.files(id);
      const existed = !!files[name];
      const total = Object.values(files).reduce((sum, b) => sum + b.length, 0) - (files[name]?.length || 0) + bytes.length;
      if (!existed && Object.keys(files).length >= MAX_FILES) throw new DraftFailure(`В проекте не больше ${MAX_FILES} файлов.`);
      if (total > MODULE_BUNDLE_MAX) throw new DraftFailure('Проект станет больше 32 МиБ: уберите лишние файлы.');
    }
    this.write(target, bytes);
    if (!creating) this.touch(id);
  }

  deleteFile(id: string, name: string): void {
    if (['manifest.json', 'form.json'].includes(name)) throw new DraftFailure('manifest.json и form.json удалять нельзя.');
    fs.rmSync(this.target(id, name), { force: true });
    this.touch(id);
  }

  files(id: string): ProjectFiles {
    if (!this.exists(id)) throw new DraftFailure('Проект не найден.');
    const out: ProjectFiles = {};
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else if (entry.isFile() && validBundlePath(rel) && !entry.name.endsWith('.tmp')) out[rel] = new Uint8Array(fs.readFileSync(path.join(dir, entry.name)));
      }
    };
    walk(this.projectDir(id), '');
    return out;
  }

  state(id: string): DraftState {
    try { return JSON.parse(fs.readFileSync(this.statePath(id), 'utf8')); } catch { throw new DraftFailure('Проект не найден.'); }
  }
  setState(id: string, patch: Partial<DraftState>): DraftState {
    const next = { ...this.state(id), ...patch, updatedAt: Date.now() };
    this.write(this.statePath(id), JSON.stringify(next));
    return next;
  }
  private touch(id: string) { this.setState(id, {}); }

  remove(id: string): void { fs.rmSync(this.dir(id), { recursive: true, force: true }); }

  list(): DraftSummary[] {
    if (!fs.existsSync(this.root)) return [];
    const out: DraftSummary[] = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !MODULE_ID.test(entry.name)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(this.projectDir(entry.name), 'manifest.json'), 'utf8'));
        const state = this.state(entry.name);
        out.push({ id: entry.name, name: String(manifest.name || entry.name), version: String(manifest.version || ''), language: String(manifest.sourceLanguage || manifest.language || 'typescript'),
          updatedAt: state.updatedAt, parentRequest: state.parentRequest });
      } catch { /* повреждённый черновик в списке не показываем: открыть его всё равно нечем */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
