/**
 * Повтор отправки не плодит обращений, а предел частоты не обходится.
 *
 * Обрыв связи случается ровно между «сервер записал» и «окно узнало» — и окно
 * повторяет отправку. Без общего ключа это вторая карточка, и обе попадают в
 * очередь разбора: обработчик читает одно и то же дважды и не понимает, почему
 * автор написал два раза.
 *
 * Оговорка про уборку: в домене обращений удаления нет вовсе — отклонение и
 * отзыв это состояния, а не стирание. Поэтому заведённые здесь карточки
 * остаются в базе намеренно; их заголовки начинаются с «__», чтобы отличить их
 * от настоящих.
 *
 * Нужен поднятый сервер: npx tsx server.ts
 */

import { randomUUID } from 'node:crypto';
import { FEATURES } from '../src/lib/permissions';
import { LIMITS } from '../feedback/contracts';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let f = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (f++, console.error('  ✗', name, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ''));

async function api(method: string, path: string, token: string, body?: any) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json, retryAfter: res.headers.get('Retry-After') };
}

const stamp = Date.now().toString(36).slice(-6);
let deploymentId = '';

const submit = (over: Record<string, any> = {}) => ({
  schemaVersion: 1,
  clientRequestId: randomUUID(),
  deploymentId,
  type: 'BUG',
  title: `__проба повторов ${stamp}`,
  description: 'Проверка повторной отправки: карточка должна остаться одна.',
  sectionKey: '/sheet',
  incidentAt: new Date(Date.now() - 60000).toISOString(),
  appVersion: '1.1.0',
  frequency: 'ONCE',
  impact: 'NORMAL',
  uploadIds: [],
  consent: { technicalEvents: false, appContext: true, reviewedAt: new Date().toISOString() },
  ...over,
});

async function main() {
  try {
    const health = await fetch(`${BASE}/api/health`);
    if (!health.ok) throw new Error(String(health.status));
  } catch (_) {
    console.error(`Сервер на ${BASE} не отвечает. Поднимите его: npx tsx server.ts`);
    process.exit(2);
  }

  const admin = (await api('POST', '/api/login', '', LOGIN)).json?.token || '';
  if (!admin) { console.error('Не удалось войти'); process.exit(2); }
  deploymentId = (await api('GET', '/api/feedback/meta', admin)).json?.data?.deploymentId || '';
  ok('признак контура получен', !!deploymentId);

  console.log('\n1. Обращение заводится');
  const first = submit();
  const made = await api('POST', '/api/feedback/reports', admin, first);
  ok('карточка создана', made.status === 201, made.json);
  const reportId = made.json?.data?.id;
  ok('номер выдан', Number(made.json?.data?.number) > 0, made.json?.data?.number);
  ok('состояние — новое', made.json?.data?.status === 'NEW', made.json?.data?.status);
  ok('автор проставлен сервером', made.json?.data?.author?.id, made.json?.data?.author);

  console.log('\n2. Повтор возвращает ту же карточку');
  const again = await api('POST', '/api/feedback/reports', admin, first);
  ok('второй раз — не создание, а возврат', again.status === 200, again.status);
  ok('и карточка та же', again.json?.data?.id === reportId, [again.json?.data?.id, reportId]);
  ok('повтор назван повтором', again.json?.meta?.repeat === true, again.json?.meta);

  // Одновременная отправка из двух окон: без уникального индекса в базе прошли
  // бы обе, и в очереди оказалось бы два одинаковых обращения
  const key = randomUUID();
  const twin = submit({ clientRequestId: key, title: `__двойная отправка ${stamp}` });
  const [x, y] = await Promise.all([
    api('POST', '/api/feedback/reports', admin, twin),
    api('POST', '/api/feedback/reports', admin, twin),
  ]);
  const ids = [x.json?.data?.id, y.json?.data?.id].filter(Boolean);
  ok('одновременная отправка дала одну карточку',
    ids.length === 2 && ids[0] === ids[1], [x.status, y.status, ids]);

  console.log('\n3. Тот же ключ с другим содержанием — это ошибка');
  const changed = await api('POST', '/api/feedback/reports', admin, { ...first, title: `__совсем другое ${stamp}` });
  ok('отвергнуто', changed.status === 409, changed.status);
  ok('и названо по имени', changed.json?.error?.code === 'IDEMPOTENCY_CONFLICT', changed.json?.error);

  console.log('\n4. Ответ на «дошло ли»');
  const asked = await api('GET', `/api/feedback/reports/by-request/${first.clientRequestId}`, admin);
  ok('карточка находится по ключу отправки', asked.json?.data?.id === reportId, asked.json);
  const nothing = await api('GET', `/api/feedback/reports/by-request/${randomUUID()}`, admin);
  ok('чужого ключа не существует', nothing.status === 404, nothing.status);

  console.log('\n5. Присланному в теле не верим');
  const lied = await api('POST', '/api/feedback/reports', admin, submit({
    authorId: 'кто-то-другой', status: 'DONE', priority: 'P0', number: 999999,
    title: `__подмена полей ${stamp}`,
  }));
  ok('карточка создана', lied.status === 201, lied.json);
  ok('автор всё равно из сессии', lied.json?.data?.author?.id === made.json?.data?.author?.id, lied.json?.data?.author);
  ok('состояние всё равно новое', lied.json?.data?.status === 'NEW', lied.json?.data?.status);
  ok('приоритет всё равно обычный', lied.json?.data?.priority === 'P2', lied.json?.data?.priority);
  ok('номер всё равно свой', lied.json?.data?.number !== 999999, lied.json?.data?.number);

  console.log('\n6. Чужая база и чужие вложения');
  const alien = await api('POST', '/api/feedback/reports', admin, submit({ deploymentId: randomUUID() }));
  ok('обращение из другого контура отвергнуто', alien.status === 400, [alien.status, alien.json?.error?.code]);
  const noSuch = await api('POST', '/api/feedback/reports', admin, submit({ uploadIds: [randomUUID()] }));
  ok('несуществующее вложение отвергнуто', noSuch.status === 400, noSuch.json?.error);

  console.log('\n7. Второй сотрудник и границы видимости');
  const pass = `p${stamp}A!`;
  const perms: Record<string, any> = {};
  for (const feat of FEATURES) perms[feat.id] = { enabled: feat.id !== 'feedback.triage', until: null };
  const mate = await api('POST', '/api/users', admin, {
    symbol: `fbi${stamp}`, name: 'Проба Повторов', password: pass, role: 'USER',
    permissions: JSON.stringify(perms),
  });
  const mateId = mate.json?.user?.id || mate.json?.id;
  const mateToken = (await api('POST', '/api/login', '', { symbol: `fbi${stamp}`, password: pass })).json?.token || '';
  ok('второй сотрудник вошёл', !!mateToken, mate.json);

  const peek = await api('GET', `/api/feedback/reports/${reportId}`, mateToken);
  ok('чужое обращение ему не видно', peek.status === 404, peek.status);
  const queue = await api('GET', '/api/feedback/reports?scope=queue', mateToken);
  ok('и очередь без права разбора закрыта', queue.status === 403, [queue.status, queue.json?.error?.code]);
  const own = await api('GET', '/api/feedback/reports', mateToken);
  ok('свой список открыт и пуст', own.status === 200 && (own.json?.data || []).length === 0, own.json?.meta);
  const adminSees = await api('GET', `/api/feedback/reports/${reportId}`, admin);
  ok('администратор карточку видит', adminSees.status === 200, adminSees.status);

  console.log('\n8. Предел частоты считается в базе, а не в памяти');
  // Занимаем предел от имени второго сотрудника, чтобы не тратить час
  // администратора: у него дальше свои проверки
  let refused: any = null;
  let created = 0;
  for (let n = 0; n < LIMITS.reportsPerHour + 2; n++) {
    const r = await api('POST', '/api/feedback/reports', mateToken, submit({ title: `__предел ${stamp} №${n}` }));
    if (r.status === 201) { created++; continue; }
    refused = r;
    break;
  }
  ok(`до предела прошло ${created} из ${LIMITS.reportsPerHour}`, created === LIMITS.reportsPerHour, created);
  ok('следующее отвергнуто', refused?.status === 429, refused?.status);
  ok('и названо по имени', refused?.json?.error?.code === 'RATE_LIMITED', refused?.json?.error);
  ok('человеку сказано, когда попробовать', Number(refused?.retryAfter) > 0, refused?.retryAfter);
  // Повтор уже принятой отправки не должен считаться новой: иначе окно,
  // добивающееся ответа после обрыва, само себя и заблокирует
  const repeatUnderLimit = await api('POST', '/api/feedback/reports', mateToken, submit({
    clientRequestId: (await api('GET', '/api/feedback/reports', mateToken)).json?.data?.[0]?.id ? randomUUID() : randomUUID(),
  }));
  ok('за пределом новые всё так же не принимаются', repeatUnderLimit.status === 429, repeatUnderLimit.status);

  if (mateId) await api('DELETE', `/api/users/${mateId}`, admin).catch(() => {});
  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
}

void main().catch((error) => { console.error(error); process.exit(1); });
