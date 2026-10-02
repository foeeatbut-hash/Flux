import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

async function main() {
  const vite = await createServer({ configFile: 'vite.config.ts', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite не сообщил адрес тестового сервера');
    const url = `http://127.0.0.1:${address.port}/scripts/fixtures/play-match-frame.html`;
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText || 'request failed'}`));

    await page.goto(url);
    await page.getByText('Эта игра окну незнакома').waitFor();
    await page.getByText('ваш ход').waitFor();
    await page.evaluate(() => (window as any).__playMatchTest.deferNextGet());
    await page.waitForFunction(() => (window as any).__playMatchTest.calls.filter((call: any) => call.method === 'GET').length === 2);
    await page.getByRole('button', { name: 'Сдаться' }).click();
    await page.waitForFunction(() => (window as any).__playMatchTest.calls.some((call: any) => call.method === 'POST'));
    await page.evaluate(() => (window as any).__playMatchTest.releaseGet('A'));
    await page.getByText('Партия окончена').waitFor();
    const getCount = await page.evaluate(() => (window as any).__playMatchTest.calls.filter((call: any) => call.method === 'GET').length);
    assert.equal(getCount, 3, 'После позднего poll ход вызывает отдельный свежий fetch');
    console.log('✓ Поздний poll не подавляет перечитывание после сдачи');

    await page.goto(`${url}?poll=10000`);
    await page.getByText('ваш ход').waitFor();
    await page.evaluate(() => (window as any).__playMatchTest.deferNextGet());
    await page.getByRole('button', { name: 'Переключить матч' }).click();
    await page.getByText('Открываем доску…').waitFor();
    assert.equal(await page.getByText('ваш ход').count(), 0, 'Доска прежней партии очищается сразу при переключении');
    await page.evaluate(() => (window as any).__playMatchTest.releaseGet('B'));
    await page.getByText('Партия окончена').waitFor();
    console.log('✓ При переключении матчей старая доска не остаётся активной');

    await page.goto(`${url}?poll=10000`);
    await page.getByText('ваш ход').waitFor();
    await page.evaluate(() => (window as any).__playMatchTest.failNextGet());
    await page.getByTitle('Обновить доску').click();
    await page.getByText('Связь прервана').waitFor();
    await page.getByTitle('Обновить доску').click();
    await page.getByText('Связь прервана').waitFor({ state: 'detached', timeout: 2500 });
    assert.equal(await page.getByText('ваш ход').count(), 1, 'После успешного опроса сохранённая доска восстановлена');
    console.log('✓ Успешный poll убирает ошибку связи и сохраняет доску');

    assert.deepEqual(errors, [], 'MatchFrame не создаёт ошибок React в браузере');
    await page.close();
  } finally {
    await browser.close();
    await vite.close();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
