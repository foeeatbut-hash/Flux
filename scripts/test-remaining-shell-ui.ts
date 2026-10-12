import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

async function main() {
  process.env.DISABLE_HMR = 'true';
  const vite = await createServer({ configFile: 'vite.config.ts', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not expose its isolated port');
    browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const shell = await browser.newPage({ viewport: { width: 1024, height: 720 } });
    shell.on('pageerror', e => errors.push(e.message));
    shell.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await shell.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/remaining-shell/start-menu.html`);
    await shell.getByRole('button', { name: 'Открыть Пуск' }).click();
    await shell.getByRole('dialog', { name: 'Пуск' }).waitFor();
    const shellSearch = shell.getByPlaceholder('Найти раздел, а по Enter — искать везде');
    await shellSearch.fill('почта');
    assert.equal(await shell.getByRole('button', { name: 'Почта', exact: true }).count(), 1, 'case-insensitive Russian search finds the permitted section');
    await shellSearch.fill('no-section-matches');
    await shell.getByText('Раздела с таким названием нет.', { exact: false }).waitFor();
    await shellSearch.fill('почта');
    await shell.getByRole('button', { name: 'Почта', exact: true }).click();
    await shell.waitForFunction(() => document.querySelector('[data-testid="route"]')?.textContent === '/mail');
    assert.equal(await shell.getByTestId('route').textContent(), '/mail', 'tile opens the selected route');
    assert.equal(await shell.getByRole('dialog', { name: 'Пуск' }).count(), 0, 'navigation closes Start');
    console.log('✓ shell.start.open-search/item-open component: opens Start, finds a Russian label, reports a miss, and navigates to selected route');

    await shell.getByRole('button', { name: 'Открыть Пуск' }).click();
    const pinned = shell.getByRole('button', { name: 'Почта', exact: true }).first();
    await pinned.evaluate((element) => {
      const box = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
    });
    await shell.getByRole('button', { name: 'Закрепить на панели задач' }).waitFor();
    await shell.getByRole('button', { name: 'Закрепить в Пуске' }).click();
    assert.equal(await shell.getByTestId('desk-apps').textContent(), '/mail', 'Start favorite state is retained for the Start menu');
    assert.equal(await shell.getByRole('dialog', { name: 'Пуск' }).count(), 0, 'pin action closes Start');
    await shell.getByRole('button', { name: 'Открыть Пуск' }).click();
    const pinnedAgain = shell.getByRole('button', { name: 'Почта', exact: true }).first();
    await pinnedAgain.evaluate((element) => { const box = element.getBoundingClientRect(); element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 })); });
    await shell.getByRole('button', { name: 'Открепить из Пуска' }).click();
    assert.equal(await shell.getByTestId('desk-apps').textContent(), '', 'unpinning a Start favorite leaves the desktop free of app icons');
    console.log('✓ shell.start.context-desktop-pin component: app favorites stay in Start and never create desktop icons');

    await shell.getByRole('button', { name: 'Открыть Пуск' }).click();
    const taskbarPin = shell.getByRole('button', { name: 'Почта', exact: true }).first();
    await taskbarPin.evaluate((element) => { const box = element.getBoundingClientRect(); element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 })); });
    await shell.getByRole('button', { name: 'Закрепить на панели задач' }).click();
    assert.equal(await shell.getByTestId('bar-apps').textContent(), '/mail', 'context command pins selected program to taskbar');

    await shell.getByRole('button', { name: 'Открыть Пуск' }).click();
    await shell.getByTitle('Тёмная тема').click();
    assert.equal(await shell.evaluate(() => document.documentElement.classList.contains('dark')), true, 'footer theme button toggles document theme');
    await shell.keyboard.press('Escape');
    assert.equal(await shell.getByRole('dialog', { name: 'Пуск' }).count(), 0, 'Escape closes Start');
    await shell.getByRole('button', { name: 'Открыть Пуск' }).click();
    await shell.getByTitle('Главная — сводка по проекту').click();
    assert.equal(await shell.getByTestId('windows').textContent(), '/', 'Home footer command opens a separate root window');
    assert.equal(await shell.getByRole('dialog', { name: 'Пуск' }).count(), 0, 'Home command closes Start');
    console.log('✓ shell.start.footer-profile/open-home component: toggles theme, Escape closes, and Home opens a window');
    assert.deepEqual(errors, [], 'shell UI fixtures have no browser/React errors');
    console.log('✓ Shell component browser console and React errors: none');
    await shell.close();
  } finally {
    await browser?.close();
    await vite.close();
  }
}
main().catch(error => { console.error(error); process.exit(1); });
