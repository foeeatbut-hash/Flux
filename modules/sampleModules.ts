import manifest from './fixtures/equipment-inspector/manifest.json';
import type { ModuleManifest } from './contract';

// Образец «Параметры позиции» — только для проверок и сборки его оболочки; пользователю Flux не показывается.
export const sampleModules: readonly ModuleManifest[] = [manifest as ModuleManifest];
