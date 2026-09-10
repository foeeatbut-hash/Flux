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
/** SHOTS=1 — сохранять снимки для владельца. По умолчанию набор их не делает. */
const SHOTS = process.env.SHOTS === '1' ? (process.env.SHOTS_DIR || '/tmp/flux-feedback') : '';

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
    const text = await page.evaluate(() => document.body.textContent || '');
    ok('раздел открылся', /Новое обращение/.test(text), text.slice(0, 200));
    ok('очередь разбора видна администратору', /Очередь разбора/.test(text));

    console.log('\n2. Обращение пишется и уходит');
    await page.click('text=Новое обращение');
    // Форма ленивая: ждём её появления, а не отмеренную паузу — иначе набор
    // рапортует о поломке там, где просто не дождался
    const formShown = await page.waitForSelector('input[placeholder*="Закрылась"]', { timeout: 20000 })
      .then(() => true).catch(() => false);
    ok('форма открылась', formShown, await page.evaluate(() => (document.body.textContent || '').slice(0, 300)));

    await page.fill('input[placeholder*="Закрылась"]', title);
    await page.fill('textarea', 'Живая проверка: описание длиннее десяти знаков, как требует договор.');
    await page.waitForTimeout(900);

    ok('предпросмотр показывает то, что уйдёт', await (async () => {
      await page.click('text=Посмотреть, что уйдёт');
      await page.waitForTimeout(600);
      const shown = await page.evaluate(() => document.body.textContent || '');
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
      // textContent, а не innerText: окно, ушедшее на второй план, оболочка
      // скрывает через display:none, и innerText такой текст не отдаёт — проверка
      // объявляла поломкой то, что просто оказалось за другим окном
      () => /Отправлено/.test(document.body.textContent || ''), null, { timeout: 60000 },
    ).then(() => true).catch(() => false);
    // При провале важно не «чего нет на странице», а что показывает сама форма:
    // осталась ли она открыта и на каком шаге застряла
    const state = await page.evaluate(() => {
      const box = document.querySelector('[aria-label="Обращение"]');
      return { есть: !!box, текст: box ? (box.textContent || '').slice(0, 200) : '' };
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

    /**
     * Доступ разбирающего, а не место в первой сотне.
     *
     * Очередь отдаётся одной страницей, сначала старым, и курсора у неё пока
     * нет — на базе, где обращений больше сотни, новая карточка за край
     * страницы уходит всегда. Это известная дыра (серверная пагинация — этап
     * 2 задания), и проверять ею доступ бессмысленно: набор падал бы не на
     * поломке, а на длине очереди. Поэтому спрашиваем то, что и есть
     * настоящий вопрос: видит ли карточку разбирающий.
     */
    const forTriage = await fetch(`${BASE}/api/feedback/reports/${row?.id}`, { headers: head })
      .then((r) => r.json());
    ok('карточка доступна разбирающему', forTriage?.data?.id === row?.id, forTriage?.error);
    const queue = await fetch(`${BASE}/api/feedback/reports?scope=queue&status=NEW&limit=100`,
      { headers: head }).then((r) => r.json());
    ok('очередь разбора отвечает', Array.isArray(queue?.data), queue?.error);

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

    console.log('\n4.1. Панель у кнопки: одно поле, и записи уезжают сами');
  // Ради этого раздела всё и делалось. Проверяется не «есть ли поле», а три
  // вещи, каждая из которых по отдельности молча теряла работу человека:
  // панель открывается из верхней кнопки, написанное переживает закрытие, и
  // технические записи доезжают до карточки сами
  {
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.location.hash = '#/'; });
    await page.waitForTimeout(1500);

    // У кнопки и у панели одинаковый aria-label — различаем по роли, иначе
    // селектор совпадает с кнопкой и «полей ноль» означает не то, что кажется
    const panel = 'div[role="dialog"][aria-label="Сообщить о проблеме"]';
    const opened = await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Сообщить о проблеме"]');
      if (btn) (btn as HTMLButtonElement).click();
      return !!btn;
    });
    ok('в верхней панели есть «Сообщить о проблеме»', opened);
    await page.waitForSelector(panel, { timeout: 15000 });

    const shown = await page.evaluate((sel: string) => {
      const box = document.querySelector(sel);
      return {
        текст: (box?.textContent || '').replace(/\s+/g, ' '),
        затемнение: !!document.querySelector('.bg-slate-900\\/40'),
        полей: box?.querySelectorAll('textarea,input').length || 0,
        галочек: box?.querySelectorAll('input[type=checkbox]').length || 0,
      };
    }, panel);
    ok('одно поле и ни одной галочки', shown.полей === 1 && shown.галочек === 0, shown);
    ok('панель не затемняет программу', !shown.затемнение, shown);
    ok('технического текста в панели нет',
      !/Технические записи этого окна|журнал|Экспорт|Подробно/i.test(shown.текст), shown.текст.slice(0, 200));

    // Написанное обязано пережить закрытие. Раньше текст жил в состоянии
    // формы, в черновик уходила пустота, и закрытие панели теряло всё
    const kept = `__панель ${stamp}. Закрылась Таблица при вставке столбца.`;
    await page.fill(`${panel} textarea`, kept);
    await page.waitForTimeout(900);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const gone = await page.$(panel);
    ok('Esc сворачивает панель', !gone);

    await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Сообщить о проблеме"]');
      if (btn) (btn as HTMLButtonElement).click();
    });
    await page.waitForSelector(panel, { timeout: 15000 });
    await page.waitForTimeout(1200);
    const restored = await page.evaluate((sel: string) =>
      (document.querySelector(`${sel} textarea`) as HTMLTextAreaElement)?.value || '', panel);
    ok('написанное вернулось на место', restored === kept, restored.slice(0, 120));

    // Снимок панели сотрудника: владельцу нужно увидеть, что у человека одно
    // поле и одна кнопка, а не читать об этом словами
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/панель-сотрудника.png` });

    /**
     * Двойное нажатие — двумя нажатиями в одном такте.
     *
     * Не двумя `page.click`: после первого панель перестраивается («Отправлено»
     * вместо поля), она становится ниже, и второе нажатие по прежним
     * координатам попадает уже МИМО панели — а клик мимо её сворачивает. Так
     * набор ловил собственный промах и объявлял его поломкой. Нажимаем прямо в
     * странице, синхронно: ровно это и делает человек, стукнув дважды.
     */
    await page.evaluate((sel: string) => {
      const btn = Array.from(document.querySelectorAll(`${sel} button`))
        .find((b) => /Отправить/.test(b.textContent || '')) as HTMLButtonElement | undefined;
      btn?.click();
      btn?.click();
    }, panel);
    const done = await page.waitForFunction(
      (sel: string) => /Отправлено/.test(document.querySelector(sel)?.textContent || ''),
      panel, { timeout: 120000 },
    ).then(() => true).catch(() => false);
    const state = await page.evaluate((sel: string) => {
      const box = document.querySelector(sel);
      return { есть: !!box, текст: box ? (box.textContent || '').replace(/\s+/g, ' ').slice(0, 200) : '' };
    }, panel);
    ok('панель отправила обращение', done, state);
    ok('показан номер обращения, а не просто «готово»', /ОБР-\d{6}/.test(state.текст), state.текст);

    const token2 = await page.evaluate(() => localStorage.getItem('flux_auth_token') || '');
    const head2 = { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' };
    const list = await fetch(`${BASE}/api/feedback/reports?scope=mine`, { headers: head2 }).then((r) => r.json());
    const fromPanel = (list?.data || []).filter((r: any) => String(r.title).includes(`__панель ${stamp}`));
    const quick = fromPanel[0];
    ok('обращение из панели завелось', !!quick, (list?.data || []).slice(0, 2));
    // Ради этого и защёлка: два нажатия подряд — одна карточка, а не две
    ok('двойное нажатие завело ровно одну карточку', fromPanel.length === 1, fromPanel.length);

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

    /**
     * Опись полноты — то, ради чего пакет и переделывался.
     *
     * Без неё разбирающий читает сводку без ошибок и делает вывод, что ошибок
     * не было. Здесь проверяется, что про КАЖДЫЙ источник сказано, что с ним:
     * окно приложено, оболочки в браузере нет по устройству программы (а не
     * «прочитать не удалось»), сервер и база названы своими словами.
     */
    const sources = described?.manifest?.sources || [];
    const byName = Object.fromEntries(sources.map((one: any) => [one.source, one]));
    ok('в описи все четыре источника',
      ['renderer', 'shell', 'server', 'database'].every((n) => byName[n]),
      sources.map((o: any) => o.source));
    ok('записи окна приложены и посчитаны',
      byName.renderer?.state === 'available' && byName.renderer?.events > 0, byName.renderer);
    ok('оболочки в браузере нет — и это сказано как отсутствие, а не как ошибка',
      byName.shell?.state === 'unavailable' && /браузере/.test(byName.shell?.reason || ''), byName.shell);
    ok('про сервер и базу сказано, что с ними',
      !!byName.server?.state && !!byName.database?.state
      && (byName.server.state !== 'available' ? !!byName.server.reason : true),
      { server: byName.server, database: byName.database });
    ok('состояние сборки названо словом',
      ['READY', 'PARTIAL'].includes(described?.state), described?.state);
    ok('интервал, за который собирали, записан',
      !!described?.manifest?.requestedFrom && !!described?.manifest?.requestedTo,
      described?.manifest?.requestedFrom);

    // Автор приложил записи, чтобы помочь разобрать поломку, а не чтобы
    // читать разбор работы программы: технической части ему не отдают
    const asAuthor = await fetch(`${BASE}/api/feedback/reports/${quick?.id}`, {
      headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
    }).then((r) => r.json());
    ok('разбирающий видит техническую часть', (asAuthor?.data?.diagnostics || []).length > 0);

    /**
     * Пакет для разработчика — настоящим архивом, а не списком имён.
     *
     * Экспорт отдавал Markdown с перечнем вложений. Имена — это не данные: по
     * строке «диагностика.jsonl» сбой не воспроизвести. Здесь проверяется, что
     * в архиве лежит то, с чем можно работать, и что первым делом в нём
     * сказано, чего в пакете НЕТ.
     */
    const pack = await fetch(`${BASE}/api/feedback/reports/${quick?.id}/package`, {
      headers: { Authorization: `Bearer ${token2}` },
    });
    ok('пакет отдаётся', pack.status === 200, pack.status);
    const zipBytes = new Uint8Array(await pack.arrayBuffer());
    ok('это настоящий zip', zipBytes[0] === 0x50 && zipBytes[1] === 0x4b, [...zipBytes.slice(0, 4)]);
    // Имена файлов лежат в архиве открытым текстом даже при сжатии содержимого
    const asText = Buffer.from(zipBytes).toString('latin1');
    for (const part of ['README.md', 'manifest.json', 'summary.json', 'timeline.json', 'reproduction.md']) {
      ok(`в архиве есть ${part}`, asText.includes(part));
    }
    ok('сырые записи источников приложены', /sources\//.test(asText));
    // Сжатие не для красоты: JSONL ужимается на порядок, и без него пакет из
    // мегабайтов записей ехал бы человеку по сети как есть
    const rawSize = (described?.manifest?.sources || [])
      .reduce((sum: number, one: any) => sum + (one.bytes || 0), 0);
    ok('архив меньше сырых записей — значит сжат',
      rawSize > 0 && zipBytes.length < rawSize, { архив: zipBytes.length, сырые: rawSize });

    // Снимок карточки администратора: покрытие, задержки, ошибки и пакет
    if (SHOTS) {
      // Панель закрываем: иначе она перекрывает карточку на снимке
      await page.evaluate(() => {
        const close = document.querySelector('div[role="dialog"][aria-label="Сообщить о проблеме"] button[aria-label="Закрыть"]');
        if (close) (close as HTMLElement).click();
      });
      await page.evaluate(() => { window.location.hash = '#/feedback'; });
      await page.waitForTimeout(2500);
      const opened = await page.click(`text=__панель ${stamp}`, { timeout: 15000 })
        .then(() => true).catch(() => false);
      ok('карточка для снимка открыта', opened);
      await page.waitForTimeout(3000);
      // Разворачиваем разделы: свёрнутые они на снимке ничего не показывают
      await page.evaluate(() => {
        for (const b of Array.from(document.querySelectorAll('button'))) {
          if (/Задержки|Ошибки|Цепочки/.test(b.textContent || '')) (b as HTMLElement).click();
        }
      });
      await page.waitForTimeout(800);
      // Догоняем до технической части: свёрнутые разделы на снимке пусты, а
      // владельцу нужно увидеть именно их
      await page.evaluate(() => {
        const head = Array.from(document.querySelectorAll('*'))
          .find((n) => (n.textContent || '').trim() === 'Что видно в записях');
        head?.scrollIntoView({ block: 'start' });
      });
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/карточка-администратора.png` });
    }
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
