import { testCredentials } from './testCredentials';
/**
 * Дымовая проверка HTTP-слоя: сервер поднят, вход работает, маршруты отвечают
 * тем же, чем раньше.
 *
 * Зачем: server.ts большой, и маршруты из него выносятся в server/routes/*.
 * Перенос обработчика легко сделать «почти правильно» — забыть проверку прав,
 * потерять поле в ответе, поменять код ошибки. Эта проверка снимает срез до
 * переноса и сверяет после.
 *
 * Порядок:
 *   npx tsx server.ts &        (или npm run dev)
 *   npx tsx scripts/test-api.ts
 *
 * Если сервер не поднят — проверка честно об этом говорит и выходит с кодом 2,
 * чтобы её нельзя было принять за пройденную.
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = testCredentials();

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : ''));

let token = '';
let meId = '';
const call = async (method: string, url: string, body?: any) => {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* не JSON — оставляем null */ }
  return { status: res.status, json, text };
};

(async () => {
  // 0. Сервер вообще отвечает
  try {
    const h = await call('GET', '/api/health');
    if (h.status !== 200) throw new Error('health вернул ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`);
    console.error('Поднимите его: npx tsx server.ts');
    process.exit(2);
  }

  console.log('1. Вход и защита API');
  {
    const anon = await call('GET', '/api/users');
    ok('без токена доступ закрыт', anon.status === 401, anon.status);

    const bad = await call('POST', '/api/login', { symbol: LOGIN.symbol, password: 'заведомо-неверный' });
    ok('неверный пароль не пускает', bad.json?.success === false, bad.json);

    const good = await call('POST', '/api/login', LOGIN);
    ok('вход администратора', good.json?.success === true, good.json?.message);
    token = good.json?.token || '';
    meId = good.json?.user?.id || '';
    ok('выдан токен сессии', token.length > 50, token.length);
    ok('в ответе нет пароля', !JSON.stringify(good.json?.user || {}).includes('password'));

    const check = await call('GET', '/api/auth/check');
    ok('проверка сессии по токену', check.status === 200 && !!check.json, check.status);

    token = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa'); // портим подпись
    const forged = await call('GET', '/api/users');
    ok('подделанный токен отвергнут', forged.status === 401, forged.status);
    token = (await call('POST', '/api/login', LOGIN)).json?.token || '';
  }

  console.log('2. Проекты и справочные списки');
  const projects = await call('GET', '/api/projects');
  ok('список проектов', projects.status === 200 && Array.isArray(projects.json?.projects), projects.status);
  const projectId = projects.json?.projects?.[0]?.id;
  ok('в базе есть проект', !!projectId);

  for (const [name, url] of [
    ['сотрудники', '/api/users'],
    ['роли', '/api/roles'],
    ['настройки уведомлений', '/api/notif-prefs'],
    ['уведомления', '/api/notifications'],
    ['словарь импорта', '/api/import/dictionary'],
    ['группы чата', '/api/chat/groups'],
    ['заметки', '/api/notes'],
  ] as const) {
    const r = await call('GET', url);
    ok(`${name}: 200 и разбираемый JSON`, r.status === 200 && r.json !== null, { status: r.status, body: r.text.slice(0, 120) });
  }

  console.log('3. Данные проекта');
  for (const [name, url] of [
    ['теги', `/api/projects/${projectId}/tags`],
    ['системы', `/api/projects/${projectId}/systems`],
    ['папки', `/api/projects/${projectId}/folders`],
    ['корзина', `/api/projects/${projectId}/trash`],
    ['справочники', `/api/projects/${projectId}/dictionaries`],
    ['шаблон тега', `/api/projects/${projectId}/tag-template`],
  ] as const) {
    const r = await call('GET', url);
    ok(`${name}: 200`, r.status === 200 && r.json !== null, { status: r.status, body: r.text.slice(0, 120) });
  }

  console.log('4. Помощник и чат');
  {
    const a = await call('GET', `/api/assistant/data?projectId=${projectId}`);
    ok('данные помощника собираются', a.status === 200 && !!a.json, a.status);
    ok('помощник отдаёт теги и оборудование', Array.isArray(a.json?.tags) && Array.isArray(a.json?.components), Object.keys(a.json || {}));

    // Личная переписка требует обе стороны: без них ответа быть не должно,
    // иначе кто угодно вычитал бы чужие сообщения одним запросом
    const anonChat = await call('GET', '/api/chat/messages');
    ok('чат без собеседника не отдаёт ничего', anonChat.status === 400, anonChat.status);

    const m = await call('GET', `/api/chat/messages?senderId=${meId}&receiverId=${meId}`);
    ok('сообщения переписки', m.status === 200, { s: m.status, b: m.text.slice(0, 120) });

    // Чужой диалог закрыт даже для администратора — подробнее в test-chat-privacy
    const other = await call('GET', `/api/chat/messages?senderId=нездесь&receiverId=итутнет`);
    ok('чужая переписка закрыта', other.status === 403, other.status);

    const t = await call('GET', `/api/chat/autocomplete-tags?projectId=${projectId}&q=`);
    ok('подсказки тегов в чате', t.status === 200, t.status);
  }

  console.log('5. Запись и откат (на временной папке Проводника)');
  {
    const created = await call('POST', '/api/folders', { projectId, name: '__проверка_api', parentId: null });
    ok('папка создана', created.status === 200 || created.status === 201, { s: created.status, b: created.text.slice(0, 150) });
    const id = created.json?.id || created.json?.folder?.id;
    if (id) {
      const renamed = await call('PATCH', `/api/folders/${id}`, { name: '__проверка_api_2' });
      ok('папка переименована', renamed.status === 200, renamed.status);
      const removed = await call('DELETE', `/api/folders/${id}`);
      ok('папка удалена', removed.status === 200, removed.status);
    } else {
      ok('идентификатор новой папки получен', false, created.json);
    }
  }

  console.log('6. Сотрудники и роли');
  {
    const roles = await call('GET', '/api/roles');
    ok('встроенные роли засеяны', (roles.json?.roles || []).length >= 4, (roles.json?.roles || []).length);

    const symbol = '__proverka_' + Date.now().toString(36);
    const made = await call('POST', '/api/users', {
      symbol, lastName: 'Проверкин', firstName: 'Тест', role: 'ENGINEER_VENT', password: 'проверка',
    });
    ok('сотрудник заведён', made.status === 200 || made.status === 201, { s: made.status, b: made.text.slice(0, 150) });
    const uid = made.json?.id || made.json?.user?.id;
    if (uid) {
      const list = await call('GET', '/api/users');
      const row = (list.json || []).find((u: any) => u.id === uid);
      ok('сотрудник виден в списке', !!row);
      ok('пароль наружу не отдаётся', !!row && !('password' in row), row && Object.keys(row));
      ok('ФИО собрано в одну строку', !!row?.name && row.name.includes('Проверкин'), row?.name);

      const upd = await call('PUT', `/api/users/${uid}`, { firstName: 'Тест2' });
      ok('профиль обновлён', upd.status === 200, { s: upd.status, b: upd.text.slice(0, 150) });

      const del = await call('DELETE', `/api/users/${uid}`);
      ok('профиль удалён', del.status === 200, del.status);
    } else {
      ok('идентификатор нового сотрудника получен', false, made.json);
    }
  }

  console.log('7. Подпись сотрудника');
  {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    const list = await call('GET', '/api/users');
    const row = (list.json || [])[0];
    ok('в списке сотрудников нет картинок подписей', row && !('signatureImage' in row), row && Object.keys(row).slice(0, 20));
    ok('зато есть признак «подпись есть»', row && 'hasSignature' in row);

    const saved = await call('PUT', `/api/users/${meId}/signature`, { signatureImage: PNG, signatureHeightMm: 10 });
    ok('свою подпись сохранить можно', saved.status === 200, saved.status);
    const back = await call('GET', `/api/users/${meId}/signature`);
    ok('подпись читается обратно', back.json?.signature === PNG);
    ok('высота сохранена', back.json?.signatureHeightMm === 10, back.json?.signatureHeightMm);

    // Ссылка на чужой адрес утянула бы документ в сеть при каждой печати
    const link = await call('PUT', `/api/users/${meId}/signature`, { signatureImage: 'http://чужой/подпись.png' });
    ok('ссылка вместо картинки отвергается', link.status === 400, link.status);
    const huge = await call('PUT', `/api/users/${meId}/signature`, { signatureImage: 'data:image/png;base64,' + 'A'.repeat(1_600_000) });
    ok('слишком большая картинка отвергается', huge.status === 400, huge.status);

    // Чужую подпись менять нельзя — она как личная печать
    const symbol = '__podpis_' + Date.now().toString(36);
    const other = await call('POST', '/api/users', { symbol, lastName: 'Чужой', firstName: 'Сотрудник', role: 'ENGINEER_VENT', password: 'проверка' });
    const otherId = other.json?.id || other.json?.user?.id;
    if (otherId) {
      const asOther = await call('POST', '/api/login', { symbol, password: 'проверка' });
      const keep = token;
      token = asOther.json?.token || '';
      const foreign = await call('PUT', `/api/users/${meId}/signature`, { signatureImage: PNG });
      ok('рядовой сотрудник не трогает чужую подпись', foreign.status === 403, foreign.status);
      const own = await call('PUT', `/api/users/${otherId}/signature`, { signatureImage: PNG, signatureHeightMm: 6 });
      ok('свою — ставит сам', own.status === 200, own.status);
      token = keep;
      await call('DELETE', `/api/users/${otherId}`);
    } else {
      ok('временный сотрудник заведён', false, other.json);
    }

    const cleared = await call('PUT', `/api/users/${meId}/signature`, { signatureImage: null });
    ok('подпись убирается', cleared.status === 200 && cleared.json?.signature === null, cleared.json);
  }

  console.log('8. Ошибки отвечают внятно, а не падают');
  {
    const missing = await call('GET', '/api/projects/нет-такого/tags');
    ok('несуществующий проект → не 500', missing.status !== 500, missing.status);
    const badRoute = await call('GET', '/api/такого-маршрута-нет');
    ok('неизвестный маршрут → 404', badRoute.status === 404, badRoute.status);
  }

  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
