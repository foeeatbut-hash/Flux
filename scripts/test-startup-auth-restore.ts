import assert from 'node:assert/strict';
import { restoreStartupUser } from '../src/lib/startupAuth.ts';

const response = (status: number, data: unknown) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});

async function main() {
  let calls = 0;
  const delayedUser = await restoreStartupUser(async (signal) => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(signal.aborted, false, 'delayed response stays within the request bound');
    return response(200, { user: { id: 'restored-user' } });
  }, { timeoutMs: 250, retryDelaysMs: [5] });
  assert.equal(delayedUser?.id, 'restored-user');
  assert.equal(calls, 1, 'a delayed API response is awaited instead of racing the login screen');

  calls = 0;
  const recoveredUser = await restoreStartupUser(async () => {
    calls++;
    if (calls === 1) throw new TypeError('Failed to fetch');
    return response(200, { user: { id: 'restored-after-retry' } });
  }, { timeoutMs: 250, retryDelaysMs: [0, 0], wait: async () => {} });
  assert.equal(recoveredUser?.id, 'restored-after-retry');
  assert.equal(calls, 2, 'transient network failure retries and restores the authenticated profile');

  for (const status of [401, 403]) {
    calls = 0;
    const unauthenticated = await restoreStartupUser(async () => {
      calls++;
      return response(status, { error: 'denied' });
    }, { timeoutMs: 250, retryDelaysMs: [0, 0], wait: async () => {} });
    assert.equal(unauthenticated, null, `${status} keeps the normal unauthenticated path`);
    assert.equal(calls, 1, `${status} is an HTTP decision, not a reason to retry`);
  }

  calls = 0;
  const bounded = await restoreStartupUser(async (signal) => {
    calls++;
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    return new Promise<any>(() => {});
  }, { timeoutMs: 15, retryDelaysMs: [0], wait: async () => {} });
  assert.equal(bounded, null);
  assert.equal(calls, 2, 'unreachable API stops after the bounded number of attempts');

  console.log('5 startup authentication restore checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
