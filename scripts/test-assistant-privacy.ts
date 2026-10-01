import { testCredentials } from './testCredentials';
/**
 * Разговоры с помощником — личные. Проверяется вдвоём, а не в одиночку.
 *
 * «Я не вижу своего чужого» — проверка ни о чём: нужен второй вход. Здесь
 * заводится второй сотрудник, входит своим паролем и смотрит на те же данные с
 * другой стороны: в списке чужого разговора нет, по прямому адресу его тоже
 * нет, записать в него нельзя и удалить нельзя.
 *
 * Отдельно проверяется администратор: обещание в интерфейсе сказано без
 * оговорок — «администратор тоже нет», — и оно должно быть правдой.
 *
 * Запуск (нужен поднятый сервер):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-assistant-privacy.ts
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = testCredentials();

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 220) : ''));

const call = async (token: string, method: string, url: string, body?: any) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null as any, text }; }
};

(async () => {
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}). Поднимите: npx tsx server.ts`);
    process.exit(2);
  }

  const admin = (await call('', 'POST', '/api/login', ADMIN)).json?.token || '';
  if (!admin) { console.error('Не удалось войти администратором.'); process.exit(2); }

  // Второй сотрудник со своим паролем: полагаться на засеянного нельзя —
  // прогон стал бы зависеть от того, что лежало в базе
  const stamp = Date.now().toString(36).slice(-5);
  const symbol = `ПЧ${stamp}`;
  const password = `pv-${stamp}-Aa1`;
  const made = await call(admin, 'POST', '/api/users', {
    name: `Проверка приватности ${stamp}`, symbol, password, role: 'ENGINEER_VENT',
  });
  const otherId = made.json?.user?.id || made.json?.id || '';
  if (!otherId) { console.error('Второй сотрудник не завёлся.', made.status, made.json); process.exit(2); }
  const other = (await call('', 'POST', '/api/login', { symbol, password })).json?.token || '';
  if (!other) { console.error('Второй сотрудник не вошёл.'); process.exit(2); }

  const chatId = `chat_test_${stamp}`;
  try {
    console.log('1. Свой разговор сохраняется и читается');
    const put = await call(admin, 'PUT', `/api/assistant/chats/${chatId}`, {
      title: 'покажи дубли', preview: 'Нашёл 3 повтора', projectId: '',
      messages: JSON.stringify([{ id: '1', role: 'user', text: 'покажи дубли' }]),
      search: 'покажи дубли нашёл 3 повтора',
    });
    ok('разговор записался', put.status === 200, put.json || put.status);
    const mine = await call(admin, 'GET', '/api/assistant/chats');
    ok('разговор виден в своём списке', (mine.json?.chats || []).some((c: any) => c.id === chatId));
    ok('в списке есть вторая строка', (mine.json?.chats || []).find((c: any) => c.id === chatId)?.preview === 'Нашёл 3 повтора');
    const one = await call(admin, 'GET', `/api/assistant/chats/${chatId}`);
    ok('разговор читается целиком', String(one.json?.chat?.messages || '').includes('покажи дубли'));

    console.log('2. Поиск идёт по репликам');
    const found = await call(admin, 'GET', '/api/assistant/chats?q=повтора');
    ok('находится по слову из ответа, а не только из названия',
      (found.json?.chats || []).some((c: any) => c.id === chatId), found.json);
    const missed = await call(admin, 'GET', '/api/assistant/chats?q=щщщнетакого');
    ok('чего не спрашивали — не находится', !(missed.json?.chats || []).some((c: any) => c.id === chatId));

    console.log('3. Чужой не видит и не трогает');
    const theirList = await call(other, 'GET', '/api/assistant/chats');
    ok('в списке постороннего чужого разговора нет',
      !(theirList.json?.chats || []).some((c: any) => c.id === chatId), theirList.json);
    const theirGet = await call(other, 'GET', `/api/assistant/chats/${chatId}`);
    ok('по прямому адресу посторонний получает отказ', theirGet.status === 404, theirGet.status);
    const theirPut = await call(other, 'PUT', `/api/assistant/chats/${chatId}`, {
      title: 'подмена', messages: '[]', search: '', projectId: '',
    });
    ok('посторонний не перезаписывает чужой разговор', theirPut.status === 403, theirPut.status);
    const theirDel = await call(other, 'DELETE', `/api/assistant/chats/${chatId}`);
    ok('посторонний не удаляет чужой разговор', theirDel.status === 404, theirDel.status);
    const still = await call(admin, 'GET', `/api/assistant/chats/${chatId}`);
    ok('разговор цел после чужих попыток', still.json?.chat?.title === 'покажи дубли', still.json?.chat?.title);

    console.log('4. Администратор — не исключение');
    const theirChat = `chat_other_${stamp}`;
    await call(other, 'PUT', `/api/assistant/chats/${theirChat}`, {
      title: 'личное', messages: '[]', search: 'личное', projectId: '',
    });
    const adminList = await call(admin, 'GET', '/api/assistant/chats');
    ok('администратор не видит чужой разговор в списке',
      !(adminList.json?.chats || []).some((c: any) => c.id === theirChat));
    const adminGet = await call(admin, 'GET', `/api/assistant/chats/${theirChat}`);
    ok('администратор не читает чужой разговор по адресу', adminGet.status === 404, adminGet.status);
    await call(other, 'DELETE', `/api/assistant/chats/${theirChat}`);

    console.log('5. Удаление своего');
    const del = await call(admin, 'DELETE', `/api/assistant/chats/${chatId}`);
    ok('свой разговор удаляется', del.status === 200);
    ok('после удаления его нет', (await call(admin, 'GET', `/api/assistant/chats/${chatId}`)).status === 404);
  } finally {
    await call(admin, 'DELETE', `/api/assistant/chats/${chatId}`);
    await call(admin, 'DELETE', `/api/users/${otherId}`);
  }

  console.log(f ? `\nПровалено проверок: ${f}` : '\nВсе проверки личных разговоров пройдены');
  process.exit(f ? 1 : 0);
})();
