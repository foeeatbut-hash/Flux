import { app, BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  SHELL_DESKTOP_CHANGED, SHELL_DESKTOP_OPEN, SHELL_DESKTOP_SNAPSHOT,
  type ShellDesktopActionResult, type ShellDesktopSnapshot,
} from '../filesystem/shellDesktop';
import { runNativeDesktopScript } from './nativeDesktopRunner';
import { diagnosticsWriter } from './diagnostics';
import { safeError } from '../diagnostics/event';
import type { WindowsFileRef } from '../filesystem/contracts';
import type { WindowsFilesService } from './filesystem/service';

export interface NativeDesktopItem {
  nativeId: string; name: string; kind: 'file' | 'directory' | 'shortcut' | 'virtual';
  isFluxAppShortcut?: boolean;
  x: number; y: number; icon: { base64: string; width: number; height: number } | null;
  fileSystemPath?: string | null;
}
export interface NativeDesktopSnapshot {
  items: NativeDesktopItem[]; skipped: number; iconSize: number;
  spacing: { x: number; y: number }; iconsVisible: boolean;
  physicalBounds: { x: number; y: number; width: number; height: number };
}
interface NativeDesktopDependencies {
  platform: string;
  run: (action: 'snapshot' | 'open', nativeId?: string) => Promise<unknown>;
  screenToDipPoint: (point: { x: number; y: number }) => { x: number; y: number };
  displayAt: (point: { x: number; y: number }) => { id: number; scaleFactor: number };
  fileRefForPath?: (filename: string) => Promise<WindowsFileRef | null>;
  now?: () => number;
  onFailure?: (error: unknown) => void;
}
const unavailable = (status: 'unavailable' | 'unsupported', message: string): ShellDesktopSnapshot => ({
  status, message, revision: '', items: [], view: null,
});
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
const nativeKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value);
export function validateNativeDesktop(value: unknown): NativeDesktopSnapshot {
  const input = value as NativeDesktopSnapshot;
  if (!input || !Array.isArray(input.items) || input.items.length > 10000 || !finite(input.iconSize)
    || input.iconSize < 8 || input.iconSize > 1024 || typeof input.iconsVisible !== 'boolean'
    || !input.spacing || !finite(input.spacing.x) || !finite(input.spacing.y)
    || !Number.isInteger(input.skipped) || input.skipped < 0 || input.skipped > 10000
    || !input.physicalBounds || !['x', 'y', 'width', 'height'].every(key => finite(input.physicalBounds[key as keyof NativeDesktopSnapshot['physicalBounds']]))
    || input.physicalBounds.width <= 0 || input.physicalBounds.height <= 0)
    throw new Error('Некорректный снимок рабочего стола Windows.');
  const seen = new Set<string>();
  for (const item of input.items) {
    if (!item || !nativeKey(item.nativeId) || seen.has(item.nativeId) || typeof item.name !== 'string'
      || item.name.length > 4096 || !['file', 'directory', 'shortcut', 'virtual'].includes(item.kind)
      || !finite(item.x) || !finite(item.y)
      || (item.isFluxAppShortcut !== undefined && typeof item.isFluxAppShortcut !== 'boolean')) throw new Error('Некорректный значок Windows.');
    if (item.fileSystemPath != null && (typeof item.fileSystemPath !== 'string' || item.fileSystemPath.length > 32767
      || /[\u0000-\u001f]/u.test(item.fileSystemPath))) throw new Error('Некорректный адрес значка Windows.');
    seen.add(item.nativeId);
    if (item.icon && (typeof item.icon.base64 !== 'string' || item.icon.base64.length > 2_000_000
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.icon.base64)
      || !finite(item.icon.width) || !finite(item.icon.height) || item.icon.width < 1 || item.icon.width > 2048
      || item.icon.height < 1 || item.icon.height > 2048
      || !Buffer.from(item.icon.base64, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))))
      throw new Error('Некорректное изображение значка Windows.');
  }
  return input;
}

/** Capability существует только для значка из последнего успешного снимка. */
export class DesktopShellService {
  private byId = new Map<string, string>();
  private byNativeId = new Map<string, string>();
  private cached: { at: number; snapshot: ShellDesktopSnapshot } | null = null;
  private pending: Promise<ShellDesktopSnapshot> | null = null;
  constructor(private deps: NativeDesktopDependencies) {}
  invalidate() { this.cached = null; }
  async snapshot(): Promise<ShellDesktopSnapshot> {
    if (this.deps.platform !== 'win32') return unavailable('unsupported', 'Зеркало рабочего стола доступно в Windows.');
    if (this.pending) return this.pending;
    const now = this.deps.now || Date.now;
    if (this.cached && now() - this.cached.at < 5000) return this.cached.snapshot;
    this.pending = this.refresh().then(snapshot => { this.cached = { at: now(), snapshot }; return snapshot; })
      .finally(() => { this.pending = null; });
    return this.pending;
  }
  private async refresh(): Promise<ShellDesktopSnapshot> {
    try {
      const raw = validateNativeDesktop(await this.deps.run('snapshot'));
      const byId = new Map<string, string>(), byNativeId = new Map<string, string>();
      const items = await Promise.all(raw.items.map(async item => {
        const id = this.byNativeId.get(item.nativeId) || randomUUID();
        byId.set(id, item.nativeId); byNativeId.set(item.nativeId, id);
        const position = this.deps.screenToDipPoint({ x: item.x, y: item.y });
        const display = this.deps.displayAt(position);
        if (!finite(position.x) || !finite(position.y) || !Number.isFinite(display.scaleFactor) || display.scaleFactor <= 0)
          throw new Error('Недоступны координаты монитора.');
        const fileRef = item.fileSystemPath && (item.kind === 'file' || item.kind === 'directory')
          ? await this.deps.fileRefForPath?.(item.fileSystemPath).catch(() => null) : null;
        return { id, name: item.name, kind: item.kind, isFluxAppShortcut: item.isFluxAppShortcut === true, position, monitorId: display.id,
          cell: { width: raw.spacing.x / display.scaleFactor, height: raw.spacing.y / display.scaleFactor },
          ...(fileRef ? { fileRef } : {}),
          icon: item.icon ? { dataUrl: `data:image/png;base64,${item.icon.base64}`,
            width: item.icon.width / display.scaleFactor, height: item.icon.height / display.scaleFactor } : null };
      }));
      this.byId = byId; this.byNativeId = byNativeId;
      return { status: 'ready', revision: randomUUID(), items,
        ...(raw.skipped > 0 ? { message: `Windows не вернула данные для ${raw.skipped} значков. Обновите рабочий стол.` } : {}),
        view: { physicalBounds: raw.physicalBounds, iconSize: raw.iconSize, spacing: raw.spacing, iconsVisible: raw.iconsVisible } };
    } catch (error) {
      try { this.deps.onFailure?.(error); } catch { /* Отказ диагностики не влияет на список файлов. */ }
      this.byId.clear(); this.byNativeId.clear();
      return unavailable('unavailable', 'Windows не предоставила вид Проводника. Проверьте, что Проводник запущен и политика Windows разрешает локальный помощник; файлы сохранены.');
    }
  }
  async open(id: unknown): Promise<ShellDesktopActionResult> {
    if (typeof id !== 'string' || id.length > 100 || !this.byId.has(id))
      return { ok: false, message: 'Значок изменился. Обновите рабочий стол Windows.' };
    try {
      const result = await this.deps.run('open', this.byId.get(id)) as { opened?: boolean };
      if (result?.opened !== true) throw new Error('Не подтверждено открытие.');
      return { ok: true };
    } catch { this.invalidate(); return { ok: false, message: 'Windows не открыла значок. Обновите рабочий стол и повторите действие.' }; }
  }
}

async function runNativeDesktop(action: 'snapshot' | 'open' | 'public-desktop', nativeId?: string): Promise<unknown> {
  return runNativeDesktopScript(action, nativeId);
}

export async function windowsPublicDesktopFolder(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const result = await runNativeDesktop('public-desktop') as { path?: unknown };
    return typeof result.path === 'string' ? result.path : null;
  } catch { return null; }
}

export function setupDesktopShell(options: {
  isTrusted: (event: IpcMainInvokeEvent) => boolean;
  mayRead: (event: IpcMainInvokeEvent) => boolean | Promise<boolean>;
  files?: Pick<WindowsFilesService, 'refForShellPath'>;
}) {
  const service = new DesktopShellService({ platform: process.platform, run: runNativeDesktop,
    screenToDipPoint: point => screen.screenToDipPoint(point), displayAt: point => screen.getDisplayNearestPoint(point),
    fileRefForPath: filename => options.files?.refForShellPath(filename) || Promise.resolve(null),
    onFailure: error => diagnosticsWriter()?.record('desktop.snapshot', { outcome: 'error', ...safeError(error) }) });
  const subscribers = new Set<number>();
  const guard = async (event: IpcMainInvokeEvent) => {
    if (!options.isTrusted(event) || !await options.mayRead(event)) throw new Error('Войдите в Flux для работы с рабочим столом этого компьютера.');
    if (!subscribers.has(event.sender.id)) {
      subscribers.add(event.sender.id); event.sender.once('destroyed', () => subscribers.delete(event.sender.id));
    }
  };
  ipcMain.handle(SHELL_DESKTOP_SNAPSHOT, async event => { await guard(event); return service.snapshot(); });
  ipcMain.handle(SHELL_DESKTOP_OPEN, async (event, id) => { await guard(event); return service.open(id); });
  const changed = () => {
    service.invalidate();
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && subscribers.has(win.webContents.id))
      win.webContents.send(SHELL_DESKTOP_CHANGED);
  };
  // Каталог не сообщает о переносе значка: перечитываем и раскладку Проводника.
  const timer = setInterval(changed, 15000); timer.unref();
  const focus = (_event: unknown, window: BrowserWindow) => { if (subscribers.has(window.webContents.id)) changed(); };
  app.on('browser-window-focus', focus);
  screen.on('display-metrics-changed', changed);
  screen.on('display-added', changed); screen.on('display-removed', changed);
  app.once('will-quit', () => {
    clearInterval(timer); app.removeListener('browser-window-focus', focus);
    screen.removeListener('display-metrics-changed', changed);
    screen.removeListener('display-added', changed); screen.removeListener('display-removed', changed);
  });
  return { invalidate: changed };
}
