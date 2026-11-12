import type { ModuleManifest } from './contract';

// Встроенных программ у пользователя Flux нет: всё ставится из Store подписанным выпуском.
// Учебная «Параметры позиции» живёт образцом в Studio («Новая программа») и фикстурой
// проверок (`modules/sampleModules.ts`), а в обычном Flux её больше нет.
export const bundledModules: readonly ModuleManifest[] = [];
