'use strict';
// Вместо `import 'module-logic'` в Worker подпрограммы: логику разработчика studio/shared/runtime.ts
// кладёт в globalThis.__fluxLogic ДО кода Worker'а, поэтому здесь она уже есть.
module.exports = globalThis.__fluxLogic;
