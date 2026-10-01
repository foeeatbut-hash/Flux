/** Повторяется только то же намерение после обрыва, конфликт не запирает кнопку старым ключом. */
import assert from 'node:assert/strict';
import { usePlayPendingStore } from '../src/store/playPendingStore';
async function main() {
  const store = usePlayPendingStore.getState(); store.reset();
  const keys: string[] = [];
  const offline = async (key: string) => { keys.push(key); return { ok: false, code: 'OFFLINE', message: 'Нет сети' }; };
  await store.run('ready', offline, 'lobby:1:true');
  await store.run('ready', offline, 'lobby:1:true');
  assert.equal(keys[0], keys[1]); console.log('✓ Обрыв с тем же намерением сохраняет ключ');
  await store.run('ready', offline, 'lobby:2:false');
  assert.notEqual(keys[1], keys[2]); console.log('✓ Новая версия или противоположное действие получает новый ключ');
  await store.run('ready', async key => { keys.push(key); return { ok: false, code: 'VERSION_CONFLICT', message: 'Стол изменён' }; }, 'lobby:2:false');
  await store.run('ready', offline, 'lobby:2:false');
  assert.notEqual(keys[3], keys[4]); console.log('✓ Серверный отказ не блокирует следующую попытку прежней распиской');
  let resolve!: (value: { ok: boolean; result: string }) => void;
  const delayed = store.run<string>('invite', () => new Promise<{ ok: boolean; result: string }>(r => { resolve = r; }), 'same-target');
  const duplicate = await store.run('invite', () => Promise.resolve({ ok: true, result: 'duplicate' }), 'same-target');
  assert.equal(duplicate, null); resolve({ ok: true, result: 'created' }); assert.equal(await delayed, 'created');
  console.log('✓ Двойное нажатие не создаёт второй запрос');
}
main().catch(error => { console.error(error); process.exit(1); });
