/**
 * Метки в живом текстовом документе: вставились, запомнились, обновились.
 *
 * Проверка написана по жалобе «умные блоки не работают». Правила меток считает
 * scripts/test-doc-labels.ts, но правила можно посчитать верно и всё равно
 * ничего не вставить: значение берётся с сервера, вставка идёт через движок
 * документа, а память о метке уезжает в базу и возвращается при следующем
 * открытии. Ошибиться можно в любом из четырёх мест, и каждое из них видно
 * только на живой программе.
 *
 * Главное здесь — не «кнопка нажалась», а что метка ПЕРЕЖИЛА закрытие
 * документа: именно этого раньше и не было — вставлялся мёртвый текст.
 *
 * Запуск (нужен поднятый сервер):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-labels-live.ts
 */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d).slice(0, 300) : ''));

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  await page.route('**/api/license/status', (r: any) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ licensed: true, machineId: 'TEST', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
  }));

  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6500);
    const inputs = await page.$$('input');
    await inputs[0].fill(LOGIN.symbol);
    await inputs[1].fill(LOGIN.password);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
    ok('вход выполнен', await page.evaluate(() => !!document.querySelector('[data-taskbar]')));

    // Проект нужен: значения меток берутся из него, без проекта кнопка
    // «Метки» выключена и мерить нечего
    const project = await page.evaluate(async () => {
      const me = JSON.parse(localStorage.getItem('pdm_session_user') || '{}');
      const r = await fetch('/api/projects');
      const list = (await r.json()).projects || (await (await fetch('/api/projects')).json());
      const p = (Array.isArray(list) ? list : [])[0];
      // Хранится проект целиком, а не только его номер (src/store/store.ts)
      if (p && me?.id) localStorage.setItem(`max_active_project_${me.id}`, JSON.stringify(p));
      return p ? { id: p.id, name: p.name, code: p.code, saved: !!me?.id } : null;
    });
    ok('проект для проб есть и он выбран', !!project?.saved, project);
    if (!project) throw new Error('нет проекта');

    // Документ создаём напрямую: путь «через интерфейс» уже проверен в
    // scripts/test-walkthrough.ts, здесь предмет другой
    const docId = await page.evaluate(async (projectId: string) => {
      const r = await fetch('/api/constructor/docs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // TEXT — текстовый документ; DOC в Flux Office означает таблицу
        body: JSON.stringify({ name: 'Проба меток', kind: 'TEXT', projectId }),
      });
      const d = await r.json();
      return d?.doc?.id || d?.id || '';
    }, project.id);
    ok('документ создан', !!docId, docId);

    console.log('1. Значения проекта сервер отдаёт теми же функциями, что и таблицам');
    const value = await page.evaluate(async (projectId: string) => {
      const r = await fetch('/api/constructor/fn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, calls: [{ fn: 'project', args: ['name'] }] }),
      });
      return r.ok ? String((await r.json()).results?.[0] ?? '') : '';
    }, project.id);
    ok('значение поля «Название» получено', !!value && value !== '#ОШИБКА', value);

    console.log('2. Метка, записанная в документ, переживает закрытие');
    // Пишем привязку так же, как её пишет редактор, и читаем обратно с
    // сервера: если колонка bindings не доезжает до базы, здесь и вскроется
    const label = {
      id: 'lb-проба', fn: 'project', args: ['name'], value, title: 'Проект · name',
    };
    const saved = await page.evaluate(async (args: any) => {
      const put = await fetch(`/api/constructor/docs/${args.docId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindings: JSON.stringify({ schemaVersion: 1, labels: [args.label] }) }),
      });
      if (!put.ok) return { ok: false, status: put.status };
      const back = await fetch(`/api/constructor/docs/${args.docId}`);
      const d = await back.json();
      return { ok: true, bindings: (d?.doc || d)?.bindings || '' };
    }, { docId, label });
    ok('привязки сохранились', saved.ok, saved);
    ok('и вернулись с сервера целыми',
      typeof saved.bindings === 'string' && saved.bindings.includes('lb-проба'), saved.bindings);

    console.log('3. Редактор открывает документ и знает про его метку');
    await page.goto(`${BASE}/#/sheet?doc=${encodeURIComponent(docId)}`, { waitUntil: 'domcontentloaded' });
    // Переход, отличающийся только решёткой, страницу не перезагружает, а
    // выбранный проект программа читает при загрузке — поэтому перезагружаем
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(11000);
    const opened = await page.evaluate(() => document.body.innerText);
    ok('редактор открыт', /Проба меток/.test(opened), opened.slice(0, 300));

    // Лента показывает органы только активной вкладки — как в Ворде. Метки
    // живут на вкладке «Данные проекта», её и открываем
    const dataTab = page.locator('button', { hasText: /^Данные проекта$/ }).first();
    ok('вкладка ленты «Данные проекта» есть', await dataTab.count() > 0);
    if (await dataTab.count()) { await dataTab.click(); await page.waitForTimeout(800); }

    // Кнопка «Обновить данные» на ленте должна быть живой: метка у документа
    // есть, значит обновлять есть что
    const refresh = page.locator('button', { hasText: 'Обновить данные' }).first();
    const seen = await refresh.count();
    ok('кнопка «Обновить данные» на ленте есть', seen > 0, seen);
    const enabled = seen > 0 && await refresh.isEnabled();
    ok('и она не выключена — документ помнит свою метку', enabled);
    if (enabled) {
      await refresh.click();
      await page.waitForTimeout(3000);
      const said = await page.evaluate(() => document.body.innerText);
      // Метка честно оторвалась: значения в тексте нет, мы его туда не писали.
      // Молчание или «обновлено N» здесь были бы хуже — они бы означали, что
      // программа не проверяет текст перед заменой
      ok('программа отчиталась о метках',
        /мет(ок|ки)|оторвал/i.test(said), said.slice(-400));
    }

    console.log('4. Панель меток показывает метку документа');
    const fields = page.locator('button', { hasText: 'Метки' }).first();
    if (await fields.count()) {
      await fields.click();
      await page.waitForTimeout(800);
      const tab = page.locator('button', { hasText: 'В документе' }).first();
      ok('вкладка «В документе» есть', await tab.count() > 0);
      if (await tab.count()) {
        await tab.click();
        await page.waitForTimeout(500);
        const list = await page.evaluate(() => document.body.innerText);
        ok('метка видна списком', list.includes('Проект · name'), list.slice(-400));
      }
    }

    // Прибираем за собой: проба не должна оставлять мусор в проекте
    await page.evaluate((id: string) => fetch(`/api/constructor/docs/${id}`, { method: 'DELETE' }), docId);
  } catch (e: any) {
    f++;
    console.error('  ✗ проба оборвалась:', e?.message || e);
  } finally {
    await browser.close();
  }

  if (f) { console.error(`\nПровалено проверок: ${f}`); process.exit(1); }
  console.log('\nМетки живого документа: все проверки пройдены');
})();
