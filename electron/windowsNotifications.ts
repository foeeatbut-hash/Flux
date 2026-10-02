import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  WINDOWS_NOTIFICATIONS_CHANGED, WINDOWS_NOTIFICATIONS_CONSENT, WINDOWS_NOTIFICATIONS_SNAPSHOT,
  type WindowsNotificationItem, type WindowsNotificationsSnapshot,
} from '../filesystem/windowsNotifications';
import { resolveSafePath } from './filesystem/paths';

const runFile = promisify(execFile);
const FAMILY = /^Flux\.NotificationBridge_[a-z0-9]{13}$/;
const MAX_BYTES = 2 * 1024 * 1024;
interface PackageLocation { familyName: string; localAppData: string }
interface WindowsNotificationsDependencies {
  platform: string;
  locatePackage: () => Promise<PackageLocation | null>;
  readSnapshot: (location: PackageLocation) => Promise<string>;
  launch: (location: PackageLocation) => Promise<void>;
  now?: () => number;
}
const empty = (status: WindowsNotificationsSnapshot['status'], message: string): WindowsNotificationsSnapshot => ({ status, message, items: [] });
const textField = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
export function validateWindowsNotifications(value: unknown, now: number): WindowsNotificationsSnapshot {
  const raw = value as { schema?: unknown; status?: unknown; updatedAt?: unknown; items?: unknown };
  if (!raw || raw.schema !== 1 || !['ready', 'denied', 'consent-required', 'unavailable'].includes(String(raw.status))
    || !textField(raw.updatedAt, 64) || !Array.isArray(raw.items) || raw.items.length > 200)
    throw new Error('Некорректный снимок уведомлений Windows.');
  const timestamp = Date.parse(raw.updatedAt);
  if (!Number.isFinite(timestamp) || now - timestamp > 45000 || timestamp - now > 5000)
    throw new Error('Компонент Windows не обновляет разрешение и уведомления.');
  const ids = new Set<string>();
  const items: WindowsNotificationItem[] = [];
  for (const item of raw.items) {
    if (!item || !textField(item.id, 64) || !/^win:\d{1,10}$/.test(item.id) || ids.has(item.id)
      || item.source !== 'windows' || !textField(item.appName, 256) || !textField(item.title, 1024)
      || !textField(item.body, 8192) || !textField(item.createdAt, 64) || !Number.isFinite(Date.parse(item.createdAt)))
      throw new Error('Некорректное уведомление Windows.');
    ids.add(item.id);
    // Дополнительные поля локального файла не становятся действиями, URL или путями renderer.
    items.push({ id: item.id, source: 'windows', appName: item.appName, title: item.title, body: item.body, createdAt: item.createdAt });
  }
  if (raw.status === 'denied') return empty('denied', 'Windows запретила доступ к уведомлениям. Измените разрешение компонента в параметрах Windows.');
  if (raw.status === 'consent-required') return empty('consent-required', 'Подключите уведомления Windows и разрешите передачу в окне компонента.');
  if (raw.status === 'unavailable') return empty('unavailable', 'Компонент Windows остановлен. Откройте его и оставьте работающим.');
  return { status: 'ready', updatedAt: raw.updatedAt, items };
}

export class WindowsNotificationsService {
  private pending: Promise<WindowsNotificationsSnapshot> | null = null;
  private lastLaunch = -Infinity;
  constructor(private deps: WindowsNotificationsDependencies) {}
  private location(location: PackageLocation | null): location is PackageLocation {
    return !!location && FAMILY.test(location.familyName) && typeof location.localAppData === 'string' && path.isAbsolute(location.localAppData);
  }
  async snapshot(): Promise<WindowsNotificationsSnapshot> {
    if (this.deps.platform !== 'win32') return empty('unsupported', 'Уведомления Windows доступны в приложении для Windows.');
    if (this.pending) return this.pending;
    this.pending = this.refresh().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async refresh(): Promise<WindowsNotificationsSnapshot> {
    try {
      const location = await this.deps.locatePackage();
      if (!this.location(location)) return empty('not-installed', 'Для чтения уведомлений Windows установите подписанный компонент Flux Notification Bridge.');
      try {
        const bytes = await this.deps.readSnapshot(location);
        if (Buffer.byteLength(bytes, 'utf8') > MAX_BYTES) throw new Error('Снимок слишком велик.');
        return validateWindowsNotifications(JSON.parse(bytes), (this.deps.now || Date.now)());
      } catch {
        return empty('unavailable', 'Компонент не передаёт свежие уведомления. Откройте его и проверьте разрешение Windows.');
      }
    } catch { return empty('unavailable', 'Windows не предоставила состояние установленного компонента уведомлений.'); }
  }
  async requestConsent(): Promise<{ ok: boolean; message?: string }> {
    if (this.deps.platform !== 'win32') return { ok: false, message: 'Нужна версия Flux для Windows.' };
    const now = (this.deps.now || Date.now)();
    if (now - this.lastLaunch < 5000) return { ok: false, message: 'Компонент уже запускается. Подтвердите доступ в его окне.' };
    this.lastLaunch = now;
    try {
      const location = await this.deps.locatePackage();
      if (!this.location(location)) return { ok: false, message: 'Сначала установите подписанный Flux Notification Bridge.' };
      await this.deps.launch(location);
      return { ok: true, message: 'В окне компонента нажмите «Разрешить передачу в Flux». Разрешение выдаёт Windows.' };
    } catch { return { ok: false, message: 'Windows не запустила компонент уведомлений. Проверьте его установку.' }; }
  }
}

const PACKAGE_SCRIPT = String.raw`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$package=Get-AppxPackage -Name 'Flux.NotificationBridge' | Where-Object { $_.Status -eq 'Ok' } | Select-Object -First 1
if ($null -eq $package) { [Console]::WriteLine('null') } else {
  [Console]::WriteLine((@{familyName=$package.PackageFamilyName;localAppData=[Environment]::GetFolderPath('LocalApplicationData')} | ConvertTo-Json -Compress))
}`;
async function locatePackage(): Promise<PackageLocation | null> {
  const result = await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PACKAGE_SCRIPT, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024, encoding: 'utf8' });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}
export async function readWindowsNotificationsFile(location: PackageLocation): Promise<string> {
  if (!FAMILY.test(location.familyName)) throw new Error('Неподдерживаемый пакет.');
  const relative = `Packages/${location.familyName}/LocalState/notifications.json`;
  const filename = await resolveSafePath(location.localAppData, relative);
  const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_BYTES)) throw new Error('Некорректный снимок.');
    const bytes = await file.readFile();
    if (bytes.byteLength > MAX_BYTES) throw new Error('Снимок слишком велик.');
    await resolveSafePath(location.localAppData, relative);
    const after = await file.stat({ bigint: true }), named = await fs.lstat(filename, { bigint: true });
    if (before.ino !== named.ino || before.dev !== named.dev || before.mtimeNs !== after.mtimeNs || before.size !== after.size)
      throw new Error('Снимок изменился во время чтения.');
    return bytes.toString('utf8');
  } finally { await file.close(); }
}

export function setupWindowsNotifications(options: {
  isTrusted: (event: IpcMainInvokeEvent) => boolean;
  mayRead: (event: IpcMainInvokeEvent) => boolean | Promise<boolean>;
}) {
  const service = new WindowsNotificationsService({ platform: process.platform, locatePackage, readSnapshot: readWindowsNotificationsFile,
    launch: async location => { await runFile('explorer.exe', [`shell:AppsFolder\\${location.familyName}!App`], { windowsHide: true, timeout: 10000 }); } });
  const subscribers = new Set<number>();
  const guard = async (event: IpcMainInvokeEvent) => {
    if (!options.isTrusted(event) || !await options.mayRead(event)) throw new Error('Войдите в Flux для просмотра уведомлений Windows.');
    if (!subscribers.has(event.sender.id)) {
      subscribers.add(event.sender.id); event.sender.once('destroyed', () => subscribers.delete(event.sender.id));
    }
  };
  ipcMain.handle(WINDOWS_NOTIFICATIONS_SNAPSHOT, async event => { await guard(event); return service.snapshot(); });
  ipcMain.handle(WINDOWS_NOTIFICATIONS_CONSENT, async event => { await guard(event); return service.requestConsent(); });
  // Сигнал не несёт чужих текстов: каждый renderer перечитывает снимок с проверкой своей сессии.
  const timer = setInterval(() => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && subscribers.has(window.webContents.id))
      window.webContents.send(WINDOWS_NOTIFICATIONS_CHANGED);
  }, 10000);
  timer.unref();
  app.once('will-quit', () => clearInterval(timer));
  return service;
}
