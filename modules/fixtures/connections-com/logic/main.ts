import type { ModuleApi } from '../../../contract';

/**
 * Пример COM: Scripting.FileSystemObject, только строковые методы без побочных
 * эффектов (GetBaseName, BuildPath) — диск не читается и не пишется. Так же устроен
 * доступ к E3: открыть объект по имени, вызывать методы по имени, освободить.
 */
export function setup({ flux, state, calc, connect }: ModuleApi) {
  flux.on('changed', async () => {
    try {
      const fso = await connect.com.open('fso');
      const base = await connect.com.call('fso', fso, 'GetBaseName', ['C:\\Проекты\\схема-12.dwg']);
      const joined = await connect.com.call('fso', fso, 'BuildPath', ['C:\\Проекты', 'схема-12.dwg']);
      await connect.com.release('fso', fso);
      state.problem = 'нет';
      calc.out = { base: String(base), joined: String(joined) };
    } catch (error) {
      state.problem = error instanceof Error ? error.message : 'FAILED';
      calc.out = { base: '', joined: '' };
    }
  });
}
