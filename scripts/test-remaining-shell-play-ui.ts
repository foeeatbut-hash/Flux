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
    await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/remaining-shell/play-components.html`);

    await page.getByRole('button', { name: 'Библиотека' }).click();
    assert.equal(await page.getByRole('button', { name: 'Подготовить стол' }).count(), 1);
    assert.equal(await page.getByText('Дурак', { exact: false }).count() > 0, true);
    await page.getByRole('button', { name: /Бильярд/ }).first().click();
    assert.equal(await page.getByText('Забейте сплошные или полосатые шары', { exact: false }).count(), 1);
    await page.getByRole('button', { name: 'Подготовить стол' }).click();
    assert.match(await page.getByTestId('calls').textContent() || '', /select:billiards/);
    console.log('✓ play.lobby.game-select component: choosing billiards dispatches the selected game and opens preparation');

    await page.getByRole('button', { name: 'Пригласить' }).click();
    const search = page.getByPlaceholder('Имя или табельный');
    await search.fill('TEST-0003');
    assert.equal(await page.getByRole('button', { name: /Наблюдатель без права хода/ }).count(), 1);
    assert.equal(await page.getByRole('button', { name: /Алексей Проверочный/ }).count(), 0);
    await page.getByRole('button', { name: /Наблюдатель без права хода/ }).click();
    assert.match(await page.getByTestId('calls').textContent() || '', /invite:watcher/);
    await search.fill('никакого совпадения');
    await page.getByText('Никого не нашлось').waitFor();
    await page.getByTitle('Закрыть').click();
    await page.getByRole('button', { name: 'Пригласить' }).click();
    await search.waitFor();
    await page.getByRole('button', { name: /Алексей Проверочный/ }).click();
    assert.match(await page.getByTestId('calls').textContent() || '', /invite:player-2/);
    console.log('✓ play.lobby.invite-search component: filters by employee number/name, reports empty results, dispatches chosen user, and closes');

    await page.getByRole('button', { name: 'Библиотека' }).click();
    await page.getByRole('button', { name: /Дурак/ }).first().click();
    await page.getByRole('button', { name: 'Подготовить стол' }).click();
    await page.getByRole('button', { name: 'Подготовка' }).click();
    const seatSelect = page.getByRole('combobox', { name: 'Количество мест в Дураке' });
    assert.equal(await seatSelect.count(), 1, 'leader can choose the number of Durak seats');
    await seatSelect.selectOption('3');
    assert.match(await page.getByTestId('calls').textContent() || '', /seats:3/);
    console.log('✓ Durak seat selector dispatches the persisted seat count');
    await page.getByRole('button', { name: 'Принять' }).click();
    await page.getByRole('button', { name: 'Отказаться' }).click();
    assert.match(await page.getByTestId('calls').textContent() || '', /accept:invite-one\|decline:invite-one/);
    await page.getByRole('button', { name: 'Переключить роль' }).click();
    assert.equal(await page.getByRole('button', { name: 'Наблюдаете' }).isDisabled(), true);
    assert.equal(await page.getByText('Наблюдает', { exact: false }).count() > 0, true);
    await page.getByRole('button', { name: 'Переключить роль' }).click();
    await page.getByRole('button', { name: 'Готов', exact: true }).click();
    assert.match(await page.getByTestId('calls').textContent() || '', /ready-start/);
    console.log('✓ play.lobby.invite-actions/spectator/ready component: accept/decline route IDs are preserved, spectator main action is disabled, ready action dispatches');

    await page.getByRole('button', { name: 'Занято' }).click();
    assert.equal(await page.locator('[data-play-action="ready"]').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: /Убрать из группы/ }).first().isDisabled(), true);
    await page.getByRole('button', { name: 'Ошибка' }).click();
    await page.getByText('Соединение прервано. Повторите действие.').waitFor();
    assert.match(await page.getByTestId('calls').textContent() || '', /ready-start/);
    console.log('✓ play.lobby.pending-error component: pending state disables repeat submit/removal and failure is visible without losing lobby state');

    await page.getByRole('button', { name: 'Ошибка' }).click();
    await page.getByRole('button', { name: 'Занято' }).click();
    await page.getByTitle('Убрать из группы: Алексей Проверочный Сотрудник').click();
    assert.equal(await page.locator('section[aria-label="Группа"]').getByText('Алексей Проверочный Сотрудник').count(), 0, 'successful leader removal updates the displayed party list');
    await page.getByTitle('Выйти из группы').click();
    assert.match(await page.getByTestId('calls').textContent() || '', /kick:player-2\|leave/);
    console.log('✓ play.party.leave-kick component: leader kick removes the selected member and leave dispatches once');

    for (const width of [820, 1024, 1440, 1920]) {
      for (const height of [720, 480]) {
        await page.setViewportSize({ width, height });
        for (const theme of ['light', 'dark']) {
          await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
          const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, viewport: innerWidth, root: document.querySelector('main')?.scrollWidth }));
          assert.ok(overflow.doc <= overflow.viewport + 2, `document horizontal overflow ${width}x${height} ${theme}: ${JSON.stringify(overflow)}`);
          assert.ok(Number(overflow.root) <= width + 2, `Play fixture overflow ${width}x${height} ${theme}: ${JSON.stringify(overflow)}`);
        }
      }
    }
    console.log('✓ Play component visual bounds: 820–1920 widths, short-height 480, both themes, no horizontal overflow');
    assert.deepEqual(errors, [], 'Play component fixture has no browser/React errors');
    console.log('✓ Play component browser console and React errors: none');

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
    assert.deepEqual(errors, [], 'shell and Play UI fixtures have no browser/React errors');
    console.log('✓ Shell and Play component browser console and React errors: none');
    await shell.close();
  } finally {
    await browser?.close();
    await vite.close();
  }
}
main().catch(error => { console.error(error); process.exit(1); });
