/**
 * Обращение программы к другой программе (`flux.programs.call`) — главный процесс.
 *
 * Расчёт метода идёт в окне Flux тем же движком, что `compute` (Python, WebAssembly, а у TypeScript — собранный `build/logic.js` в изолированном хосте), поэтому вызов делится на два шага:
 * `begin` — ВСЕ проверки и место в очереди пределов, `end` — итог и журнал. Решает только этот файл по проверенным
 * выпускам (подпись владельца, кэш), а не окно и не слова программы:
 * 1. вызывающая — установленная, проверенная; в её подписанном манифесте есть разрешение `program` на этот идентификатор;
 * 2. вызова самой себя и вложенного вызова нет: пока метод программы исполняется для другой, она сама ничего не вызывает;
 * 3. пределы на вызывающую: 4 одновременно и 20 в секунду, данные ≤ 256 КиБ;
 * 4. вызываемая — ТА ВЕРСИЯ, что запускается у этого человека сейчас (установлена, канал, отзыв и откат, контрольные примеры),
 *    и объявляет метод в `exports`;
 * 5. журнал у обеих: кто, метод, длительность, объём, итог — без содержимого.
 * У метода нет ни подключений, ни сети, ни чтения данных Flux — только расчёт, поэтому обращение не обходит чужих разрешений.
 */
import { hasProgramPermission } from '../modules/permissions/registry';
import { EXPORT_METHOD, PROGRAM_ERROR_CODES, PROGRAM_ID, PROGRAM_LIMITS, exportsOf, type ProgramCallErrorCode } from '../modules/programs/model';
import { languageOf, type ModuleLanguage } from '../modules/engine/types';
import type { ModuleManifest } from '../modules/contract';
import type { ModuleJournal } from './moduleJournal';
import type { VerifiedModule } from './moduleConnections';
import type { RunnableRelease } from '../modules/trust/verify';

export interface ProgramBeginRequest { moduleId: string; version: string; call: { program?: unknown; method?: unknown; bytes?: unknown } }
export type ProgramBeginReply =
  | { ok: true; ticket: string; program: string; version: string; language: ModuleLanguage; manifest: ModuleManifest }
  | { ok: false; code: ProgramCallErrorCode };
export interface ProgramEndRequest { ticket: string; outcome: string; bytesOut?: number }
export interface ProgramCallDeps {
  /** Проверенный выпуск вызывающей программы (как у подключений) */
  resolve: (moduleId: string, version: string) => Promise<VerifiedModule | null>;
  /** Вызываемая: выпуск, который у этого человека запускается СЕЙЧАС; null — не установлена, не допущена, отозвана или не прошла контрольные примеры */
  current: (moduleId: string) => Promise<VerifiedModule | null>;
  userId: () => string;
  journal: ModuleJournal;
  now?: () => number;
}

/**
 * Выпуск вызываемой программы, который запускается у этого человека сейчас: выбранная им версия или ближайшая проверенная ниже
 * (`ModuleCache.resolve` — канал, отзыв, откат владельца), программа установлена, контрольные примеры на этом компьютере не провалены.
 */
export function currentRelease(runnable: ReadonlyMap<string, RunnableRelease>, installed: Readonly<Record<string, unknown>>, blocked: (release: RunnableRelease) => boolean, moduleId: string): VerifiedModule | null {
  const release = installed[moduleId] ? runnable.get(moduleId) : undefined;
  return release && !blocked(release) ? { manifest: release.manifest, version: release.claim.version, author: release.claim.author, verifiedAt: release.claim.iat } : null;
}

interface Slot { windowAt: number; calls: number; inFlight: number }
interface Pending { caller: string; callerVersion: string; callee: string; calleeVersion: string; method: string; bytesIn: number; started: number; user: string }

const OUTCOME: Record<ProgramCallErrorCode, string> = { NOT_ALLOWED: 'denied', NOT_INSTALLED: 'not-installed', NO_METHOD: 'no-method', LIMIT: 'limit', TIMEOUT: 'timeout', FAILED: 'failed' };

export class ModuleProgramCalls {
  private slots = new Map<string, Slot>();
  private pending = new Map<string, Pending>();
  /** Сколько методов программы исполняется сейчас (для других): пока так, сама она вызовов не делает */
  private serving = new Map<string, number>();
  private counter = 0;
  private now: () => number;
  constructor(private deps: ProgramCallDeps) { this.now = deps.now ?? Date.now; }

  private slot(moduleId: string): Slot {
    let s = this.slots.get(moduleId);
    if (!s) { s = { windowAt: 0, calls: 0, inFlight: 0 }; this.slots.set(moduleId, s); }
    return s;
  }
  private record(moduleId: string, version: string, user: string, event: 'call' | 'export', detail: string, outcome: string, ms: number, bytesIn: number, bytesOut: number) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(moduleId) || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) return;
    const level = outcome === 'ok' || outcome === 'denied' || outcome === 'not-installed' || outcome === 'no-method' ? 'info' : 'warn';
    // Вызов — в «Подключениях» вызывающей, исполнение метода — в «Расчётах» вызываемой: каждая видит своё, содержимого нет ни там, ни там
    this.deps.journal.add({ moduleId, version, userId: user, category: event === 'call' ? 'connection' : 'compute', level, event, detail, outcome, ms, bytesIn, bytesOut });
  }

  async begin(request: ProgramBeginRequest): Promise<ProgramBeginReply> {
    const user = this.deps.userId();
    const started = this.now();
    const program = request.call?.program, method = request.call?.method, bytes = request.call?.bytes;
    if (typeof program !== 'string' || !PROGRAM_ID.test(program) || typeof method !== 'string' || !EXPORT_METHOD.test(method) || !Number.isSafeInteger(bytes) || (bytes as number) < 0) return { ok: false, code: 'FAILED' };
    const caller = await this.deps.resolve(request.moduleId, request.version);
    // Неизвестная программа журнала не получает: запись нужна версии, которой нет
    if (!caller) return { ok: false, code: 'NOT_ALLOWED' };
    const label = `программа «${program}» · ${method}`;
    const refuse = (code: ProgramCallErrorCode): ProgramBeginReply => {
      this.record(request.moduleId, caller.version, user, 'call', label, OUTCOME[code], this.now() - started, bytes as number, 0);
      return { ok: false, code };
    };
    if (!hasProgramPermission(caller.manifest, program)) return refuse('NOT_ALLOWED');
    if (program === request.moduleId) return refuse('NOT_ALLOWED');
    if ((this.serving.get(request.moduleId) || 0) > 0) return refuse('NOT_ALLOWED');
    // Вызовы, которым никто не сообщил итог (окно закрыто на середине), освобождают место сами
    this.sweep();
    const slot = this.slot(request.moduleId), now = this.now();
    if (now - slot.windowAt >= 1000) { slot.windowAt = now; slot.calls = 0; }
    if (++slot.calls > PROGRAM_LIMITS.perSecond || slot.inFlight >= PROGRAM_LIMITS.inFlight || (bytes as number) > PROGRAM_LIMITS.bytes) return refuse('LIMIT');
    const callee = await this.deps.current(program);
    if (!callee) return refuse('NOT_INSTALLED');
    if (!exportsOf(callee.manifest).some(e => e.method === method)) return refuse('NO_METHOD');
    const ticket = `pc-${++this.counter}`;
    slot.inFlight++;
    this.serving.set(program, (this.serving.get(program) || 0) + 1);
    this.pending.set(ticket, { caller: request.moduleId, callerVersion: caller.version, callee: program, calleeVersion: callee.version, method, bytesIn: bytes as number, started: this.now(), user });
    return { ok: true, ticket, program, version: callee.version, language: languageOf(callee.manifest), manifest: callee.manifest };
  }

  /** Итог от окна: `ok` или код ошибки; длительность считает сам главный процесс */
  end(request: ProgramEndRequest): boolean {
    const item = this.pending.get(String(request.ticket));
    if (!item) return false;
    this.finish(String(request.ticket), item, (PROGRAM_ERROR_CODES as readonly string[]).includes(request.outcome) ? OUTCOME[request.outcome as ProgramCallErrorCode] : request.outcome === 'ok' ? 'ok' : 'failed', Number(request.bytesOut) || 0);
    return true;
  }

  private finish(ticket: string, item: Pending, outcome: string, bytesOut: number) {
    this.pending.delete(ticket);
    const slot = this.slot(item.caller);
    slot.inFlight = Math.max(0, slot.inFlight - 1);
    const left = (this.serving.get(item.callee) || 1) - 1;
    if (left > 0) this.serving.set(item.callee, left); else this.serving.delete(item.callee);
    const ms = this.now() - item.started;
    this.record(item.caller, item.callerVersion, item.user, 'call', `программа «${item.callee}» · ${item.method}`, outcome, ms, item.bytesIn, bytesOut);
    this.record(item.callee, item.calleeVersion, item.user, 'export', `${item.method} · из «${item.caller}»`, outcome, ms, item.bytesIn, bytesOut);
  }

  private sweep() {
    const now = this.now();
    for (const [ticket, item] of this.pending) if (now - item.started > PROGRAM_LIMITS.staleMs) this.finish(ticket, item, 'timeout', 0);
  }

  /** Сколько вызовов идёт сейчас (для проверок) */
  get active() { return this.pending.size; }
}
