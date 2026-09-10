/**
 * Отметки прочитанного и счётчик непрочитанного.
 *
 * Самая тихая поломка из всех, что нашлись: окно слало `seenRevision: 0` —
 * поля, которого сервер не знает вовсе. Сервер читает `publicRevision` и
 * `internalRevision`, брал из пустого тела нули и писал `Math.max(что было, 0)`,
 * то есть не двигал отметку НИКОГДА. Красный кружок у автора не гас после
 * прочтения ни разу: человек открывал карточку, не находил ничего нового и
 * переставал верить счётчику вообще.
 *
 * Проверяется путь целиком, настоящими запросами: счётчик вырос → карточку
 * прочитали → счётчик погас → пришёл новый публичный ответ → счётчик вырос
 * снова. И отдельно — что внутренняя переписка обработчиков автору счётчик не
 * растит и прочитанной ему не отмечается.
 *
 * Запуск (нужен поднятый сервер):
 *   nohup npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-feedback-read.ts
 */

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

const uuid = (): string => {
  const hex = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const head = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function login(symbol: string, password: string): Promise<string> {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, password }),
  }).then((x) => x.json());
  return r?.token || r?.data?.token || '';
}

async function main() {
  const alive = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
  if (!alive) { console.log('Сервер не отвечает — набор пропущен. Поднимите: npx tsx server.ts'); process.exit(2); }

  const stamp = Date.now();
  const adminToken = await login(ADMIN.symbol, ADMIN.password);
  if (!adminToken) { console.log('Вход администратора не удался — набор пропущен'); process.exit(2); }

  console.log('1. Заводим автора и его обращение');
  const pass = `Pw${stamp}!`;
  const symbol = `fbr${stamp}`.slice(0, 12);
  const made = await fetch(`${BASE}/api/users`, {
    method: 'POST', headers: head(adminToken),
    body: JSON.stringify({ name: `Проверка чтения ${stamp}`, symbol, password: pass, role: 'ENGINEER_VENT' }),
  }).then((r) => r.json());
  ok('сотрудник заведён', !!(made?.data?.id || made?.id), made?.error);

  const authorToken = await login(symbol, pass);
  ok('автор вошёл', !!authorToken);
  if (!authorToken) { console.log('\nПРОВАЛОВ:', ++failed); process.exit(1); }

  // Контур спрашиваем у сервера: чужой он не примет, и это правильно —
  // черновик из другой базы не должен уезжать сюда
  const meta = await fetch(`${BASE}/api/feedback/meta`, { headers: head(authorToken) }).then((r) => r.json());
  const deploymentId = meta?.data?.deploymentId || '';
  ok('контур спрошен у сервера', !!deploymentId, meta?.error);

  const created = await fetch(`${BASE}/api/feedback/reports`, {
    method: 'POST', headers: head(authorToken),
    body: JSON.stringify({
      schemaVersion: 1, clientRequestId: uuid(), deploymentId, type: 'BUG',
      description: `__чтение ${stamp}. Проверяем счётчик непрочитанного.`,
      sectionKey: '/feedback', incidentAt: new Date().toISOString(), appVersion: '1.2.0',
      frequency: 'ALWAYS', impact: 'NORMAL', uploadIds: [],
      consent: { technicalEvents: false, appContext: true, reviewedAt: new Date().toISOString() },
    }),
  }).then((r) => r.json());
  const reportId = created?.data?.id;
  ok('обращение заведено', !!reportId, created?.error);
  if (!reportId) { console.log('\nПРОВАЛОВ:', ++failed); process.exit(1); }

  const unread = async (token: string) =>
    fetch(`${BASE}/api/feedback/unread`, { headers: head(token) }).then((r) => r.json());
  const card = async (token: string) =>
    fetch(`${BASE}/api/feedback/reports/${reportId}`, { headers: head(token) }).then((r) => r.json());
  const read = async (token: string, body: Record<string, unknown>) =>
    fetch(`${BASE}/api/feedback/reports/${reportId}/read`, {
      method: 'POST', headers: head(token), body: JSON.stringify(body),
    }).then((r) => r.json());

  console.log('\n2. Сервер говорит, докуда можно отметить');
  const first = await card(authorToken);
  ok('публичная граница пришла с сервера',
    typeof first?.data?.publicRevision === 'number' && first.data.publicRevision > 0,
    first?.data?.publicRevision);
  ok('внутренняя граница автору не отдаётся',
    first?.data?.internalRevision === 0, first?.data?.internalRevision);

  /** Ответить от имени обработчика. Ревизию спрашиваем: её требует сервер. */
  const say = async (text: string, visibility: 'PUBLIC' | 'INTERNAL') => {
    const now = await card(adminToken);
    return fetch(`${BASE}/api/feedback/reports/${reportId}/comments`, {
      method: 'POST', headers: head(adminToken),
      body: JSON.stringify({
        text, visibility, clientRequestId: uuid(),
        expectedRevision: now?.data?.revision,
      }),
    }).then((r) => r.json());
  };

  console.log('\n3. Публичный ответ растит счётчик, а прочтение его гасит');
  // Сначала гасим то, что накопилось от создания: проверяем именно реакцию на
  // ответ, а не остаток от предыдущего шага
  const before = await card(authorToken);
  await read(authorToken, { publicRevision: before?.data?.publicRevision || 0, internalRevision: 0 });

  const answer = await say('Разбираемся, спасибо.', 'PUBLIC');
  ok('обработчик ответил публично', !answer?.error, answer?.error);

  const grew = await unread(authorToken);
  ok('счётчик у автора вырос', (grew?.data?.mine ?? 0) > 0, grew?.data);

  const afterAnswer = await card(authorToken);
  const mark = await read(authorToken, {
    publicRevision: afterAnswer?.data?.publicRevision || 0,
    internalRevision: 0,
  });
  ok('отметка принята', !mark?.error, mark?.error);

  const quiet = await unread(authorToken);
  // Ради этой строки всё и чинилось: раньше она была невыполнима в принципе
  ok('счётчик погас после прочтения', (quiet?.data?.mine ?? 1) === 0, quiet?.data);

  console.log('\n4. Новый ответ снова растит счётчик');
  await say('Исправление уехало в сборку.', 'PUBLIC');
  const again = await unread(authorToken);
  ok('счётчик вырос на новый ответ', (again?.data?.mine ?? 0) > 0, again?.data);

  console.log('\n5. Внутренняя переписка автора не касается');
  const beforeInternal = await card(authorToken);
  await read(authorToken, {
    publicRevision: beforeInternal?.data?.publicRevision || 0, internalRevision: 0,
  });
  const calm = await unread(authorToken);
  ok('после прочтения снова тихо', (calm?.data?.mine ?? 1) === 0, calm?.data);

  const inner = await say('Внутреннее: похоже на гонку в очереди.', 'INTERNAL');
  ok('внутренняя заметка записана', !inner?.error, inner?.error);

  const afterInternal = await unread(authorToken);
  ok('внутренняя заметка счётчик автора не растит', (afterInternal?.data?.mine ?? 1) === 0, afterInternal?.data);

  // Попытка автора отметить внутреннее прочитанным не должна проходить: он
  // этого не видел, и записать обратное значит соврать самим себе
  const cheat = await read(authorToken, { publicRevision: 1, internalRevision: 9999 });
  ok('автору внутреннюю отметку не записывают', (cheat?.data?.internalRevision ?? 0) === 0, cheat?.data);

  console.log('\n6. Обработчику внутреннее видно и отмечается');
  const forTriage = await card(adminToken);
  ok('обработчику отдают обе границы',
    (forTriage?.data?.internalRevision ?? 0) > 0, forTriage?.data?.internalRevision);
  const triageMark = await read(adminToken, {
    publicRevision: forTriage?.data?.publicRevision || 0,
    internalRevision: forTriage?.data?.internalRevision || 0,
  });
  ok('отметка обработчика записана',
    (triageMark?.data?.internalRevision ?? 0) > 0, triageMark?.data);

  console.log('\n7. Действия обработчика доводятся до конца');
  /**
   * Раньше окно слало только причину, а сервер требовал ещё исполнителя,
   * версию исправления и целевую карточку — и отвечал отказом. «Взять в
   * работу» и «Отдать на проверку» не работали вовсе: человек нажимал кнопку и
   * получал «Так менять нельзя», не понимая, чем провинился.
   */
  const move = async (to: string, extra: Record<string, unknown> = {}) => {
    const now = await card(adminToken);
    return fetch(`${BASE}/api/feedback/reports/${reportId}/transition`, {
      method: 'POST', headers: head(adminToken),
      body: JSON.stringify({ to, clientRequestId: uuid(), expectedRevision: now?.data?.revision, ...extra }),
    }).then((r) => r.json());
  };

  const who = await fetch(`${BASE}/api/feedback/assignees`, { headers: head(adminToken) })
    .then((r) => r.json());
  ok('список исполнителей отдаётся разбирающему', Array.isArray(who?.data) && who.data.length > 0, who?.error);
  ok('автору список исполнителей не отдают',
    (await fetch(`${BASE}/api/feedback/assignees`, { headers: head(authorToken) }).then((r) => r.json()))?.error?.code
      === 'FORBIDDEN');

  const noAssignee = await move('IN_PROGRESS');
  ok('без исполнителя в работу не берут', !!noAssignee?.error, noAssignee?.data?.status);

  await move('TRIAGE');
  const started = await move('IN_PROGRESS', { assigneeId: who?.data?.[0]?.id });
  ok('с исполнителем — берут', started?.data?.status === 'IN_PROGRESS', started?.error || started?.data?.status);
  // Спрашиваем карточку, а не верим ответу перехода: важно, что записалось,
  // а не что вернулось
  const inWork = await card(adminToken);
  ok('исполнитель записан', !!inWork?.data?.assigneeId, inWork?.data?.assigneeId);

  const noRelease = await move('VERIFY');
  ok('без версии на проверку не отдают', !!noRelease?.error, noRelease?.data?.status);

  const verify = await move('VERIFY', { resolvedVersion: '1.3.0' });
  ok('с версией — отдают', verify?.data?.status === 'VERIFY', verify?.error || verify?.data?.status);
  const onVerify = await card(adminToken);
  ok('версия исправления записана', onVerify?.data?.resolvedVersion === '1.3.0', onVerify?.data?.resolvedVersion);
  ok('автор видит, в какой версии проверять',
    (await card(authorToken))?.data?.resolvedVersion === '1.3.0');

  // Второй путь того же перехода: выпуска не будет, и это сказано словами
  const other = await fetch(`${BASE}/api/feedback/reports`, {
    method: 'POST', headers: head(authorToken),
    body: JSON.stringify({
      schemaVersion: 1, clientRequestId: uuid(), deploymentId, type: 'BUG',
      description: `__чтение ${stamp} второе. Проверяем «без выпуска».`,
      sectionKey: '/feedback', incidentAt: new Date().toISOString(), appVersion: '1.2.0',
      frequency: 'ALWAYS', impact: 'NORMAL', uploadIds: [],
      consent: { technicalEvents: false, appContext: true, reviewedAt: new Date().toISOString() },
    }),
  }).then((r) => r.json());
  const secondId = other?.data?.id;
  const moveSecond = async (to: string, extra: Record<string, unknown> = {}) => {
    const now = await fetch(`${BASE}/api/feedback/reports/${secondId}`, { headers: head(adminToken) })
      .then((r) => r.json());
    return fetch(`${BASE}/api/feedback/reports/${secondId}/transition`, {
      method: 'POST', headers: head(adminToken),
      body: JSON.stringify({ to, clientRequestId: uuid(), expectedRevision: now?.data?.revision, ...extra }),
    }).then((r) => r.json());
  };
  await moveSecond('TRIAGE');
  await moveSecond('IN_PROGRESS', { assigneeId: who?.data?.[0]?.id });
  const noRelease2 = await moveSecond('VERIFY', { noReleaseReason: 'Настройка на сервере, обновление не нужно' });
  ok('«без выпуска» с объяснением тоже проходит',
    noRelease2?.data?.status === 'VERIFY', noRelease2?.error || noRelease2?.data?.status);

  console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('ПАДЕНИЕ', e); process.exit(1); });
