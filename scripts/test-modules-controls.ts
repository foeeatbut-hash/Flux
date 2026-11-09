/**
 * Итог контрольных примеров на компьютере (electron/moduleControls.ts):
 * расхождение — окончательно, разовый сбой времени или памяти — повтор до
 * трёх раз, «Проверить снова» сбрасывает, старейшие по обращению вытесняются.
 *
 * Запуск: npx tsx scripts/test-modules-controls.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTROLS_MAX, CONTROLS_RETRIES, ModuleControls } from '../electron/moduleControls';
import { runControls } from '../modules/engine/controls';
import { ComputeError } from '../modules/engine/types';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; };
const fake = (n: number, language = 'wasm') => ({ signature: `sig-${n}`, manifest: { language }, claim: { version: '1.0.0' } }) as any;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-controls-'));
  const file = path.join(dir, 'controls.json');
  let c = new ModuleControls(file, '41.7.2');
  const r = fake(1);

  console.log('Разбор итога прогона');
  const set = { version: 1 as const, cases: [{ name: 'a', input: 1, expect: { x: 1 } }] };
  const wrong = await runControls(set, async () => ({ x: 2 }));
  const slow = await runControls(set, async () => { throw new ComputeError('TIMEOUT'); });
  ok('другой результат — расхождение', !wrong.ok && wrong.mismatch);
  ok('ошибка расчёта (время) — не расхождение, а повод повторить', !slow.ok && !slow.mismatch);

  console.log('Окончательный отказ и разовый сбой');
  ok('до проверки — неизвестно, запуск не закрыт', c.status(r) === 'unknown' && !c.blocked(r));
  await c.record(r, 'mismatch');
  ok('расхождение закрывает выпуск окончательно', c.status(r) === 'failed' && c.blocked(r));
  const t = fake(2);
  for (let n = 1; n < CONTROLS_RETRIES; n++) {
    await c.record(t, 'transient');
    ok(`разовый сбой №${n}: выпуск не закрыт, проверка повторится`, c.status(t) === 'unknown' && !c.blocked(t));
  }
  await c.record(t, 'transient');
  ok(`после ${CONTROLS_RETRIES} подряд сбоев отказ окончательный`, c.status(t) === 'failed' && c.blocked(t));
  await c.record(t, 'passed');
  ok('успешный прогон снимает отказ', c.status(t) === 'passed' && !c.blocked(t));
  await c.record(t, 'transient');
  ok('и счётчик попыток после успеха начинается заново', c.status(t) === 'unknown');

  console.log('Проверить снова');
  await c.reset(r);
  ok('сброс забывает даже окончательный отказ', c.status(r) === 'unknown' && !c.blocked(r));

  console.log('Хранение');
  await c.record(r, 'mismatch');
  c = new ModuleControls(file, '41.7.2'); await c.load();
  ok('итог переживает перезапуск', c.status(r) === 'failed');
  ok('другая версия Electron проверяет заново', new ModuleControls(file, '42.0.0').status(r) === 'unknown');
  ok('TypeScript проверять не нужно', !c.required(fake(9, 'typescript')) && c.required(fake(9, 'python')));

  console.log('Предел и вытеснение по давности');
  const small = new ModuleControls(path.join(dir, 'many.json'), 'e');
  await small.record(fake(0), 'passed');
  for (let n = 1; n < CONTROLS_MAX; n++) small.status(fake(n)), await (small as any).results.set(`${'a'.repeat(64)}|${n}`, { ok: true, at: n });
  await small.record(fake(0), 'passed'); // свежее обращение переносит ключ в конец
  const before = (small as any).results.size;
  await small.record(fake(100000), 'passed');
  ok('записей не больше предела', (small as any).results.size <= CONTROLS_MAX && before >= CONTROLS_MAX);
  ok('вытеснена самая давняя, а недавно обновлённая осталась', small.status(fake(0)) === 'passed' && !(small as any).results.has(`${'a'.repeat(64)}|1`));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`Итог контрольных примеров: проверок ${passed}`);
}
main().catch(e => { console.error('✗', e); process.exit(1); });
