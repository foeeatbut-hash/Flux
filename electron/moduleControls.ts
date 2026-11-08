/**
 * Итог контрольных примеров выпуска на ЭТОМ компьютере.
 *
 * Зачем в главном процессе: окно прогоняет примеры (там живут очередь и
 * движки), но решение «запускать ли выпуск» хранится и применяется здесь —
 * сам модуль до главного процесса дотянуться не может, а неудачный итог
 * закрывает выдачу кода выпуска (runtime.js, logic.*) протоколом. Итог
 * привязан к хешу подписи выпуска и к версии Electron: другой выпуск или
 * другой движок проверяются заново.
 *
 * Состояние ограничено: хранится не больше MAX записей, старые уходят.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ipcMain } from 'electron';
import { sha256Hex } from '../modules/trust/envelope';
import type { RunnableRelease } from '../modules/trust/verify';
import { trustedAuthSender } from './authStorage';

export type ControlsStatus = 'passed' | 'failed' | 'unknown';
export const CONTROLS_MAX = 500;

export class ModuleControls {
  private results = new Map<string, { ok: boolean; at: number }>();
  constructor(private file: string, private engine: string, private now: () => number = Date.now) {}

  private key(release: RunnableRelease) { return `${sha256Hex(release.signature)}|${this.engine}`; }

  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved && typeof saved === 'object') for (const [k, v] of Object.entries(saved as Record<string, any>)) {
        if (/^[0-9a-f]{64}\|[\w.\-+]{1,40}$/.test(k) && typeof v?.ok === 'boolean' && Number.isSafeInteger(v.at)) this.results.set(k, { ok: v.ok, at: v.at });
      }
    } catch { /* первого запуска ещё не было */ }
  }

  status(release: RunnableRelease): ControlsStatus {
    const found = this.results.get(this.key(release));
    return found ? (found.ok ? 'passed' : 'failed') : 'unknown';
  }

  /** Подпрограмме без контрольных примеров (TypeScript) проверять нечего — запуск не ждёт итога */
  required(release: RunnableRelease) { return release.manifest.language === 'python' || release.manifest.language === 'wasm'; }
  blocked(release: RunnableRelease) { return this.required(release) && this.status(release) === 'failed'; }

  async record(release: RunnableRelease, ok: boolean) {
    this.results.set(this.key(release), { ok, at: this.now() });
    for (const k of [...this.results.keys()].slice(0, Math.max(0, this.results.size - CONTROLS_MAX))) this.results.delete(k);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.results)));
    await fs.rename(tmp, this.file);
  }
}

export function registerModuleControlsIpc(controls: ModuleControls, runnable: () => Map<string, RunnableRelease>, ready: Promise<unknown>,
  trusted: (event: Electron.IpcMainInvokeEvent) => boolean = trustedAuthSender) {
  const refuse = { ok: false, error: 'Доступно только окну Flux.' };
  ipcMain.handle('modules:controls', async (event, data: any) => {
    if (!trusted(event)) return refuse;
    await ready;
    const release = runnable().get(String(data?.moduleId || ''));
    if (!release) return { ok: false, error: 'Выпуск не найден среди проверенных.' };
    return { ok: true, version: release.claim.version, required: controls.required(release), status: controls.status(release) };
  });
  ipcMain.handle('modules:controls-result', async (event, data: any) => {
    if (!trusted(event)) return refuse;
    await ready;
    const release = runnable().get(String(data?.moduleId || ''));
    // Итог принимается только для того выпуска, который сейчас запускается: чужую версию отметить нельзя
    if (!release || release.claim.version !== String(data?.version || '') || typeof data?.ok !== 'boolean') return { ok: false, error: 'Итог не относится к запущенному выпуску.' };
    await controls.record(release, data.ok);
    return { ok: true, status: controls.status(release) };
  });
}
