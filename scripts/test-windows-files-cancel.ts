import assert from 'node:assert/strict';
import { windowsFilesRequest } from '../src/lib/windowsFiles';

// Мост contextBridge не пропускает AbortSignal: отмена обязана ехать данными (cancelId) и отдельным вызовом cancel.
async function main() {
  const original = (globalThis as any).window;
  const invoked: { request: any; options: any }[] = []; const cancelled: string[] = [];
  let release: (() => void) | undefined;
  (globalThis as any).window = { electron: { windowsFiles: {
    invoke: (request: any, options: any) => {
      assert.ok(options === undefined || (Object.keys(options).length === 1 && typeof options.cancelId === 'string'), 'второй аргумент моста — только данные');
      invoked.push({ request, options });
      return new Promise(resolve => { release = () => resolve({ ok: true, data: 'готово' }); });
    },
    cancel: (cancelId: string) => { cancelled.push(cancelId); },
    onChanged: () => () => undefined,
  } } };
  try {
    const plain = windowsFilesRequest({ action: 'roots' } as any); release!();
    assert.deepEqual(await plain, { ok: true, data: 'готово' }); assert.equal(invoked[0].options, undefined, 'без сигнала cancelId не заводится');
    const controller = new AbortController();
    const pending = windowsFilesRequest({ action: 'thumbnail' } as any, { signal: controller.signal });
    const cancelId = invoked[1].options.cancelId;
    assert.match(cancelId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, 'cancelId подходит под проверку главного процесса');
    assert.deepEqual(cancelled, []); controller.abort(); assert.deepEqual(cancelled, [cancelId], 'abort превращается в cancel(cancelId)');
    release!(); await pending;
    const done = new AbortController(); const finished = windowsFilesRequest({ action: 'thumbnail' } as any, { signal: done.signal }); release!(); await finished;
    done.abort(); assert.equal(cancelled.length, 1, 'после ответа отмена ничего не шлёт');
  } finally { (globalThis as any).window = original; }
  console.log('✓ отмена запросов моста идёт через cancelId и cancel, а не через AbortSignal');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
