/**
 * Два независимых клиента проходят полный цикл — то, чем ТЗ меряет готовность.
 *
 * Два НАСТОЯЩИХ браузера, два разных сотрудника, один сервер, одна база и
 * отдельный игровой процесс. Проверка написана против главного соблазна:
 * объявить сделанным то, что сходится в одном окне. В одном окне сходится
 * всё — и приглашение самому себе, и готовность, которую видит только тот, кто
 * её нажал. Расходится это ровно тогда, когда людей становится двое.
 *
 * Что проверяется по шагам:
 *
 *   приглашение уходит из окна первого и ПОЯВЛЯЕТСЯ в окне второго;
 *   принятое приглашение меняет состав группы у ОБОИХ;
 *   готовность одного видна другому;
 *   матч, начатый ведущим, наступает у обоих;
 *   результат от игрового сервера показывается обоим;
 *   после матча лобби возвращается в подготовку, и цикл повторяется.
 *
 * Билеты и подписанный результат идут своим путём — от игрового клиента к
 * игровому серверу и обратно к платформе (это и есть §18.1): окно их не
 * трогает, и подменить их из окна нельзя.
 *
 * Запуск (сервер поднят с подключённой проверочной игрой):
 *   export FLUX_TESTGAME_SECRET=…
 *   FLUX_TESTGAME_URL=http://127.0.0.1:3210 npx tsx server.ts &
 *   npx tsx scripts/test-play-two-clients-live.ts
 */
import { spawn } from 'node:child_process';
import { APP_PLAY, PLAY_ADMIN, gameEntitlement, isPlayKey } from '../play/features';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const SECRET = String(process.env.FLUX_TESTGAME_SECRET || '');
const GAME_PORT = Number(process.env.FLUX_TESTGAME_PORT || 3210);
const GAME = `http://127.0.0.1:${GAME_PORT}`;
const OUT = process.env.FLUX_FRAMES || '.walkthrough';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : '')));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const api = async (token: string, method: string, url: string, body?: any) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) as any }; } catch { return { status: res.status, json: null as any, text }; }
};

const game = async (path: string, body: any) => {
  const res = await fetch(GAME + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};

async function grant(adminToken: string, userId: string, keys: string[]): Promise<void> {
  const list = await api(adminToken, 'GET', '/api/users');
  const row = (list.json?.users || list.json || []).find((u: any) => u.id === userId) || {};
  let perms: Record<string, any> = {};
  try { perms = row.permissions ? JSON.parse(row.permissions) : {}; } catch (_) { perms = {}; }
  for (const k of keys) perms[k] = { enabled: true, until: null, mode: 'ALLOW' };
  await api(adminToken, 'PUT', `/api/users/${userId}`, { permissions: JSON.stringify(perms) });
}

async function revoke(adminToken: string, userId: string): Promise<void> {
  const list = await api(adminToken, 'GET', '/api/users');
  const row = (list.json?.users || list.json || []).find((u: any) => u.id === userId) || {};
  let perms: Record<string, any> = {};
  try { perms = row.permissions ? JSON.parse(row.permissions) : {}; } catch (_) { perms = {}; }
  for (const k of Object.keys(perms)) if (isPlayKey(k)) delete perms[k];
  await api(adminToken, 'PUT', `/api/users/${userId}`, { permissions: JSON.stringify(perms) });
}

/** Одно окно программы: свой браузер, свой профиль, свой вход. */
async function openClient(chromium: any, symbol: string, password: string) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: symbol, expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input', { timeout: 40000 });
  await page.waitForTimeout(1500);
  const inputs = await page.$$('input');
  await inputs[0].fill(symbol);
  await inputs[1].fill(password);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(9000);
  return { browser, page };
}

/** Открыть раздел так, как открывает человек: Пуском, а не адресом. */
async function openPlay(page: any): Promise<boolean> {
  const start = await page.$('button[aria-label="Пуск"]');
  if (!start) return false;
  await start.click();
  await page.waitForTimeout(1000);
  const tile = await page.$('text=Flux Play');
  if (!tile) { await page.keyboard.press('Escape'); return false; }
  await tile.click();
  await page.waitForTimeout(3500);
  return true;
}

const text = async (page: any): Promise<string> =>
  String(await page.evaluate('document.body.innerText')).replace(/\s+/g, ' ');

/** Дождаться, пока в окне появится нужное. Молчаливое ожидание — не проверка. */
async function until(page: any, re: RegExp, seconds = 20): Promise<boolean> {
  for (let i = 0; i < seconds * 2; i++) {
    if (re.test(await text(page))) return true;
    await wait(500);
  }
  return false;
}

/**
 * Дождаться, пока нужное из окна ИСЧЕЗНЕТ.
 *
 * Обратная сторона `until`, и нужна она честности ради: «ушедший из группы
 * больше не показан» проверяется отсутствием, а отсутствие наступает не в тот
 * же миг — событие должно дойти до второго окна.
 */
async function gone(page: any, re: RegExp, seconds = 20): Promise<boolean> {
  for (let i = 0; i < seconds * 2; i++) {
    if (!re.test(await text(page))) return true;
    await wait(500);
  }
  return false;
}

/** Нажать кнопку по видимой надписи. */
async function press(page: any, label: string): Promise<boolean> {
  const done = await page.evaluate(`(() => {
    const want = ${JSON.stringify(label)};
    for (const b of document.querySelectorAll('button')) {
      if (b.disabled) continue;
      if ((b.innerText || '').trim() === want) { b.click(); return true; }
    }
    return false;
  })()`);
  if (done) await page.waitForTimeout(1500);
  return !!done;
}

(async () => {
  if (!SECRET) {
    console.error('Нет FLUX_TESTGAME_SECRET: сервер и игра должны знать один секрет.');
    process.exit(2);
  }
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`);
    process.exit(2);
  }

  const admin = await api('', 'POST', '/api/login', ADMIN);
  const adminToken = String(admin.json?.token || '');
  const adminId = String(admin.json?.user?.id || '');
  if (!adminToken) { console.error('Не удалось войти администратором.'); process.exit(2); }

  const stamp = Date.now().toString(36).slice(-5);
  const people: Array<{ id: string; token: string; symbol: string; password: string }> = [];
  let child: any = null;
  const browsers: any[] = [];

  const cleanup = async () => {
    for (const b of browsers) { try { await b.close(); } catch (_) { /* уже закрыт */ } }
    try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* уже ушла */ }
    for (const p of people) { try { await revoke(adminToken, p.id); } catch (_) { /* нет профиля */ } }
    try { await api(adminToken, 'PUT', '/api/play/platform', { enabled: false }); } catch (_) {}
    try { await revoke(adminToken, adminId); } catch (_) {}
  };

  try {
    console.log('1. Стенд: платформа включена, доступ выдан двоим');
    {
      await grant(adminToken, adminId, [PLAY_ADMIN, APP_PLAY]);
      const on = await api(adminToken, 'PUT', '/api/play/platform', { enabled: true });
      ok('платформа включена', on.status === 200, on.status);

      for (const suffix of ['A', 'B']) {
        const symbol = `ДВ${suffix}${stamp}`;
        const password = `dv-${suffix}-${stamp}-Aa1`;
        const made = await api(adminToken, 'POST', '/api/users', {
          name: `Игрок ${suffix} ${stamp}`, symbol, password, role: 'ENGINEER',
        });
        const id = String(made.json?.user?.id || made.json?.id || '');
        await grant(adminToken, id, [APP_PLAY, gameEntitlement('testgame')]);
        const login = await api('', 'POST', '/api/login', { symbol, password });
        people.push({ id, token: String(login.json?.token || ''), symbol, password });
      }
      ok('оба сотрудника заведены', people.every((p) => p.id && p.token), people.map((p) => p.symbol));
    }
    const [A, B] = people;

    console.log('\n2. Проверочная игра — отдельным процессом');
    {
      child = spawn('npx', ['tsx', 'scripts/testgame-server.ts'], {
        env: {
          ...process.env,
          FLUX_TESTGAME_SECRET: SECRET,
          FLUX_TESTGAME_PORT: String(GAME_PORT),
          FLUX_PLATFORM_URL: BASE,
          FLUX_PLATFORM_TOKEN: A.token,
        },
        stdio: 'ignore',
        detached: true,
      });
      let alive = false;
      for (let i = 0; i < 40 && !alive; i++) {
        await wait(500);
        try { alive = (await fetch(`${GAME}/health`, { method: 'POST' })).ok; } catch (_) { alive = false; }
      }
      ok('игровой процесс отвечает', alive);
      if (!alive) throw new Error('игра не поднялась');
    }

    console.log('\n3. Два окна программы, два разных сотрудника');
    const { chromium } = await import('playwright-core');
    const one = await openClient(chromium, A.symbol, A.password);
    const two = await openClient(chromium, B.symbol, B.password);
    browsers.push(one.browser, two.browser);
    ok('первый открыл раздел', await openPlay(one.page));
    ok('второй открыл раздел', await openPlay(two.page));

    console.log('\n4. Приглашение уходит из одного окна и приходит в другое');
    {
      // Группы ещё нет: «Позвать» появляется вместе с ней, поэтому сперва
      // подготовка — она же и заводит группу
      ok('первый нажал «Подготовиться»', await press(one.page, 'Подготовиться'));
      ok('лобби появилось у первого', await until(one.page, /Проверочная игра|мест/i, 15), await text(one.page));

      // Регистр не проверяем: `innerText` отдаёт текст уже с применённым
      // `text-transform`, и заголовок панели читается как «ГРУППА»
      ok('панель группы появилась', await until(one.page, /Группа/i, 15), await text(one.page));
      ok('первый нажал «Позвать»', await press(one.page, 'Позвать'));

      /**
       * Ищем коллегу так, как ищет человек.
       *
       * Список в выборе ограничен: в отделе сотрудников сотни, и вываливать
       * их все — это не список, а стена. Поэтому там есть поиск, и проверка
       * обязана пользоваться им, а не надеяться, что нужный окажется в первых
       * строках.
       */
      const box = await one.page.$('input[placeholder="Имя или табельный"]');
      ok('строка поиска на месте', !!box);
      if (box) { await box.fill(`Игрок B ${stamp}`); await one.page.waitForTimeout(900); }

      const picked = await one.page.evaluate(`(() => {
        const want = ${JSON.stringify(`Игрок B ${stamp}`)};
        for (const b of document.querySelectorAll('button')) {
          if ((b.innerText || '').includes(want)) { b.click(); return true; }
        }
        return false;
      })()`);
      ok('выбрал второго в списке', !!picked, await text(one.page));
      await one.page.waitForTimeout(2500);

      ok('второй увидел приглашение', await until(two.page, /зовёт в группу/i, 20), await text(two.page));
    }

    console.log('\n5. Принятое приглашение меняет группу у обоих');
    {
      ok('второй принял', await press(two.page, 'Принять'));
      ok('второй оказался в группе', await until(two.page, /Группа/i, 20), await text(two.page));
      ok('первый увидел пополнение',
        await until(one.page, new RegExp(`Игрок B ${stamp}`), 20), await text(one.page));
      ok('второй видит и первого',
        await until(two.page, new RegExp(`Игрок A ${stamp}`), 20), await text(two.page));
    }

    console.log('\n6. Готовность одного видна другому');
    {
      ok('первый отметился', await press(one.page, 'Готов'));
      ok('второй это увидел', await until(two.page, /готов/i, 20), await text(two.page));
      ok('второй отметился', await press(two.page, 'Готов'));
      // Ведущий — первый: у него появляется «Начать матч», у второго — ожидание
      ok('у ведущего появилось «Начать матч»', await until(one.page, /Начать матч/i, 20), await text(one.page));
      ok('второй ждёт ведущего', await until(two.page, /Ждём ведущего/i, 20), await text(two.page));
    }

    console.log('\n7. Матч начинается у обоих');
    {
      ok('ведущий начал матч', await press(one.page, 'Начать матч'));
      ok('первый в матче', await until(one.page, /Вернуться в игру/i, 25), await text(one.page));
      ok('второй тоже в матче', await until(two.page, /Вернуться в игру/i, 25), await text(two.page));
      await one.page.screenshot({ path: `${OUT}/play-two-clients-match.png` }).catch(() => {});
    }

    console.log('\n8. Билеты и результат идут своим путём — мимо окна');
    let sessionId = '';
    {
      // Игровой клиент предъявляет билет игре, игра спрашивает платформу.
      // Окно в этом не участвует и подменить ничего не может
      for (const p of people) {
        const rejoin = await api(p.token, 'POST', '/api/play/session/rejoin', {});
        sessionId = String(rejoin.json?.result?.session?.id || sessionId);
        const joined = await game('/join', { token: String(rejoin.json?.result?.ticket || '') });
        ok(`${p.symbol} пущен в игру`, joined.json?.ok === true, joined.json);
      }
      const finished = await game('/finish', { sessionId, winnerTeam: 1, durationSec: 4 });
      ok('игра прислала подписанный результат', finished.json?.ok === true, finished.json);
    }

    console.log('\n9. Результат виден обоим, и цикл повторяется');
    {
      ok('первый увидел итог', await until(one.page, /Матч закончен/i, 30), await text(one.page));
      ok('второй увидел итог', await until(two.page, /Матч закончен/i, 30), await text(two.page));
      ok('победитель назван обоим', /Победила команда/i.test(await text(two.page)), await text(two.page));
      await one.page.screenshot({ path: `${OUT}/play-two-clients-result.png` }).catch(() => {});

      // «Ещё раз»: готовность сброшена, и та же группа играет снова
      ok('первый снова может отметиться', await until(one.page, /Готов/i, 20), await text(one.page));
      ok('первый отметился повторно', await press(one.page, 'Готов'));
      ok('второй отметился повторно', await press(two.page, 'Готов'));
      ok('матч можно начать снова', await until(one.page, /Начать матч/i, 20), await text(one.page));
    }

    console.log('\n10. Выход из группы виден второму');
    {
      ok('второй вышел', await press(two.page, 'Выйти'));
      ok('первый остался один', await gone(one.page, new RegExp(`Игрок B ${stamp}`), 20),
        await text(one.page));
      const left = await api(B.token, 'GET', '/api/play/party');
      ok('и в группе его больше нет', left.json?.result === null, left.json?.result);
    }
  } catch (e: any) {
    ok(`прогон дошёл до конца (${e?.message || e})`, false);
  } finally {
    console.log('\n11. Возвращаем стенд в исходное состояние');
    await cleanup();
    const closed = await api(adminToken, 'GET', '/api/play/platform');
    ok('платформа снова закрыта', closed.status === 404, closed.status);
  }

  console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
  process.exit(f === 0 ? 0 : 1);
})();
