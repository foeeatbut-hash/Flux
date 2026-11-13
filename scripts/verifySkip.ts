/**
 * Пропуск набора, который виден как пропуск.
 *
 * Раньше набор без Chromium/Electron/сборки печатал FLUX_VERIFY_SKIP и
 * заканчивался кодом 0: job CI был зелёным, хотя не проверено ничего. Раннер
 * (verification/runner.ts) такой вывод считает SKIP, но job'ы CI запускают
 * наборы напрямую, мимо раннера. Поэтому в job, где набор обязателен, ставится
 * FLUX_REQUIRE_NO_SKIP=1: пропуск тогда превращается в провал. Без переменной
 * (локально, у владельца без Windows) поведение прежнее — пропуск вслух.
 *
 * Код выхода выставляется в обработчике exit: часть наборов завершается
 * явным process.exit(0), который иначе затёр бы провал.
 */
export function verifySkip(reason: string): void {
  console.log(`FLUX_VERIFY_SKIP: ${reason}`);
  if (process.env.FLUX_REQUIRE_NO_SKIP !== '1') return;
  console.error(`✗ набор обязателен в этом job, но пропущен: ${reason}`);
  process.on('exit', () => { process.exitCode = 1; });
}
