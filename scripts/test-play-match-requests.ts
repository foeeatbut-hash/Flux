import assert from 'node:assert/strict';
import { coalesceRequest } from '../src/play/runtime/matchRequests';

async function main() {
  const requests = coalesceRequest();
  let finish!: () => void;
  let calls = 0;
  const operation = () => {
    calls++;
    return new Promise<void>(resolve => { finish = resolve; });
  };
  const first = requests.run(operation);
  const poll = requests.run(operation);
  const manualRefresh = requests.run(operation);
  assert.equal(calls, 1, 'Опрос и ручное обновление не запускают параллельные запросы');
  finish();
  await Promise.all([first, poll, manualRefresh]);
  await requests.run(async () => { calls++; });
  assert.equal(calls, 2, 'После ответа следующий опрос запускает новый запрос');
  let finishPoll!: () => void, finishFresh!: () => void;
  const latePoll = requests.run(() => new Promise<void>(resolve => { finishPoll = resolve; }));
  let freshCalls = 0;
  const postMove = requests.runFresh(() => {
    freshCalls++;
    return new Promise<void>(resolve => { finishFresh = resolve; });
  });
  assert.equal(requests.run(() => { throw new Error('не должен запускаться'); }), postMove, 'Опросы присоединяются к свежему запросу после хода');
  finishPoll();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(freshCalls, 1, 'Свежий запрос начинается только после позднего poll');
  finishFresh();
  await Promise.all([latePoll, postMove]);
  console.log('✓ Запрос после хода следует за уже начатым poll');
  console.log('✓ Опрос доски не перекрывает ручное обновление');
}

main().catch(error => { console.error(error); process.exit(1); });
