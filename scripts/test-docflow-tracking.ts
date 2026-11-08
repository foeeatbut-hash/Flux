/** Слежение за связанными файлами не читает диск, пока у файла не изменились размер или время изменения. */
import assert from 'node:assert/strict';
import { HashMemory, needsHash } from '../src/lib/docflowTracking';

let passed = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); passed++; };

async function main() {
  check('без запомненного отпечатка нужен хеш', needsHash(undefined, { size: 1, modifiedAt: 'a' }));
  check('размер и время те же — хеш не нужен', !needsHash({ size: 1, mtime: 'a', sha256: 'x' }, { size: 1, modifiedAt: 'a' }));
  check('изменился размер или время — хеш нужен', needsHash({ size: 1, mtime: 'a', sha256: 'x' }, { size: 2, modifiedAt: 'a' }) && needsHash({ size: 1, mtime: 'a', sha256: 'x' }, { size: 1, modifiedAt: 'b' }));

  const memory = new HashMemory(3);
  let reads = 0;
  const read = (sha: string, size: number) => async () => { reads++; return { sha256: sha, size }; };
  const first = await memory.fingerprint('l1', { size: 10, modifiedAt: 't1' }, read('aaa', 10));
  check('первый проход читает файл', reads === 1 && first?.sha256 === 'aaa' && first.read);
  for (let pass = 0; pass < 5; pass++) await memory.fingerprint('l1', { size: 10, modifiedAt: 't1' }, read('zzz', 10));
  check('при неизменных размере и времени диск не читается, берётся прежний отпечаток', reads === 1 && (await memory.fingerprint('l1', { size: 10, modifiedAt: 't1' }, read('zzz', 10)))?.sha256 === 'aaa');
  const changedTime = await memory.fingerprint('l1', { size: 10, modifiedAt: 't2' }, read('bbb', 10));
  check('изменилось время — файл читается заново', reads === 2 && changedTime?.sha256 === 'bbb' && changedTime.read);
  const changedSize = await memory.fingerprint('l1', { size: 11, modifiedAt: 't2' }, read('ccc', 11));
  check('изменился размер — файл читается заново', reads === 3 && changedSize?.sha256 === 'ccc');
  check('сбой чтения не запоминается и не выдаёт отпечаток', await memory.fingerprint('l2', { size: 1, modifiedAt: 't' }, async () => null) === null && memory.get('l2') === undefined);
  for (const key of ['a', 'b', 'c', 'd']) await memory.fingerprint(key, { size: 1, modifiedAt: 't' }, read(key, 1));
  check('память ограничена и не растёт без предела', ['a', 'b', 'c', 'd', 'l1'].filter((k) => memory.get(k)).length <= 3);
  console.log(`docflow-tracking: ${passed} проверок прошли`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
