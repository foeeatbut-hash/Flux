import { testCredentials } from './testCredentials';
/**
 * Личная переписка не должна приходить посторонним.
 *
 * Раньше сервер рассылал события чата всем подключённым (io.emit): интерфейс
 * чужие сообщения прятал, но текст всё равно приходил на каждую машину в сети —
 * его было видно в отладчике браузера. Теперь у каждого сокета своя комната
 * `user:<id>`, и событие уходит только собеседникам.
 *
 * Эту вещь нельзя проверить разбором кода — нужны три живых подключения.
 * Скрипт заводит двух временных сотрудников, поднимает три сокета
 * (отправитель, получатель, посторонний), шлёт сообщение и смотрит, кому оно
 * пришло. Временные профили удаляются в конце в любом случае.
 *
 * Порядок:
 *   nohup npx tsx server.ts &
 *   npx tsx scripts/test-chat-privacy.ts
 */
import { io as ioClient, Socket } from 'socket.io-client';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = testCredentials();

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 200) : ''));

const api = async (token: string, method: string, url: string, body?: any) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null, text }; }
};

const login = async (symbol: string, password: string) => {
  const r = await api('', 'POST', '/api/login', { symbol, password });
  return { token: r.json?.token as string, id: r.json?.user?.id as string };
};

/** Подключение с токеном; собирает все входящие chat:new */
const connect = (token: string) =>
  new Promise<{ socket: Socket; got: any[] }>((resolve, reject) => {
    const got: any[] = [];
    const socket = ioClient(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.on('chat:message_received', (m: any) => got.push(m));
    socket.on('connect', () => resolve({ socket, got }));
    socket.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('сокет не подключился за 8 с')), 8000);
  });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    await fetch(BASE + '/api/health');
  } catch {
    console.error(`Сервер на ${BASE} не отвечает. Поднимите его: npx tsx server.ts`);
    process.exit(2);
  }

  const admin = await login(ADMIN.symbol, ADMIN.password);
  if (!admin.token) { console.error('Не удалось войти администратором.'); process.exit(2); }

  const stamp = Date.now().toString(36);
  const made: string[] = [];
  const mkUser = async (tag: string) => {
    const symbol = `__chat_${tag}_${stamp}`;
    const r = await api(admin.token, 'POST', '/api/users', {
      symbol, lastName: 'Проверкин', firstName: tag, role: 'ENGINEER_VENT', password: 'проверка',
    });
    const id = r.json?.id || r.json?.user?.id;
    if (id) made.push(id);
    return { id, symbol, password: 'проверка' };
  };

  try {
    console.log('1. Подготовка: два временных сотрудника');
    const b = await mkUser('b');
    const c = await mkUser('c');
    ok('получатель заведён', !!b.id);
    ok('посторонний заведён', !!c.id);
    if (!b.id || !c.id) throw new Error('не удалось завести временных сотрудников');

    const bAuth = await login(b.symbol, b.password);
    const cAuth = await login(c.symbol, c.password);
    ok('получатель вошёл', !!bAuth.token);
    ok('посторонний вошёл', !!cAuth.token);

    console.log('2. Сокеты пускают только по токену');
    let refused = false;
    try {
      await connect('заведомо-негодный-токен');
    } catch { refused = true; }
    ok('без действительного токена сокет не подключается', refused);

    const A = await connect(admin.token);
    const B = await connect(bAuth.token);
    const C = await connect(cAuth.token);
    ok('три подключения установлены', !!A.socket.id && !!B.socket.id && !!C.socket.id);

    console.log('3. Сообщение уходит только собеседникам');
    const text = `тайное сообщение ${stamp}`;
    const sent = await api(admin.token, 'POST', '/api/chat/messages', {
      senderId: admin.id, receiverId: b.id, content: text,
    });
    ok('сообщение отправлено', sent.status === 200 || sent.status === 201, { s: sent.status, b: sent.text });
    await wait(1500);

    const hasText = (arr: any[]) => arr.some((m) => JSON.stringify(m).includes(text));
    ok('получатель получил сообщение', hasText(B.got), B.got.length);
    ok('отправитель получил своё сообщение', hasText(A.got), A.got.length);
    ok('ПОСТОРОННИЙ НЕ ПОЛУЧИЛ сообщение', !hasText(C.got), C.got);

    console.log('4. Переписку не вычитать и через API');
    const peek = await api(cAuth.token, 'GET', `/api/chat/messages?senderId=${admin.id}&receiverId=${b.id}`);
    const leaked = JSON.stringify(peek.json || {}).includes(text);
    ok('посторонний не читает чужую переписку', !leaked && peek.status === 403, { status: peek.status, leaked });

    const mine = await api(bAuth.token, 'GET', `/api/chat/messages?senderId=${admin.id}&receiverId=${b.id}`);
    ok('участник свою переписку читает', mine.status === 200 && JSON.stringify(mine.json).includes(text), mine.status);

    console.log('5. Нельзя писать и править от чужого имени');
    const forgery = await api(cAuth.token, 'POST', '/api/chat/messages', {
      senderId: admin.id, receiverId: b.id, content: 'подделка от имени администратора',
    });
    ok('нельзя отправить сообщение от чужого имени', forgery.status === 403, forgery.status);

    const msgId = sent.json?.id;
    if (msgId) {
      const edit = await api(cAuth.token, 'PUT', `/api/chat/messages/${msgId}`, { userId: admin.id, content: 'подменено' });
      ok('нельзя отредактировать чужое сообщение', edit.status === 403, edit.status);

      const kill = await api(cAuth.token, 'DELETE', `/api/chat/messages/${msgId}?userId=${admin.id}`);
      ok('нельзя удалить чужое сообщение', kill.status === 403, kill.status);

      const react = await api(cAuth.token, 'POST', `/api/chat/messages/${msgId}/react`, { userId: admin.id, emoji: '👍' });
      ok('нельзя реагировать в чужом диалоге', react.status === 403, react.status);

      const own = await api(admin.token, 'PUT', `/api/chat/messages/${msgId}`, { content: text + ' (правка)' });
      ok('автор своё сообщение правит', own.status === 200, own.status);
    } else {
      ok('идентификатор отправленного сообщения получен', false, sent.json);
    }

    console.log('6. Группы: чужую не прочитать');
    const grp = await api(admin.token, 'POST', '/api/chat/groups', {
      name: `__проверка_${stamp}`, ownerId: admin.id, memberIds: [b.id], type: 'GROUP',
    });
    const gid = grp.json?.id || grp.json?.group?.id;
    ok('группа создана', !!gid, { s: grp.status, b: grp.text });
    if (gid) {
      const outsider = await api(cAuth.token, 'GET', `/api/chat/group-messages?groupId=${gid}`);
      ok('посторонний не читает переписку группы', outsider.status === 403, outsider.status);

      const member = await api(bAuth.token, 'GET', `/api/chat/group-messages?groupId=${gid}`);
      ok('участник группы переписку читает', member.status === 200, member.status);

      const intruder = await api(cAuth.token, 'POST', '/api/chat/group-messages', {
        senderId: c.id, groupId: gid, content: 'я сюда не звался',
      });
      ok('посторонний не пишет в группу', intruder.status === 403, intruder.status);

      await api(admin.token, 'DELETE', `/api/chat/groups/${gid}?userId=${admin.id}`).catch(() => {});
    }

    A.socket.close(); B.socket.close(); C.socket.close();
  } finally {
    // Временные профили убираем в любом случае — база остаётся чистой
    for (const id of made) await api(admin.token, 'DELETE', `/api/users/${id}`).catch(() => {});
  }

  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
