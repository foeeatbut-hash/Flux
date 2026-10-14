import assert from 'node:assert/strict';
import { createFileMetadataCache } from '../src/services/fileMetadataCache';

async function main() {
  let now = 1000, loads = 0;
  const cache = createFileMetadataCache<string>(() => now, 100);
  const identity = { server: 'https://one', actor: 'alice', project: 'p1', session: 'token-a' };
  const load = async () => `value-${++loads}`;
  const [first, same] = await Promise.all([cache.get('f1', identity, load), cache.get('f1', identity, load)]);
  assert.equal(first, same); assert.equal(loads, 1, 'concurrent reads share one in-flight request');
  assert.equal(await cache.get('f1', { ...identity, actor: 'bob' }, load), 'value-2', 'cache is isolated by actor');
  assert.equal(await cache.get('f1', { ...identity, project: 'p2' }, load), 'value-3', 'cache is isolated by project');
  assert.equal(await cache.get('f1', { ...identity, session: 'token-b' }, load), 'value-4', 'cache is isolated by session');
  assert.equal(await cache.get('f1', { ...identity, server: 'https://two' }, load), 'value-5', 'cache is isolated by server');
  now += 101; assert.equal(await cache.get('f1', identity, load), 'value-6', 'expired entries reload');
  cache.invalidate('f1'); assert.equal(await cache.get('f1', identity, load), 'value-7', 'file invalidation evicts all scoped versions');
  cache.invalidate(); assert.equal(cache.size, 0, 'session invalidation clears the cache');
  await assert.rejects(cache.get('broken', identity, async () => { throw new Error('offline'); }));
  assert.equal(await cache.get('broken', identity, load), 'value-8', 'failed requests are not cached');
  cache.invalidate(); loads = 100; now = 5000;
  assert.equal(await cache.get('poll', identity, load), 'value-101');
  now += 40; assert.equal(await cache.get('poll', identity, load, 50), 'value-101', 'a fresh enough answer is shared with the poller');
  now += 20; assert.equal(await cache.get('poll', identity, load, 50), 'value-102', 'a poller with a short maxAge does not see an older answer');
  assert.equal(await cache.get('poll', identity, load, 0), 'value-103', 'maxAge 0 always asks the server and refreshes the cache');
  assert.equal(await cache.get('poll', identity, load), 'value-103', 'the refreshed answer serves ordinary readers');
  console.log('✓ metadata cache deduplicates and isolates server, actor, project, and session');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
