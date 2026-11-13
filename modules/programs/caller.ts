/**
 * Обращение программы к другой программе (`flux.programs.call`): шаги вызывающей стороны без окна и без Electron.
 *
 * Общий код окна Flux (src/services/moduleProgramCall.ts) и Studio (studio/shell/runPrograms.ts): последовательность
 * «begin → контрольные примеры → расчёт → end», коды ошибок и пределы размера одни и те же, различаются только каналы
 * к главному процессу и движок расчёта, которые приходят в `ProgramCallerDeps`.
 */
import { ComputeError, codeOf } from '../engine/types';
import { encodeJson } from '../engine/json';
import { PROGRAM_LIMITS, type ProgramCall, type ProgramCallErrorCode, type ProgramReply } from './model';
import type { ModuleManifest, ModuleOutput } from '../contract';
import type { ModuleLanguage } from '../engine/types';

/** Что вызывающей стороне нужно снаружи: каналы к главному процессу, расчёт и проверка контрольных примеров; проверки подставляют свои */
export interface ProgramCallerDeps {
  invoke: (channel: string, data: unknown) => Promise<any>;
  compute: (target: { moduleId: string; version: string; language: ModuleLanguage }, input: unknown) => Promise<ModuleOutput>;
  controls: (manifest: ModuleManifest) => Promise<'ok' | 'failed' | 'retry'>;
}

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;

/** Код ошибки расчёта → код обращения: время и очередь различимы, остальное — «не удалось» (подробности в журнале вызываемой) */
function codeFor(error: unknown): ProgramCallErrorCode {
  const failure = error instanceof ComputeError ? error : new ComputeError('CRASH');
  const code = codeOf(failure);
  // Ответ, не поместившийся в предел размера (256 КиБ на всё состояние и результат), — это предел, а не поломка метода
  return code === 'TIMEOUT' ? 'TIMEOUT' : code === 'BUSY' || (code === 'BAD_OUTPUT' && /больше/.test(failure.message)) ? 'LIMIT' : 'FAILED';
}

export function createProgramCallerWith(options: { moduleId: string; version: string }, deps: () => ProgramCallerDeps | null) {
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
