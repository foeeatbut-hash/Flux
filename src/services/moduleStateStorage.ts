/**
 * Состояние страницы программы со стороны окна Flux: диск (через главный процесс) у самостоятельной программы,
 * память окна у остальных.
 *
 * Окно не решает, куда писать: оно спрашивает главный процесс, а тот по проверенному манифесту отвечает `disk: true` или
 * `disk: false`. Без главного процесса (веб-окно, проверки в браузере) состояние живёт в памяти, как раньше.
 * Память — `lib/pageStateMemory.ts`: очищается при выходе из профиля; диск остаётся (данные человека на его компьютере).
 */
import { MEMORY_LIMIT_BYTES, stateBytes } from '../../modules/storage/model';
import { bridge } from './moduleReleaseService';
import { pageState, pageStateKey } from '../lib/pageStateMemory';

export interface ProgramStateStore {
  load: () => Promise<Record<string, unknown>>;
  /** `undefined` — сохранено; `{ code }` — отказ (предел хранилища, ошибка диска), состояние осталось прежним */
  keep: (state: Record<string, unknown>) => Promise<{ code: 'LIMIT' | 'FAILED' } | undefined>;
}

export function createProgramStateStore(program: { moduleId: string; version: string; userId: string; channel: string }): ProgramStateStore {
  const memoryKey = pageStateKey(program.userId, program.moduleId, program.channel);
  const ipc = bridge();
  const { moduleId, version } = program;
  return {
    async load() {
      if (!ipc) return pageState.load(memoryKey);
      const reply = await ipc.invoke('modules:state-load', { moduleId, version });
      if (!reply?.ok) throw new Error('Хранилище программы не прочитано');
      return reply.disk ? (reply.state as Record<string, unknown>) : pageState.load(memoryKey);
    },
    async keep(state) {
      if (!ipc) { pageState.keep(memoryKey, state); return; }
      let reply: any;
      try { reply = await ipc.invoke('modules:state-keep', { moduleId, version, state }); } catch { return { code: 'FAILED' }; }
      if (reply?.ok && reply.disk) return;
      if (reply?.ok) {
        // Главный процесс не признал программу самостоятельной (окно могло ошибиться с пределом): память — прежние 256 КиБ
        if ((stateBytes(state) ?? Infinity) > MEMORY_LIMIT_BYTES) return { code: 'LIMIT' };
        pageState.keep(memoryKey, state); return;
      }
      return { code: reply?.code === 'LIMIT' ? 'LIMIT' : 'FAILED' };
    },
  };
}
