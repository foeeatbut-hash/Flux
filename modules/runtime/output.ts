import type { ModuleOutput } from '../contract';

export const MODULE_STATE_BYTES = 256 * 1024;
export function checkedOutput(value: unknown): ModuleOutput {
  const output = value as ModuleOutput;
  if (!output || !output.state || typeof output.state !== 'object' || Array.isArray(output.state)
    || !output.calc?.out || typeof output.calc.out !== 'object' || Array.isArray(output.calc.out)) {
    throw new Error('STATE_LIMIT');
  }
  // Ограничиваем и state, и выходы: иначе большой calc обходил бы лимит снимка.
  const json = JSON.stringify(output);
  if (new TextEncoder().encode(json).byteLength > MODULE_STATE_BYTES) throw new Error('STATE_LIMIT');
  return JSON.parse(json);
}
