/**
 * Внутреннее не доходит до автора, а два обработчика не перетирают друг друга.
 *
 * Первое — не про удобство, а про доверие. Обработчики обсуждают обращение
 * между собой прямо в карточке: «это уже третий раз», «спросить, не он ли
 * менял настройку». Если хоть один путь отдаёт такую заметку автору — списком,
 * счётчиком непрочитанного, историей событий или ответом на другой запрос, —
 * пользоваться внутренними заметками больше нельзя вообще.
 *
 * Поэтому проверяются все пути, а не один: фильтр, написанный над готовым
 * ответом, однажды забывают в новом маршруте, и заметка утекает именно там.
 *
 * Второе — про совместную работу. Два обработчика, открывшие карточку
 * одновременно, не должны молча перезаписать решение друг друга.
 *
 * Нужен поднятый сервер: npx tsx server.ts
 */

import { randomUUID } from 'node:crypto';
import { FEATURES } from '../src/lib/permissions';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const SECRET = 'ВНУТРЕННЯЯ_ЗАМЕТКА_НЕ_ДЛЯ_АВТОРА';

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
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json, text };
}

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
  const stamp = Date.now().toString(36).slice(-6);
  const deploymentId = (await api('GET', '/api/feedback/meta', admin)).json?.data?.deploymentId || '';

  /**
   * Автор — обычный сотрудник, каким его заводит программа.
   *
   * Здесь ему выдавали ВСЁ, кроме разбора, — в том числе технические
   * вложения. Это расходилось с настройками по умолчанию (`DEFAULT_DENIED`) и
   * делало проверку мягче, чем жизнь: пакет диагностики такому «обычному
   * сотруднику» отдавался, и никто бы этого не заметил.
   */
  const pass = `p${stamp}A!`;
  const denied = ['feedback.triage', 'feedback.diagnostics', 'feedback.manage'];
  const perms: Record<string, any> = {};
  for (const feat of FEATURES) perms[feat.id] = { enabled: !denied.includes(feat.id), until: null };
  const mk = await api('POST', '/api/users', admin, {
    symbol: `fbp${stamp}`, name: 'Проба Приватности', password: pass, role: 'USER',
    permissions: JSON.stringify(perms),
  });
  const authorId = mk.json?.user?.id || mk.json?.id;
  const author = (await api('POST', '/api/login', '', { symbol: `fbp${stamp}`, password: pass })).json?.token || '';
  ok('автор вошёл', !!author, mk.json);

  console.log('\n1. Автор завёл обращение');
  const made = await api('POST', '/api/feedback/reports', author, {
    schemaVersion: 1, clientRequestId: randomUUID(), deploymentId, type: 'BUG',
    title: `__приватность ${stamp}`,
    description: 'Проверка: внутренние заметки не должны доходить до автора.',
    sectionKey: '/sheet', incidentAt: new Date(Date.now() - 60000).toISOString(),
    appVersion: '1.1.0', frequency: 'ONCE', impact: 'NORMAL', uploadIds: [],
    consent: { technicalEvents: false, appContext: true, reviewedAt: new Date().toISOString() },
  });
  ok('карточка создана', made.status === 201, made.json);
  const id = made.json?.data?.id;
  let revision = made.json?.data?.revision || 1;

  console.log('\n2. Обработчик пишет внутреннюю заметку и меняет приоритет');
  const note = await api('POST', `/api/feedback/reports/${id}/comments`, admin, {
    clientRequestId: randomUUID(), expectedRevision: revision,
    text: SECRET, visibility: 'INTERNAL',
  });
  ok('заметка записана', note.status === 200, note.json);
  revision = note.json?.data?.revision || revision + 1;

  const prio = await api('POST', `/api/feedback/reports/${id}/priority`, admin, {
    clientRequestId: randomUUID(), expectedRevision: revision, priority: 'P1',
  });
  ok('приоритет изменён', prio.status === 200, prio.json);
  revision = prio.json?.data?.revision || revision + 1;

  console.log('\n3. Автор не видит внутреннего ни одним путём');
  const seen: Array<[string, string]> = [];
  const comments = await api('GET', `/api/feedback/reports/${id}/comments`, author);
  seen.push(['список сообщений', comments.text]);
  const events = await api('GET', `/api/feedback/reports/${id}/events`, author);
  seen.push(['история событий', events.text]);
  const cardSelf = await api('GET', `/api/feedback/reports/${id}`, author);
  seen.push(['карточка', cardSelf.text]);
  const list = await api('GET', '/api/feedback/reports', author);
  seen.push(['список обращений', list.text]);
  const actions = await api('GET', `/api/feedback/reports/${id}/actions`, author);
  seen.push(['доступные действия', actions.text]);

  for (const [where, text] of seen) {
    ok(`в «${where}» заметки нет`, !String(text).includes(SECRET), String(text).slice(0, 160));
  }
  ok('внутренних событий автору не видно',
    !(events.json?.data || []).some((e: any) => e.visibility === 'INTERNAL'),
    (events.json?.data || []).map((e: any) => `${e.kind}:${e.visibility}`));
  ok('внутренних сообщений автору не видно',
    !(comments.json?.data || []).some((c: any) => c.visibility === 'INTERNAL'),
    (comments.json?.data || []).map((c: any) => c.visibility));

  console.log('\n3.1. Счётчик непрочитанного молчит о внутреннем');
  // Самый тихий путь утечки: заметки автор не видит, но красный кружок на
  // разделе растёт. Человек открывает карточку, не находит ничего нового — и
  // перестаёт верить счётчику вообще
  await api('POST', `/api/feedback/reports/${id}/read`, author, { publicRevision: revision });
  const quiet = await api('GET', '/api/feedback/unread', author);
  const beforeNote = quiet.json?.data?.mine ?? -1;
  const note2 = await api('POST', `/api/feedback/reports/${id}/comments`, admin, {
    clientRequestId: randomUUID(), expectedRevision: revision,
    text: `${SECRET} второй раз`, visibility: 'INTERNAL',
  });
  revision = note2.json?.data?.revision || revision + 1;
  const afterNote = await api('GET', '/api/feedback/unread', author);
  ok('после внутренней заметки счётчик автора не вырос',
    (afterNote.json?.data?.mine ?? -1) === beforeNote, [beforeNote, afterNote.json?.data]);

  console.log('\n3.2. Выгрузка автору отдаёт только его половину');
  const exported = await api('GET', `/api/feedback/reports/${id}/export`, author);
  ok('выгрузка отдалась', exported.status === 200, exported.json?.error);
  ok('внутренней заметки в выгрузке нет',
    !String(exported.json?.data?.markdown || '').includes(SECRET),
    String(exported.json?.data?.markdown || '').slice(0, 200));
  const exportedByAdmin = await api('GET', `/api/feedback/reports/${id}/export`, admin);
  ok('обработчику она в выгрузке видна',
    String(exportedByAdmin.json?.data?.markdown || '').includes(SECRET));

  console.log('\n3.3. Сводка и дубли — не для автора');
  ok('сводка закрыта', (await api('GET', '/api/feedback/summary', author)).status === 403);
  ok('кандидаты в дубли закрыты',
    (await api('GET', `/api/feedback/reports/${id}/duplicates`, author)).status === 403);
  ok('обработчику сводка отдаётся', (await api('GET', '/api/feedback/summary', admin)).status === 200);

  console.log('\n4. Обработчик видит всё, что писал');
  const asAdmin = await api('GET', `/api/feedback/reports/${id}/comments`, admin);
  ok('заметка на месте', String(asAdmin.text).includes(SECRET));
  const adminEvents = await api('GET', `/api/feedback/reports/${id}/events`, admin);
  ok('внутренние события видны',
    (adminEvents.json?.data || []).some((e: any) => e.visibility === 'INTERNAL'),
    (adminEvents.json?.data || []).map((e: any) => `${e.kind}:${e.visibility}`));

  console.log('\n5. Автор не может писать внутренние заметки');
  const sneak = await api('POST', `/api/feedback/reports/${id}/comments`, author, {
    clientRequestId: randomUUID(), expectedRevision: revision,
    text: 'попробую внутреннюю', visibility: 'INTERNAL',
  });
  ok('попытка отвергнута', sneak.status === 403, [sneak.status, sneak.json?.error?.code]);

  console.log('\n6. Публичный ответ до автора доходит');
  const reply = await api('POST', `/api/feedback/reports/${id}/comments`, admin, {
    clientRequestId: randomUUID(), expectedRevision: revision,
    text: 'Разбираемся, спасибо', visibility: 'PUBLIC',
  });
  ok('ответ записан', reply.status === 200, reply.json);
  revision = reply.json?.data?.revision || revision + 1;
  const afterReply = await api('GET', `/api/feedback/reports/${id}/comments`, author);
  ok('автор его видит', String(afterReply.text).includes('Разбираемся'), afterReply.text.slice(0, 200));
  ok('и заметки рядом с ним по-прежнему нет', !String(afterReply.text).includes(SECRET));

  console.log('\n7. Два обработчика не перетирают друг друга');
  const stale = revision - 1;
  const clash = await api('POST', `/api/feedback/reports/${id}/priority`, admin, {
    clientRequestId: randomUUID(), expectedRevision: stale, priority: 'P3',
  });
  ok('изменение по устаревшей ревизии отвергнуто', clash.status === 409, clash.status);
  ok('и названо по имени', clash.json?.error?.code === 'REVISION_CONFLICT', clash.json?.error?.code);
  // Человеку возвращают текущее состояние, чтобы он не гадал, что изменилось
  ok('в отказе есть текущая ревизия', Number(clash.json?.error?.details?.revision) === revision,
    clash.json?.error?.details);

  console.log('\n8. Повтор действия не делает его дважды');
  const key = randomUUID();
  const one = await api('POST', `/api/feedback/reports/${id}/priority`, admin, {
    clientRequestId: key, expectedRevision: revision, priority: 'P0',
  });
  const two = await api('POST', `/api/feedback/reports/${id}/priority`, admin, {
    clientRequestId: key, expectedRevision: revision, priority: 'P0',
  });
  ok('первый раз выполнено', one.status === 200, one.json);
  ok('второй раз — тот же результат', two.status === 200 && two.json?.meta?.repeat === true, two.json);
  ok('ревизия не сдвинулась дважды', one.json?.data?.revision === two.json?.data?.revision,
    [one.json?.data?.revision, two.json?.data?.revision]);
  // Тот же ключ с другим смыслом — уже не повтор
  const twist = await api('POST', `/api/feedback/reports/${id}/priority`, admin, {
    clientRequestId: key, expectedRevision: one.json?.data?.revision, priority: 'P3',
  });
  ok('тот же ключ с другим действием отвергнут', twist.status === 409, [twist.status, twist.json?.error?.code]);

  console.log('\n9. Переходы идут по правилам, а не по желанию');
  const now = (await api('GET', `/api/feedback/reports/${id}`, admin)).json?.data;
  const wrong = await api('POST', `/api/feedback/reports/${id}/transition`, admin, {
    clientRequestId: randomUUID(), expectedRevision: now.revision, to: 'DONE',
  });
  ok('из нового сразу в готово нельзя', wrong.status === 409, [wrong.status, wrong.json?.error?.code]);
  const started = await api('POST', `/api/feedback/reports/${id}/transition`, admin, {
    clientRequestId: randomUUID(), expectedRevision: now.revision, to: 'TRIAGE',
  });
  ok('в разбор — можно', started.status === 200, started.json);
  const noAssignee = await api('POST', `/api/feedback/reports/${id}/transition`, admin, {
    clientRequestId: randomUUID(), expectedRevision: started.json?.data?.revision, to: 'IN_PROGRESS',
  });
  ok('в работу без исполнителя нельзя', noAssignee.status === 409, noAssignee.json?.error?.message);

  /**
   * Пакет для разработчика — по отдельному праву, а не «кому открылась карточка».
   *
   * Автор приложил записи, чтобы помочь разобрать поломку, а не чтобы читать
   * разбор работы программы. Кнопку ему больше не рисуют, но проверять надо не
   * кнопку: прямой запрос по адресу никакой кнопки не спрашивает.
   */
  const mineForAuthor = (await api('GET', '/api/feedback/reports?scope=mine', author)).json?.data || [];
  const ownId = mineForAuthor[0]?.id;
  if (ownId) {
    const denied = await api('GET', `/api/feedback/reports/${ownId}/package`, author);
    ok('автору пакет диагностики не отдают даже по своей карточке',
      denied.status === 403, [denied.status, denied.json?.error?.code]);
    const allowed = await api('GET', `/api/feedback/reports/${ownId}/package`, admin);
    ok('разбирающему — отдают', allowed.status === 200, allowed.status);
  }

  if (authorId) await api('DELETE', `/api/users/${authorId}`, admin).catch(() => {});
  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
}

void main().catch((error) => { console.error(error); process.exit(1); });
