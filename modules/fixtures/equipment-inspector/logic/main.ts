import type { ModuleApi } from '../../../contract';

export function setup({ flux, state, calc }: ModuleApi) {
  state.recalculations ??= 0;
  flux.on('changed', async () => {
    const equipment = await flux.read('equipment');
    state.recalculations = Number(state.recalculations) + 1;
    calc.out = { parameterCount: equipment?.params.length || 0 };
  });
}
