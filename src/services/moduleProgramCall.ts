/**
 * Обращение программы к другой программе (`flux.programs.call`) — сторона окна Flux.
 *
 * Окно не решает, можно ли: `modules:program-begin` проверяет всё в главном процессе по подписанным выпускам
 * (разрешение, установлена ли вызываемая, объявлен ли метод, пределы) и возвращает, какую версию и на каком языке считать.
 * Дальше окно исполняет метод тем же движком и под теми же пределами, что `compute` (Python, WebAssembly): вход `{ export, data }`,
 * ответ — `calc.out`. Состояния, подключений, сети и данных Flux у метода нет. `modules:program-end` сообщает итог для журнала.
 */
import type { ProgramCall, ProgramReply } from '../../modules/programs/model';
import { createProgramCallerWith, type ProgramCallerDeps } from '../../modules/programs/caller';
import { moduleCompute } from './moduleComputeHost';
import { ensureControls } from './moduleControlsGate';
import { bridge } from './moduleReleaseService';

export type { ProgramCallerDeps };
const windowDeps = (): ProgramCallerDeps | null => {
  const ipc = bridge();
  return ipc ? { invoke: (channel, data) => ipc.invoke(channel, data), compute: (target, input) => moduleCompute().compute(target, input, 'active'), controls: ensureControls } : null;
};

export function createProgramCaller(options: { moduleId: string; version: string }, deps: () => ProgramCallerDeps | null = windowDeps): (request: ProgramCall) => Promise<ProgramReply> {
  return createProgramCallerWith(options, deps);
}
