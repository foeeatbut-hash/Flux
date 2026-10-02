/** Exercise HTTP stream failures without Electron, real release bytes, or a company server. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { downloadVerifiedUpdate, assertUpdatePublished } from '../electron/updateDownload';
import { testSignature } from './fixtures/updateTestSign';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-download-fixture-'));
const bytes = Buffer.alloc(6 * 1024 * 1024, 7); bytes.write('MZ');
const privateKey = crypto.createPrivateKey(fs.readFileSync(path.join(__dirname, 'fixtures/update-test-key.txt')));
const keyHex = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const signature = testSignature(bytes, '2.0.0');
let mode = 'good', count = 0;
const listener = http.createServer((req, res) => {
  count++;
  if (req.url?.startsWith('/api/updates/check/')) return res.end(JSON.stringify({ ok: mode !== 'revoked', version: '2.0.0', signature }));
  if (mode === 'redirect') { res.writeHead(302, { Location: 'https://outside.invalid/leak' }); return res.end(); }
  res.writeHead(200, { 'Content-Length': mode === 'length' ? bytes.length + 1 : bytes.length });
  if (mode === 'cut') { res.write(bytes.subarray(0, 1024 * 1024)); setImmediate(() => res.destroy()); return; }
  if (mode === 'corrupt') { const wrong = Buffer.from(bytes); wrong[1000] ^= 1; return res.end(wrong); }
  res.end(bytes);
});
(async () => {
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const server = `http://127.0.0.1:${(listener.address() as any).port}`;
  const options = { version: '2.0.0', signature, current: '1.0.0', server, token: 'fixture-token', keyHex };
  const dest = path.join(directory, 'Flux.exe'), url = `${server}/api/updates/download/2.0.0`;
  await downloadVerifiedUpdate(url, dest, options); assert.deepEqual(fs.readFileSync(dest), bytes);
  for (const bad of ['corrupt', 'cut', 'length', 'redirect']) {
    mode = bad; await assert.rejects(() => downloadVerifiedUpdate(url, dest, options));
    assert.deepEqual(fs.readFileSync(dest), bytes, 'a failed download never overwrites the last verified file');
    assert.equal(fs.readdirSync(directory).length, 1, 'partial downloads are removed');
  }
  const before = count;
  await assert.rejects(() => downloadVerifiedUpdate('https://outside.invalid/api/updates/download/2.0.0', dest, options));
  await assert.rejects(() => downloadVerifiedUpdate(url, dest, { ...options, keyHex: 'a'.repeat(64) }));
  await assert.rejects(() => downloadVerifiedUpdate(url, dest, { ...options, current: '2.0.0' }));
  assert.equal(count, before, 'invalid source, key and rollback fail before sending a token');
  mode = 'good'; await assertUpdatePublished(options);
  mode = 'revoked'; await assert.rejects(() => assertUpdatePublished(options), /отозван/);
  console.log('18 isolated update transport checks passed');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  await new Promise<void>(resolve => listener.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true });
});
