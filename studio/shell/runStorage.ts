/**
 * Хранилище самостоятельной программы в запуске Studio, главный процесс (область `studio`).
 *
 * Те же правила, что у Flux (modules/storage): на диск попадает состояние ТОЛЬКО самостоятельной программы (ничего не читает
 * во Flux, открывается из «Пуска»), предел 1 МиБ проверяет этот процесс, а не окно, запись атомарная, битый файл откладывается
 * рядом. Программа, читающая данные Flux, остаётся с состоянием в памяти окна, как раньше. Папка — `program-data` в данных
 * Studio, область `studio`: с областями `released` и `dev` Flux она не пересекается. Данные проектов сюда не попадают: тестовая
 * база лежит отдельно, а на диске оказывается только то, что программа сама положила в `flux.state`.
 *
 * Человек в пути один и тот же всегда: Studio — это компьютер разработчика, а не учётная запись во Flux, и состояние запуска не
 * должно пропадать от того, что разработчик вошёл под другим именем.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { clearStorage, readEnvelope, storageUsage, writeEnvelope, type StorageTarget, type WriteResult } from '../../modules/storage/disk';
import { STORAGE_IN_MEMORY_TEXT, isStandalone, storageFullText, storageUsageText } from '../../modules/storage/model';
import type { RunStorageInfo, RunStorageKeepReply, RunStorageLoadReply } from '../shared/runActions';
import { StudioFailure } from './api';
import type { RunContext } from './runConnections';

export const STUDIO_STORAGE_USER = 'studio';

export class RunStorage {
  private readonly root: string;
  constructor(private readonly deps: { dir: string; version: string; current: () => RunContext | null }) {
    this.root = path.join(deps.dir, 'program-data');
  }

  /** Цель — только у запущенной самостоятельной программы; у остальных диска нет */
  private target(): StorageTarget | null {
    const run = this.deps.current();
    if (!run || !isStandalone(run.manifest)) return null;
    return { root: this.root, userId: STUDIO_STORAGE_USER, programId: run.manifest.id, scope: 'studio' };
  }
  private requireRun() {
    if (!this.deps.current()) throw new StudioFailure('Программа не запущена.');
  }

  async info(): Promise<RunStorageInfo> {
    this.requireRun();
    const target = this.target();
    if (!target) return { standalone: false, bytes: null, text: STORAGE_IN_MEMORY_TEXT };
    const bytes = await storageUsage(fs, target).catch(() => null);
    return { standalone: true, bytes, text: bytes === null ? 'Хранилище: файл не читается' : storageUsageText(bytes) };
  }

  /** Состояние при запуске: у самостоятельной — с диска, у остальных — пустое (их состояние живёт в окне) */
  async load(): Promise<RunStorageLoadReply> {
    this.requireRun();
    const target = this.target();
    if (!target) return { standalone: false, state: {} };
    const read = await readEnvelope(fs, target).catch(() => ({ ok: false as const, code: 'FAILED' as const }));
    if (!read.ok) return { standalone: true, state: {}, line: 'Хранилище не прочитано: диск не отвечает; состояние живёт в окне до закрытия', failed: true };
    return { standalone: true, state: read.state, ...(read.broken ? { line: `Файл хранилища не распознан и отложен: ${path.basename(read.broken.kept)}; программа начала с пустого состояния` } : {}) };
  }

  async keep(state: unknown): Promise<RunStorageKeepReply> {
    this.requireRun();
    const target = this.target();
    if (!target) return { ok: true, stored: false };
    const wrote: WriteResult = await writeEnvelope(fs, target, { writtenBy: this.deps.version, state }).catch((): WriteResult => ({ ok: false, code: 'FAILED' }));
    if (wrote.ok) return { ok: true, stored: true, bytes: wrote.bytes, ...(wrote.broken ? { line: `Прежний файл хранилища не распознан и отложен: ${path.basename(wrote.broken.kept)}` } : {}) };
    const failed = wrote as Extract<WriteResult, { ok: false }>;
    if (failed.code === 'LIMIT') return { ok: false, code: 'LIMIT', line: storageFullText(failed.bytes ?? 0) };
    return { ok: false, code: 'FAILED', line: 'Хранилище не записано: ошибка диска; состояние живёт в окне до закрытия' };
  }

  async clear(): Promise<{ removed: boolean }> {
    this.requireRun();
    const target = this.target();
    if (!target) return { removed: false };
    const cleared = await clearStorage(fs, target);
    if (!cleared.ok) throw new StudioFailure('Хранилище не очищено: ошибка диска.');
    return { removed: cleared.removed };
  }
}
