import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listArchive, run7z } from '../server/archive/engine.js';
import { checkArchiveLimits, parse7zListing, safeArchivePath } from '../server/archive/safety.js';

const listing = `Path = sample.7z
Type = 7z

----------
Path = Папка/файл.txt
Size = 5
Packed Size = 10
Encrypted = -
Folder = -

----------
Path = Папка
Attributes = D
Folder = +
`;
assert.deepEqual(parse7zListing(listing), [
  { path: 'Папка/файл.txt', size: 5, directory: false, encrypted: false },
  { path: 'Папка', size: 0, directory: true, encrypted: false },
]);
for (const path of ['../escape', '/absolute', 'C:/drive', 'folder/../../escape', 'name:stream', 'CON.txt', 'COM¹.log', 'folder/a.']) {
  assert.throws(() => safeArchivePath(path), undefined, `rejects ${path}`);
}
assert.throws(() => parse7zListing(listing.replace('Encrypted = -', 'Symbolic Link = target')));
assert.throws(() => parse7zListing(`${listing}\n----------\nPath = Папка/файл.txt\nSize = 5\nFolder = -\n`));
assert.throws(() => parse7zListing(`----------\nPath = conflict\nSize = 1\nFolder = -\n\nPath = conflict/child.txt\nSize = 1\nFolder = -\n`));
assert.throws(() => checkArchiveLimits([{ path: 'a', size: 2, directory: false, encrypted: false }], 10, 1));

async function main(): Promise<void> {
if (process.platform === 'linux' && !process.argv.includes('--parser-only')) {
  const temp = await mkdtemp(join(tmpdir(), 'flux-archive-cli-smoke-'));
  try {
    const source = join(temp, 'payload', 'Папка с пробелом'); await mkdir(source, { recursive: true });
    await writeFile(join(source, 'файл - 1.txt'), 'Проверка архиватора');
    await writeFile(join(source, 'файл - 2.txt'), 'Вторая запись');
    await writeFile(join(temp, 'payload', 'корень.txt'), 'Третья запись');
    for (const format of ['zip', '7z']) {
      const archive = join(temp, `тест.${format}`);
      await run7z(['a', `-t${format}`, '-mx=1', '-bd', '-y', archive, '.'], { cwd: join(temp, 'payload') });
      const entries = await listArchive(archive);
      assert.equal(entries.filter((x) => !x.directory).length, 3);
      assert.ok(entries.some((x) => x.path === 'Папка с пробелом/файл - 1.txt'));
      const testOutput = await run7z(['t', '-bd', '-y', '--', archive]);
      assert.match(testOutput, /Everything is Ok/i);
      const out = join(temp, `out-${format}`); await mkdir(out);
      await run7z(['x', '-bd', '-y', `-o${out}`, '--', archive]);
      assert.equal(await readFile(join(out, 'Папка с пробелом', 'файл - 1.txt'), 'utf8'), 'Проверка архиватора');
    }
    console.log('Архивный CLI smoke пройден');
  } finally { await rm(temp, { recursive: true, force: true }); }
} else if (!process.argv.includes('--parser-only')) console.log('Архивный CLI smoke пропущен: требуется Linux');

console.log('Проверки безопасности archive parser пройдены');
}

void main();
