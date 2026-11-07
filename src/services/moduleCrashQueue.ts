import { newRequestId } from '../../feedback/contracts';
import { validCrashBatch, type ModuleCrashBatch } from '../../feedback/moduleCrashes';
import type { ModuleFailure } from '../../feedback/moduleContext';
import { call } from './moduleReleaseService';

interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
const KEY = 'flux.module-crashes.v1';

/** Пакет неизменен до расписки: оборванный ответ не удваивает счётчик. */
export class ModuleCrashQueue {
  private working: Promise<void> | null = null;
  constructor(private storage: StorageLike, private send: (batch: ModuleCrashBatch) => Promise<unknown>) {}
  private read(): ModuleCrashBatch[] {
    try { const v = JSON.parse(this.storage.getItem(KEY) || '[]'); return Array.isArray(v) ? v.filter(validCrashBatch) : []; } catch { return []; }
  }
  record(moduleId: string, version: string, kind: ModuleFailure) {
    const batch: ModuleCrashBatch = { id: newRequestId(), events: [{ moduleId, version, kind, count: 1 }] };
    if (!validCrashBatch(batch)) return;
    // Предел защищает диск при бесконечном сбое неисправной подпрограммы.
    this.storage.setItem(KEY, JSON.stringify([...this.read(), batch].slice(-2000)));
  }
  flush(): Promise<void> {
    if (this.working) return this.working;
    this.working = this.drain().finally(() => { this.working = null; });
    return this.working;
  }
  private async drain() {
    for (const batch of this.read().slice(0, 30)) {
      await this.send(batch);
      // Во время запроса мог произойти новый сбой: перечитываем перед удалением.
      this.storage.setItem(KEY, JSON.stringify(this.read().filter((b) => b.id !== batch.id)));
    }
  }
}
let queue: ModuleCrashQueue | null = null;
function ownQueue() { return queue ||= new ModuleCrashQueue(window.localStorage, (batch) => call('POST', '/crashes', batch)); }
export function recordModuleCrash(moduleId: string, version: string, kind: ModuleFailure): void {
  try { ownQueue().record(moduleId, version, kind); } catch { /* отказ диска не прерывает чужую работу */ }
  void flushModuleCrashes();
}
export async function flushModuleCrashes(): Promise<void> {
  try { await ownQueue().flush(); } catch { /* пакет остаётся на компьютере до связи */ }
}
