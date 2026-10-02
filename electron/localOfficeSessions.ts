/** Local Office sessions. Only WindowsFiles capabilities ever address the original file. */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, extname, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WindowsFilesService } from './filesystem/service';
import { WindowsFilesError, validateWindowsName } from './filesystem/paths';
import type { WindowsFileRef } from '../filesystem/contracts';
import { createLocalOfficeWorkerHost } from './localOfficeWorkerHost';
import { isOfficeOperation, type OfficeHostDiagnostic } from '../diagnostics/officeOperations';
import { safeError } from '../diagnostics/event';

export type LocalOfficeApp = 'pdf' | 'sheets';
export interface LocalOfficeHost {
  start(resources: string): void;
  open(path: string, dataDir?: string): number | Promise<number>;
  setDataDir?(id: number, path: string): void | Promise<void>;
  invoke(id: number, channel: string, args: unknown[], saveTarget?: string, commit?: () => Promise<void>): Promise<any>;
  send(id: number, channel: string, args: unknown[]): void | Promise<void>;
  onSend(fn: (id: number, channel: string, args: unknown[]) => void): void | (() => void);
  close(id: number): void | Promise<void>;
  dispose?(): void | Promise<void>;
  requestCopy?(id: number, target: string): Promise<boolean>;
}
export type LocalOfficeRequest =
  | { action: 'open'; app: LocalOfficeApp; ref: WindowsFileRef }
  | { action: 'invoke'; session: number; channel: string; args?: unknown[]; copyName?: string }
  | { action: 'send'; session: number; channel: string; args?: unknown[] }
  | { action: 'copy'; session: number; name: string }
  | { action: 'close'; session: number };
export interface LocalOfficeEvent { session: number; channel: string; args: unknown[] }
export interface LocalOfficeAuthorization {
  /** Re-evaluated before every operation, including after native save and before disk persistence. */
  mayRead(): boolean | Promise<boolean>;
  mayWrite(): boolean | Promise<boolean>;
}
export interface LocalOfficeSessionOptions {
  files: Pick<WindowsFilesService, 'read' | 'write' | 'publish' | 'createDraft' | 'resolveRef'>;
  userData: string;
  resourcesDir?: string;
  loadHost?: (app: LocalOfficeApp) => LocalOfficeHost;
  onEvent(owner: number, event: LocalOfficeEvent): void;
  copyTimeoutMs?: number;
  onDiagnostic?(event: OfficeHostDiagnostic): void;
}
interface CopyState { path: string; name: string; made?: unknown; cancel: () => void }
interface Session {
  id: number; owner: number; app: LocalOfficeApp; host: LocalOfficeHost; nativeId: number;
  ref: WindowsFileRef; fileId: string; sha: string; dir: string; path: string; closed: boolean;
  queue: Promise<unknown>; inFlight: Set<Promise<unknown>>; copy?: CopyState;
}
const MAX_BYTES = 64 * 1024 * 1024;
const PDF_READ = new Set(['pdf:consume-pending', 'pdf:read-file', 'pdf:is-untitled', 'pdf:validate-text-edits',
  'pdf:list-edit-fonts', 'pdf:can-draw-text', 'pdf:list-page-images', 'pdf:list-static-form-fills',
  'pdf:page-image-png', 'pdf:page-preview-png', 'pdf:get-username', 'pdf:list-signatures']);
const PDF_PRIVATE_EDIT = new Set(['pdf:add-signature','pdf:remove-signature']);
const PDF_SAVE = new Set(['pdf:save', 'pdf:insert-blank-page', 'pdf:set-page-size', 'pdf:crop-pages']);
const SHEET_READ = new Set(['workbook:select', 'workbook:read-range', 'workbook:read-formulas', 'workbook:recalc',
  'workbook:read-media', 'workbook:read-pivot-definition', 'workbook:close', 'workbook:csv-save-confirm',
  'sheets:consume-new-blank', 'sheets:has-queued-workbook', 'sheets:consume-headless-export']);
const SHEET_EDIT = new Set(['workbook:save', 'workbook:save-edits-begin', 'workbook:save-edits-chunk', 'workbook:save-edits-abort', 'workbook:write-recovery']);
const SEND = new Set(['pdf:dirty-changed', 'pdf:close-save-result', 'pdf:save-as-result',
  'workbook:pending-edits', 'workbook:close-save-result', 'workbook:recovery-prompt-reply']);
function fail(code: string, message: string): never { throw new WindowsFilesError(code, message); }

/** Native bundles have independent webContents counters: expose our own, globally unique IDs. */
export class LocalOfficeSessions {
  private sessions = new Map<number, Session>();
  private hosts = new Map<LocalOfficeApp, LocalOfficeHost>();
  private offs: (() => void)[] = [];
  private nextId = 1;
  private opening = new Map<number, number>();
  private closedOwners = new Set<number>();
  private disposed = false;
  constructor(private options: LocalOfficeSessionOptions) {}
  get size(): number { return this.sessions.size; }

  private async readPermission(auth: LocalOfficeAuthorization) {
    if (!await auth.mayRead()) fail('UNAUTHORIZED', 'Войдите в Flux для работы с локальным файлом.');
  }
  private async writePermission(auth: LocalOfficeAuthorization) {
    await this.readPermission(auth);
    if (!await auth.mayWrite()) fail('READ_ONLY', 'Изменение файла недоступно: проверьте права и лицензию Flux.');
  }
  private alive(s: Session) {
    if (s.closed || this.disposed) fail('SESSION_CLOSED', 'Окно редактора уже закрыто.');
  }
  private owned(owner: number, id: number): Session {
    const s = Number.isSafeInteger(id) ? this.sessions.get(id) : undefined;
    if (!s || s.owner !== owner || s.closed) fail('SESSION_NOT_FOUND', 'Окно локального редактора не найдено.');
    return s;
  }
  private host(app: LocalOfficeApp): LocalOfficeHost {
    const have = this.hosts.get(app); if (have) return have;
    const h = this.options.loadHost ? this.options.loadHost(app) : createLocalOfficeWorkerHost(app, this.options.resourcesDir);
    const off = h.onSend((nativeId, channel, args) => {
      // Never broadcast contents, paths or editor messages to another native window.
      for (const s of this.sessions.values()) if (s.app === app && s.nativeId === nativeId && !s.closed &&
        (channel.startsWith('pdf:') || channel.startsWith('workbook:') || channel.startsWith('sheets:'))) {
        this.options.onEvent(s.owner, { session: s.id, channel, args }); break;
      }
    });
    if (typeof off === 'function') this.offs.push(off);
    this.hosts.set(app, h); return h;
  }
  async handle(owner: number, request: LocalOfficeRequest, auth: LocalOfficeAuthorization): Promise<any> {
    const app = request?.action === 'open' ? request.app : this.sessions.get((request as any)?.session)?.app;
    const action = request?.action;
    const started = performance.now();
    const candidate = (request as any)?.channel;
    const operation = isOfficeOperation(candidate) ? candidate : 'windows-office:invoke';
    const emit = (fields: Partial<OfficeHostDiagnostic>) => {
      if ((app !== 'pdf' && app !== 'sheets') || !['open', 'invoke', 'send', 'copy', 'close'].includes(action)) return;
      try { this.options.onDiagnostic?.({ app, action, operation, phase: 'start', ...fields }); } catch { /* Запись не влияет на документ. */ }
    };
    emit({ phase: 'start' });
    try {
      const result = await this.handleInner(owner, request, auth);
      emit({ phase: 'end', durationMs: performance.now() - started,
        outcome: result?.ok === false ? 'error' : result?.canceled ? 'cancelled' : 'ok' });
      return result;
    } catch (error: any) {
      emit({ phase: 'end', durationMs: performance.now() - started,
        outcome: error?.code === 'CONFLICT' ? 'conflict' : 'error', ...safeError(error) });
      throw error;
    }
  }
  private async handleInner(owner: number, request: LocalOfficeRequest, auth: LocalOfficeAuthorization): Promise<any> {
    await this.readPermission(auth);
    if (this.disposed || this.closedOwners.has(owner)) fail('SESSION_CLOSED', 'Окно Flux уже закрыто.');
    if (!request || typeof request !== 'object') fail('INVALID_REQUEST', 'Некорректная команда редактора.');
    if (request.action === 'open') return this.open(owner, request.app, request.ref, auth);
    const s = this.owned(owner, request.session);
    if (request.action === 'close') { await this.closeSession(s); return { closed: true }; }
    if (request.action === 'send') {
      if (!SEND.has(request.channel) || (s.app === 'pdf') !== request.channel.startsWith('pdf:')) fail('CHANNEL_DISABLED', 'Команда локального редактора недоступна.');
      await s.host.send(s.nativeId, request.channel, this.args(request.args)); return { sent: true };
    }
    if (request.action === 'copy') return this.pdfCopy(s, request.name, auth);
    if (request.action !== 'invoke') fail('INVALID_ACTION', 'Команда локального редактора неизвестна.');
    const promise = s.queue.catch(() => undefined).then(() => this.invoke(s, request, auth));
    s.queue = promise; s.inFlight.add(promise);
    try { return await promise; } finally { s.inFlight.delete(promise); }
  }
  private args(value: unknown): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 32) fail('INVALID_REQUEST', 'Некорректные параметры редактора.');
    // Structured-clone permits cycles; reject before reaching native code, and cap IPC allocation.
    try { if (JSON.stringify(value).length > MAX_BYTES * 1.4) fail('TOO_LARGE', 'Правки превышают допустимый размер файла.'); }
    catch (e) { if (e instanceof WindowsFilesError) throw e; fail('INVALID_REQUEST', 'Некорректные параметры редактора.'); }
    return value;
  }
  private async open(owner: number, app: LocalOfficeApp, ref: WindowsFileRef, auth: LocalOfficeAuthorization) {
    if (app !== 'pdf' && app !== 'sheets') fail('INVALID_APP', 'Этот локальный редактор недоступен.');
    const pending = this.opening.get(owner) || 0;
    if ([...this.sessions.values()].filter(s => s.owner === owner).length + pending >= 16 || this.sessions.size + [...this.opening.values()].reduce((a,b) => a+b,0) >= 64) fail('SESSION_LIMIT', 'Закройте неиспользуемые окна редакторов.');
    this.opening.set(owner, pending + 1);
    let dir: string | undefined; let nativeId: number | undefined; let host: LocalOfficeHost | undefined;
    try {
      const original = await this.options.files.read(ref);
      const suffix = extname(original.name).toLowerCase();
      if (app === 'pdf' ? suffix !== '.pdf' : !['.xlsx', '.xlsm'].includes(suffix)) fail('INVALID_FILE', 'Выберите файл подходящего формата для редактора.');
      validateWindowsName(original.name);
      const bytes = Buffer.from(original.base64, 'base64');
      if (bytes.length > MAX_BYTES) fail('TOO_LARGE', 'Файл превышает допустимый размер 64 МБ.');
      const parent = join(this.options.userData, 'local-office');
      await mkdir(parent, { recursive: true, mode: 0o700 }); await chmod(parent, 0o700);
      dir = await mkdtemp(join(parent, `view-${owner}-`)); await chmod(dir, 0o700);
      const path = join(dir, original.name);
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
      await this.readPermission(auth);
      if (this.closedOwners.has(owner) || this.disposed) fail('SESSION_CLOSED', 'Окно Flux уже закрыто.');
      host = this.host(app); nativeId = await host.open(path, dir); await host.setDataDir?.(nativeId, dir);
      await this.readPermission(auth);
      if (this.closedOwners.has(owner) || this.disposed) fail('SESSION_CLOSED', 'Окно Flux уже закрыто.');
      const id = this.nextId++;
      this.sessions.set(id, { id, owner, app, host, nativeId, ref: { ...ref }, fileId: original.fileId,
        sha: original.sha256, dir, path, closed: false, queue: Promise.resolve(), inFlight: new Set() });
      return { session: id, name: original.name };
    } catch (e) {
      if (nativeId !== undefined) try { await host?.close(nativeId); } catch { /* clean up below */ }
      if (dir) await rm(dir, { force: true, recursive: true }); throw e;
    } finally { const left = (this.opening.get(owner) || 1) - 1; if (left) this.opening.set(owner, left); else this.opening.delete(owner); }
  }
  private checkPaths(s: Session, args: unknown[], channel: string) {
    const visit = (value: unknown, depth: number) => {
      if (depth > 24) fail('INVALID_REQUEST', 'Слишком сложные параметры редактора.');
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (/^(path|filePath|sourcePath|targetPath|outputPath)$/i.test(key) && child !== undefined && child !== null && child !== '') {
          if (s.app === 'sheets' && channel === 'workbook:read-pivot-definition' && key === 'path' && typeof child === 'string' && /^xl\/[A-Za-z0-9._/-]+\.xml$/.test(child) && !child.includes('..')) continue;
          if (child !== s.path && !(key === 'targetPath' && child === s.copy?.path)) fail('PATH_NOT_GRANTED', 'Редактор может работать только с открытым файлом.');
        }
        visit(child, depth + 1);
      }
    };
    visit(args, 0);
    if (s.app === 'pdf' && ['pdf:read-file','pdf:is-untitled','pdf:list-page-images','pdf:list-static-form-fills'].includes(channel) && typeof args[0] === 'string' && args[0] !== s.path) fail('PATH_NOT_GRANTED', 'Редактор может работать только с открытым PDF.');
  }
  private async privateBytes(path: string): Promise<Buffer> {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_BYTES) fail('TOO_LARGE', 'Файл превышает допустимый размер 64 МБ.');
    const bytes = await readFile(path);
    if (bytes.length > MAX_BYTES) fail('TOO_LARGE', 'Файл превышает допустимый размер 64 МБ.');
    return bytes;
  }
  private async persist(s: Session, auth: LocalOfficeAuthorization) {
    this.alive(s); await this.writePermission(auth); this.alive(s);
    const current = await this.options.files.read(s.ref);
    if (current.fileId !== s.fileId || current.sha256 !== s.sha) fail('CONFLICT', 'Файл изменён вне этого окна. Сохраните правки отдельной копией.');
    const bytes = await this.privateBytes(s.path);
    await this.writePermission(auth); this.alive(s);
    const saved = await this.options.files.write(s.ref, bytes.toString('base64'), s.sha);
    s.sha = saved.sha256;
  }
  private copyName(s: Session, value: string): string {
    if (typeof value !== 'string') fail('INVALID_NAME', 'Укажите имя копии.');
    validateWindowsName(value);
    if (extname(value).toLowerCase() !== extname(s.path).toLowerCase()) fail('INVALID_NAME', 'Расширение копии должно совпадать с форматом открытого файла.');
    return value;
  }
  private async publishCopy(s: Session, path: string, name: string, auth: LocalOfficeAuthorization) {
    const bytes = await this.privateBytes(path);
    await this.writePermission(auth); this.alive(s);
    const ref = this.options.files.resolveRef(s.ref);
    const source = await this.options.files.read(ref);
    const relativePath = posix.dirname(ref.relativePath.replace(/\\/g, '/'));
    const parent = { rootId: ref.rootId, relativePath: relativePath === '.' ? '' : relativePath };
    await this.writePermission(auth); this.alive(s);
    return source.storage === 'flux'
      ? this.options.files.createDraft(parent, name, bytes.toString('base64'))
      : this.options.files.publish(parent, name, bytes.toString('base64'), randomUUID());
  }
  private async invoke(s: Session, request: Extract<LocalOfficeRequest, {action: 'invoke'}>, auth: LocalOfficeAuthorization) {
    this.alive(s); await this.readPermission(auth);
    const channel = request.channel;
    const allowed = s.app === 'pdf' ? PDF_READ.has(channel) || PDF_SAVE.has(channel) || PDF_PRIVATE_EDIT.has(channel) : SHEET_READ.has(channel) || SHEET_EDIT.has(channel);
    if (!allowed) fail('CHANNEL_DISABLED', 'Эта операция недоступна для локального файла. Используйте «Сохранить как» для создания копии в подключённой папке.');
    const args = this.args(request.args); this.checkPaths(s, args, channel);
    const modifies = s.app === 'pdf' ? PDF_SAVE.has(channel) || PDF_PRIVATE_EDIT.has(channel) : SHEET_EDIT.has(channel);
    if (modifies) { await this.writePermission(auth); this.alive(s); }
    const payload = args[0] as any;
    if (s.app === 'pdf' && channel === 'pdf:save' && payload?.redactions !== undefined) fail('CHANNEL_DISABLED', 'Необратимое удаление текста требует отдельного защищённого экспорта PDF.');
    const pdfTarget = s.app === 'pdf' && channel === 'pdf:save' && payload?.targetPath === s.copy?.path && !!s.copy;
    if (s.copy && modifies && !pdfTarget) fail('COPY_IN_PROGRESS', 'Дождитесь завершения сохранения копии PDF.');
    if (s.app === 'sheets' && channel === 'workbook:write-recovery') {
      // SaveAs uses the same native engine, without replacing the original workbook session.
      // Recovery bytes stay private to this webContents, never in global temp or the company API.
      const result = await s.host.invoke(s.nativeId, 'workbook:save',
        [{ ...payload, mode: 'save-as', targetPath: undefined }], join(s.dir, `recovery${extname(s.path) === '.xlsm' ? '.xlsm' : '.xlsx'}`));
      return { ok: result?.fluxCopySaved === true };
    }
    const sheetCopy = s.app === 'sheets' && channel === 'workbook:save' && payload?.mode === 'save-as';
    if (sheetCopy && !request.copyName) return { canceled: true };
    const copyName = sheetCopy ? this.copyName(s, request.copyName!) : undefined;
    const copyTarget = sheetCopy ? join(s.dir, `copy-${randomUUID()}${extname(s.path)}`) : undefined;
    const normalSave = !copyTarget && !pdfTarget && (s.app === 'pdf' ? PDF_SAVE.has(channel) : channel === 'workbook:save');
    const baseline = normalSave ? join(s.dir, `baseline-${randomUUID()}`) : undefined;
    let committed = false;
    if (baseline) await copyFile(s.path, baseline);
    try {
      const commit = s.app === 'sheets' && normalSave ? async () => { await this.persist(s, auth); committed = true; } : undefined;
      const result = await s.host.invoke(s.nativeId, channel, args, copyTarget, commit);
      this.alive(s);
      const successful = result && result.ok !== false && (!result.canceled || result.fluxCopySaved);
      if (successful && (copyTarget || pdfTarget)) {
        const made = await this.publishCopy(s, copyTarget || s.copy!.path, copyName || s.copy!.name, auth);
        if (pdfTarget) s.copy!.made = made;
        else return { canceled: true, fluxCopySaved: true, copy: made };
      } else if (successful && normalSave && !committed) { await this.persist(s, auth); committed = true; }
      return result;
    } catch (error) {
      // Keep the original native session usable for SaveAs after a CAS/licence failure.
      if (baseline && !committed && !s.closed) await copyFile(baseline, s.path).catch(() => {});
      throw error;
    } finally {
      if (baseline) await rm(baseline, { force: true }).catch(() => {});
      if (copyTarget) await rm(copyTarget, { force: true }).catch(() => {});
    }
  }
  private async pdfCopy(s: Session, value: string, auth: LocalOfficeAuthorization) {
    this.alive(s); await this.writePermission(auth);
    if (s.app !== 'pdf' || !s.host.requestCopy) fail('INVALID_APP', 'Сохранение копии PDF недоступно.');
    if (s.copy) fail('COPY_IN_PROGRESS', 'Копия PDF уже сохраняется.');
    const name = this.copyName(s, value);
    let cancel!: () => void;
    const canceled = new Promise<boolean>(resolve => { cancel = () => resolve(false); });
    const copy: CopyState = { path: join(s.dir, `copy-${randomUUID()}.pdf`), name, cancel };
    s.copy = copy;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // This request waits for renderer invoke + send, so it MUST NOT hold the invoke queue.
    const operation = (async () => {
      try {
        const deadline = new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), this.options.copyTimeoutMs ?? 120_000); });
        const ok = await Promise.race([s.host.requestCopy!(s.nativeId, copy.path), canceled, deadline]);
        if (!ok) {
          // Resolve the native waiter's timer as well; cancellation never creates a file.
          try { await s.host.send(s.nativeId, 'pdf:save-as-result', [false]); } catch { /* closed host */ }
        }
        return copy.made ? { copy: copy.made } : { canceled: true };
      } finally {
        if (timeout) clearTimeout(timeout);
        if (s.copy === copy) s.copy = undefined;
        await rm(copy.path, { force: true }).catch(() => {});
      }
    })();
    s.inFlight.add(operation);
    try { return await operation; } finally { s.inFlight.delete(operation); }
  }
  private async closeSession(s: Session) {
    if (s.closed) return;
    s.closed = true; this.sessions.delete(s.id); s.copy?.cancel();
    try { await s.host.close(s.nativeId); } catch { /* cleanup is mandatory */ }
    await Promise.allSettled([...s.inFlight]);
    await rm(s.dir, { recursive: true, force: true });
  }
  async closeOwner(owner: number) {
    this.closedOwners.add(owner);
    await Promise.allSettled([...this.sessions.values()].filter(s => s.owner === owner).map(s => this.closeSession(s)));
  }
  async dispose() {
    this.disposed = true;
    await Promise.allSettled([...this.sessions.values()].map(s => this.closeSession(s)));
    this.offs.splice(0).forEach(off => off());
    await Promise.allSettled([...this.hosts.values()].map(host => host.dispose?.()));
    this.hosts.clear();
  }
}

/** Loaded only by Electron main; no corporate API or server modules are involved. */
export function loadLocalOfficeHost(app: LocalOfficeApp, resourcesDir?: string): LocalOfficeHost {
  const candidates = [resourcesDir, process.env.FLUX_GENOFFICE_SERVER,
    (process as any).resourcesPath && join((process as any).resourcesPath, 'genoffice-server'),
    join(process.cwd(), 'genoffice-server')].filter(Boolean) as string[];
  const dir = candidates.find(path => existsSync(join(path, `${app}.cjs`)));
  if (!dir) fail('EDITOR_UNAVAILABLE', 'Локальный редактор отсутствует в этой сборке Flux.');
  const host = createRequire(join(dir, 'package.json'))(join(dir, `${app}.cjs`)) as LocalOfficeHost;
  if (typeof host.setDataDir !== 'function') fail('EDITOR_UPDATE_REQUIRED', 'Обновите сборку Flux: локальному редактору требуется изолированное хранение файлов.');
  host.start(dir); return host;
}
