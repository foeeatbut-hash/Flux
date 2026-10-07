import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WindowsFilesError } from './paths';

// Вид папки, набор вкладок и тому подобное — настройки оформления, а не
// данные проекта. Хранилище нарочно скромное: ограничения не дают окну
// заполнить userData мусором, а старое вытесняется само.
const MAX_KEYS = 4000;
const MAX_KEY_LENGTH = 300;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const FILE = 'windows-files-view-state.json';

interface Stored { version: 1; entries: Record<string, { at: number; json: string }> }

export class ViewStateStore {
  private data: Stored = { version: 1, entries: {} };
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private filename: string) {}
  static async load(userData: string): Promise<ViewStateStore> {
    const store = new ViewStateStore(path.join(userData, FILE));
    try {
      const parsed = JSON.parse(await fs.readFile(store.filename, 'utf8'));
      if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === 'object') store.data = parsed;
    } catch (error: any) {
      // Повреждённый файл вида не стоит отказа проводника: вид просто начнётся заново,
      // а испорченный файл остаётся рядом для разбора.
      if (error.code !== 'ENOENT') await fs.rename(store.filename, `${store.filename}.broken-${Date.now()}`).catch(() => undefined);
    }
    return store;
  }
  private static key(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > MAX_KEY_LENGTH || /[\u0000-\u001f]/u.test(value)) throw new WindowsFilesError('INVALID_REQUEST', 'Недопустимый ключ вида.');
    return value;
  }
  get(keys: unknown): Record<string, unknown> {
    if (!Array.isArray(keys) || keys.length > 200) throw new WindowsFilesError('INVALID_REQUEST', 'Укажите до 200 ключей вида.');
    const result: Record<string, unknown> = {};
    for (const raw of keys) {
      const key = ViewStateStore.key(raw); const item = this.data.entries[key];
      if (item) { try { result[key] = JSON.parse(item.json); } catch { /* повреждённая запись равна отсутствующей */ } }
    }
    return result;
  }
  async set(entries: unknown): Promise<{ stored: number }> {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new WindowsFilesError('INVALID_REQUEST', 'Передайте значения вида объектом.');
    const pairs = Object.entries(entries as Record<string, unknown>);
    if (pairs.length > 50) throw new WindowsFilesError('INVALID_REQUEST', 'За один раз можно записать не больше 50 значений вида.');
    const prepared = pairs.map(([rawKey, value]) => {
      const key = ViewStateStore.key(rawKey);
      const json = JSON.stringify(value ?? null);
      if (json === undefined || Buffer.byteLength(json) > MAX_VALUE_BYTES) throw new WindowsFilesError('VIEW_STATE_TOO_LARGE', 'Значение вида слишком велико: предел 64 КБ на ключ.');
      return { key, json };
    });
    const now = Date.now();
    for (const { key, json } of prepared) this.data.entries[key] = { at: now, json };
    this.trim();
    await this.save();
    return { stored: prepared.length };
  }
  async delete(keys: unknown): Promise<{ deleted: number }> {
    if (!Array.isArray(keys) || keys.length > 200) throw new WindowsFilesError('INVALID_REQUEST', 'Укажите до 200 ключей вида.');
    let deleted = 0;
    for (const raw of keys) { const key = ViewStateStore.key(raw); if (key in this.data.entries) { delete this.data.entries[key]; deleted++; } }
    if (deleted) await this.save();
    return { deleted };
  }
  /** Вытесняются самые давние записи: свежий вид папки важнее забытого. */
  private trim() {
    const items = Object.entries(this.data.entries).sort((a, b) => b[1].at - a[1].at);
    let total = 0; const keep: typeof items = [];
    for (const item of items) {
      const size = Buffer.byteLength(item[0]) + Buffer.byteLength(item[1].json);
      if (keep.length >= MAX_KEYS || total + size > MAX_TOTAL_BYTES) continue;
      total += size; keep.push(item);
    }
    if (keep.length !== items.length) this.data.entries = Object.fromEntries(keep);
  }
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    const operation = this.queue.then(async () => {
      const temp = `${this.filename}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, snapshot, { flag: 'wx', mode: 0o600 }); await fs.rename(temp, this.filename); }
      finally { await fs.unlink(temp).catch(() => undefined); }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
