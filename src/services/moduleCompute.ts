/**
 * Исполнение логики программ на Python, WebAssembly и (как метод для других программ) TypeScript — одна очередь,
 * одни пределы и один путь ошибок на все программы окна Flux.
 *
 * Кто что делает:
 * - программа (iframe) присылает ВХОД по мосту, язык и исходник она не
 *   выбирает; окно берёт файл логики из проверенного выпуска через протокол
 *   (главный процесс отдаёт только то, что прошло проверку подписи);
 * - очередь (`ComputeScheduler`) держит «ядра − 1, не больше 4» расчётов;
 * - WebAssembly исполняется в Worker окна (модуль не имеет доступа ни к чему,
 *   кроме импортов Flux), Python — в общем Worker изолированного хоста;
 * - TypeScript — только функция `compute` из собранного `build/logic.js` пакета, по Worker на каждый вызов в своём
 *   изолированном хосте без сети (логика формы TypeScript по-прежнему живёт в окне программы и сюда не попадает);
 * - превышение времени останавливает Worker, сбой записывается в счётчики
 *   сбоев с видом (не текстом), следующий расчёт получает чистую среду;
 * - пока расчётов нет, живут только отложенные выгрузки (по одному таймеру на
 *   Python и на Worker'ы WebAssembly), опроса нет.
 *
 * Класс не знает про DOM: Worker'ы, хост и таймеры ему передают (src/services/moduleComputeHost.ts).
 */
import { ComputeScheduler, type Priority } from '../../modules/engine/scheduler';
import { ComputeError, LIMITS, codeOf, failureKindOf, type ComputeErrorCode, type ModuleLanguage } from '../../modules/engine/types';
import { encodeJson, parseComputeOutput } from '../../modules/engine/json';
import { parseControls, runControls, type Controls, type ControlsReport } from '../../modules/engine/controls';
import type { ModuleOutput } from '../../modules/contract';
import { checkedOutput } from '../../modules/runtime/output';

export interface ComputeTarget { moduleId: string; version: string; language: ModuleLanguage }
export interface RunOptions { timeoutMs?: number; seed?: number }

/** Среда исполнения WebAssembly: один Worker — один расчёт за раз */
export interface WasmRunner {
  run(fingerprint: string, bytes: Uint8Array, input: string, seed: number, timeoutMs: number): Promise<{ output: string; from: 'cache' | 'compiled' }>;
  /** Остановить все Worker'ы (выгрузка по простою) */
  stopAll(): void;
  keepOnly(fingerprints: string[]): void;
  readonly workers: number;
  /** Сколько раз модуль компилировался и сколько раз взят готовым: проверка «компиляция один раз на выпуск» */
  readonly stats?: { compiled: number; cached: number };
}
/** Хост логики TypeScript: Worker на вызов, без состояния между вызовами, останавливается по времени */
export interface TsRunner {
  run(source: string, input: string, seed: number, timeoutMs: number): Promise<{ output: string }>;
  /** Выгрузить хост целиком (останавливает идущие вызовы) */
  unload(): void;
  readonly loaded: boolean;
}
/** Общая среда Python */
export interface PythonRunner {
  run(key: string, source: string, input: string, seed: number, timeoutMs: number): Promise<{ output: string; bootMs: number }>;
  /** Выгрузить среду целиком */
  unload(): void;
  readonly loaded: boolean;
  /** Сколько расчётов ждут или идут в среде (всегда идёт не больше одного) */
  readonly queued?: number;
}
export interface ComputeDeps {
  scheduler: ComputeScheduler;
  wasm: WasmRunner;
  python: PythonRunner;
  /** Нет — логика TypeScript здесь не исполняется (`UNAVAILABLE`): так устроены проверки, которым она не нужна */
  ts?: TsRunner;
  /** Файл логики из проверенного выпуска (`logic.wasm`, `logic.py`, `logic.js` — собранный TypeScript, `controls.json`) */
  fetchFile(moduleId: string, file: 'logic.wasm' | 'logic.py' | 'logic.js' | 'controls.json'): Promise<Uint8Array>;
  sha256(bytes: Uint8Array): Promise<string>;
  /** Минуты простоя Python до выгрузки (настройка, по умолчанию 5) */
  pythonIdleMinutes(): number;
  wasmIdleMs?: number;
  tsIdleMs?: number;
  onFailure(moduleId: string, version: string, kind: 'crash' | 'timeout' | 'memory' | 'controls'): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface Source { bytes: Uint8Array; text?: string; fingerprint: string }

export class ModuleCompute {
  private sources = new Map<string, Promise<Source>>();
  private idlePython: unknown = null;
  private idleWasm: unknown = null;
  private idleTs: unknown = null;
  private disposed = false;

  constructor(private deps: ComputeDeps) {}

  private timer(fn: () => void, ms: number) { return (this.deps.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms); }
  private untimer(handle: unknown) { if (handle !== null) (this.deps.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle); }

  private source(target: ComputeTarget): Promise<Source> {
    const key = `${target.moduleId}@${target.version}:${target.language}`;
    let found = this.sources.get(key);
    if (!found) {
      const file = target.language === 'python' ? 'logic.py' : target.language === 'typescript' ? 'logic.js' : 'logic.wasm';
      found = (async () => {
        let bytes: Uint8Array;
        try { bytes = await this.deps.fetchFile(target.moduleId, file); } catch { throw new ComputeError('UNAVAILABLE', 'файл логики недоступен'); }
        return { bytes, fingerprint: await this.deps.sha256(bytes), text: target.language === 'wasm' ? undefined : new TextDecoder().decode(bytes) };
      })();
      // Неудачная загрузка не запоминается: следующая попытка попробует снова
      found.catch(() => this.sources.delete(key));
      // Источников держим немного: версия программы меняется редко
      if (this.sources.size >= 16) this.sources.delete(this.sources.keys().next().value as string);
      this.sources.set(key, found);
    }
    return found;
  }

  /** Расчёт для программы: вход → выход по схеме договора, или ComputeError */
  async compute(target: ComputeTarget, input: unknown, priority: Priority, options: RunOptions = {}, report = true): Promise<ModuleOutput> {
    if (this.disposed) throw new ComputeError('DENIED', 'окно закрыто');
    try {
      return await this.execute(target, input, priority, options);
    } catch (error) {
      const kind = failureKindOf(codeOf(error));
      if (kind && report) this.deps.onFailure(target.moduleId, target.version, kind);
      throw error instanceof ComputeError ? error : new ComputeError('CRASH');
    }
  }

  private async execute(target: ComputeTarget, input: unknown, priority: Priority, options: RunOptions): Promise<ModuleOutput> {
    if (target.language === 'typescript' && !this.deps.ts) throw new ComputeError('UNAVAILABLE', 'логика TypeScript здесь не исполняется');
    // Числа и размер проверяются до очереди: заведомо неверный вход не занимает слот
    const text = encodeJson(input);
    const seed = Number.isSafeInteger(options.seed) ? options.seed! : seedOf(input);
    const timeoutMs = Math.min(LIMITS.timeoutMs, Math.max(20, options.timeoutMs ?? LIMITS.timeoutMs));
    const source = await this.source(target);
    // Файл логики TypeScript — собранный JS из подписанного пакета; больше предела Flux его не запускает (хост проверяет то же ещё раз)
    if (target.language === 'typescript' && source.bytes.length > LIMITS.tsFileBytes) throw new ComputeError('ABI', 'файл логики больше 1 МиБ');
    const lane = target.language === 'python' ? 'python' : '';
    const raw = await this.deps.scheduler.run(priority, target.moduleId, async () => {
      if (this.disposed) throw new ComputeError('DENIED', 'окно закрыто');
      if (target.language === 'python') {
        this.untimer(this.idlePython); this.idlePython = null;
        try {
          return (await this.deps.python.run(`${target.moduleId}@${target.version}`, source.text!, text, seed, timeoutMs)).output;
        } finally { this.armPythonIdle(); }
      }
      if (target.language === 'typescript') {
        this.untimer(this.idleTs); this.idleTs = null;
        try { return (await this.deps.ts!.run(source.text!, text, seed, timeoutMs)).output; } finally { this.armTsIdle(); }
      }
      this.untimer(this.idleWasm); this.idleWasm = null;
      try {
        return (await this.deps.wasm.run(source.fingerprint, source.bytes, text, seed, timeoutMs)).output;
      } finally { this.armWasmIdle(); }
    }, lane);
    // Результат проверяется до показа: схема договора, числа, размер
    const output = parseComputeOutput(raw);
    try { return checkedOutput(output); } catch { throw new ComputeError('BAD_OUTPUT', 'состояние и результаты больше 256 КиБ'); }
  }

  private armPythonIdle() {
    if (this.disposed || !this.deps.python.loaded) return;
    this.untimer(this.idlePython);
    const minutes = Math.max(1, this.deps.pythonIdleMinutes());
    // Один отложенный вызов, а не опрос: до него процессор не просыпается
    this.idlePython = this.timer(() => { this.idlePython = null; this.deps.python.unload(); }, minutes * 60_000);
  }
  private armTsIdle() {
    if (this.disposed || !this.deps.ts?.loaded) return;
    this.untimer(this.idleTs);
    // Хост без Worker'ов почти ничего не стоит, но пустой кадр в окне держать незачем
    this.idleTs = this.timer(() => { this.idleTs = null; this.deps.ts?.unload(); }, this.deps.tsIdleMs ?? 60_000);
  }
  private armWasmIdle() {
    if (this.disposed || !this.deps.wasm.workers) return;
    this.untimer(this.idleWasm);
    this.idleWasm = this.timer(() => { this.idleWasm = null; this.deps.wasm.stopAll(); }, this.deps.wasmIdleMs ?? 60_000);
  }

  /**
   * Контрольные примеры выпуска на ЭТОМ компьютере: тем же путём, каким идёт
   * настоящий расчёт (очередь, пределы, проверка выхода).
   */
  async controls(target: ComputeTarget): Promise<ControlsReport> {
    let parsed: Controls | string;
    try { parsed = parseControls(new TextDecoder().decode(await this.deps.fetchFile(target.moduleId, 'controls.json'))); }
    catch { throw new ComputeError('UNAVAILABLE', 'контрольные примеры недоступны'); }
    if (typeof parsed === 'string') throw new ComputeError('CONTROLS', parsed);
    // Сбои внутри набора — расхождение примера, а не отдельное событие сбоя: событие одно, «контрольные не сошлись»
    const report = await runControls(parsed, input => this.compute(target, input, 'active', {}, false));
    // Событие — только за расхождение результата; разовая нехватка времени или памяти на слабом ПК — не сбой выпуска
    if (report.mismatch) this.deps.onFailure(target.moduleId, target.version, 'controls');
    return report;
  }

  /**
   * Оставить только выпуски (`модуль@версия`), которые ещё лежат в кэше проверенных: источники и
   * скомпилированные модули остальных — удалённых, отозванных, вытесненных — не живут дальше.
   */
  async retain(live: ReadonlySet<string>) {
    const kept: Promise<Source>[] = [];
    for (const [key, source] of [...this.sources]) {
      if (live.has(key.slice(0, key.lastIndexOf(':')))) kept.push(source); else this.sources.delete(key);
    }
    const resolved = await Promise.allSettled(kept);
    this.deps.wasm.keepOnly(resolved.flatMap(r => r.status === 'fulfilled' ? [r.value.fingerprint] : []));
  }

  /** Программу закрыли: её ожидающие расчёты снимаются с очереди, идущие доходят до предела времени */
  cancel(moduleId: string) { this.deps.scheduler.cancelQueued(moduleId); }

  /** Закрытие окна или выход: останавливает среды и отменяет ожидающих */
  dispose() {
    this.disposed = true;
    this.untimer(this.idlePython); this.untimer(this.idleWasm); this.untimer(this.idleTs);
    this.deps.wasm.stopAll(); this.deps.python.unload(); this.deps.ts?.unload();
  }
}

/** Зерно случайности из входа: целое `seed` верхнего уровня; без него — 0, то есть случайности нет */
function seedOf(input: unknown): number {
  const seed = (input as { seed?: unknown } | null)?.seed;
  return Number.isSafeInteger(seed) ? (seed as number) : 0;
}

export type { ComputeErrorCode };
