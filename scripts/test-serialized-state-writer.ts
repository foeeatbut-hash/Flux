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
}

void run().catch((error) => { console.error(error); process.exitCode = 1; });
