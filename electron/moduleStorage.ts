/**
 * Хранилище состояния самостоятельной программы на диске: главный процесс Flux.
 *
 * Окно программы зовёт `state-load` / `state-keep` через мост, окно Flux переправляет вызов сюда. Здесь решается всё, что
 * нельзя доверить окну: самостоятельная ли программа (по проверенному манифесту, а не по слову окна), чья это папка (человек —
 * из главного процесса, а не из запроса), какая область (выпуск или сборка из разработки), предел 1 МиБ и сам файл
 * (modules/storage/disk.ts: атомарная запись, битый файл откладывается). Программа, читающая данные Flux, на диск не попадает:
 * ей отвечается «хранилища нет», и окно держит её состояние в памяти, как раньше.
 *
 * Порядок сохранений из разных окон одной программы держит очередь у самого файла (modules/storage/disk.ts).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModuleManifest } from '../modules/contract';
import { PROGRAM_ID } from '../modules/programs/model';
import { clearStorage, readEnvelope, storageUsage, writeEnvelope, type StorageFs, type StorageTarget } from '../modules/storage/disk';
import { isStandalone, storageFullText, type StorageScope } from '../modules/storage/model';
import type { ModuleJournal } from './moduleJournal';

/** Какую программу и в какой области сейчас запускает человек: ответ главного процесса по проверенному выпуску или пакету разработки */
export type StorageLocator = (moduleId: string, version: string) => Promise<{ manifest: ModuleManifest; version: string; scope: StorageScope } | null>;

export interface ModuleStorageHost {
  /** `<данные приложения>/program-data` */
  root: string;
  userId: () => string;
  locate: StorageLocator;
  journal: ModuleJournal;
  /** Версия Flux: пишется в файл для диагностики */
  writtenBy: () => string;
  fs?: StorageFs;
  now?: () => Date;
}

export type StorageLoadReply = { ok: true; disk: false } | { ok: true; disk: true; state: Record<string, unknown>; bytes: number } | { ok: false; code: 'FAILED' };
export type StorageKeepReply = { ok: true; disk: boolean; bytes?: number } | { ok: false; code: 'LIMIT'; text: string; bytes: number } | { ok: false; code: 'FAILED' };

export class ModuleStorage {
  private fs: StorageFs;
  constructor(private host: ModuleStorageHost) { this.fs = host.fs ?? (fs as unknown as StorageFs); }

  private target(userId: string, moduleId: string, scope: StorageScope): StorageTarget { return { root: this.host.root, userId, programId: moduleId, scope }; }

  private note(moduleId: string, version: string, level: 'info' | 'warn' | 'error', event: string, detail: string, outcome: string) {
    this.host.journal.add({ moduleId, version, userId: this.host.userId(), category: 'log', level, event, detail, outcome, ms: 0, bytesIn: 0, bytesOut: 0 }, 'main');
  }

  async load(moduleId: string, version: string): Promise<StorageLoadReply> {
    const userId = this.host.userId();
    const found = await this.host.locate(moduleId, version);
    if (!found || !isStandalone(found.manifest)) return { ok: true, disk: false };
    if (!userId) return { ok: false, code: 'FAILED' };
    const target = this.target(userId, found.manifest.id, found.scope);
    const result = await readEnvelope(this.fs, target, { now: this.host.now?.() });
    if (!result.ok) { this.note(found.manifest.id, found.version, 'warn', 'storage-failed', 'Хранилище программы не прочитано', 'failed'); return { ok: false, code: 'FAILED' }; }
    // Битый файл не затёрт, а отложен рядом: об этом знает журнал программ (владелец и разработчик увидят, что данные не пропали)
    if (result.broken) this.note(found.manifest.id, found.version, 'warn', 'storage-broken', `Файл хранилища повреждён и отложен: ${result.broken.kept}`, 'broken');
    return { ok: true, disk: true, state: result.state, bytes: result.bytes };
  }

  async keep(moduleId: string, version: string, state: unknown): Promise<StorageKeepReply> {
    const userId = this.host.userId();
    const found = await this.host.locate(moduleId, version);
    if (!found || !isStandalone(found.manifest)) return { ok: true, disk: false };
    if (!userId) return { ok: false, code: 'FAILED' };
    const target = this.target(userId, found.manifest.id, found.scope);
    const result = await writeEnvelope(this.fs, target, { writtenBy: this.host.writtenBy(), state, now: this.host.now?.() });
    if (result.ok) {
      if (result.broken) this.note(found.manifest.id, found.version, 'warn', 'storage-broken', `Файл хранилища повреждён и отложен: ${result.broken.kept}`, 'broken');
      return { ok: true, disk: true, bytes: result.bytes };
    }
    if (result.ok === false && result.code === 'LIMIT') {
      const text = storageFullText(result.bytes ?? 0);
      this.note(found.manifest.id, found.version, 'warn', 'storage-full', text, 'limit');
      return { ok: false, code: 'LIMIT', text, bytes: result.bytes ?? 0 };
    }
    // В журнал уходит только код ошибки диска: текст ошибки содержит путь к папке человека
    const code = (result.ok === false && result.reason ? result.reason.split(':')[0] : '').slice(0, 20);
    this.note(found.manifest.id, found.version, 'warn', 'storage-failed', `Хранилище программы не записано${code ? ` (${code})` : ''}`, 'failed');
    return { ok: false, code: 'FAILED' };
  }

  /**
   * Удаление области по точному пути `<человек>/<программа>/<область>` (modules/storage/disk.ts). Идентификатор проверен по образцу
   * программы ещё здесь, чтобы негодное не дошло и до сборки пути. Звать только по явному действию человека: удаление программы в
   * Store и «Очистить хранилище» у сборки из разработки; ни вход, ни обновление списка, ни отзыв выпуска сюда не ведут.
   */
  async clear(moduleId: string, scope: StorageScope): Promise<{ ok: true; removed: boolean } | { ok: false; code: 'FAILED' }> {
    const userId = this.host.userId();
    if (!userId || !PROGRAM_ID.test(moduleId)) return { ok: false, code: 'FAILED' };
    const target = this.target(userId, moduleId, scope);
    return clearStorage(this.fs, target).catch(() => ({ ok: false as const, code: 'FAILED' as const }));
  }

  /** Сколько занято в области; `null` — файл негоден или диск не отвечает */
  async usage(moduleId: string, scope: StorageScope): Promise<number | null> {
    const userId = this.host.userId();
    if (!userId || !PROGRAM_ID.test(moduleId)) return null;
    const target = this.target(userId, moduleId, scope);
    return storageUsage(this.fs, target).catch(() => null);
  }
}

export const storageRoot = (userData: string) => path.join(userData, 'program-data');
