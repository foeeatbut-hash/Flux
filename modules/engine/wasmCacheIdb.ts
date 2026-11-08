/**
 * Кэш скомпилированных WebAssembly на диске: IndexedDB окна Flux.
 *
 * Зачем IndexedDB: Chromium кладёт в неё не байты .wasm, а готовый
 * `WebAssembly.Module` вместе с машинным кодом, поэтому повторный запуск
 * выпуска не компилирует ничего. Ключ — SHA-256 байт .wasm из подписанного
 * пакета (его выдаёт главный процесс после проверки подписи); значение с
 * другим содержимым под этим ключом оказаться не может, а окно Flux, а не
 * модуль, — единственный, кто сюда пишет (у модуля непрозрачный источник и
 * нет IndexedDB).
 *
 * Предел: MAX записей, старейшие по последнему использованию уходят первыми, и
 * `keepOnly` убирает выпуски, которых больше нет в кэше проверенных выпусков
 * (electron/moduleCache.ts держит KEEP_VERSIONS версий на подпрограмму).
 * Любая ошибка диска — это «в кэше нет», а не сбой расчёта.
 */
import type { CompileCache } from './wasm';

const STORE = 'compiled';
export const WASM_CACHE_MAX = 32;

interface Row { key: string; module: WebAssembly.Module; usedAt: number }

export class IdbCompileCache implements CompileCache {
  private opened: Promise<IDBDatabase> | null = null;
  constructor(private name = 'flux-module-wasm', private max = WASM_CACHE_MAX) {}

  private open(): Promise<IDBDatabase> {
    return this.opened ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { this.opened = null; reject(request.error); };
    });
  }
  private async run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async get(key: string): Promise<WebAssembly.Module | undefined> {
    try {
      const row = await this.run<Row | undefined>('readonly', store => store.get(key));
      if (!row?.module) return undefined;
      // Отметка использования не ждёт ответа: расчёт важнее порядка уборки
      void this.run('readwrite', store => store.put({ ...row, usedAt: Date.now() })).catch(() => undefined);
      return row.module;
    } catch { return undefined; }
  }

  async put(key: string, module: WebAssembly.Module): Promise<void> {
    try {
      await this.run('readwrite', store => store.put({ key, module, usedAt: Date.now() } satisfies Row));
      const rows = await this.run<Row[]>('readonly', store => store.getAll());
      const stale = rows.sort((a, b) => b.usedAt - a.usedAt).slice(this.max);
      for (const row of stale) await this.run('readwrite', store => store.delete(row.key));
    } catch { /* диск недоступен — модуль просто компилируется заново */ }
  }

  async keepOnly(keys: ReadonlySet<string>): Promise<void> {
    try {
      const all = await this.run<IDBValidKey[]>('readonly', store => store.getAllKeys());
      for (const key of all) if (!keys.has(String(key))) await this.run('readwrite', store => store.delete(key));
    } catch { /* уборка повторится при следующем запуске */ }
  }

  async count(): Promise<number> {
    try { return await this.run<number>('readonly', store => store.count()); } catch { return 0; }
  }
}
