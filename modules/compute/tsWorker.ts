/**
 * Worker метода на TypeScript: одна чистая функция «JSON → JSON».
 *
 * Запускается ВНУТРИ изолированного хоста (modules/compute/tsHostFrame.ts), по одному Worker'у на вызов. Скрипт Worker'а
 * собирает хост: пролог (закрывает вложенные Worker'ы) + этот файл + собранный `build/logic.js` пакета, который кладёт
 * функции логики в `globalThis.__fluxLogic`. Здесь нет ни `flux.*`, ни моста, ни состояния: Worker умирает после ответа,
 * поэтому глобальная переменная логики между вызовами не доживает. Сети нет по CSP хоста (connect-src 'none': Worker из
 * blob: наследует политику создавшей страницы), это проверяет scripts/test-modules-ts-host.ts в настоящем Chromium.
 *
 * Этот файл идёт ПЕРВЫМ в скрипте и сразу забирает `postMessage`: код логики выполняется после него.
 */
import { withDeterminism } from '../runtime/deterministic';

const post = (self as unknown as Worker).postMessage.bind(self);

(self as unknown as Worker).onmessage = async ({ data }: MessageEvent) => {
  if (data?.type !== 'run' || typeof data.id !== 'string') return;
  const id = data.id as string;
  try {
    const logic = (globalThis as { __fluxLogic?: Record<string, unknown> }).__fluxLogic;
    const compute = logic?.compute;
    if (typeof compute !== 'function') { post({ id, type: 'failed', code: 'ABI', detail: 'в логике нет функции compute' }); return; }
    const output = JSON.stringify(await withDeterminism(data.seed, () => compute(JSON.parse(String(data.input)))));
    // JSON.stringify(undefined) даёт undefined: логика вернула «ничего»
    if (typeof output !== 'string') { post({ id, type: 'failed', code: 'BAD_OUTPUT', detail: 'compute ничего не вернула' }); return; }
    post({ id, type: 'done', output });
  } catch {
    // Текст ошибки логики наружу не идёт: в нём могут быть данные вызова
    post({ id, type: 'failed', code: 'CRASH' });
  }
};
