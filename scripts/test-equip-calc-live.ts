/**
 * Выгрузка расчёта из САПР доходит до оборудования — вживую, в браузере.
 *
 * Обращение ОБР-000006: «не удаётся загрузить данные оборудования из расчётной
 * программы формата XML». Разбор при этом работал: ломался путь. Человек
 * приносил файл в «Импорт из документов», а мастер отвечал советом пойти в
 * «Оборудование» → «Импорт расчёта» — кнопки с таким именем там нет и не было.
 *
 * Поэтому проверяется не разбор (его стережёт test-veza-xml), а именно дорога:
 * файл, принесённый в мастер, доходит до предпросмотра импорта.
 *
 * Файл синтетический (scripts/fixtures/veza.ts): настоящие выгрузки заказчика
 * в репозиторий не попадают.
 *
 * Запуск (сервер поднят):
 *   npx tsx scripts/test-equip-calc-live.ts
 */

import { VEZA_SAMPLE_XML } from './fixtures/veza';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const USER = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const OUT = process.env.FLUX_FRAMES || '.walkthrough';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? String(d).slice(0, 300) : '')));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const text = async (page: any): Promise<string> =>
  String(await page.evaluate('document.body.innerText')).replace(/\s+/g, ' ');

async function until(page: any, re: RegExp, seconds = 20): Promise<boolean> {
  for (let i = 0; i < seconds * 2; i++) {
    if (re.test(await text(page))) return true;
    await wait(500);
  }
  return false;
}

async function press(page: any, label: RegExp | string): Promise<boolean> {
  const done = await page.evaluate(`(() => {
    const want = ${JSON.stringify(String(label instanceof RegExp ? label.source : label))};
    const re = new RegExp(want, 'i');
    for (const b of document.querySelectorAll('button')) {
      if (b.disabled) continue;
      if (re.test((b.innerText || '').trim())) { b.click(); return true; }
    }
    return false;
  })()`);
  if (done) await page.waitForTimeout(1200);
  return !!done;
}

(async () => {
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`);
    process.exit(2);
  }

  console.log('1. Сервер разбирает выгрузку, принесённую прямо в мастер');
  {
    const login = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(USER),
    });
    const token = String(((await login.json()) as any)?.token || '');
    ok('вход выполнен', !!token);

    const res = await fetch(BASE + '/api/equipment/parse-calc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: VEZA_SAMPLE_XML, fileName: 'расчёт.xml' }),
    });
    const data: any = await res.json().catch(() => ({}));
    ok('выгрузка разобрана', res.ok && Array.isArray(data?.units) && data.units.length > 0, data?.error);
    const blocks = (data?.units || []).reduce(
      (s: number, u: any) => s + (u.monoblocks || []).reduce((k: number, m: any) => k + (m.blocks || []).length, 0), 0,
    );
    ok('блоки на месте', blocks > 0, blocks);

    /**
     * Разобранное годится тому же плану, что и распознанное.
     *
     * Это не придирка к форме: предпросмотр отправляет единицы в
     * `import-draft-plan`, и разойдись они полем — человек увидел бы пустой
     * план вместо своего расчёта. План ничего не пишет, проверять им безопасно.
     */
    /**
     * Проект указывается явно.
     *
     * Раньше предпросмотр без проекта заводил «Общий Проект» сам, и оборудование
     * уезжало не туда, куда человек думал. Теперь отсутствие проекта — отказ со
     * словами, и проверка обязана ходить так же, как окно: с проектом.
     */
    const projects = await fetch(BASE + '/api/projects', { headers: { Authorization: `Bearer ${token}` } });
    const pj: any = await projects.json().catch(() => ({}));
    const projectId = (Array.isArray(pj) ? pj : (pj?.projects || []))[0]?.id || '';
    ok('проект для проверки найден', !!projectId, pj);

    const plan = await fetch(BASE + '/api/equipment/import-draft-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ units: data.units, category: 'AHU', projectId }),
    });
    const planned: any = await plan.json().catch(() => ({}));
    ok('план по разобранному расчёту строится', plan.ok && !!planned?.plan, planned?.error);
    const addCount = (planned?.plan?.add || planned?.plan?.create || []).length;
    ok('и в нём есть, что завести', addCount > 0 || JSON.stringify(planned?.plan || {}).length > 50, addCount);

    const plain = await fetch(BASE + '/api/equipment/parse-calc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: '<Root><Nothing/></Root>', fileName: 'пусто.xml' }),
    });
    ok('пустышка отклонена словами, а не молчанием', plain.status === 400, plain.status);
  }

  console.log('\n2. Тот же файл проходит дорогу человека: мастер → предпросмотр');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await page.route('**/api/license/status', (r: any) => r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ licensed: true, machineId: 'calc', expiresAt: Date.now() + 9e8, daysLeft: 30, reason: '' }),
    }));
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input', { timeout: 40000 });
    await page.waitForTimeout(1500);
    const inputs = await page.$$('input');
    await inputs[0].fill(USER.symbol);
    await inputs[1].fill(USER.password);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(9000);

    await page.goto(`${BASE}/#/equipment`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    ok('раздел «Оборудование» открыт', await until(page, /Оборудован/i, 20), await text(page));

    // Проект выбирают там, где о нём спрашивают: раздел сам предлагает список
    if (/Сначала выберите проект/.test(await text(page))) {
      await page.locator('button', { hasText: /проект/i }).last().click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    ok('проект выбран', !/Сначала выберите проект/.test(await text(page)), await text(page));

    ok('мастер импорта открылся', await press(page, 'Импорт из документов'), await text(page));
    await page.waitForTimeout(1500);

    /**
     * Файл приносим полем САМОГО МАСТЕРА.
     *
     * Полей выбора файла на странице несколько — своё есть и у рабочего стола.
     * Взяв первое попавшееся, проверка кладёт файл на стол и потом ищет на
     * экране то, чего там быть не может.
     */
    const inputs2 = await page.$$('[role="dialog"] input[type="file"], .fixed input[type="file"]');
    const input = inputs2[inputs2.length - 1];
    ok('поле выбора файла в мастере на месте', !!input, inputs2.length);
    await input!.setInputFiles({ name: 'расчёт.xml', mimeType: 'text/xml', buffer: Buffer.from(VEZA_SAMPLE_XML, 'utf-8') });

    ok('мастер понял, что это расчёт', await until(page, /Расчёт разобран/i, 25), await text(page));
    ok('и не отправил человека искать несуществующую кнопку',
      !/Импорт расчёта»/i.test(await text(page)), await text(page));

    await page.screenshot({ path: `${OUT}/equip-calc-wizard.png` }).catch(() => {});

    ok('кнопка импорта появилась', await press(page, 'Проверить и импортировать'), await text(page));
    ok('предпросмотр открылся', await until(page, /Предпросмотр|Что изменится|Импортировать/i, 25), await text(page));
    await page.screenshot({ path: `${OUT}/equip-calc-preview.png` }).catch(() => {});
  } catch (e: any) {
    ok(`прогон дошёл до конца (${e?.message || e})`, false);
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
