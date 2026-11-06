import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = process.env.FLUX_UI_URL || 'http://127.0.0.1:5198';
async function run() {
const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] });
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
    const mutations: Array<{ path: string; body: any }> = [];
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/feedback-module-fixture', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html class="${theme === 'dark' ? 'dark' : ''}" data-glass="off"><head><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script></head><body><div id="root"></div><script type="module" src="/scripts/feedback-module-fixture.tsx"></script></body></html>` }));
    await page.route('**/api/**', async (route) => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (req.method() === 'POST') mutations.push({ path, body: req.postDataJSON() });
      let data: any = {};
      if (path.endsWith('/meta')) data = { deploymentId: 'fixture', rights: { create: true }, chunkSize: 1024 };
      if (path.endsWith('/similar')) data = [{ id: 'known-1', number: 12, title: 'Ошибка расчёта', workaround: 'Повторить' }];
      if (path.endsWith('/affected')) data = { count: 1 };
      if (path.endsWith('/uploads')) data = { uploadId: 'file-1', status: 'READY', chunkSize: 1024, chunkCount: 1 };
      if (path.endsWith('/reports') && req.method() === 'POST') data = { id: 'sent-1', number: 5 };
      return route.fulfill({ json: { data } });
    });
    await page.goto(`${base}/feedback-module-fixture`);
    await page.getByLabel('Известная проблема').check();
    await page.getByLabel('Обход').fill('Повторить расчёт');
    await page.getByRole('button', { name: 'Сохранить известную проблему' }).click();
    await page.getByRole('button', { name: 'Это ошибка Flux' }).click();
    await page.getByLabel('Почему это ошибка Flux').fill('Ошибка в API');
    await page.getByRole('button', { name: 'Передать команде Flux' }).click();
    await page.getByRole('button', { name: 'Открыть панель' }).click();
    const panel = page.getByRole('dialog', { name: 'Сообщить о проблеме' });
    await panel.getByPlaceholder('Что случилось?').fill('Текст сохраняется');
    await panel.getByRole('button', { name: 'У меня тоже' }).click();
    await panel.getByText('Отмечено').waitFor();
    assert.equal(await panel.getByPlaceholder('Что случилось?').inputValue(), 'Текст сохраняется');
    assert.match(await panel.getByLabel('Адресат').locator('option:checked').textContent() || '', /1\.0\.0/);
    const notice = panel.getByText('Заголовок и описание увидит разработчик подпрограммы. Данные проектов не передаются.', { exact: true });
    assert.equal(await notice.isVisible(), true, 'подсказка видна при выборе подпрограммы');
    const noticeStyle = await notice.evaluate((el) => { const r = el.getBoundingClientRect(); const style = getComputedStyle(el); return { width: r.width, height: r.height, fontSize: style.fontSize, color: style.color }; });
    assert.ok(noticeStyle.width > 0 && noticeStyle.height > 0 && parseFloat(noticeStyle.fontSize) >= 12);
    console.log(`${theme}: подсказка ${JSON.stringify(noticeStyle)}`);
    await page.screenshot({ path: `/tmp/feedback-module-notice-${theme}.png` });
    await panel.getByLabel('Адресат').selectOption('');
    assert.equal(await notice.count(), 0, 'подсказка отсутствует для Flux');
    await panel.getByLabel('Адресат').selectOption('calc-one');
    assert.equal(await notice.isVisible(), true, 'подсказка возвращается при выборе подпрограммы');
    await panel.getByRole('button', { name: 'Отправить' }).click();
    await panel.getByText('Отправлено', { exact: false }).first().waitFor();
    const sent = mutations.find((m) => m.path.endsWith('/reports'))?.body;
    assert.deepEqual([sent?.moduleId, sent?.moduleVersion, sent?.moduleChannel], ['calc-one', '1.0.0', 'test']);
    await panel.getByRole('button', { name: 'Закрыть' }).click();
    await page.getByRole('button', { name: 'Перезапустить' }).click();
    await page.getByRole('button', { name: 'Открыть панель' }).click();
    await panel.getByPlaceholder('Что случилось?').fill('После перезапуска');
    await panel.getByRole('button', { name: 'Отправить' }).click();
    await panel.getByText('Отправлено', { exact: false }).first().waitFor();
    const reports = mutations.filter((m) => m.path.endsWith('/reports'));
    assert.deepEqual([reports[1]?.body.moduleId, reports[1]?.body.moduleVersion, reports[1]?.body.moduleChannel], ['calc-one', '1.1.0', 'test']);
    assert.equal(mutations.find((m) => m.path.endsWith('/module-known'))?.body.workaround, 'Повторить расчёт');
    assert.equal(mutations.find((m) => m.path.endsWith('/module-routing'))?.body.reason, 'Ошибка в API');
    assert.ok(mutations.some((m) => m.path.endsWith('/affected')));
    assert.deepEqual(errors, []);
    const rect = await panel.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, width: r.width }; });
    assert.ok(rect.x >= 0 && rect.right <= 1280 && rect.width > 300);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), theme === 'dark');
    const bg = await panel.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.ok(bg !== 'rgba(0, 0, 0, 0)', `solid panel: ${bg}`);
    await page.screenshot({ path: `/tmp/feedback-module-${theme}.png` });
    console.log(`${theme}: мутации и геометрия проверены`);
    await page.close();
  }
} finally { await browser.close(); }

}
run().catch((error) => { console.error(error); process.exitCode = 1; });
