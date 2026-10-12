import assert from 'node:assert/strict';
import { queueOfficeReply } from '../src/components/office/officeReplyQueue';

async function main() {
  const queue = new Map<string, Promise<unknown>>();
  const sent: string[] = [];
  let finishFirst!: (value: string) => void;
  const first = queueOfficeReply(queue, 'schema', () => new Promise<string>((resolve) => { sent.push('first'); finishFirst = resolve; }));
  const second = queueOfficeReply(queue, 'schema', async () => { sent.push('second'); return 'second-response'; });
  const independent = queueOfficeReply(queue, 'selection', async () => { sent.push('independent'); return 'selection-response'; });
  assert.equal(await independent, 'selection-response');
  assert.deepEqual(sent, ['first', 'independent'], 'same-channel request waits while other channels remain available');
  finishFirst('first-response');
  assert.deepEqual(await Promise.all([first, second]), ['first-response', 'second-response']);
  assert.deepEqual(sent, ['first', 'independent', 'second']);
  const rejected = queueOfficeReply(queue, 'schema', async () => { throw new Error('timeout'); });
  const recovery = queueOfficeReply(queue, 'schema', async () => 'recovered');
  await assert.rejects(rejected, /timeout/);
  assert.equal(await recovery, 'recovered');
  await Promise.resolve();
  assert.equal(queue.size, 0);
  console.log('Office reply queues preserve response ownership and independent channels');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
