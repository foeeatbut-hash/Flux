import { belongsToProject, createCoalescedRefresh } from '../src/lib/coalescedRefresh';

let ok = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { ok++; console.log(`✓ ${name}`); }
  else { fail++; console.log(`✗ ${name}: получено ${JSON.stringify(got)}, ожидалось ${JSON.stringify(want)}`); }
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

async function main() {
  let runs = 0, active = 0, peak = 0;
  const firstRun = deferred();
  const secondRun = deferred();
  const refresh = createCoalescedRefresh(async () => {
    runs++;
    active++;
    peak = Math.max(peak, active);
    await (runs === 1 ? firstRun.promise : secondRun.promise);
    active--;
  });

  const first = refresh();
  let waitingCallResolved = false;
  const coalesced = [
    refresh().then(() => { waitingCallResolved = true; }),
    refresh(),
  ];
  firstRun.resolve();
  await Promise.resolve();
  await Promise.resolve();
  eq('события во время загрузки запускают ровно один повторный проход', runs, 2);
  eq('повторный проход не выполняется параллельно с первым', peak, 1);
  eq('ожидающий вызывающий ждёт завершения повторного прохода', waitingCallResolved, false);
  secondRun.resolve();
  await Promise.all([first, ...coalesced]);
  eq('ожидающий вызывающий получает завершённый результат', waitingCallResolved, true);
  eq('последний проход завершается без потерянных запросов', active, 0);

  eq('проектное событие обновляет открытый проект', belongsToProject({ projectId: 'p1' }, 'p1'), true);
  eq('событие другого проекта игнорируется', belongsToProject({ projectId: 'p2' }, 'p1'), false);
  eq('старое событие без проекта остаётся совместимым', belongsToProject({}, 'p1'), true);

  console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
  process.exit(fail ? 1 : 0);
}

void main();
