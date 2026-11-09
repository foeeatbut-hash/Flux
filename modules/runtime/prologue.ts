/**
 * Пролог Worker'а подпрограммы: выполняется ДО её кода.
 *
 * CSP подпрограммы разрешает `worker-src blob:` — иначе окно не смогло бы запустить
 * сам Worker с логикой. Но тогда логика могла бы запустить собственные Worker'ы и
 * SharedWorker'ы вне общей очереди расчётов и пределов времени и памяти. Пролог
 * убирает эти конструкторы из глобальной области раньше, чем загрузится код модуля,
 * и закрывает возможность вернуть их обратно.
 *
 * Одна функция на два места: строка `WORKER_PROLOGUE` дописывается перед исходником
 * Worker'а (modules/runtime/runner.ts), сама функция вызывается в начале Worker'а
 * Python (modules/compute/pythonWorker.ts).
 */
export function lockNestedWorkers(scope: any = globalThis) {
  for (const name of ['Worker', 'SharedWorker', 'ServiceWorker']) {
    try { delete scope[name]; } catch { /* свойство не удаляется — переопределим ниже */ }
    try { Object.defineProperty(scope, name, { value: undefined, configurable: false, writable: false }); } catch { /* уже закрыто */ }
  }
}

/** Тот же код строкой — для дописывания в начало собранного Worker'а */
export const WORKER_PROLOGUE = `(${lockNestedWorkers.toString()})(globalThis);\n`;
