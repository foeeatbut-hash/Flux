import { createSerializedStateWriter } from '../src/lib/serializedStateWriter';

const check = (name: string, condition: boolean) => { if (!condition) throw new Error(`✗ ${name}`); console.log(`✓ ${name}`); };

async function run() {
  let state: { sha: string } | null = { sha: 'initial' };
  const tokens: string[] = [];
  let calls = 0;
  const stateRef = () => state;
  // The closure is intentionally stable while the state changes, just like a React callback.
  const stableWriter = createSerializedStateWriter(stateRef, async (_value: number, current) => {
    tokens.push(current.sha); calls++;
    if (calls === 1) { await Promise.resolve(); state = { sha: 'fresh' }; }
    if (calls === 3) throw new Error('temporary failure');
    return current;
  });
  await Promise.all([stableWriter(1), stableWriter(2)]);
  check('serialized writes read the fresh concurrency token', tokens[0] === 'initial' && tokens[1] === 'fresh');
  await stableWriter(3).then(() => { throw new Error('expected write failure'); }, () => undefined);
  await stableWriter(4);
  check('a failed write does not block retry', calls === 4 && tokens[3] === 'fresh');

  let active = 0; let peak = 0; let revision = 0;
  const seen: number[] = [];
  const burst = createSerializedStateWriter(() => ({ revision }), async (_value: number, current) => {
    active++; peak = Math.max(peak, active); seen.push(current.revision);
    await new Promise(resolve => setTimeout(resolve, 10));
    revision++; active--; return revision;
  });
  await Promise.all([burst(1), burst(2), burst(3), burst(4)]);
  check('four simultaneous saves stay serial and each sees the previous saved revision', peak === 1 && seen.join(',') === '0,1,2,3');
}

void run().catch((error) => { console.error(error); process.exitCode = 1; });
