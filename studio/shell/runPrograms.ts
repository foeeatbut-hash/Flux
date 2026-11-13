/**
 * Вторая программа для `flux.programs.call` в запуске Studio: свои черновики, «установленные» в память оболочки.
 *
 * Проверки и пределы — тот же код, что у Flux: `ModuleProgramCalls` (разрешение `program` у вызывающей, метод в `exports`, не сама
 * себя, не вложенный вызов, ≤ 256 КиБ, 4 одновременно и 20 в секунду) и общая последовательность вызывающей стороны
 * `createProgramCallerWith` (modules/programs/caller.ts: те же коды ошибок и TIMEOUT). Исполняет метод движок Studio
 * (ControlsEngine): WebAssembly и TypeScript в рабочем потоке со своими пределами времени и памяти, без сети, файлов и состояния;
 * Python исполняет только Flux, поэтому метод на Python отвечает FAILED и подсказкой в журнал запуска.
 *
 * «Установленная» — только в этой оболочке и до её закрытия: ни базы, ни файлов Flux здесь нет, писать нечего.
 */
import { ComputeError, codeOf, type ModuleLanguage } from '../../modules/engine/types';
import { createProgramCallerWith } from '../../modules/programs/caller';
import { ModuleProgramCalls } from '../../electron/moduleProgramCalls';
import type { ModuleManifest } from '../../modules/contract';
import type { ProgramCall, ProgramCallErrorCode } from '../../modules/programs/model';
import { validMessage } from '../../modules/schemas';
import type { ControlsEngine } from '../shared/controlsEngine';
import type { RunProgramReply } from '../shared/runActions';
import type { ProjectFiles } from '../shared/templates';
import { StudioFailure } from './api';
import type { RunContext } from './runConnections';
import type { RunJournal } from './runJournal';

export interface InstalledProgram { manifest: ModuleManifest; files: ProjectFiles }

export interface RunProgramsDeps {
  current: () => RunContext | null;
  engine: ControlsEngine;
  journal: RunJournal;
  now?: () => number;
}

/** Строка для журнала запуска: что произошло с вызовом и что с этим делать; содержимого данных в ней нет */
export function programLine(code: ProgramCallErrorCode, call: ProgramCall, detail = ''): string {
  const what = `«${call.program}».${call.method}`;
  switch (code) {
    case 'NOT_ALLOWED': return `${what}: NOT_ALLOWED — у вызывающей нет разрешения program на «${call.program}» в manifest.json, либо это вызов самой себя или вложенный вызов`;
    case 'NOT_INSTALLED': return `${what}: NOT_INSTALLED — «${call.program}» не установлена в тестовую базу этого запуска: установите её в списке второй программы`;
    case 'NO_METHOD': return `${what}: NO_METHOD — метод не объявлен в exports манифеста «${call.program}»`;
    case 'LIMIT': return `${what}: LIMIT — слишком частые, большие или одновременные вызовы либо ответ больше 256 КиБ (пределы те же, что во Flux)`;
    case 'TIMEOUT': return `${what}: TIMEOUT — метод не уложился во время расчёта`;
    default: return `${what}: FAILED — метод не выполнился${detail ? ` (${detail})` : ''}`;
  }
}

export class RunPrograms {
  private readonly installed = new Map<string, InstalledProgram>();
  private readonly calls: ModuleProgramCalls;

  constructor(private readonly deps: RunProgramsDeps) {
    this.calls = new ModuleProgramCalls({
      // Вызывающая — запущенный проект: его манифест, а не слова окна, решает, есть ли у неё разрешение program
      resolve: async (moduleId, version) => {
        const run = deps.current();
        return run && run.manifest.id === moduleId && String(run.manifest.version) === version
          ? { manifest: run.manifest, version, author: String(run.manifest.author ?? ''), verifiedAt: 0 } : null;
      },
      current: async moduleId => {
        const program = this.installed.get(moduleId);
        return program ? { manifest: program.manifest, version: String(program.manifest.version), author: String(program.manifest.author ?? ''), verifiedAt: 0 } : null;
      },
      userId: () => 'studio',
      journal: deps.journal,
      now: deps.now,
    });
  }

  install(program: InstalledProgram): void { this.installed.set(program.manifest.id, program); }
  remove(id: string): boolean { return this.installed.delete(id); }
  isInstalled(id: string): boolean { return this.installed.has(id); }

  /** Один вызов `flux.programs.call` от запущенной программы; отказы — кодами Flux и строкой для журнала запуска */
  async call(args: { call?: unknown }): Promise<RunProgramReply> {
    const run = this.deps.current();
    if (!run) throw new StudioFailure('Программа не запущена.');
    const envelope = { flux: 'module', v: 1, session: run.id, id: 'studio', type: 'program', call: args.call };
    // Форму вызова проверяет та же схема, что в мосте: окно могло ошибиться, оболочка доверия не даёт
    if (!validMessage('program', envelope)) return { ok: false, code: 'FAILED', line: 'flux.programs.call: вызов неверной формы (нужны program и method, как в справочнике flux.*)' };
    const call = args.call as ProgramCall;
    const version = String(run.manifest.version);
    let detail = '';
    let python = false;
    const caller = createProgramCallerWith({ moduleId: run.manifest.id, version }, () => ({
      invoke: async (channel, data: any) => {
        if (channel === 'modules:program-begin') return this.calls.begin({ moduleId: run.manifest.id, version, call: data?.call });
        if (channel === 'modules:program-end') return { ok: this.calls.end({ ticket: String(data?.ticket), outcome: String(data?.outcome), bytesOut: data?.bytesOut }) };
        return null;
      },
      compute: async (target, input) => {
        python = target.language === 'python';
        const program = this.installed.get(target.moduleId);
        try {
          // Контрольные примеры Flux здесь не нужны: это не выпуск, а черновик разработчика; проверяет их кнопка «Проверить»
          if (!program) throw new ComputeError('UNAVAILABLE', 'программу убрали во время вызова');
          return await this.deps.engine.compute(target.language as ModuleLanguage, program.files, program.manifest.logic, input);
        } catch (error) {
          detail = `${codeOf(error)}${error instanceof ComputeError && error.message.includes(': ') ? `: ${error.message.slice(error.message.indexOf(': ') + 2, 160)}` : ''}`;
          throw error;
        }
      },
      controls: async () => 'ok',
    }));
    const reply = await caller(call);
    if (!('code' in reply)) return reply;
    // Python исполняет общая среда Flux: Studio её не содержит — отказ с понятной подсказкой, а не загадочное «не удалось»
    const line = python && reply.code === 'FAILED'
      ? `«${call.program}».${call.method}: FAILED — Python исполняет Flux, а не Studio: проверьте метод через «Запустить во Flux»`
      : programLine(reply.code, call, detail);
    return { ...reply, line };
  }

}
