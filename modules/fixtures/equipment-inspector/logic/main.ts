import type { ModuleApi } from '../../../contract';

export async function recalc({ flux, calc }: ModuleApi) {
  const project = await flux.read('project');
  const equipment = await flux.read('equipment');
  const tag = await flux.read('tag');
  // Форма читает тот же снимок, что и обработчик: при событии он собирается заново.
  calc.out = { parameterCount: equipment?.params.length || 0 };
  return { flux: { project, equipment, tag }, calc };
}
