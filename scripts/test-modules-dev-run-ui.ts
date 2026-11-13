/**
 * Окно Flux: программа из разработки («Запустить во Flux» из Studio). Плашка «Разработка — не выпущено» в списке и в
 * окне программы, «Убрать», окно согласия на разрешения (то же, что при установке из Store), остановка запущенной
 * программы, когда срок аренды вышел. Главный процесс заменён подделкой в памяти страницы (scripts/fixtures/dev-run-ui.tsx);
 * настоящая проверка подписей, срока и протокола — test-modules-dev-run-host.ts и test-modules-dev-run-native.ts.
 *
 * Запуск: FLUX_UI_URL=http://127.0.0.1:5411 FLUX_CHROME=… npx tsx scripts/test-modules-dev-run-ui.ts
 * SHOT=/путь/dev.png — снимки в обеих темах.
 */
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { permissionsDigest } from '../modules/store/model';
import { verifySkip } from './verifySkip';

const BASE = process.env.FLUX_UI_URL || '';
let checks = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks++; console.log(`  ✓ ${label}`); };

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/modules/store') return route.fulfill({ json: { listings: [], autoUpdate: false } });
    if (p === '/api/modules/me') return route.fulfill({ json: { owner: false, channels: ['production'], develop: true, publish: true } });
    if (p === '/api/modules/revocations') return route.fulfill({ json: { revocations: [] } });
    if (p === '/api/modules/pins') return route.fulfill({ json: { pins: [] } });
    if (p === '/api/modules/promotions') return route.fulfill({ json: { promotions: [] } });
    if (p === '/api/modules/releases') return route.fulfill({ json: { releases: [] } });
    return route.fulfill({ json: {} });
  });
}

async function run() {
  if (!BASE || !process.env.FLUX_CHROME) { verifySkip('нужны FLUX_UI_URL (свой Vite) и FLUX_CHROME'); return; }
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await mockApi(page);
    const shot = process.env.SHOT;
    const snap = async (name: string) => {
      if (!shot) return;
      for (const dark of [false, true]) {
        await page.evaluate((d) => { document.documentElement.classList.toggle('dark', d); }, dark);
        await page.waitForTimeout(150);
        await page.screenshot({ path: shot.replace(/\.png$/, `-${name}${dark ? '-dark' : ''}.png`) });
      }
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
    };
    const calls = () => page.evaluate(() => (window as any).__calls as Array<{ channel: string; data: any }>);
    const fire = () => page.evaluate(() => (window as any).__fire());

    console.log('Библиотека Store: «Из разработки»');
    await page.goto(`${BASE}/scripts/fixtures/dev-run-ui.html?view=store`);
    await page.getByTestId('stx-nav-library').click();
    await page.getByTestId('stx-dev').waitFor();
    check('в списке три записи: две живые и одна отказанная', await page.locator('[data-testid^="stx-dev-"]').count() === 3);
    const ready = page.getByTestId('stx-dev-dev-ready');
    check('плашка «Разработка — не выпущено» у живой', /Разработка — не выпущено/.test(await ready.innerText()));
    const broken = page.getByTestId('stx-dev-dev-broken');
    check('у отказанной причина словами и «Не запускается», кнопки «Открыть» нет', /Studio закрыта: запуск из разработки прекращён/.test(await broken.innerText())
      && /Не запускается/.test(await broken.innerText()) && await broken.getByRole('button', { name: 'Открыть' }).count() === 0);
    check('принятая открывается, непринятая просит запуска', await ready.getByRole('button', { name: 'Открыть' }).count() === 1
      && await page.getByTestId('stx-dev-dev-prog').getByRole('button', { name: 'Запустить' }).count() === 1);
    // Замер: плашка — точка и слово, не мельче 12 px, вес не больше 600
    const badge = await ready.locator('.fx-st').first().evaluate((el) => { const s = getComputedStyle(el); return { size: parseFloat(s.fontSize), weight: Number(s.fontWeight) }; });
    check(`плашка: кегль ${badge.size} ≥ 12, вес ${badge.weight} ≤ 600`, badge.size >= 12 && badge.weight <= 600);
    const heights = await page.$$eval('[data-testid^="stx-dev-"]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    check(`карточки не выше 80 px: ${heights.join(', ')}`, heights.every((h) => h >= 56 && h <= 80));
    check('горизонтальной прокрутки нет', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await snap('library');

    console.log('Согласие на разрешения');
    await page.getByTestId('stx-dev-dev-prog').getByRole('button', { name: 'Запустить' }).click();
    await page.getByTestId('dev-consent').waitFor();
    const text = await page.getByTestId('dev-consent').innerText();
    check('окно: название, плашка, разрешения, оговорка про непроверенную сборку', /Расчёт нагрузок 0\.3\.0/.test(text) && /Разработка — не выпущено/.test(text) && /Читает во Flux/.test(text) && /не проверял и не подписывал владелец/.test(text));
    await snap('consent');
    await page.getByRole('button', { name: 'Принять и запустить' }).click();
    await page.getByTestId('dev-consent').waitFor({ state: 'detached' });
    const accept = (await calls()).find((c) => c.channel === 'modules:devAccept')!;
    const manifest = await page.evaluate(() => (window as any).__dev.find((d: any) => d.moduleId === 'dev-prog').manifest);
    check('главному процессу ушли программа, хеш сборки и отпечаток разрешений из манифеста', accept.data.moduleId === 'dev-prog' && accept.data.sha256 === 'a'.repeat(64) && accept.data.digest === permissionsDigest(manifest));
    check('после согласия кнопка «Открыть»', await page.getByTestId('stx-dev-dev-prog').getByRole('button', { name: 'Открыть' }).count() === 1);

    console.log('«Убрать» в списке');
    await broken.getByRole('button', { name: 'Убрать' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="stx-dev-"]').length === 2);
    check('запись исчезла, в главный процесс ушёл devRemove', (await calls()).some((c) => c.channel === 'modules:devRemove' && c.data.moduleId === 'dev-broken'));

    console.log('Окно запущенной программы');
    await page.goto(`${BASE}/scripts/fixtures/dev-run-ui.html?view=host`);
    await page.getByTestId('dev-consent-wait').waitFor();
    check('до согласия программа не открывается: вопрос о разрешениях', await page.getByTestId('dev-consent').count() === 1 && await page.locator('[data-running-module]').count() === 0);
    check('пункт «Пуска» помечен «(разработка)»', (await page.evaluate(() => (window as any).__sections()) as string[]).some((t) => /Расчёт нагрузок \(разработка\)/.test(t)));
    await snap('host-consent');
    await page.getByRole('button', { name: 'Принять и запустить' }).click();
    await page.locator('[data-running-module="dev-prog"]').waitFor();
    const head = page.locator('.fx-head');
    check('шапка окна: название, версия, плашка «Разработка — не выпущено», «Убрать»', /Расчёт нагрузок/.test(await head.innerText()) && /Разработка — не выпущено/.test(await head.innerText())
      && await page.getByTestId('dev-remove').count() === 1);
    const headBox = await head.evaluate((el) => el.getBoundingClientRect().height);
    check(`шапка раздела одна строка, 44 px (${headBox})`, Math.round(headBox) === 44);
    await snap('host-running');
    // Срок аренды вышел: главный процесс убрал пакет и сообщил окну событием — рамка с кодом программы снимается
    await page.evaluate(() => { const d = (window as any).__dev.find((x: any) => x.moduleId === 'dev-prog'); d.live = false; d.manifest = null; d.why = 'Studio закрыта: запуск из разработки прекращён'; });
    await fire();
    await page.getByTestId('dev-stopped').waitFor();
    check('программа остановлена сообщением, а не «Модуль недоступен»; рамка программы снята', /Studio закрыта/.test(await page.getByTestId('dev-stopped').innerText()) && await page.locator('[data-running-module]').count() === 0);
    await snap('host-stopped');

    check('ошибок страницы нет', errors.length === 0);
    if (errors.length) console.log(errors);
  } finally { await browser.close(); }
  console.log(`\nВСЕ ТЕСТЫ ПРОЙДЕНЫ (${checks})`);
}
run().catch((e) => { console.error(e); process.exit(1); });
