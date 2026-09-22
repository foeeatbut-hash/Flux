/**
 * Flux Play включается с чистого листа — тем, кто в программе главный.
 *
 * Жалоба владельца дословно: «флакс плей не отображается ни у кого вообще,
 * даже с разрешением доступа». Причина была в замкнутом круге: выключатель
 * платформы по умолчанию выключен, а пока он выключен, сервер прятал
 * платформу от всех — и от главного администратора вместе с листом настроек,
 * на котором лежит сам выключатель. Выданный доступ ничего не менял: раздел
 * не виден, пока платформа выключена, а включить её было нечем.
 *
 * Проверка идёт ровно тем путём, которым пойдёт владелец: с чистого состояния
 * (платформа выключена, прав ни у кого нет) — в Настройки, «Включить Flux
 * Play», — и раздел появляется у него и у сотрудника, которому выдан доступ.
 * Сотруднику без доступа при этом по-прежнему не видно ничего.
 *
 * Запуск (нужен поднятый сервер и Chromium): npx tsx scripts/test-play-enable-live.ts
 */
import { APP_PLAY, PLAY_ADMIN, gameEntitlement, isPlayKey } from '../play/features';

const BASE = process.env.FLUX_API || process.env.FLUX_BASE || 'http://localhost:3000';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : '')));

const api = async (token: string, method: string, url: string, body?: any) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) as any }; } catch { return { status: res.status, json: null as any, text }; }
};

const ALLOW = { enabled: true, until: null, mode: 'ALLOW' };

async function permsOf(token: string, userId: string): Promise<Record<string, any>> {
  const list = await api(token, 'GET', '/api/users');
  const rows = list.json?.users || list.json || [];
  const row = (Array.isArray(rows) ? rows : []).find((u: any) => u.id === userId) || {};
  try { return row.permissions ? JSON.parse(row.permissions) : {}; } catch (_) { return {}; }
}

async function setPerms(token: string, userId: string, perms: Record<string, any>) {
  return api(token, 'PUT', `/api/users/${userId}`, { permissions: JSON.stringify(perms) });
}

async function revokePlay(token: string, userId: string): Promise<void> {
  const perms = await permsOf(token, userId);
  for (const k of Object.keys(perms)) if (isPlayKey(k)) delete perms[k];
  await setPerms(token, userId, perms);
}

(async () => {
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}). Поднимите: npx tsx server.ts`);
    process.exit(2);
  }

  const admin = await api('', 'POST', '/api/login', ADMIN);
  const adminToken = String(admin.json?.token || '');
  const adminId = String(admin.json?.user?.id || '');
  if (!adminToken) { console.error('Не удалось войти администратором.'); process.exit(2); }

  console.log('0. Чистое состояние: платформа выключена, прав ни у кого нет');
  {
    // Выключить может только управляющий — выдаём себе управление, выключаем
    // и снимаем всё обратно: проверка должна начинаться там, где владелец
    await api(adminToken, 'POST', '/api/admin/play-diagnostics/bootstrap', {});
    await api(adminToken, 'PUT', '/api/play/platform', { enabled: false });
    await revokePlay(adminToken, adminId);
    await new Promise((r) => setTimeout(r, 5500));   // кэш состояния платформы — 5 с
    const off = await api(adminToken, 'GET', '/api/me/bootstrap');
    ok('платформа выключена', off.json?.platform?.enabled === false, off.json?.platform);
  }

  console.log('\n1. Главному администратору платформа видна как настройка');
  {
    const boot = await api(adminToken, 'GET', '/api/me/bootstrap');
    // Раньше здесь было «не поддерживается» — спрятанное состояние: лист
    // настроек показывал бы «на этой базе не включается», а выключатель гас
    ok('состояние настоящее: база поддерживает', boot.json?.platform?.supported === true, boot.json?.platform);
    const diag = await api(adminToken, 'GET', '/api/admin/play-diagnostics');
    ok('диагностика отвечает главному администратору', diag.status === 200, diag.status);
    ok('и называет причину: платформа выключена', diag.json?.platform?.enabled === false, diag.json?.platform);
    const gate = await api(adminToken, 'GET', '/api/play/platform');
    ok('сама платформа без права по-прежнему молчит', gate.status === 404, gate.status);
  }

  console.log('\n2. Сотрудник с доступом, пока платформа выключена, раздела не видит');
  const stamp = Date.now().toString(36).slice(-5);
  const withAccess = { symbol: `ВК${stamp}`, password: `vk-${stamp}-Aa1` };
  const without = { symbol: `БЕ${stamp}`, password: `be-${stamp}-Aa1` };
  const ids: Record<string, string> = {};
  for (const [label, who] of [['с доступом', withAccess], ['без доступа', without]] as const) {
    const made = await api(adminToken, 'POST', '/api/users', {
      name: `Проверка включения ${label} ${stamp}`, symbol: who.symbol, password: who.password, role: 'ENGINEER',
    });
    ids[who.symbol] = String(made.json?.user?.id || made.json?.id || '');
    ok(`сотрудник ${label} заведён`, !!ids[who.symbol], { s: made.status, j: made.json });
  }
  {
    const perms = await permsOf(adminToken, ids[withAccess.symbol]);
    perms[APP_PLAY] = ALLOW;
    perms[gameEntitlement('reversi')] = ALLOW;
    const saved = await setPerms(adminToken, ids[withAccess.symbol], perms);
    ok('доступ выдан в карточке', saved.status === 200, saved.status);
    const login = await api('', 'POST', '/api/login', withAccess);
    const boot = await api(String(login.json?.token || ''), 'GET', '/api/me/bootstrap');
    ok('раздела у него пока нет — платформа выключена', boot.json?.platform?.enabled === false, boot.json?.platform);
  }

  console.log('\n3. «Включить Flux Play» — одной кнопкой');
  {
    const res = await api(adminToken, 'POST', '/api/admin/play-diagnostics/enable', { openForMe: true });
    ok('включено', res.status === 200 && res.json?.enabled === true, { s: res.status, j: res.json });
    ok('управление выдано явной записью', (res.json?.granted || []).includes(PLAY_ADMIN), res.json?.granted);
    ok('и доступ к разделу — по галочке', (res.json?.granted || []).includes(APP_PLAY), res.json?.granted);
    const boot = await api(adminToken, 'GET', '/api/me/bootstrap');
    ok('у главного администратора платформа включена', boot.json?.platform?.enabled === true, boot.json?.platform);
    ok('и раздел открыт ему', !!boot.json?.permissions?.[APP_PLAY], Object.keys(boot.json?.permissions || {}));
  }

  console.log('\n4. Сотрудник с доступом видит раздел, без доступа — нет');
  {
    const a = await api('', 'POST', '/api/login', withAccess);
    const aToken = String(a.json?.token || '');
    const boot = await api(aToken, 'GET', '/api/me/bootstrap');
    ok('с доступом: платформа включена', boot.json?.platform?.enabled === true, boot.json?.platform);
    const state = await api(aToken, 'GET', '/api/play/state');
    ok('с доступом: раздел отвечает', state.status === 200, state.status);

    const b = await api('', 'POST', '/api/login', without);
    const bToken = String(b.json?.token || '');
    const bBoot = await api(bToken, 'GET', '/api/me/bootstrap');
    const keys = [...Object.keys(bBoot.json?.permissions || {}), ...Object.keys(bBoot.json?.rolePermissions || {})];
    ok('без доступа: ни одного ключа платформы', !keys.some(isPlayKey), keys.filter(isPlayKey));
    ok('без доступа: платформы нет', bBoot.json?.platform?.enabled === false, bBoot.json?.platform);
    const bState = await api(bToken, 'GET', '/api/play/state');
    ok('без доступа: раздел отвечает как выдуманный адрес', bState.status === 404, bState.status);
  }

  console.log('\n5. Окно: у главного администратора в Пуске появился Flux Play');
  let browser: any = null;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route('**/api/license/status', (r: any) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ licensed: true, machineId: 'enable', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
    }));
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input', { timeout: 40000 });
    await page.waitForTimeout(1500);
    const inputs = await page.$$('input');
    await inputs[0].fill(ADMIN.symbol);
    await inputs[1].fill(ADMIN.password);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(9000);
    const start = await page.$('button[aria-label="Пуск"]');
    if (start) { await start.click(); await page.waitForTimeout(1200); }
    ok('в Пуске раздел есть', /Flux\s*Play/i.test(String(await page.evaluate('document.body.innerText'))));
    await page.screenshot({ path: `${process.env.SHOTS || '/tmp'}/play-enable-start.png` });
  } catch (e: any) {
    console.error('  · окно не проверено:', e?.message || e);
    f++;
  } finally {
    try { await browser?.close(); } catch (_) { /* уже закрыт */ }
  }

  console.log('\n6. Уборка');
  {
    for (const id of Object.values(ids)) if (id) await api(adminToken, 'DELETE', `/api/users/${id}`);
    ok('проверочные сотрудники удалены', true);
    // Стенд возвращается туда, откуда начинал: включённая платформа и выданное
    // себе управление испортили бы следующий прогон этой и соседних проверок
    const off = await api(adminToken, 'PUT', '/api/play/platform', { enabled: false });
    ok('платформа выключена обратно', off.status === 200 && off.json?.platform?.enabled === false, off.status);
    await revokePlay(adminToken, adminId);
  }

  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
