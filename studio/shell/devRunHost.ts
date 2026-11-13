/**
 * «Запустить во Flux», главный процесс Studio: жизнь пакета в папке обмена.
 *
 * Запуск кладёт три файла (studio/shared/devRun.ts) и включает таймер продления аренды раз в DEV_LEASE_RENEW_MS. Папка убирается:
 * по «Убрать», при закрытии проекта, при выходе из Studio и при выходе человека из учётной записи Studio. Если Studio вылетела,
 * аренда протухает сама (DEV_LEASE_TTL_MS), а осиротевшая папка убирается при следующем старте (`sweep`).
 * Ничего, кроме своей папки `dev-run/<moduleId>/`, в данных Flux не трогается.
 */
import os from 'node:os';
import { DEV_LEASE_RENEW_MS } from '../../modules/trust/devRun';
import type { DeveloperKeyring } from '../shared/keyring';
import { DevRunFolder, DevRunRefused, findFluxDataDir, prepareDevRun, renewLease, sweepOrphans, type DevRunInput, type DevRunPrepared } from '../shared/devRun';

export interface DevRunState {
  running: boolean; moduleId: string; version: string;
  /** Когда собран запущенный пакет, мс */
  builtAt: number;
  /** Почему аренда не продлевается (папку Flux убрали или закрыли на запись); пусто — всё в порядке */
  problem: string;
}
const IDLE: DevRunState = { running: false, moduleId: '', version: '', builtAt: 0, problem: '' };

interface Active { folder: DevRunFolder; prepared: DevRunPrepared; timer: ReturnType<typeof setInterval>; problem: string }
export type DevRunStartInput = Omit<DevRunInput, 'keyring' | 'now'>;

export interface DevRunHostDeps {
  keyring: DeveloperKeyring;
  /** Папка данных Flux; по умолчанию — по правилам Flux (APPDATA и запасная папка). Бросает DevRunRefused, если Flux не найден */
  dataDir?: () => string;
  now?: () => number;
  renewMs?: number;
}

export class DevRunHost {
  private active: Active | null = null;
  constructor(private readonly deps: DevRunHostDeps) {}

  private dir(): string {
    return this.deps.dataDir ? this.deps.dataDir() : findFluxDataDir({ env: process.env, platform: process.platform, home: os.homedir() });
  }

  /** Папка Flux нужна до сборки: нет смысла собирать то, что некуда положить */
  checkFlux(): void { this.dir(); }

  /** Один запуск за раз: другая программа или новая сборка той же заменяет прежнюю (старая папка убирается) */
  start(input: DevRunStartInput): DevRunState {
    const dataDir = this.dir();
    const now = this.deps.now ?? Date.now;
    const prepared = prepareDevRun({ ...input, keyring: this.deps.keyring, now: now() });
    const folder = new DevRunFolder(dataDir, input.moduleId);
    const previous = this.active;
    // Прежний запуск другой программы убирается целиком; та же программа просто получает новый пакет
    if (previous && previous.folder.moduleId !== input.moduleId) this.stop();
    folder.write(prepared);
    if (previous && previous.folder.moduleId === input.moduleId) clearInterval(previous.timer);
    const timer = setInterval(() => this.renew(), this.deps.renewMs ?? DEV_LEASE_RENEW_MS);
    timer.unref?.();
    this.active = { folder, prepared, timer, problem: '' };
    return this.state();
  }

  private renew(): void {
    const a = this.active;
    if (!a) return;
    try {
      a.folder.renew(renewLease(this.deps.keyring, a.prepared.claim, (this.deps.now ?? Date.now)()));
      a.problem = '';
    } catch (error) {
      // Не продлилось (Flux удалил папку, диск закрыт на запись): запуск во Flux остановится сам, окно скажет об этом
      a.problem = error instanceof DevRunRefused ? error.message : 'Аренда не продлена.';
    }
  }

  /** «Убрать», закрытие проекта, выход: идемпотентно */
  stop(): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    clearInterval(a.timer);
    try { a.folder.remove(); } catch { /* папку держит Flux или антивирус: аренда протухнет за DEV_LEASE_TTL_MS */ }
  }

  state(): DevRunState {
    const a = this.active;
    return a ? { running: true, moduleId: a.folder.moduleId, version: a.prepared.claim.version, builtAt: a.prepared.builtAt, problem: a.problem } : IDLE;
  }

  /** Старт Studio: прибрать папки прежнего запуска, не дожившего до «Убрать». Тихо: Flux может быть не установлен */
  sweep(): string[] {
    try { return sweepOrphans(this.dir()); } catch { return []; }
  }

  dispose(): void { this.stop(); }
}
