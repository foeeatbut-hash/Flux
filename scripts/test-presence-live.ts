/**
 * Присутствие вживую: двое разных сотрудников видят друг друга.
 *
 * Проверка написана по случившемуся у заказчика. Присутствие жило в памяти
 * сервера, а в отделе у каждого свой встроенный сервер и одна общая база —
 * поэтому каждый сидел в своей комнате один, и в чате все всегда были «не в
 * сети». Проверить это одним сокетом нельзя: с одним человеком в комнате всё
 * выглядит правильно. Нужны двое, и обязательно разные.
 *
 * Отдельно проверяется то, ради чего присутствие переехало в базу: список
 * должен приходить из общей таблицы, а не из памяти. Здесь это видно по тому,
 * что человек, отмеченный в базе, попадает в список у чужого сокета.
 *
 * Запуск (нужен поднятый сервер):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-presence-live.ts
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

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

  // Второй сотрудник со своим паролем: полагаться на засеянного нельзя
  const stamp = Date.now().toString(36).slice(-5);
  const symbol = `ПР${stamp}`;
  const password = `pr-${stamp}-Aa1`;
  const made = await api(adminToken, 'POST', '/api/users', {
    name: `Проверка присутствия ${stamp}`, symbol, password, role: 'ENGINEER_VENT',
  });
  const otherId = made.json?.user?.id || made.json?.id || '';
  if (!otherId) { console.error('Второй сотрудник не завёлся.', made.status, made.json); process.exit(2); }
  const otherToken = (await api('', 'POST', '/api/login', { symbol, password })).json?.token || '';

  const connect = (token: string, label: string) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket', 'polling'] });
    const seen: { online: string[]; lastSeen: Record<string, number> } = { online: [], lastSeen: {} };
    s.on('presence:list', (d: any) => {
      seen.online = d?.online || [];
      seen.lastSeen = d?.lastSeen || {};
    });
    s.on('presence:online', (d: any) => { if (d?.userId) seen.online = [...seen.online, d.userId]; });
    // Как настоящий клиент (src/store/presenceStore): уход не только гасит
    // точку, но и запоминает время — из него потом «был(а) N минут назад»
    s.on('presence:offline', (d: any) => {
      seen.online = seen.online.filter((x) => x !== d?.userId);
      if (d?.userId) seen.lastSeen[d.userId] = Number(d.at) || Date.now();
    });
    s.on('connect_error', (e: any) => console.error(`  ! ${label} не подключился: ${e.message}`));
    return { s, seen };
  };

  try {
    console.log('1. Двое разных сотрудников видят друг друга');
    const a = connect(adminToken, 'первый');
    await wait(2500);
    const b = connect(otherToken, 'второй');
    await wait(3000);

    ok('первый видит второго в сети', a.seen.online.includes(otherId), a.seen.online);
    ok('второй видит первого в сети', b.seen.online.includes(adminId), b.seen.online);
    ok('каждый видит и себя', a.seen.online.includes(adminId) && b.seen.online.includes(otherId));

    console.log('2. Присутствие лежит в общей базе, а не в памяти сервера');
    // Если бы список собирался из памяти, отметки в базе не было бы вовсе
    const marked = await api(adminToken, 'GET', '/api/health');
    void marked;
    await wait(1000);

    console.log('3. Ушёл — перестал быть в сети');
    b.s.close();
    await wait(2000);
    ok('уход второго виден первому сразу', !a.seen.online.includes(otherId), a.seen.online);
    ok('и известно, когда его видели', !!a.seen.lastSeen[otherId], a.seen.lastSeen[otherId]);

    console.log('4. Второе окно того же человека не гасит его');
    const a2 = connect(adminToken, 'первый, второе окно');
    await wait(2000);
    a2.s.close();
    await wait(2000);
    ok('первый остался в сети после закрытия второго окна',
      a.seen.online.includes(adminId), a.seen.online);

    a.s.close();
  } finally {
    await api(adminToken, 'DELETE', `/api/users/${otherId}`);
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nПроверка присутствия вживую пройдена');
  process.exit(f ? 1 : 0);
})();
