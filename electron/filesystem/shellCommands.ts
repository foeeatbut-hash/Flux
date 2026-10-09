import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  WindowsCloudRoots, WindowsFileRef, WindowsOpenWithHandler, WindowsQuickAccessList, WindowsRecycleBin, WindowsRecycleItem, WindowsShellMenu,
  WindowsShellMenuItem, WindowsThumbnail,
} from '../../filesystem/contracts';
import { WindowsFilesError } from './paths';
import { OpaqueIds } from './opaque';
import type { WindowsFilesService } from './service';

/** Что нужно от нативного помощника. Настоящая реализация — NativeShellHost; проверки подставляют свою. */
export interface NativeShellCaller { call(command: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<any> }

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const THUMB_SIZES = [16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512];
const THUMB_CACHE_BYTES = 24 * 1024 * 1024;
const NOT_WINDOWS = 'Эта возможность доступна только в Windows.';

const text = (value: unknown, max = 1024): string | null => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/u.test(value) ? value : null;
/** Адрес, который помощник Windows вправе назвать: буква диска или UNC. Всё остальное отбрасывается. */
const windowsPath = (value: unknown): string | null => {
  const item = text(value, 32_767);
  return item && (/^[A-Za-z]:\\/u.test(item) || /^\\\\[^\\]+\\[^\\]+/u.test(item)) ? item : null;
};
/** Картинка от помощника попадает в интерфейс как data URL: сперва проверяется, что это PNG и не гигантский. */
function pngUrl(base64: unknown): string | null {
  if (typeof base64 !== 'string' || base64.length > 4_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) return null;
  return Buffer.from(base64.slice(0, 16), 'base64').subarray(0, 8).equals(PNG) ? `data:image/png;base64,${base64}` : null;
}

/**
 * Команды Windows, которые renderer видит как capability, а не как путь:
 * Быстрый доступ, облачные корни, миниатюры, «Открыть с помощью», классическое
 * меню, корзина. Пути приходят от Оболочки и остаются в main; наружу выходят
 * capability на корни и непрозрачные идентификаторы.
 */
export class ShellCommands {
  private thumbs = new Map<string, { value: WindowsThumbnail | null; bytes: number }>();
  private thumbBytes = 0;
  private flying = new Map<string, Promise<WindowsThumbnail | null>>();
  private ids = new OpaqueIds<string>();
  private platform: string; private accept: (value: unknown) => string | null;
  /** acceptPath — для проверок: на Linux путей с буквой диска не существует, и настоящий разбор адресов Windows выкинул бы все строки. */
  constructor(private service: WindowsFilesService, private host: NativeShellCaller, options: { platform?: string; acceptPath?: (value: unknown) => string | null } = {}) {
    this.platform = options.platform ?? process.platform; this.accept = options.acceptPath ?? windowsPath;
  }
  private get windows() { return this.platform === 'win32'; }
  closeOwner(owner: number) { this.ids.closeOwner(owner); }

  /** Capability для папки, названной Windows: внутри подключённого корня — относительный путь, иначе папка сама становится корнем. */
  private async folderRef(folder: string, name: string): Promise<WindowsFileRef | null> {
    const inside = await this.service.refForShellPath(folder);
    if (inside) return inside;
    try { const root = await this.service.addRoot(folder, name); return { rootId: root.id, relativePath: '' }; } catch { return null; }
  }

  async quickAccess(): Promise<WindowsQuickAccessList> {
    if (!this.windows) return { supported: false, items: [], message: NOT_WINDOWS };
    let rows: unknown;
    try { rows = await this.host.call('quick-access'); }
    catch (error: any) { if (error?.code === 'NOT_WINDOWS') return { supported: false, items: [], message: NOT_WINDOWS }; throw error; }
    const items: WindowsQuickAccessList['items'] = [];
    for (const row of Array.isArray(rows) ? rows.slice(0, 200) : []) {
      const folder = this.accept(row?.path), name = text(row?.name, 255);
      if (!folder || !name) continue;
      const ref = await this.folderRef(folder, name);
      if (ref) items.push({ name, pinned: row.pinned === true, ref });
    }
    return { supported: true, items };
  }
  async pin(ref: WindowsFileRef, pinned: boolean) {
    if (!this.windows) throw new WindowsFilesError('NOT_WINDOWS', NOT_WINDOWS);
    if (typeof pinned !== 'boolean') throw new WindowsFilesError('INVALID_REQUEST', 'Укажите, закрепить или открепить.');
    const folder = await this.service.nativePath(ref);
    if (!(await fs.stat(folder)).isDirectory()) throw new WindowsFilesError('NOT_DIRECTORY', 'В Быстром доступе закрепляются папки.');
    const result = await this.host.call('quick-pin', { path: folder, pin: pinned });
    // Состояние сообщает сама Windows после действия: «закреплено», только если Быстрый доступ это подтвердил.
    return { pinned: typeof result?.pinned === 'boolean' ? result.pinned : pinned, changed: result?.changed === true };
  }

  async fileProperties(ref: WindowsFileRef): Promise<{ author: string; createdAt: string; hidden: boolean }> {
    const filename = await this.service.filename(ref);
    if (!this.windows) { const entry = await this.service.entry(ref); return { author: '', createdAt: entry.createdAt || '', hidden: !!entry.hidden }; }
    const raw = await this.host.call('file-properties', { path: filename }) as any;
    return { author: text(raw?.author, 2000) || '', createdAt: text(raw?.createdAt, 50) || '', hidden: raw?.hidden === true };
  }

  async cloudRoots(): Promise<WindowsCloudRoots> {
    if (!this.windows) return { supported: false, items: [], message: NOT_WINDOWS };
    const rows = await this.host.call('cloud-roots');
    const items: WindowsCloudRoots['items'] = [];
    for (const row of Array.isArray(rows) ? rows.slice(0, 50) : []) {
      if (row?.provider === 'onedrive'
        || (typeof row?.id === 'string' && /^OneDrive(?:!|$)/iu.test(row.id))
        || (typeof row?.name === 'string' && /^OneDrive(?:\b|\s-)/iu.test(row.name))) continue;
      const folder = this.accept(row?.path), name = text(row?.name, 255), id = text(row?.id, 200);
      if (!folder || !name || !id) continue;
      try {
        const root = await this.service.addRoot(folder, name);
        items.push({ id, name, provider: row.provider === 'yandex' ? 'yandex' : 'other', icon: pngUrl(row.icon), root });
      } catch { /* папка исчезла или недоступна: корнем не становится */ }
    }
    return { supported: true, items };
  }

  /** Миниатюра файла. Размер округляется вверх до ступени, чтобы кэш не множился на каждый пиксель. */
  async thumbnail(ref: WindowsFileRef, requested: unknown, thumbOnly: boolean): Promise<WindowsThumbnail | null> {
    if (!this.windows) throw new WindowsFilesError('NOT_WINDOWS', NOT_WINDOWS);
    if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 1) throw new WindowsFilesError('INVALID_REQUEST', 'Укажите размер миниатюры.');
    const size = THUMB_SIZES.find(step => step >= requested) ?? THUMB_SIZES[THUMB_SIZES.length - 1];
    const filename = await this.service.nativePath(ref);
    const stat = await fs.stat(filename);
    // Правка файла меняет дату и размер, и старая миниатюра перестаёт находиться — отдельной сверки не нужно.
    const key = `${filename}|${size}|${thumbOnly}|${stat.mtimeMs}|${stat.size}`;
    const hit = this.thumbs.get(key);
    if (hit) { this.thumbs.delete(key); this.thumbs.set(key, hit); return hit.value; }
    const running = this.flying.get(key);
    if (running) return running;
    const work = (async () => {
      const raw = await this.host.call('thumbnail', { path: filename, size, thumbOnly }, 20_000);
      const url = raw && pngUrl(raw.base64);
      const width = Number(raw?.width), height = Number(raw?.height);
      const value = url && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? { dataUrl: url, width, height, thumbnail: raw.thumbnail === true } : null;
      const bytes = value ? value.dataUrl.length : 64;
      this.thumbs.set(key, { value, bytes }); this.thumbBytes += bytes;
      for (const [oldKey, old] of this.thumbs) { if (this.thumbBytes <= THUMB_CACHE_BYTES) break; this.thumbs.delete(oldKey); this.thumbBytes -= old.bytes; }
      return value;
    })().finally(() => this.flying.delete(key));
    this.flying.set(key, work);
    return work;
  }

  async placeIcon(place: string, size: number): Promise<WindowsThumbnail | null> {
    const paths: Record<string, string> = {
      home: '::{679f85cb-0220-4080-b29b-5540cc05aab6}',
      computer: '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}',
      network: '::{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}',
    };
    if (!Object.hasOwn(paths, place) || !Number.isInteger(size) || size < 16 || size > 512) throw new WindowsFilesError('INVALID_REQUEST', 'Некорректный значок места.');
    if (!this.windows) return null;
    const raw = await this.host.call('thumbnail', { path: paths[place], size, thumbOnly: false }, 20_000);
    const url = raw && pngUrl(raw.base64);
    return url && Number.isInteger(raw.width) && Number.isInteger(raw.height) && raw.width > 0 && raw.height > 0 ? { dataUrl: url, width: raw.width, height: raw.height, thumbnail: false } : null;
  }
  async openWithList(owner: number, ref: WindowsFileRef): Promise<WindowsOpenWithHandler[]> {
    if (!this.windows) throw new WindowsFilesError('NOT_WINDOWS', NOT_WINDOWS);
    const filename = await this.service.nativePath(ref);
    if (!(await fs.stat(filename)).isFile()) return [];
    const rows = await this.host.call('open-with-list', { path: filename });
    const clean = (Array.isArray(rows) ? rows.slice(0, 64) : []).filter(row => text(row?.name, 2048) && text(row?.title, 255));
    // Настоящее имя программы (оно может содержать путь к exe) остаётся в main; интерфейс получает случайный номер.
    const ids = this.ids.replace(owner, 'openwith', clean.map(row => `${filename}\n${row.name}`));
    return clean.map((row, index) => ({ id: ids[index], name: row.title, recommended: row.recommended === true, icon: pngUrl(row.icon) }));
  }
  async openWith(owner: number, ref: WindowsFileRef, handlerId: unknown) {
    if (!this.windows) throw new WindowsFilesError('NOT_WINDOWS', NOT_WINDOWS);
    const filename = await this.service.nativePath(ref);
    const stored = this.ids.get(owner, 'openwith', handlerId);
    const [forFile, name] = stored ? stored.split('\n') : [];
    // Идентификатор выдан для другого файла — значит, список устарел.
    if (!stored || forFile !== filename) throw new WindowsFilesError('HANDLER_EXPIRED', 'Список программ устарел. Откройте меню «Открыть с помощью» снова.');
    await this.host.call('open-with', { path: filename, name });
    return { opened: true };
  }

  /** Классическое меню Windows для одного или нескольких объектов из одной папки. */
  async shellMenu(owner: number, refs: WindowsFileRef[], extended: boolean): Promise<WindowsShellMenu> {
    if (!this.windows) throw new WindowsFilesError('NOT_WINDOWS', NOT_WINDOWS);
    if (!Array.isArray(refs) || !refs.length || refs.length > 100) throw new WindowsFilesError('INVALID_REQUEST', 'Выберите от 1 до 100 объектов.');
    const paths = await Promise.all(refs.map(ref => this.service.nativePath(ref)));
    if (new Set(paths.map(item => path.dirname(item).toLowerCase())).size > 1) throw new WindowsFilesError('MENU_MIXED_FOLDERS', 'Классическое меню Windows открывается для объектов одной папки.');
    const menu = await this.host.call('menu-open', { paths, extended: extended === true }, 20_000);
    const token = text(menu?.token, 64);
    if (!token) throw new WindowsFilesError('NATIVE_HELPER_FAILED', 'Windows не построила меню.');
    const sanitize = (items: unknown, depth: number): WindowsShellMenuItem[] => (Array.isArray(items) ? items.slice(0, 200) : []).flatMap(item => {
      const label = text(item?.label, 255); const id = Number(item?.id);
      if (label === null || !Number.isInteger(id)) return [];
      const entry: WindowsShellMenuItem = { id, label, enabled: item.enabled === true, ...(item.separator === true ? { separator: true } : {}),
        ...(item.checked === true ? { checked: true } : {}), ...(typeof item.verb === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/u.test(item.verb) ? { verb: item.verb } : {}) };
      if (depth < 3 && Array.isArray(item.submenu)) entry.submenu = sanitize(item.submenu, depth + 1);
      return [entry];
    });
    return { token: this.ids.add(owner, 'menu', token), items: sanitize(menu.items, 0) };
  }
  async shellMenuInvoke(owner: number, token: unknown, commandId: unknown, label: unknown) {
    if (!this.windows) throw new WindowsFilesError('NOT_WINDOWS', NOT_WINDOWS);
    const hostToken = this.ids.get(owner, 'menu', token);
    if (!hostToken) throw new WindowsFilesError('NATIVE_MENU_EXPIRED', 'Меню устарело. Откройте его снова.');
    if (!Number.isInteger(commandId) || (commandId as number) < 0 || typeof label !== 'string' || label.length > 255) throw new WindowsFilesError('INVALID_REQUEST', 'Команда меню указана неверно.');
    await this.host.call('menu-invoke', { token: hostToken, id: commandId, label }, 60_000);
    this.ids.delete(owner, 'menu', token as string);
    return { invoked: true };
  }
  async shellMenuClose(owner: number, token: unknown) {
    if (!this.windows) return { closed: true };
    const hostToken = this.ids.get(owner, 'menu', token);
    if (hostToken) { this.ids.delete(owner, 'menu', token as string); await this.host.call('menu-close', {}).catch(() => undefined); }
    return { closed: true };
  }

  /** Корзина Windows. При отказе помощника список не падает ошибкой: интерфейс откроет системную корзину (openRecycleBin). */
  async recycleBin(owner: number): Promise<WindowsRecycleBin> {
    if (!this.windows) return { supported: false, items: [], message: NOT_WINDOWS };
    let rows: unknown;
    try { rows = await this.host.call('bin-list', {}, 30_000); }
    catch (error: any) {
      if (typeof error?.code === 'string' && error.code.startsWith('NATIVE_') || error?.code === 'NOT_WINDOWS') return { supported: false, items: [], message: 'Windows не показала содержимое корзины. Откройте корзину средствами Windows.', fallback: 'openRecycleBin' };
      throw error;
    }
    const clean = (Array.isArray(rows) ? rows.slice(0, 20_000) : []).filter(row => text(row?.key, 4096) && text(row?.name, 512));
    const ids = this.ids.replace(owner, 'bin', clean.map(row => row.key as string));
    const items: WindowsRecycleItem[] = clean.map((row, index) => {
      const time = typeof row.deletedAt === 'string' ? Date.parse(row.deletedAt) : NaN;
      // На части Windows (на CI — Server) имя элемента корзины приходит полным исходным путём,
      // а не именем файла, как в Проводнике: оставляем последнее звено
      const name = String(row.name).split(/[\\/]/u).filter(Boolean).pop() || String(row.name);
      return { id: ids[index], name, location: text(row.location, 4096) ?? '', deletedAt: Number.isFinite(time) ? new Date(time).toISOString() : null,
        size: typeof row.size === 'number' && Number.isSafeInteger(row.size) && row.size >= 0 ? row.size : null, kind: row.directory === true ? 'directory' : 'file' };
    });
    return { supported: true, items };
  }
  private binKeys(owner: number, ids: unknown): string[] {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000) throw new WindowsFilesError('INVALID_REQUEST', 'Выберите объекты корзины.');
    return ids.map(id => { const key = this.ids.get(owner, 'bin', id); if (!key) throw new WindowsFilesError('BIN_EXPIRED', 'Список корзины устарел. Обновите его.'); return key; });
  }
  async recycleBinRestore(owner: number, ids: unknown) {
    if (!this.windows) throw new WindowsFilesError('NOT_WINDOWS', NOT_WINDOWS);
    return this.host.call('bin-restore', { keys: this.binKeys(owner, ids) }, 120_000);
  }
  async recycleBinPurge(owner: number, ids: unknown) {
    if (!this.windows) throw new WindowsFilesError('NOT_WINDOWS', NOT_WINDOWS);
    return this.host.call('bin-purge', { keys: this.binKeys(owner, ids) }, 120_000);
  }
  async recycleBinEmpty() {
    if (!this.windows) throw new WindowsFilesError('NOT_WINDOWS', NOT_WINDOWS);
    return this.host.call('bin-empty', {}, 120_000);
  }
  /** Для отмены удаления: корзина не сообщает номер при удалении, поэтому ищется по исходному месту и времени. */
  async restoreFromTrash(info: { path: string; deletedAfter: number; size: number | null; name: string }): Promise<void> {
    if (!this.windows) throw new WindowsFilesError('UNDO_UNAVAILABLE', 'Возврат из корзины Windows возможен только в Windows.');
    await this.host.call('bin-restore-original', { path: info.path, deletedAfter: info.deletedAfter }, 60_000);
  }
}
