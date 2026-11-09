/**
 * Сохранение вложения чата в системную папку «Загрузки».
 *
 * Отдельно от electron/chatDownload.ts, чтобы логику проверял обычный скрипт
 * без Electron (scripts/test-chat-download.ts): здесь нет ни одного импорта
 * оболочки, а скачивание и папка подаются снаружи.
 *
 * Имя файла приходит из чата, то есть от другого человека: безопасным его
 * делает safeFileName (без «../», зарезервированных имён Windows и запрещённых
 * знаков). Занятое имя не затирается — файл получает «(2)», «(3)». Создаётся
 * файл с флагом «только новый» (wx), поэтому два одновременных сохранения
 * одного имени не могут выбрать один и тот же путь.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { safeFileName, uniqueFileName } from './downloadPath';

export type SaveResult = { ok: true; path: string; name: string; bytes: number } | { ok: false; error: string };

/**
 * Адрес вложения, который главный процесс согласен скачать: только /chat_files/
 * на сервере Flux (origin задаёт оболочка, а не окно). Иначе окно могло бы
 * заставить главный процесс сходить на чужой адрес.
 */
export function isChatFileUrl(raw: string, serverOrigin: string): boolean {
  try {
    const u = new URL(String(raw || ''));
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === new URL(serverOrigin).origin && /^\/chat_files\/[^/]+\/[^/]+$/.test(u.pathname);
  } catch { return false; }
}

/** Ключ пути для сравнения: на Windows регистр имени не различается */
export function pathKey(target: string, platform: string = process.platform): string {
  const p = path.resolve(String(target || ''));
  return platform === 'win32' ? p.toLowerCase() : p;
}

/** Пути, которые этот процесс сам выдал при сохранении: показывать в папке можно только их */
export function createSavedPaths(platform: string = process.platform) {
  const keys = new Set<string>();
  return {
    remember: (target: string) => { keys.add(pathKey(target, platform)); },
    has: (target: string) => keys.has(pathKey(target, platform)),
  };
}

/** Путь лежит внутри папки (или это она сама) */
export function isInside(root: string, target: string, platform: string = process.platform): boolean {
  const r = pathKey(root, platform);
  const p = pathKey(target, platform);
  return p === r || p.startsWith(r + path.sep);
}

/** Создать новый файл с неповторяющимся именем; вернуть дескриптор, имя и путь */
async function createUnique(dir: string, wanted: string): Promise<{ handle: fs.promises.FileHandle; name: string; full: string }> {
  let taken: string[] = [];
  try { taken = await fs.promises.readdir(dir); } catch { /* папки не было — mkdir выше её создал */ }
  let name = uniqueFileName(wanted, taken);
  for (let attempt = 0; attempt < 100; attempt++) {
    const full = path.join(dir, name);
    try {
      return { handle: await fs.promises.open(full, 'wx'), name, full };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      // Имя заняли между чтением папки и созданием: считаем занятым и берём следующее
      taken = [...taken, name];
      name = uniqueFileName(wanted, taken);
    }
  }
  throw new Error('Не удалось подобрать свободное имя файла');
}

export interface SaveOptions {
  dir: string;
  name: string;
  /** Открыть вложение: тот, кто скачивает (в программе — сетевой стек Chromium) */
  open: () => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }>;
}

export async function saveToDownloads(options: SaveOptions): Promise<SaveResult> {
  let created: { handle: fs.promises.FileHandle; name: string; full: string } | null = null;
  try {
    await fs.promises.mkdir(options.dir, { recursive: true });
    const response = await options.open();
    if (!response.ok || !response.body) {
      return { ok: false, error: response.status === 404 ? 'Файл не найден на сервере: возможно, его удалили.' : `Сервер не отдал файл (код ${response.status}).` };
    }
    created = await createUnique(options.dir, safeFileName(options.name));
    const out = created.handle.createWriteStream();
    let bytes = 0;
    const source = Readable.fromWeb(response.body as any);
    source.on('data', (chunk: Buffer) => { bytes += chunk.length; });
    await pipeline(source, out);
    return { ok: true, path: created.full, name: created.name, bytes };
  } catch (error: any) {
    // Недокачанный файл не оставляем: он выглядел бы готовым
    if (created) { try { await created.handle.close(); } catch { /* уже закрыт потоком */ } await fs.promises.rm(created.full, { force: true }).catch(() => {}); }
    const code = String(error?.code || '');
    const reason = code === 'ENOSPC' ? 'на диске нет места' : code === 'EACCES' || code === 'EPERM' ? 'нет прав на запись в папку «Загрузки»' : String(error?.message || error);
    return { ok: false, error: `Не удалось сохранить файл: ${reason}.` };
  }
}

export interface ChatDownloadDeps<E> {
  /** Основное окно Flux: trustedAuthSender в оболочке */
  trusted: (event: E) => boolean;
  serverOrigin: string;
  downloadsDir: () => string;
  fetch: (url: string) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }>;
  showItem: (target: string) => void;
}

/**
 * Обработчики двух каналов. Вынесены сюда из electron/chatDownload.ts, чтобы
 * проверку отправителя, адреса и выданных путей можно было проверить без Electron.
 */
export function createChatDownloadHandlers<E>(deps: ChatDownloadDeps<E>) {
  const saved = createSavedPaths();
  return {
    async save(event: E, url: string, name: string): Promise<SaveResult> {
      if (!deps.trusted(event)) return { ok: false, error: 'Сохранение доступно только основному окну Flux.' };
      if (!isChatFileUrl(url, deps.serverOrigin)) return { ok: false, error: 'Это не вложение чата.' };
      const result = await saveToDownloads({ dir: deps.downloadsDir(), name: String(name || 'Файл'), open: () => deps.fetch(url) });
      if (result.ok) saved.remember(result.path);
      return result;
    },
    reveal(event: E, target: string): { ok: boolean; error?: string } {
      if (!deps.trusted(event)) return { ok: false, error: 'Доступно только основному окну Flux.' };
      if (!saved.has(String(target || ''))) return { ok: false, error: 'Показать можно только файл, сохранённый из чата в этом сеансе.' };
      deps.showItem(String(target));
      return { ok: true };
    },
  };
}
