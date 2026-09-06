/**
 * Уведомление приходит толчком, а не вылавливается опросом.
 *
 * Владелец сказал прямо: «сообщения, уведомления приходят с огромной
 * задержкой». Причина была не в сети: новое узнавалось опросом раз в
 * пятнадцать секунд, и ровно на столько же опаздывало окошко Windows — его
 * поднимает окно программы, а окно узнавало из того же опроса.
 *
 * Проверить это разбором кода нельзя: там всё выглядело правильно, просто
 * медленно. Поэтому проба смотрит на время: один сотрудник пишет другому, и у
 * второго уведомление обязано появиться быстрее секунды. Заодно считаются
 * запросы к /api/notifications — если толчок работает, за это время их быть не
 * должно ни одного.
 *
 * Запуск (нужен поднятый сервер):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-notify-live.ts
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

/** Быстрее этого — «сразу»; опрос дал бы пятнадцать секунд */
const FAST_MS = 1000;

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 240) : ''));

const api = async (token: string, method: string, url: string, body?: any) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null as any, text }; }
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { io } = await import('socket.io-client');
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`);
    process.exit(2);
  }

  const admin = await api('', 'POST', '/api/login', ADMIN);
  const adminToken = admin.json?.token || '';
  const adminId = admin.json?.user?.id || '';
  if (!adminToken) { console.error('Не удалось войти администратором.'); process.exit(2); }

  // Второй сотрудник: уведомление должно прийти ЕМУ, а не тому, кто написал
  const stamp = Date.now().toString(36).slice(-5);
  const symbol = `УВ${stamp}`;
  const password = `uv-${stamp}-Aa1`;
  const made = await api(adminToken, 'POST', '/api/users', {
    name: `Проверка доставки ${stamp}`, symbol, password, role: 'ENGINEER',
  });
  const otherId = made.json?.user?.id || made.json?.id || '';
  if (!otherId) { console.error('Второй сотрудник не завёлся.', made.status, made.json); process.exit(2); }
  const otherToken = (await api('', 'POST', '/api/login', { symbol, password })).json?.token || '';

  let sock: any = null;
  try {
    console.log('1. Уведомление доходит толчком');
    sock = io(BASE, { auth: { token: otherToken }, transports: ['websocket', 'polling'] });
    const connected = await new Promise<boolean>((res) => {
      sock.on('connect', () => res(true));
      sock.on('connect_error', () => res(false));
      setTimeout(() => res(false), 8000);
    });
    ok('получатель подключился сокетом', connected);

    const got: any[] = [];
    sock.on('notify:new', (row: any) => got.push({ row, at: Date.now() }));

    // Пишем ему из другой учётной записи: уведомление рождает сам сервер
    const sentAt = Date.now();
    const sent = await api(adminToken, 'POST', '/api/chat/messages', {
      senderId: adminId, receiverId: otherId, content: `проверка доставки ${stamp}`,
    });
    ok('сообщение отправлено', sent.status < 400, { status: sent.status, body: sent.json || sent.text });

    // Ждём недолго: если толчка нет, опрос всё равно не спасёт — его тут нет
    for (let i = 0; i < 40 && !got.length; i++) await wait(50);

    ok('уведомление пришло', got.length > 0, got.length);
    const delay = got.length ? got[0].at - sentAt : Infinity;
    ok(`пришло быстрее секунды (${Number.isFinite(delay) ? delay : '—'} мс)`, delay < FAST_MS, delay);
    ok('это уведомление о переписке', got[0]?.row?.category === 'ЧАТ', got[0]?.row?.category);
    ok('адресовано именно получателю', got[0]?.row?.userId === otherId);

    console.log('2. Отправитель не получает уведомления сам о себе');
    const mine: any[] = [];
    const selfSock = io(BASE, { auth: { token: adminToken }, transports: ['websocket', 'polling'] });
    await new Promise<void>((res) => { selfSock.on('connect', () => res()); setTimeout(res, 5000); });
    selfSock.on('notify:new', (row: any) => mine.push(row));
    await api(adminToken, 'POST', '/api/chat/messages', {
      senderId: adminId, receiverId: otherId, content: `второе ${stamp}`,
    });
    await wait(600);
    ok('себе уведомление не приходит', mine.length === 0, mine.length);
    selfSock.disconnect();

    console.log('3. Опрос стал страховкой, а не способом доставки');
    const { POLL_MS } = await import('../src/store/notificationStore');
    ok('опрос реже прежних пятнадцати секунд', POLL_MS >= 60000, POLL_MS);
    const store = (await import('fs')).readFileSync(
      new URL('../src/store/notificationStore.ts', import.meta.url), 'utf8');
    ok('пока окно скрыто, опроса нет', store.includes('document.hidden'));
    const provider = (await import('fs')).readFileSync(
      new URL('../src/components/SocketProvider.tsx', import.meta.url), 'utf8');
    ok('оболочка слушает толчок', provider.includes("'notify:new'"));
    // Второе соединение чата рвалось при уходе с раздела и шумело в консоль
    const chat = (await import('fs')).readFileSync(
      new URL('../src/store/chatStore.ts', import.meta.url), 'utf8');
    ok('у чата больше нет своего сокета', !/\bio\(/.test(chat), (chat.match(/\bio\([^)]*/) || [])[0]);
  } catch (e: any) {
    f++;
    console.error('  ✗ проба оборвалась:', e?.message || e);
  } finally {
    try { sock?.disconnect(); } catch (_) { /* уже закрыт */ }
    // Прибираем: проба не должна оставлять сотрудников в отделе
    try { await api(adminToken, 'DELETE', `/api/users/${otherId}`); } catch (_) { /* сервер мог уйти */ }
  }

  if (f) { console.error(`\nПровалено проверок: ${f}`); process.exit(1); }
  console.log('\nДоставка уведомлений: все проверки пройдены');
})();
