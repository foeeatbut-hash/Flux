/**
 * Очередь отправки обращения.
 *
 * Проверяется не «отправилось ли», а поведение на неудачах: именно там очередь
 * либо спасает написанное, либо тихо теряет его и заводит вторую карточку.
 * Сервер здесь подменён — настоящий проверяется живьём, — но код очереди берётся
 * настоящий, вместе с разбором ответа и разбивкой файла на куски.
 *
 * Запуск: npx tsx scripts/test-feedback-queue.ts
 */

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`, detail === undefined ? '' : detail); }
};

// Окно, которого в Node нет: договор о сервере читает адрес из хранилища
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

type Call = { method: string; url: string };
const calls: Call[] = [];
/** Что отвечать на очередной запрос: по кусочку пути. */
let plan: (method: string, url: string, body: any) => any;

const json = (data: unknown, status = 200) => ({
  ok: status < 400, status,
  text: async () => JSON.stringify(status < 400 ? { data } : { error: data }),
});

(globalThis as any).fetch = async (url: string, init: any = {}) => {
  const method = init.method || 'GET';
  calls.push({ method, url });
  const answer = plan(method, String(url), init.body);
  if (answer instanceof Error) throw answer;
  return answer;
};

async function main() {
  const { SubmissionQueue, nextDelay, stateForError, RETRY_STEPS, MAX_ATTEMPTS, packageFromDraft } =
    await import('../src/feedback/submissionQueue');
  const { ApiError } = await import('../src/feedback/feedbackApi');

  const body = {
    schemaVersion: 1 as const,
    clientRequestId: '11111111-2222-4333-8444-555555555555',
    deploymentId: 'dep', type: 'BUG' as const,
    title: 'Не открывается спецификация',
    description: 'При открытии спецификации окно остаётся пустым.',
    sectionKey: 'explorer', incidentAt: new Date().toISOString(), appVersion: '1.0.0',
    frequency: 'ALWAYS' as const, impact: 'HIGH' as const,
    consent: { technicalEvents: true, appContext: true, reviewedAt: new Date().toISOString() },
  };
  const pack = (files: any[] = []) => ({
    key: 'dep|u1|d1', draftId: 'd1', deploymentId: 'dep', userId: 'u1', body, files,
  });

  /** Дождаться, пока очередь придёт в одно из названных состояний. */
  const settle = async (queue: any, key: string, want: string[]) => {
    for (let i = 0; i < 400; i++) {
      const item = queue.snapshot().find((s: any) => s.key === key);
      if (item && want.includes(item.state)) return item;
      await new Promise((r) => setTimeout(r, 5));
    }
    return queue.snapshot().find((s: any) => s.key === key);
  };

  console.log('1. Расписание повторов');
  ok('первая задержка около двух секунд', nextDelay(0, () => 0.5) === 2000, nextDelay(0, () => 0.5));
  ok('разброс не выходит за пятую часть',
    nextDelay(0, () => 0) === 1600 && nextDelay(0, () => 1) === 2400);
  ok('после пятой попытки — раз в пять минут', nextDelay(RETRY_STEPS.length, () => 0.5) === 300000);
  ok('попыток подряд не больше десяти', MAX_ATTEMPTS === 10);

  console.log('\n2. Отказ ведёт туда, где его разберут');
  ok('нет связи — повторим сами', stateForError(new ApiError('OFFLINE', '', 0)) === 'FAILED_RETRYABLE');
  ok('сервер занемог — повторим сами', stateForError(new ApiError('X', '', 503)) === 'FAILED_RETRYABLE');
  ok('401 — надо войти заново', stateForError(new ApiError('X', '', 401)) === 'NEEDS_SIGN_IN');
  ok('403 не повторяется без человека', stateForError(new ApiError('X', '', 403)) === 'NEEDS_REVIEW');
  ok('413 не повторяется без человека', stateForError(new ApiError('X', '', 413)) === 'NEEDS_REVIEW');
  ok('429 не повторяется без человека', stateForError(new ApiError('X', '', 429)) === 'NEEDS_REVIEW');

  console.log('\n3. Обычная отправка с вложением');
  calls.length = 0;
  const bytes = new Uint8Array(300 * 1024).fill(7);
  plan = (method, url) => {
    if (method === 'POST' && /\/uploads$/.test(url)) {
      return json({ uploadId: 'up1', chunkSize: 256 * 1024, chunkCount: 2, status: 'PENDING' });
    }
    if (method === 'GET' && /\/uploads\/up1$/.test(url)) return json({ status: 'PENDING', received: [] });
    if (method === 'PUT') return json({ received: true });
    if (method === 'POST' && /complete$/.test(url)) return json({ status: 'READY' });
    if (method === 'POST' && /\/reports$/.test(url)) return json({ id: 'r1', number: 7 });
    return json({ code: 'NOT_FOUND', message: url }, 404);
  };
  const q1 = new SubmissionQueue();
  await q1.enqueue(pack([{ id: 'a1', name: 'снимок.png', kind: 'IMAGE', blob: new Blob([bytes]) }]) as any);
  const done = await settle(q1, 'dep|u1|d1', ['SENT', 'NEEDS_REVIEW', 'NEEDS_SIGN_IN', 'FAILED_RETRYABLE']);
  ok('состояние «отправлено»', done?.state === 'SENT', done);
  ok('номер карточки запомнен', done?.reportId === 'r1', done?.reportId);
  ok('файл поехал двумя кусками', calls.filter((c) => c.method === 'PUT').length === 2);
  ok('ход показан по подтверждённым байтам', done?.done === bytes.length, done?.done);
  ok('карточка создана один раз', calls.filter((c) => /\/feedback\/reports$/.test(c.url)).length === 1);
  ok('номер человеку показан словом', done?.reportNumber === 'ОБР-000007', done?.reportNumber);
  q1.clear();

  console.log('\n3.1. Двух вложений едут два, а не одно');
  // Ключ загрузки был один на всю отправку, а сервер считает загрузку по паре
  // «владелец + ключ»: второй файл находил ПЕРВУЮ готовую загрузку и молча
  // возвращал её. К обращению приезжало одно вложение из двух, форма при этом
  // показывала успех, и узнать о потере было неоткуда
  calls.length = 0;
  const keys: string[] = [];
  plan = (method, url, body) => {
    if (method === 'POST' && /\/uploads$/.test(url)) {
      const asked = JSON.parse(String(body || '{}'));
      keys.push(asked.clientRequestId);
      return json({ uploadId: `up-${keys.length}`, chunkSize: 256 * 1024, chunkCount: 1, status: 'PENDING' });
    }
    if (method === 'GET' && /\/uploads\/up-\d$/.test(url)) return json({ status: 'PENDING', received: [] });
    if (method === 'PUT') return json({ received: true });
    if (method === 'POST' && /complete$/.test(url)) return json({ status: 'READY' });
    if (method === 'POST' && /\/reports$/.test(url)) return json({ id: 'r2', number: 8 });
    return json({ code: 'NOT_FOUND', message: url }, 404);
  };
  const small = new Uint8Array(1024).fill(3);
  const q1b = new SubmissionQueue();
  await q1b.enqueue(pack([
    { id: 'a1', name: 'снимок.png', kind: 'IMAGE', blob: new Blob([small]) },
    { id: 'a2', name: 'диагностика.jsonl', kind: 'DIAGNOSTICS', blob: new Blob([small]) },
  ]) as any);
  const two = await settle(q1b, 'dep|u1|d1', ['SENT', 'NEEDS_REVIEW', 'FAILED_RETRYABLE']);
  ok('оба вложения отправлены', two?.state === 'SENT', two);
  ok('загрузок заведено две', keys.length === 2, keys.length);
  ok('у каждого файла свой ключ загрузки', keys.length === 2 && keys[0] !== keys[1], keys);
  ok('ключ загрузки — это ключ вложения, а не отправки',
    keys.includes('a1') && keys.includes('a2'), keys);
  q1b.clear();

  console.log('\n4. Ответ на подтверждение потерялся');
  calls.length = 0;
  let asked = 0;
  plan = (method, url) => {
    if (method === 'POST' && /\/feedback\/reports$/.test(url)) return new Error('сеть оборвалась');
    if (method === 'GET' && /by-request/.test(url)) { asked++; return json({ id: 'r9' }); }
    return json({ code: 'NOT_FOUND', message: url }, 404);
  };
  const q2 = new SubmissionQueue();
  await q2.enqueue(pack() as any);
  const lost = await settle(q2, 'dep|u1|d1', ['SENT', 'NEEDS_REVIEW', 'FAILED_RETRYABLE']);
  ok('карточка найдена по ключу запроса, а не создана заново', lost?.state === 'SENT', lost);
  ok('спросили ровно один раз', asked === 1, asked);
  ok('вторая отправка не пошла', calls.filter((c) => /\/feedback\/reports$/.test(c.url)).length === 1);
  q2.clear();

  console.log('\n5. Молчание сервера не считается отправкой');
  calls.length = 0;
  plan = (method, url) => {
    if (method === 'POST' && /\/feedback\/reports$/.test(url)) return new Error('сеть оборвалась');
    if (method === 'GET' && /by-request/.test(url)) return json({ code: 'NOT_FOUND', message: '' }, 404);
    return json({ code: 'NOT_FOUND', message: url }, 404);
  };
  const q3 = new SubmissionQueue();
  await q3.enqueue(pack() as any);
  const unknown = await settle(q3, 'dep|u1|d1', ['SENT', 'FAILED_RETRYABLE', 'NEEDS_REVIEW']);
  ok('карточки нет — значит не отправлено', unknown?.state === 'FAILED_RETRYABLE', unknown);
  ok('«отправлено» не показано', unknown?.reportId === undefined);
  // Иначе очередь досидит до своей минуты и не даст набору закончиться
  q3.clear();

  console.log('\n6. Отказ, который повторять бессмысленно');
  plan = (method, url) => {
    if (method === 'POST' && /\/feedback\/reports$/.test(url)) {
      return json({ code: 'FORBIDDEN', message: 'Нет права заводить обращения' }, 403);
    }
    return json({ code: 'NOT_FOUND', message: url }, 404);
  };
  const q4 = new SubmissionQueue();
  await q4.enqueue(pack() as any);
  const denied = await settle(q4, 'dep|u1|d1', ['NEEDS_REVIEW', 'SENT', 'FAILED_RETRYABLE']);
  ok('отправка ждёт человека', denied?.state === 'NEEDS_REVIEW', denied);
  ok('попытки не тратились', denied?.attempts === 0, denied?.attempts);
  ok('причина названа словами', String(denied?.note).includes('Нет права'), denied?.note);
  q4.clear();

  console.log('\n7. Отмена');
  // Состояние подтверждения наступает по-настоящему: сервер принял запрос и
  // молчит. Подделывать его правкой снимка нельзя — снимок отдаёт копии, и
  // проверка, которая правит копию, проверяла бы саму себя, а не очередь.
  plan = (method, url) => {
    if (method === 'POST' && /\/feedback\/reports$/.test(url)) return new Promise(() => {});
    return json({ code: 'NOT_FOUND', message: url }, 404);
  };
  const q5 = new SubmissionQueue();
  await q5.enqueue(pack() as any);
  const hanging = await settle(q5, 'dep|u1|d1', ['COMMITTING', 'NEEDS_REVIEW', 'SENT']);
  ok('дошло до подтверждения', hanging?.state === 'COMMITTING', hanging?.state);
  ok('на подтверждении отменить нельзя', q5.cancel('dep|u1|d1') === false);
  ok('и оно осталось на подтверждении', q5.snapshot()[0].state === 'COMMITTING');
  q5.clear();

  plan = () => json({ code: 'NOT_FOUND', message: '' }, 404);
  const q6 = new SubmissionQueue();
  await q6.enqueue(pack() as any);
  const stuck = await settle(q6, 'dep|u1|d1', ['NEEDS_REVIEW', 'FAILED_RETRYABLE', 'SENT']);
  ok('до подтверждения — можно', q6.cancel('dep|u1|d1') === true, stuck);
  ok('состояние стало «отменено»', q6.snapshot()[0].state === 'CANCELLED');
  q6.clear();

  console.log('\n8. Пакет собирается обратно только целым');
  ok('без ключа запроса пакет не собирается',
    packageFromDraft({ id: 'k', deploymentId: 'dep', userId: 'u1', draftId: 'd1', updatedAt: 0,
      state: 'QUEUED', fields: { title: 'есть' }, attachments: [] } as any) === null);
  const rebuilt = packageFromDraft({
    id: 'k', deploymentId: 'dep', userId: 'u1', draftId: 'd1', updatedAt: 0, state: 'QUEUED',
    clientRequestId: body.clientRequestId, fields: { ...body }, attachments: [],
  } as any);
  ok('ключ запроса переживает перезапуск', rebuilt?.body.clientRequestId === body.clientRequestId);

  // Ничего не должно остаться висеть: набор обязан закончиться сам, а не по
  // таймауту запускающего
  const held = ((process as any).getActiveResourcesInfo?.() || []).filter((r: string) => r === 'Timeout');
  ok('распущенная очередь не держит процесс', held.length === 0, held);

  console.log('\n9. Перезапуск программы очередь не теряет');
  {
    // Черновик, застигнутый перезапуском: пакет собран, ключ выдан, состояние
    // «в очереди». После входа он должен поехать сам, а не ждать, пока человек
    // вспомнит и нажмёт ещё раз
    const drafts: any[] = [
      { id: 'dep|u1|d1', deploymentId: 'dep', userId: 'u1', draftId: 'd1', updatedAt: 1,
        state: 'QUEUED', clientRequestId: body.clientRequestId, fields: { ...body }, attachments: [] },
      { id: 'dep|u1|d2', deploymentId: 'dep', userId: 'u1', draftId: 'd2', updatedAt: 2,
        state: 'SENT', clientRequestId: body.clientRequestId, fields: { ...body }, attachments: [] },
      { id: 'dep|u1|d3', deploymentId: 'dep', userId: 'u1', draftId: 'd3', updatedAt: 3,
        state: 'EDITING', fields: { ...body }, attachments: [] },
    ];
    const restored = drafts
      .filter((d) => ['QUEUED', 'UPLOADING', 'COMMITTING', 'FAILED_RETRYABLE'].includes(d.state))
      .map(packageFromDraft)
      .filter(Boolean);
    ok('к отправке возвращается только незаконченное', restored.length === 1, restored.length);
    ok('и это тот самый черновик', restored[0]?.draftId === 'd1', restored[0]?.draftId);
    ok('отправленное второй раз не едет', !restored.some((p: any) => p.draftId === 'd2'));
    ok('недописанное не едет тоже', !restored.some((p: any) => p.draftId === 'd3'));
  }

  console.log(`\nПройдено: ${passed}, провалено: ${failed}`);
  if (failed) { console.log('ЕСТЬ ПРОВАЛЫ'); process.exit(1); }
  console.log('ВСЕ ТЕСТЫ ПРОЙДЕНЫ');
}

main().catch((error) => { console.error('Набор не отработал:', error); process.exit(1); });
