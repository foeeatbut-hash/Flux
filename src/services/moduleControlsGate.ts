/**
 * Первый запуск выпуска на этом компьютере: короткий набор контрольных
 * примеров («вход → ожидаемый выход с допуском») из подписанного пакета.
 * Не сошлось — подпрограмма не запускается, событие уходит в счётчики сбоев
 * (это делает ModuleCompute.controls), а главный процесс запоминает итог и
 * перестаёт отдавать код выпуска (electron/moduleControls.ts).
 */
import { languageOf } from '../../modules/engine/types';
import type { ModuleManifest } from '../../modules/contract';
import { moduleCompute } from './moduleComputeHost';
import { bridge } from './moduleReleaseService';

export type ControlsGate = 'ok' | 'failed';


export async function ensureControls(manifest: ModuleManifest): Promise<ControlsGate> {
  const language = languageOf(manifest);
  if (language === 'typescript') return 'ok';
  const ipc = bridge();
  const known = ipc ? await ipc.invoke('modules:controls', { moduleId: manifest.id }).catch(() => null) : null;
  if (known?.ok && known.version === manifest.version) {
    if (known.status === 'passed') return 'ok';
    if (known.status === 'failed') return 'failed';
  }
  let ok = false;
  try { ok = (await moduleCompute().controls({ moduleId: manifest.id, version: manifest.version, language })).ok; } catch { ok = false; }
  if (known?.ok) await ipc!.invoke('modules:controls-result', { moduleId: manifest.id, version: manifest.version, ok }).catch(() => null);
  return ok ? 'ok' : 'failed';
}
