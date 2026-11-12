/**
 * Разделы разработчика в главном процессе: ключ, проекты, тестовая база, запуск, проверка, публикация, ошибки.
 *
 * Без Electron: всё, что нужно от программы, приходит в `DeveloperDeps`, поэтому службу проверяют на Linux
 * (scripts/test-studio-shell.ts). Окно получает только то, что возвращают действия, и с пределами длины;
 * закрытого ключа и токена сессии среди этого нет по построению (ключ подписывает `keyring.sign`, токен
 * не покидает этот процесс).
 */
import { randomUUID } from 'node:crypto';
import { languageOf } from '../../modules/engine/types';
import { resources, type ModuleManifest, type LaunchContext, type Resource } from '../../modules/contract';
import { MODULE_CHANNELS, MODULE_ID, MODULE_VERSION, type ModuleChannel } from '../../modules/trust/claims';
import { unpackBundle, validBundlePath } from '../../modules/trust/bundle';
import { moduleHeaders } from '../../modules/protocol';
import { runChecks, type CheckReport } from '../shared/checks';
import type { ControlsEngine } from '../shared/controlsEngine';
import fs from 'node:fs';
import path from 'node:path';
import { Drafts } from '../shared/drafts';
import { DeveloperKeyring, KeyringFailure, type SafeStorageLike } from '../shared/keyring';
import { buildRequest, PublishRefused } from '../shared/publish';
import { assembleRuntime, loadRuntimeTemplates, type RuntimeTemplates } from '../shared/runtime';
import { createFromTemplate, TEMPLATES, TEMPLATE_IDS, validProjectId, type ProjectFiles, type TemplateId } from '../shared/templates';
import { FLUX_ASSET_FILE, PAGE_URL_FILE, pageProblem, pageTypeOf } from '../../modules/page/model';
import { TestBase } from '../shared/testBase';
import type { DeveloperAction } from './actions';
import { studioRequest, StudioFailure, type StudioUser } from './api';
import {
  certificateStatus, lastRelease, markFixed, ownBundle, ownErrors, ownRequests, versionWarning, type Session,
} from './developerServer';

export interface DeveloperDeps {
  dir: string;
  storage: SafeStorageLike;
  version: string;
  /** Текущая сессия (подключение + вход) или null; токен не уходит дальше этого файла */
  session: () => (Session & { user: StudioUser; owner: boolean }) | null;
  assets: { templatesRoot: string; runtimeDir: string };
  engine: ControlsEngine;
  /** Снимок области окна в PNG (Electron: capturePage); в проверках подставляется */
  capture?: (rect: { x: number; y: number; width: number; height: number }) => Promise<Uint8Array>;
}

const text = (v: unknown, max: number): string => {
  if (typeof v !== 'string' || v.length > max) throw new StudioFailure('Некорректные данные формы.');
  return v;
};
const moduleId = (v: unknown): string => {
  const id = text(v, 64);
  if (!MODULE_ID.test(id)) throw new StudioFailure('Некорректный идентификатор программы.');
  return id;
};
/** Текст в окне редактируется только у небольших текстовых файлов; остальное (wasm, снимки) показывается размером */
const TEXT_FILE = /\.(json|ts|js|mjs|html|css|svg|py|c|cpp|h|rs|go|cs|csproj|toml|mod|sh|md|txt)$|^(Cargo\.lock|go\.sum)$/i;
const EDIT_LIMIT = 512 * 1024;

/** Отметка «запрос сертификата отправлен» для этого ключа: после выдачи или смены ключа перестаёт совпадать */
class RequestedMarker {
  private readonly file: string;
  constructor(dir: string) { this.file = path.join(dir, 'certificate-request.json'); }
  has(key: string): boolean { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')).key === key; } catch { return false; } }
  save(key: string): void { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ key, at: Date.now() })); }
}

interface Run {
  id: string; language: ReturnType<typeof languageOf>; files: ProjectFiles; logicPath: string;
  runtime: string; html: string; css: string; context: LaunchContext; resources: readonly string[];
  /** Страница программы (договор v2): файлы ui/ отдаются из проекта, а не из собранного runtime.js */
  page: boolean;
}

export class DeveloperService {
  readonly keyring: DeveloperKeyring;
  readonly drafts: Drafts;
  readonly testBase: TestBase;
  private templates: RuntimeTemplates | null = null;
  private run: Run | null = null;
  private readonly requested: RequestedMarker;

  constructor(private readonly deps: DeveloperDeps) {
    this.keyring = new DeveloperKeyring(deps.dir, deps.storage);
    this.drafts = new Drafts(deps.dir);
    this.testBase = new TestBase(deps.dir);
    this.requested = new RequestedMarker(deps.dir);
  }

  private session(): Session & { user: StudioUser; owner: boolean } {
    const s = this.deps.session();
    if (!s) throw new StudioFailure('Войдите в Flux Studio.');
    return s;
  }
  private runtimeTemplates(): RuntimeTemplates { return this.templates ??= loadRuntimeTemplates(this.deps.assets.runtimeDir); }
  private manifestOf(files: ProjectFiles): ModuleManifest {
    try { return JSON.parse(Buffer.from(files['manifest.json'] || new Uint8Array()).toString('utf8')); } catch { throw new StudioFailure('manifest.json не читается как JSON.'); }
  }

  /** Страница и файлы запущенной программы для протокола flux-module://run/…; чужих путей не отдаёт */
  asset(url: string): { status: number; type: string; body: Uint8Array | string; headers: Record<string, string> } | null {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    const run = this.run;
    if (!run || parsed.protocol !== 'flux-module:' || parsed.hostname !== 'run' || parsed.username || parsed.password || parsed.port) return null;
    const file = parsed.pathname === '/' ? 'index.html' : parsed.pathname.slice(1);
    if (run.page) {
      // Те же адреса и тот же заголовок CSP, что у Flux (electron/modules.ts): страница в Studio ведёт себя как во Flux
      if (FLUX_ASSET_FILE.test(file)) {
        const t = this.runtimeTemplates();
        const body = file.endsWith('.js') ? t.pageClient : t.pageCss;
        return body ? { status: 200, type: pageTypeOf(file)!, body, headers: moduleHeaders(pageTypeOf(file)!, false, true) } : null;
      }
      const bytes = PAGE_URL_FILE.test(file) ? run.files[file] : undefined;
      return bytes ? { status: 200, type: pageTypeOf(file)!, body: bytes, headers: moduleHeaders(pageTypeOf(file)!, false, true) } : null;
    }
    const map: Record<string, [string, string]> = {
      'index.html': [run.html, 'text/html; charset=utf-8'], 'runtime.js': [run.runtime, 'text/javascript; charset=utf-8'], 'flux.css': [run.css, 'text/css; charset=utf-8'],
    };
    const hit = map[file];
    return hit ? { status: 200, type: hit[1], body: hit[0], headers: moduleHeaders(hit[1]) } : null;
  }

  async handle(action: DeveloperAction, args: Record<string, any>): Promise<unknown> {
    switch (action) {
      // ── Ключ разработчика ────────────────────────────────────────────────────
      case 'keyInfo': return this.keyring.info();
      case 'keyCreate': return this.guard(() => this.keyring.create(args.replace === true));
      case 'keyRequest': {
        const user = this.session().user;
        return { text: this.guard(() => this.keyring.certificateRequest({ userId: user.id, name: user.name })) };
      }
      // Запрос уходит в очередь владельца; профиль сервер берёт из входа. Текст запроса (keyRequest) остаётся запасным путём
      case 'keyRequestSend': {
        const info = this.keyring.info(), s = this.session();
        if (!info.exists) throw new StudioFailure('Сначала создайте ключ разработчика.');
        await studioRequest(s.origin, 'certRequest', { token: s.token, body: { key: info.publicKey, name: s.user.name || s.user.id } });
        this.requested.save(info.publicKey);
        return { sent: true };
      }
      case 'keyCertificate': {
        const info = this.keyring.info();
        if (!info.exists) return { status: 'nokey', name: '' };
        const status = await certificateStatus(this.session(), info.publicKey);
        // «Запрос отправлен» помнится на этом компьютере, пока сертификата нет
        return status.status === 'none' && this.requested.has(info.publicKey) ? { status: 'requested', name: '' } : status;
      }

      // ── Проекты ──────────────────────────────────────────────────────────────
      case 'templates': return TEMPLATES;
      case 'drafts': return this.drafts.list();
      case 'draftCreate': {
        const template = text(args.template, 20) as TemplateId, id = text(args.id, 64), name = text(args.name, 80);
        if (!TEMPLATE_IDS.includes(template)) throw new StudioFailure('Неизвестная заготовка.');
        const bad = validProjectId(id);
        if (bad) throw new StudioFailure(bad);
        if (this.drafts.exists(id)) throw new StudioFailure(`Проект «${id}» уже есть на этом компьютере.`);
        const s = this.session();
        const files = createFromTemplate(this.deps.assets.templatesRoot, template, { id, name, author: s.user.name || s.user.id }, args.kind === 'page' ? 'page' : 'form');
        this.drafts.create(id, files, { template, ...(TEMPLATES.find(t => t.id === template)?.changelog ? { changelog: TEMPLATES.find(t => t.id === template)!.changelog } : {}) });
        return { id };
      }
      case 'draftImport': return this.importRequest(text(args.requestId, 64));
      case 'draftTree': {
        const id = moduleId(args.id), files = this.drafts.files(id);
        return { state: this.drafts.state(id), files: Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.length, text: TEXT_FILE.test(path) && bytes.length <= EDIT_LIMIT })).sort((a, b) => a.path.localeCompare(b.path)) };
      }
      case 'draftFile': {
        const id = moduleId(args.id), path = text(args.path, 240), bytes = this.drafts.files(id)[path];
        if (!bytes) throw new StudioFailure('Файла нет в проекте.');
        if (!TEXT_FILE.test(path) || bytes.length > EDIT_LIMIT) return { text: null, size: bytes.length };
        return { text: Buffer.from(bytes).toString('utf8'), size: bytes.length };
      }
      case 'draftSave': { this.drafts.writeFile(moduleId(args.id), text(args.path, 240), text(args.text, EDIT_LIMIT)); return { saved: true }; }
      case 'draftRemoveFile': { this.drafts.deleteFile(moduleId(args.id), text(args.path, 240)); return { removed: true }; }
      case 'draftRemove': { this.drafts.remove(moduleId(args.id)); return { removed: true }; }
      case 'draftState': {
        const id = moduleId(args.id), patch: Record<string, unknown> = {};
        if (args.changelog !== undefined) patch.changelog = text(args.changelog, 4000);
        if (args.comment !== undefined) patch.comment = text(args.comment, 4000);
        if (args.channel !== undefined) {
          if (!MODULE_CHANNELS.includes(args.channel)) throw new StudioFailure('Канал — «тестовый» или «рабочий».');
          patch.channel = args.channel;
        }
        return this.drafts.setState(id, patch);
      }

      // ── Тестовая база и запуск ───────────────────────────────────────────────
      case 'testBase': { this.testBase.ensure(); return { file: 'test-base.sqlite', counts: this.testBase.counts(), context: this.testBase.context() }; }
      case 'testBaseReset': { this.testBase.reset(); return { counts: this.testBase.counts() }; }
      case 'runStart': return this.startRun(moduleId(args.id), args);
      case 'runRead': return this.runRead(args);
      case 'runCompute': return this.runCompute(args);
      case 'runShot': return this.shoot(moduleId(args.id), text(args.theme, 5), args.rect);

      // ── Проверка и публикация ────────────────────────────────────────────────
      case 'check': return this.check(moduleId(args.id));
      case 'publish': return this.publish(moduleId(args.id));
      case 'requests': return ownRequests(this.session());
      case 'errors': return ownErrors(this.session(), this.session().owner);
      case 'errorFixed': {
        await markFixed(this.session(), { reportId: text(args.reportId, 64), version: text(args.version, 40), revision: Number(args.revision) });
        return { marked: true };
      }
    }
  }

  private guard<T>(fn: () => T): T {
    try { return fn(); } catch (error) { if (error instanceof KeyringFailure) throw new StudioFailure(error.message); throw error; }
  }

  /** «Исправить и отправить заново»: пакет своего запроса становится черновиком, связанным с этим запросом */
  private async importRequest(requestId: string) {
    const s = this.session();
    const row = (await ownRequests(s)).find(r => r.id === requestId);
    if (!row) throw new StudioFailure('Запрос не найден среди ваших.');
    const files = unpackBundle(await ownBundle(s, requestId));
    delete files['build/runtime.js'];
    const id = row.moduleId;
    if (this.drafts.exists(id)) throw new StudioFailure(`Проект «${id}» уже есть на этом компьютере. Откройте его или удалите перед импортом.`);
    this.drafts.create(id, files, { template: 'request', parentRequest: row.id, changelog: row.changelog, channel: row.channel === 'production' ? 'production' : 'test' });
    return { id };
  }

  private context(args: Record<string, any>): LaunchContext {
    const entry = ['start', 'equipment', 'tag'].includes(args.entry) ? args.entry : 'start';
    const str = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 160 ? v : null;
    return { projectId: str(args.projectId), entry, entityId: str(args.entityId) };
  }

  private async startRun(id: string, args: Record<string, any>) {
    const files = this.drafts.files(id), manifest = this.manifestOf(files);
    const page = manifest.ui === 'page';
    const built = page ? { runtime: '', problem: pageProblem(files, manifest.pages) } : assembleRuntime(this.runtimeTemplates(), manifest, files);
    if (built.problem) throw new StudioFailure(built.problem);
    this.testBase.ensure();
    const t = this.runtimeTemplates();
    this.run = {
      id: randomUUID(), language: languageOf(manifest), files, logicPath: manifest.logic, runtime: built.runtime, html: t.html, css: t.css,
      context: this.context(args), resources: manifest.reads || [], page,
    };
    return { session: this.run.id, url: page ? 'flux-module://run/ui/index.html' : 'flux-module://run/index.html', language: this.run.language, manifest: { id: manifest.id, name: manifest.name, version: manifest.version, reads: manifest.reads, entries: manifest.entries, connections: manifest.connections || [], ui: manifest.ui, pages: manifest.pages }, context: this.run.context };
  }

  /** Чтение для запущенной программы — только объявленное в reads и только из тестовой базы */
  private runRead(args: Record<string, any>) {
    const run = this.run;
    if (!run) throw new StudioFailure('Программа не запущена.');
    const resource = text(args.resource, 20) as Resource;
    if (!(resources as readonly string[]).includes(resource) || !run.resources.includes(resource)) throw new StudioFailure('DENIED');
    const entityId = typeof args.entityId === 'string' && args.entityId.length <= 160 ? args.entityId : undefined;
    return this.testBase.read(resource, run.context, entityId);
  }

  private async runCompute(args: Record<string, any>) {
    const run = this.run;
    if (!run) throw new StudioFailure('Программа не запущена.');
    if (run.language === 'typescript') throw new StudioFailure('Логика на TypeScript считает сама программа.');
    if (!args.input || typeof args.input !== 'object' || Array.isArray(args.input)) throw new StudioFailure('Некорректный вход расчёта.');
    try { return { output: await this.deps.engine.compute(run.language, run.files, run.logicPath, args.input) }; }
    catch (error: any) { return { code: String(error?.code || 'CRASH') }; }
  }

  /** Снимок окна программы в выбранной теме → store/<тема>.png проекта и запись в manifest.store.screenshots */
  private async shoot(id: string, theme: string, rect: any) {
    if (!this.deps.capture) throw new StudioFailure('Снимок экрана в этой сборке недоступен.');
    if (!['light', 'dark'].includes(theme)) throw new StudioFailure('Тема — светлая или тёмная.');
    const box = ['x', 'y', 'width', 'height'].every(k => Number.isFinite(rect?.[k]) && rect[k] >= 0 && rect[k] < 20_000) && rect.width >= 16 && rect.height >= 16;
    if (!box) throw new StudioFailure('Не удалось определить область окна программы.');
    const png = await this.deps.capture({ x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) });
    if (png.length > 2 * 1024 * 1024) throw new StudioFailure('Снимок больше 2 МиБ: уменьшите окно.');
    const name = `store/${theme}.png`;
    this.drafts.writeFile(id, name, png);
    const manifest = this.manifestOf(this.drafts.files(id));
    const listed = new Set(manifest.store?.screenshots || []);
    listed.add(name);
    const next = { ...manifest, store: { category: 'other', summary: '', ...(manifest.store || {}), screenshots: [...listed].filter(validBundlePath) } };
    this.drafts.writeFile(id, 'manifest.json', `${JSON.stringify(next, null, 2)}\n`);
    return { saved: name };
  }

  private async check(id: string): Promise<CheckReport> {
    const state = this.drafts.state(id);
    return runChecks({ files: this.drafts.files(id), changelog: state.changelog, studioVersion: this.deps.version, engine: this.deps.engine });
  }

  private async publish(id: string) {
    const s = this.session();
    const state = this.drafts.state(id), files = this.drafts.files(id), manifest = this.manifestOf(files);
    if (manifest.id !== id || !MODULE_VERSION.test(String(manifest.version))) throw new StudioFailure('Идентификатор и версия в manifest.json не сходятся с проектом.');
    // Отчёт строится заново в момент отправки: «прошло вчера» не считается, а отчёт из окна не принимается вовсе
    const report = await runChecks({ files, changelog: state.changelog, studioVersion: this.deps.version, engine: this.deps.engine });
    if (!report.ok) throw new StudioFailure('Проверка перед отправкой не пройдена: отправка недоступна. Откройте раздел «Проверка перед отправкой».');
    // У страницы нет runtime.js: пакет несёт ui/ как есть, и подписывается ровно он
    const built = manifest.ui === 'page' ? { runtime: '', problem: pageProblem(files, manifest.pages) } : assembleRuntime(this.runtimeTemplates(), manifest, files);
    if (built.problem) throw new StudioFailure(built.problem);
    const last = await lastRelease(s, id);
    let request;
    try {
      request = buildRequest(this.keyring, {
        moduleId: id, version: manifest.version, files, runtime: built.runtime, baseRelease: last ? `${id}@${last.version}` : null,
        parentRequest: state.parentRequest, channel: state.channel as ModuleChannel, changelog: state.changelog, comment: state.comment, report, studioVersion: this.deps.version,
      });
    } catch (error) {
      if (error instanceof KeyringFailure || error instanceof PublishRefused) throw new StudioFailure(error.message);
      throw error;
    }
    const reply = await studioRequest<{ id?: string; duplicate?: boolean }>(s.origin, 'submit', {
      token: s.token, body: { signature: request.signature, bundle: Buffer.from(request.bundle).toString('base64') }, timeoutMs: 180_000,
    });
    if (typeof reply.id !== 'string') throw new StudioFailure('Flux не подтвердил приём запроса.');
    // Следующая отправка этого проекта продолжает историю: прежний запрос станет «заменён новой отправкой»
    this.drafts.setState(id, { parentRequest: reply.id });
    return { id: reply.id, duplicate: reply.duplicate === true, warning: await versionWarning(s.origin, this.deps.version) };
  }

  /** Предупреждение для главного окна */
  warning(origin: string) { return versionWarning(origin, this.deps.version); }
}
