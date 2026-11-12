/**
 * Обращение программы к другой программе (`flux.programs.call`) — сторона окна Flux.
 *
 * Окно не решает, можно ли: `modules:program-begin` проверяет всё в главном процессе по подписанным выпускам
 * (разрешение, установлена ли вызываемая, объявлен ли метод, пределы) и возвращает, какую версию и на каком языке считать.
 * Дальше окно исполняет метод тем же движком и под теми же пределами, что `compute` (Python, WebAssembly): вход `{ export, data }`,
 * ответ — `calc.out`. Состояния, подключений, сети и данных Flux у метода нет. `modules:program-end` сообщает итог для журнала.
 */
import { ComputeError, codeOf } from '../../modules/engine/types';
import { encodeJson } from '../../modules/engine/json';
import { PROGRAM_LIMITS, type ProgramCall, type ProgramCallErrorCode, type ProgramReply } from '../../modules/programs/model';
import type { ModuleManifest, ModuleOutput } from '../../modules/contract';
import type { ModuleLanguage } from '../../modules/engine/types';
import { moduleCompute } from './moduleComputeHost';
import { ensureControls } from './moduleControlsGate';
import { bridge } from './moduleReleaseService';

/** Что окну нужно снаружи: каналы к главному процессу, расчёт и проверка контрольных примеров; проверки подставляют свои */
export interface ProgramCallerDeps {
  invoke: (channel: string, data: unknown) => Promise<any>;
  compute: (target: { moduleId: string; version: string; language: ModuleLanguage }, input: unknown) => Promise<ModuleOutput>;
  controls: (manifest: ModuleManifest) => Promise<'ok' | 'failed' | 'retry'>;
}
const windowDeps = (): ProgramCallerDeps | null => {
  const ipc = bridge();
  return ipc ? { invoke: (channel, data) => ipc.invoke(channel, data), compute: (target, input) => moduleCompute().compute(target, input, 'active'), controls: ensureControls } : null;
};

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;

/** Код ошибки расчёта → код обращения: время и очередь различимы, остальное — «не удалось» (подробности в журнале вызываемой) */
function codeFor(error: unknown): ProgramCallErrorCode {
  const failure = error instanceof ComputeError ? error : new ComputeError('CRASH');
  const code = codeOf(failure);
  // Ответ, не поместившийся в предел размера (256 КиБ на всё состояние и результат), — это предел, а не поломка метода
  return code === 'TIMEOUT' ? 'TIMEOUT' : code === 'BUSY' || (code === 'BAD_OUTPUT' && /больше/.test(failure.message)) ? 'LIMIT' : 'FAILED';
}

export function createProgramCaller(options: { moduleId: string; version: string }, deps: () => ProgramCallerDeps | null = windowDeps) {
  return async function call(request: ProgramCall): Promise<ProgramReply> {
    const ipc = deps();
    if (!ipc) return { ok: false, code: 'FAILED' };
    const input = { export: request.method, data: request.data ?? null };
    let bytes: number;
    try { encodeJson(input, PROGRAM_LIMITS.bytes + 1024); bytes = bytesOf(request.data); } catch { return { ok: false, code: 'FAILED' }; }
    let begun: any;
    try { begun = await ipc.invoke('modules:program-begin', { moduleId: options.moduleId, version: options.version, call: { program: request.program, method: request.method, bytes } }); }
    catch { return { ok: false, code: 'FAILED' }; }
    if (!begun?.ok) return { ok: false, code: (begun?.code as ProgramCallErrorCode) || 'FAILED' };
    let outcome: ProgramCallErrorCode | 'ok' = 'ok';
    let out: unknown = null;
    try {
      // Контрольные примеры выпуска на этом компьютере — как при первом запуске программы: непроверенную логику метод не исполняет
      if (await ipc.controls(begun.manifest) !== 'ok') throw new ComputeError('CONTROLS');
      const output = await ipc.compute({ moduleId: begun.program, version: begun.version, language: begun.language }, input);
      out = output.calc.out;
      if (bytesOf(out) > PROGRAM_LIMITS.bytes) outcome = 'LIMIT';
    } catch (error) { outcome = codeFor(error); }
    // Итог главному процессу: журнал обеих программ и освобождение места в пределах; без содержимого
    await ipc.invoke('modules:program-end', { ticket: begun.ticket, outcome, bytesOut: outcome === 'ok' ? bytesOf(out) : 0 }).catch(() => null);
    return outcome === 'ok' ? { ok: true, data: out } : { ok: false, code: outcome };
  };
}
