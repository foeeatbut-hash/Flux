/**
 * Первый запуск выпуска на этом компьютере: короткий набор контрольных
 * примеров («вход → ожидаемый выход с допуском») из подписанного пакета.
 * Не сошлось — программа не запускается, событие уходит в счётчики сбоев
 * (это делает ModuleCompute.controls), а главный процесс запоминает итог и
 * перестаёт отдавать код выпуска (electron/moduleControls.ts).
 */
import { languageOf } from '../../modules/engine/types';
import { needsControls } from '../../modules/programs/model';
import type { ModuleManifest } from '../../modules/contract';
import { moduleCompute } from './moduleComputeHost';
import { bridge } from './moduleReleaseService';

export type ControlsGate = 'ok' | 'failed' | 'retry';

/** «Проверить снова»: главный процесс забывает итог, затем проверка идёт заново */
export async function resetControls(manifest: ModuleManifest): Promise<void> {
  await bridge()?.invoke('modules:controls-reset', { moduleId: manifest.id }).catch(() => null);
}


export async function ensureControls(manifest: ModuleManifest): Promise<ControlsGate> {
  const language = languageOf(manifest);
  // Форма на TypeScript считает сама и контрольных примеров не имеет; с методами для других программ — имеет, как Python и WebAssembly
  if (!needsControls(manifest)) return 'ok';
  const ipc = bridge();
  const known = ipc ? await ipc.invoke('modules:controls', { moduleId: manifest.id }).catch(() => null) : null;
  if (known?.ok && known.version === manifest.version) {
    if (known.status === 'passed') return 'ok';
    if (known.status === 'failed') return 'failed';
  }
  let outcome: 'passed' | 'mismatch' | 'transient' = 'transient';
  try {
    const report = await moduleCompute().controls({ moduleId: manifest.id, version: manifest.version, language });
    outcome = report.ok ? 'passed' : report.mismatch ? 'mismatch' : 'transient';
  } catch { outcome = 'transient'; }
  if (known?.ok) await ipc!.invoke('modules:controls-result', { moduleId: manifest.id, version: manifest.version, outcome }).catch(() => null);
  return outcome === 'passed' ? 'ok' : outcome === 'mismatch' ? 'failed' : 'retry';
}
