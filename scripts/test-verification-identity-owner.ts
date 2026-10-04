import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Stateful boundary regression for the Owner vault writer. The target and all
 * data are synthetic files under a fresh temporary directory; no user profile
 * or credential path is read.
 */
async function verifyAtomicWriteDoesNotFollowSymlinks() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-identity-owner-'));
  try {
    const outside = path.join(temp, 'synthetic-protected-file.txt');
    const requested = path.join(temp, 'vault.flux-owner');
    await fs.writeFile(outside, 'sentinel: synthetic data\n', { flag: 'wx' });
    await fs.symlink(outside, requested);

    const requireFromOwner = createRequire(path.join(process.cwd(), 'tools/flux-owner/package.json'));
    const { atomicWrite } = requireFromOwner('./src/vault.cjs') as { atomicWrite: (file: string, text: string) => Promise<void> };
    await atomicWrite(requested, 'synthetic replacement\n');

    assert.equal(await fs.readFile(outside, 'utf8'), 'sentinel: synthetic data\n',
      'writing the selected path must not truncate the symlink target');
    assert.equal(await fs.readFile(requested, 'utf8'), 'synthetic replacement\n',
      'the selected path must contain the new bytes');
    assert.equal((await fs.lstat(requested)).isSymbolicLink(), false,
      'atomic replacement must replace the link itself');
    const leftovers = (await fs.readdir(temp)).filter(name => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'successful replacement must leave no temporary file');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

verifyAtomicWriteDoesNotFollowSymlinks()
  .then(() => console.log('Identity/Owner filesystem regression: 4 checks PASS'))
  .catch(error => { console.error(error); process.exitCode = 1; });
