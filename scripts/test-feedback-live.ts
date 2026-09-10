/**
 * Обращение живьём: браузер, сервер, база.
 *
 * Остальные наборы проверяют части — договор, переходы, куски файла. Здесь
 * проверяется то, ради чего всё делалось: сотрудник открывает раздел, пишет
 * обращение, оно доезжает до базы и появляется в очереди разбора с номером.
 * Ни одна проверка по отдельности этого не показывает: форма может собирать
 * правильное тело и не отправлять его, а сервер — принимать правильное тело,
 * которого никто не шлёт.
 *
 * Отдельно проверяется главное обещание приватности: внутренняя заметка не
 * доходит до автора. Не «поле выставлено», а «в ответе сервера автору её
 * нет» — проверяется настоящим запросом от имени автора.
 *
 * Запуск (нужен поднятый сервер и playwright-core):
 *   nohup npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-feedback-live.ts
 */

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)));

async function main() {
  const alive = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
  if (!alive) { console.log('Сервер не отвечает — набор пропущен. Поднимите: npx tsx server.ts'); process.exit(2); }

  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); }
  catch (_) { console.log('playwright-core не установлен — набор пропущен'); process.exit(2); }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // Лицензия проверяется подписью, приватного ключа в репозитории нет —
  // подменяем только ответ проверки, код программы не трогаем. Без этого набор
  // упирается в экран активации и не доходит даже до входа
  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));

  const noise: string[] = [];
  page.on('console', (m: any) => { if (m.type() === 'error') noise.push(m.text()); });
  page.on('pageerror', (e: any) => noise.push(`исключение: ${String(e.message).slice(0, 200)}`));

  const stamp = Date.now();
  const title = `__живая проверка обращения ${stamp}`;

  try {
    console.log('1. Вход и раздел');
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    // Ждать вслепую нельзя: сборка грузится по-разному, и набор падал на своей
    // же подготовке — «поля не нашлись» вместо разговора о программе
    await page.waitForSelector('input', { timeout: 30000 });
    await page.waitForTimeout(1500);
    const inputs = await page.$$('input');
    await inputs[0].fill(LOGIN.symbol);
    await inputs[1].fill(LOGIN.password);
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-taskbar]', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);
    ok('вход выполнен', await page.evaluate(() => !!document.querySelector('[data-taskbar]')));

    await page.evaluate(() => { window.location.hash = '#/feedback'; });
    await page.waitForTimeout(3500);
    const text = await page.evaluate(() => document.body.innerText);
    ok('раздел открылся', /Новое обращение/.test(text), text.slice(0, 200));
    ok('очередь разбора видна администратору', /Очередь разбора/.test(text));

    console.log('\n2. Обращение пишется и уходит');
    await page.click('text=Новое обращение');
    // Форма ленивая: ждём её появления, а не отмеренную паузу — иначе набор
    // рапортует о поломке там, где просто не дождался
    const formShown = await page.waitForSelector('input[placeholder*="Закрылась"]', { timeout: 20000 })
      .then(() => true).catch(() => false);
    ok('форма открылась', formShown, await page.evaluate(() => document.body.innerText.slice(0, 300)));

    await page.fill('input[placeholder*="Закрылась"]', title);
    await page.fill('textarea', 'Живая проверка: описание длиннее десяти знаков, как требует договор.');
    await page.waitForTimeout(900);

    ok('предпросмотр показывает то, что уйдёт', await (async () => {
      await page.click('text=Посмотреть, что уйдёт');
      await page.waitForTimeout(600);
      const shown = await page.evaluate(() => document.body.innerText);
      await page.click('text=Править');
      await page.waitForTimeout(400);
      return shown.includes(title);
    })());

    await page.click('button:has-text("Отправить")');
    /**
     * Ждём подтверждения сервером, а не нажатия.
     *
     * Отмеренная пауза здесь врёт в обе стороны: на быстрой машине набор ждёт
     * впустую, на медленной — объявляет поломкой то, что просто ещё едет.
     * «Отправлено» ставится только после ответа сервера, его и ждём.
     */
    const told = await page.waitForFunction(
      () => /Отправлено/.test(document.body.innerText), null, { timeout: 45000 },
    ).then(() => true).catch(() => false);
    // При провале важно не «чего нет на странице», а что показывает сама форма:
    // осталась ли она открыта и на каком шаге застряла
    const state = await page.evaluate(() => {
      const box = document.querySelector('[aria-label="Сообщить об ошибке"]') as HTMLElement | null;
      return { есть: !!box, текст: box ? box.innerText.slice(0, 200) : '' };
    });
    ok('форма сообщила об отправке', told, state);

    console.log('\n3. Обращение доехало до базы');
    const token = await page.evaluate(() => localStorage.getItem('flux_auth_token') || '');
    const head = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const mine = await fetch(`${BASE}/api/feedback/reports?scope=mine`, { headers: head }).then((r) => r.json());
    const row = (mine?.data || []).find((r: any) => r.title === title);
    ok('карточка есть в списке', !!row, (mine?.data || []).length);
    ok('у карточки есть номер', !!row?.number, row?.number);
    ok('состояние — «Новое»', row?.status === 'NEW', row?.status);

    // Очередь отдаётся страницей и сначала старым — новая карточка на живой
    // базе оказывается за краем страницы. Поэтому спрашиваем очередь новых и с
    // запасом: проверяется, что карточка в ней есть, а не то, что она сверху
    const queue = await fetch(`${BASE}/api/feedback/reports?scope=queue&status=NEW&limit=100`,
      { headers: head }).then((r) => r.json());
    ok('карточка попала в очередь разбора',
      (queue?.data || []).some((r: any) => r.id === row?.id), (queue?.data || []).length);

    console.log('\n4. Внутренняя заметка не доходит до автора');
    // Автор — тот же человек, поэтому заводим отдельного сотрудника-автора:
    // проверять приватность на себе бессмысленно
    const pass = `Pw${stamp}!`;
    const symbol = `fbl${stamp}`.slice(0, 12);
    const made = await fetch(`${BASE}/api/users`, {
      method: 'POST', headers: head,
      body: JSON.stringify({ symbol, name: 'Живая Проверка', password: pass, role: 'USER' }),
    }).then((r) => r.json()).catch(() => null);
    const authorId = made?.user?.id || made?.id || '';
    ok('сотрудник для проверки заведён', !!authorId, made);

    if (authorId) {
      const mateToken = await fetch(`${BASE}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, password: pass }),
      }).then((r) => r.json()).then((d: any) => d?.token || '');
      const mateHead = { Authorization: `Bearer ${mateToken}`, 'Content-Type': 'application/json' };

      const meta = await fetch(`${BASE}/api/feedback/meta`, { headers: mateHead }).then((r) => r.json());
      const key = () => crypto.randomUUID();
      const created = await fetch(`${BASE}/api/feedback/reports`, {
        method: 'POST', headers: mateHead,
        body: JSON.stringify({
          schemaVersion: 1, clientRequestId: key(), deploymentId: meta?.data?.deploymentId,
          type: 'BUG', title: `__приватность ${stamp}`,
          description: 'Обращение для проверки видимости внутренней заметки.',
          sectionKey: '/feedback', incidentAt: new Date().toISOString(), appVersion: '0.0.0',
          frequency: 'ONCE', impact: 'LOW', uploadIds: [],
          consent: { technicalEvents: false, appContext: true, reviewedAt: new Date().toISOString() },
        }),
      }).then((r) => r.json());
      const reportId = created?.data?.id;
      ok('автор завёл своё обращение', !!reportId, created);

      const secret = `тайна-обработчика-${stamp}`;
      const noted = await fetch(`${BASE}/api/feedback/reports/${reportId}/comments`, {
        method: 'POST', headers: head,
        body: JSON.stringify({
          text: secret, visibility: 'INTERNAL', clientRequestId: key(), expectedRevision: 1,
        }),
      }).then((r) => r.json());
      ok('обработчик написал внутреннюю заметку', !noted?.error, noted?.error);

      const seenByAuthor = await fetch(`${BASE}/api/feedback/reports/${reportId}/comments`, { headers: mateHead })
        .then((r) => r.text());
      ok('автор заметки не видит', !seenByAuthor.includes(secret), seenByAuthor.slice(0, 200));

      const cardForAuthor = await fetch(`${BASE}/api/feedback/reports/${reportId}`, { headers: mateHead })
        .then((r) => r.text());
      ok('и в карточке её тоже нет', !cardForAuthor.includes(secret));

      const seenByTriage = await fetch(`${BASE}/api/feedback/reports/${reportId}/comments`, { headers: head })
        .then((r) => r.text());
      ok('обработчику она видна', seenByTriage.includes(secret));
    }

    console.log('\n4.1. Короткая форма: строка, и записи уезжают сами');
  // Решение владельца: сотруднику журналы не показываются, он пишет строку.
  // Проверяется не «есть ли поле», а доезжают ли записи до карточки: без них
  // разбирающий получит слова без единого числа
  {
    // Форма могла остаться открытой от прошлого раздела — закрываем, иначе
    // нажатия уходят в неё
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.location.hash = '#/settings'; });
    await page.waitForTimeout(3000);
    const inSettings = await page.evaluate(() => {
      const entry = Array.from(document.querySelectorAll('button'))
        .find((b) => /Ошибки и сбои/.test(b.textContent || ''));
      if (entry) (entry as HTMLButtonElement).click();
      return !!entry;
    });
    ok('в Настройках есть «Ошибки и сбои»', inSettings);
    await page.waitForTimeout(1500);

    const opened = await page.evaluate(() => {
      const found = Array.from(document.querySelectorAll('button'))
        .find((b) => /Сообщить об ошибке/.test(b.textContent || ''));
      if (found) (found as HTMLButtonElement).click();
      return !!found;
    });
    ok('кнопка «Сообщить об ошибке» на месте', opened);
    await page.waitForTimeout(1500);

    const shown = await page.evaluate(() => document.body.innerText);
    ok('форма — одна строка, без галочек про журналы',
      /Что случилось/.test(shown) && !/Технические записи этого окна/.test(shown),
      shown.slice(0, 200));
    ok('сказано, что записи приложатся сами', /сама приложит свои технические записи/.test(shown));

    const short = `__короткая форма ${stamp}. Закрылась Таблица при вставке столбца.`;
    // Ищем внутри самого окна формы: снаружи есть свои поля и своя кнопка
    // «Отправить», и нажатие уходило в них, а не сюда
    const box = '[aria-label="Сообщить об ошибке"]';
    await page.fill(`${box} textarea`, short);
    await page.click(`${box} button:has-text("Отправить")`);
    // Ждём долго намеренно: перед подтверждением уезжает пакет записей, и на
    // небыстрой машине это дольше, чем кажется. Сорока пяти секунд не хватило —
    // карточка к тому времени уже была заведена, а надпись ещё не появилась
    const done = await page.waitForFunction(
      () => /Отправлено|Обращение появилось/.test(document.body.innerText), null, { timeout: 120000 },
    ).then(() => true).catch(() => false);
    ok('короткая форма отправилась', done, await page.evaluate(() => document.body.innerText.slice(0, 200)));

    const token2 = await page.evaluate(() => localStorage.getItem('flux_auth_token') || '');
    const head2 = { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' };
    const list = await fetch(`${BASE}/api/feedback/reports?scope=mine`, { headers: head2 }).then((r) => r.json());
    const quick = (list?.data || []).find((r: any) => String(r.title).includes('короткая форма'));
    ok('обращение из короткой формы завелось', !!quick, (list?.data || []).slice(0, 2));

    const full = await fetch(`${BASE}/api/feedback/reports/${quick?.id}`, { headers: head2 }).then((r) => r.json());
    const bundle = (full?.data?.attachments || []).find((a: any) => a.kind === 'DIAGNOSTICS');
    ok('технические записи приложились сами', !!bundle, full?.data?.attachments);
    ok('и их можно прочитать', bundle
      ? (await fetch(`${BASE}/api/feedback/attachments/${bundle.id}`, { headers: head2 })).status === 200
      : false);

    // Сводка считается после создания карточки и без ожидания ответа, поэтому
    // спрашиваем не сразу
    await page.waitForTimeout(3000);
    const withSummary = await fetch(`${BASE}/api/feedback/reports/${quick?.id}`, { headers: head2 })
      .then((r) => r.json());
    const described = (withSummary?.data?.diagnostics || [])[0];
    ok('записи разобраны в сводку', !!described?.summary, withSummary?.data?.diagnostics);
    ok('в сводке посчитаны события', (described?.summary?.events ?? 0) > 0, described?.summary?.events);
    ok('сказано, сколько строк не разобралось',
      described?.manifest?.broken !== undefined, described?.manifest);
  }

  console.log('\n5. Тишина в консоли');
    const real = noise.filter((n) => !/favicon|ResizeObserver/.test(n));
    ok('ошибок в консоли нет', real.length === 0, real.slice(0, 3));
  } finally {
    await browser.close();
  }

  console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error('Набор не отработал:', error); process.exit(1); });
