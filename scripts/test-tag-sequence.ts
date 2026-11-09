/**
 * Нумерация тегов по префиксу и очередь выдачи номеров.
 */
import assert from 'node:assert/strict';
import { nextTagIdentifier as next, serializeByProject } from '../server/tagSequence';

// 76: разрядность — у тега с наибольшим номером, три знака только без тегов
assert.equal(next([], 'P-'), 'P-001');
assert.equal(next(['P-01', 'P-02', 'P-09'], 'P-'), 'P-10');
assert.equal(next(['P-9', 'P-10'], 'P-'), 'P-11');
assert.equal(next(['K001', 'K999'], 'K'), 'K1000');
// 77: с суффиксом чужие серии не считаются
assert.equal(next(['K005', 'K001B'], 'K', 'B'), 'K002B');
assert.equal(next(['K005'], 'K', 'B'), 'K001B');
assert.equal(next(['K001B', 'K003B', 'K010'], 'K', 'B'), 'K004B');
// без суффикса «005B» не число
assert.equal(next(['K005B', 'K002'], 'K'), 'K003');
// регистр префикса различается
assert.equal(next(['p-05'], 'P-'), 'P-001');
console.log('✓ нумерация: разрядность, суффикс, регистр');

// 78: выдача номеров по очереди — параллельные запросы получают разные номера
(async () => {
  const stored: string[] = [];
  const gen = () => serializeByProject('p1', async () => {
    const id = next(stored, 'T-');
    await new Promise(r => setTimeout(r, 5)); // окно между чтением и записью
    stored.push(id);
    return id;
  });
  const got = await Promise.all([gen(), gen(), gen(), gen()]);
  assert.equal(new Set(got).size, 4, `номера разные: ${got}`);
  assert.deepEqual([...got].sort(), ['T-001', 'T-002', 'T-003', 'T-004']);
  // сбой одного запроса не ломает очередь
  await assert.rejects(serializeByProject('p1', async () => { throw new Error('x'); }));
  assert.equal(await serializeByProject('p1', async () => 'ok'), 'ok');
  console.log('✓ параллельная выдача номеров — по очереди, сбой не ломает очередь');
})().catch(e => { console.error(e); process.exitCode = 1; });
