import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
/**
 * Вложения чата в окне: скачивание в «Загрузки» (в программе) и обычное
 * скачивание (в браузере), загрузка кусками с долей и отказом сервера.
 * Мост главного процесса и ответы сервера заданы сценарием; настоящие маршруты
 * проверяет scripts/test-chat-upload-chunks.ts, сохранение на диск —
 * scripts/test-chat-download.ts.
 * Ждём состояния страницы (появился текст, пропала полоса), а не таймеры.
 * SHOT=путь — снимки в обеих темах.
 */
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
let checks = 0;
const check = (label: string, condition: boolean, detail?: unknown) => { assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); checks++; };

async function open(browser: any, electron: boolean) {
  const context = await browser.newContext({ viewport: { width: 900, height: 600 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.stack || e.message));
  if (electron) {
    // Скриптом-строкой: функции из tsx получают обёртку __name, которой в странице нет
    await page.addInitScript(`(() => {
      const w = window;
      w.__saves = []; w.__reveals = []; w.__saveAnswer = null;
      w.electron = { chat: {
        saveAttachment: async (url, name) => { w.__saves.push({ url, name }); const copy = name.replace('.pdf', ' (2).pdf'); return w.__saveAnswer || { ok: true, path: 'C:/Users/ivan/Downloads/' + copy, name: copy }; },
        reveal: async (path) => { w.__reveals.push(path); return { ok: true }; },
      } };
    })()`);
  }
  await page.route('**/api/chat/file-link**', (route: any) => route.fulfill({ json: { url: '/chat_files/node-1/x.pdf?exp=1&sig=abc' } }));
  await page.route('**/chat_files/**', (route: any) => route.fulfill({ status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent('Чертёж ОВ-12.pdf')}` }, body: Buffer.from('%PDF-1.4 тест') }));
  return { page, errors };
}

async function run() {
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const shot = process.env.SHOT;
  try {
    // ── В программе: файл сохраняет главный процесс, окно показывает итог ────
    {
      const { page, errors } = await open(browser, true);
      await page.goto(`${BASE}/scripts/fixtures/chat-files-ui.html`);
      const download = page.getByRole('button', { name: 'Скачать Чертёж ОВ-12.pdf' });
      await download.waitFor({ timeout: 15000 });
      check('у вложения две кнопки: открыть и скачать', await page.getByRole('button', { name: /Чертёж ОВ-12\.pdf/ }).count() >= 2 && await page.locator('[data-chat-download]').count() === 1);
      const row = await page.locator('[data-chat-download]').evaluate((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
      check('кнопка «Скачать» не мельче 24 px', row.w >= 24 && row.h >= 24, row);
      await download.click();
      const saved = page.getByTestId('chat-saved');
      await saved.waitFor();
      check('итог: «Сохранено в Загрузки» с именем, под которым файл лёг', /Сохранено в Загрузки: Чертёж ОВ-12 \(2\)\.pdf/.test(await saved.innerText()), await saved.innerText());
      const saves = await page.evaluate(() => (window as any).__saves);
      check('главному процессу ушла подписанная ссылка и имя вложения', saves.length === 1 && /^http:\/\/127\.0\.0\.1:\d+\/chat_files\/node-1\/x\.pdf\?exp=1&sig=abc$/.test(saves[0].url) && saves[0].name === 'Чертёж ОВ-12.pdf', saves);
      if (shot) {
        for (const dark of [false, true]) {
          await page.evaluate((d) => document.documentElement.classList.toggle('dark', d), dark);
          await page.screenshot({ path: shot.replace(/\.png$/, `-saved${dark ? '-dark' : ''}.png`) });
        }
        await page.evaluate(() => document.documentElement.classList.remove('dark'));
      }
      await saved.getByRole('button', { name: 'Показать в папке' }).click();
      await page.waitForFunction(() => (window as any).__reveals.length === 1);
      check('«Показать в папке» передаёт путь сохранённого файла', (await page.evaluate(() => (window as any).__reveals))[0] === 'C:/Users/ivan/Downloads/Чертёж ОВ-12 (2).pdf');
      await saved.getByRole('button', { name: 'Закрыть уведомление' }).click();
      await page.getByTestId('chat-saved').waitFor({ state: 'detached' });
      check('уведомление закрывается', true);

      // Отказ: диска нет места — человек видит причину, «Сохранено» не показано
      await page.evaluate(() => { (window as any).__saveAnswer = { ok: false, error: 'Не удалось сохранить файл: на диске нет места.' }; });
      await download.click();
      await page.waitForFunction(() => (window as any).__toasts().includes('Не удалось сохранить файл: на диске нет места.'));
      check('при отказе сохранения показана причина, а «Сохранено» нет', await page.getByTestId('chat-saved').count() === 0);
      check('в консоли страницы нет ошибок', errors.length === 0, errors);
      await page.context().close();
    }

    // ── В браузере: обычное скачивание под исходным именем ───────────────────
    {
      const { page } = await open(browser, false);
      await page.goto(`${BASE}/scripts/fixtures/chat-files-ui.html`);
      await page.evaluate(`(() => { const w = window; w.__anchors = []; const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { w.__anchors.push({ href: this.href, download: this.download }); return click.call(this); }; })()`);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать Чертёж ОВ-12.pdf' }).click()]);
      const anchors = await page.evaluate(() => (window as any).__anchors);
      // Имя файла в заголовке отдаёт сам сервер; окно просит скачать под исходным именем
      check('в браузере вложение скачивается обычной ссылкой с именем файла', anchors.length === 1 && anchors[0].download === 'Чертёж ОВ-12.pdf' && /\/chat_files\/node-1\/x\.pdf\?exp=1&sig=abc$/.test(anchors[0].href) && /\/chat_files\/node-1\/x\.pdf/.test(dl.url()), { anchors, url: dl.url() });
      check('«Сохранено в Загрузки» в браузере не показывается (пути на диске окно не знает)', await page.getByTestId('chat-saved').count() === 0);
      await page.context().close();
    }

    // ── Загрузка кусками: доля по ходу, итог в списке прикреплённого ─────────
    {
      const { page } = await open(browser, false);
      const bytes = Buffer.alloc(2500, 7);
      const chunks: Array<{ idx: number; data: string; sum: string | undefined }> = [];
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let startBody: any = null; let doneBody: any = null;
      await page.route('**/api/chat/upload/start', (route: any) => { startBody = route.request().postDataJSON(); return route.fulfill({ json: { success: true, id: 'up-1', chunkBytes: 1024 } }); });
      await page.route('**/api/chat/upload/up-1/chunk', async (route: any) => {
        const body = route.request().postDataJSON();
        chunks.push({ idx: body.idx, data: body.data, sum: route.request().headers()['x-chunk-sha256'] });
        if (body.idx === 2) await gate; // последний кусок держим: видна доля предыдущих
        return route.fulfill({ json: { ok: true } });
      });
      await page.route('**/api/chat/upload/up-1/done', (route: any) => { doneBody = route.request().postDataJSON(); return route.fulfill({ json: { success: true, filePath: '/chat_files/up-1/big.bin', fileName: 'big.bin', fileSize: bytes.length } }); });
      await page.goto(`${BASE}/scripts/fixtures/chat-files-ui.html`);
      await page.getByLabel('Выбрать файл').setInputFiles({ name: 'big.bin', mimeType: 'application/octet-stream', buffer: bytes });
      await page.getByText('Загрузка «big.bin»: 82%').waitFor();
      check('по ходу загрузки показана доля (2 куска из 3 по байтам)', true);
      if (shot) {
        for (const dark of [false, true]) {
          await page.evaluate((d) => document.documentElement.classList.toggle('dark', d), dark);
          await page.screenshot({ path: shot.replace(/\.png$/, `-upload${dark ? '-dark' : ''}.png`) });
        }
        await page.evaluate(() => document.documentElement.classList.remove('dark'));
      }
      release();
      await page.getByRole('list', { name: 'Прикреплено' }).getByText('big.bin').waitFor();
      check('перед началом названы имя и точный размер', startBody.fileName === 'big.bin' && startBody.size === 2500, startBody);
      check('файл ушёл тремя кусками по порядку', chunks.map((c) => c.idx).join() === '0,1,2');
      check('куски собираются в исходные байты', Buffer.concat(chunks.map((c) => Buffer.from(c.data, 'base64'))).equals(bytes));
      check('каждый кусок снабжён контрольной суммой', chunks.every((c) => /^[0-9a-f]{64}$/.test(c.sum || '')), chunks.map((c) => c.sum));
      check('в конце названо число кусков', doneBody?.count === 3, doneBody);
      check('полоса загрузки после завершения убрана', await page.getByText(/Загрузка «big\.bin»/).count() === 0);
      await page.context().close();
    }

    // ── Отказ сервера при начале загрузки ────────────────────────────────────
    {
      const { page } = await open(browser, false);
      await page.route('**/api/chat/upload/start', (route: any) => route.fulfill({ status: 413, json: { error: 'Файл больше 500 МБ: положите его в Проводник и отправьте ссылкой' } }));
      await page.goto(`${BASE}/scripts/fixtures/chat-files-ui.html`);
      await page.getByLabel('Выбрать файл').setInputFiles({ name: 'huge.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(10, 1) });
      await page.waitForFunction(() => (window as any).__toasts().includes('Файл больше 500 МБ: положите его в Проводник и отправьте ссылкой'));
      check('причина отказа сервера показана по-русски', true);
      check('отказанный файл не прикреплён, полоса загрузки убрана', await page.getByRole('list', { name: 'Прикреплено' }).locator('li').count() === 0 && await page.getByText(/Загрузка «huge\.bin»/).count() === 0);
      await page.context().close();
    }
    // ── Обрыв загрузки: клиент сам стирает недогруженное ─────────────────────
    {
      const { page } = await open(browser, false);
      let deleted = 0;
      await page.route('**/api/chat/upload/start', (route: any) => route.fulfill({ json: { success: true, id: 'up-2', chunkBytes: 1024 } }));
      await page.route('**/api/chat/upload/up-2/chunk', (route: any) => route.fulfill({ status: 500, json: { error: 'Сервер недоступен' } }));
      await page.route('**/api/chat/upload/up-2', (route: any) => { if (route.request().method() === 'DELETE') deleted++; return route.fulfill({ json: { success: true } }); });
      await page.goto(`${BASE}/scripts/fixtures/chat-files-ui.html`);
      await page.getByLabel('Выбрать файл').setInputFiles({ name: 'cut.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(3000, 2) });
      await page.waitForFunction(() => (window as any).__toasts().includes('Сервер недоступен'));
      await page.waitForFunction(() => document.querySelectorAll('[role=status]').length === 0);
      check('при отказе на куске клиент отменяет загрузку (DELETE), причина показана', deleted === 1, deleted);
      await page.context().close();
    }
  } finally {
    await browser.close();
  }
  console.log(`chat-files-ui: ${checks} проверок пройдено`);
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
