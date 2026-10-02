import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalOfficeWorkerHost } from '../electron/localOfficeWorkerHost';

async function main() {
  const folder = await mkdtemp(join(tmpdir(), 'flux-worker-fixture-'));
  await writeFile(join(folder, 'pdf.cjs'), `
    let sink = () => {};
    module.exports = {
      start() {}, setDataDir() {}, open() { return 1; }, close() {},
      onSend(fn) { sink = fn; }, send() {}, requestCopy() { return true; },
      async invoke(id, channel, args, target, commit) {
        if (channel === 'busy') { sink(id, 'busy-start', []); const end = Date.now() + 350; while (Date.now() < end) {} return 'done'; }
        if (channel === 'save') { await commit(); return {ok: true}; }
        if (channel === 'crash') process.exit(17);
        return args;
      }
    };
  `);
  const host = createLocalOfficeWorkerHost('pdf', folder);
  try {
    const id = await host.open('/fixture.pdf', '/fixture');
    let ticks = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const unsubscribe = host.onSend((_id, channel) => { if (channel === 'busy-start') timer = setInterval(() => ticks++, 10); });
    assert.equal(await host.invoke(id, 'busy', []), 'done');
    if (timer) clearInterval(timer);
    if (typeof unsubscribe === 'function') unsubscribe();
    assert.ok(ticks >= 5, `Main thread must remain responsive during native CPU work; ticks=${ticks}`);
    console.log('✓ Main thread timers continue while the editor blocks its worker');
    let committed = false;
    assert.deepEqual(await host.invoke(id, 'save', [], undefined, async () => { committed = true; }), { ok: true });
    assert.ok(committed);
    await assert.rejects(() => host.invoke(id, 'save', [], undefined, async () => { throw Object.assign(new Error('revoked'), {code:'READ_ONLY'}); }), (e: any) => e.code === 'READ_ONLY');
    console.log('✓ Parent commit authorizes persistence and propagates a revocation');
    await assert.rejects(() => host.invoke(id, 'crash', []), (e: any) => e.code === 'EDITOR_STOPPED');
    await assert.rejects(async () => host.open('/fixture.pdf', '/fixture'), (e: any) => e.code === 'EDITOR_STOPPED');
    console.log('✓ A crashed editor rejects pending and future RPC without trapping the application');
  } finally { await host.dispose?.(); await rm(folder, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
