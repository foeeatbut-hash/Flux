import manifest from './fixtures/equipment-inspector/manifest.json';
import type { ModuleManifest } from './contract';

// Только встроенные фикстуры. До проверки подписи PR 2 здесь нет загрузчика из БД/файла.
export const bundledModules: readonly ModuleManifest[] = [manifest as ModuleManifest];
