import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const base = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const chrome = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
let completed = false;
process.on('exit', () => { if (!completed) process.exitCode = 1; });
(async () => {
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${base}/scripts/fixtures/drafts-panel.html`);
    const left = page.locator('[data-drafts-button="1"]');
    const right = page.locator('[data-drafts-button="2"]');
    const panel = page.locator('[data-drafts-panel]');
    await left.getByText('2', { exact: true }).waitFor();
    assert.equal(await right.getByText('2', { exact: true }).count(), 1, 'счётчик только вне проекта на обоих мониторах');
    await right.click();
    await panel.waitFor();
    const bounds = await panel.boundingBox();
    assert.ok(bounds && bounds.x >= 640 && bounds.x + bounds.width <= 1280 && bounds.y >= 0, 'панель внутри правого монитора');
    assert.equal(await right.getAttribute('aria-expanded'), 'true');
    assert.equal(await left.getAttribute('aria-expanded'), 'false');
    await right.click();
    assert.equal(await panel.count(), 0, 'повторное нажатие закрывает панель');
    await left.click();
    await page.keyboard.press('Escape');
    assert.equal(await panel.count(), 0, 'Escape закрывает панель');
    await left.click();
    await page.mouse.click(500, 100);
    assert.equal(await panel.count(), 0, 'щелчок снаружи закрывает панель');
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'в', code: 'KeyD', ctrlKey: true, altKey: true, bubbles: true })));
    await panel.waitFor();
    assert.equal(await left.getAttribute('aria-expanded'), 'true', 'сочетание работает при русской раскладке');
    await page.evaluate(() => { const f = (window as any).__drafts; f.setEntries([f.draft('новый')]); });
    await panel.getByText('Черновик новый').waitFor();
    await left.getByText('1', { exact: true }).waitFor();
    assert.equal(await panel.getByText('Черновик 1', { exact: true }).count(), 0, 'изменение источника обновляет список');
    // Обычное окно (один монитор): панель задач стоит под столом, и низ
    // панели — в 4 px над ней, а не ещё на высоту панели задач выше.
    await page.evaluate(() => { const f = (window as any).__drafts; f.store.getState().close(); f.windows.setState({ displays: [], area: { w: 1280, h: 752 }, activeDisplayId: null }); });
    await page.waitForTimeout(250);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', ctrlKey: true, altKey: true, bubbles: true })));
    await panel.waitFor();
    await page.waitForTimeout(300); // появление fx-rise-in сдвигает панель на 12 px, мерить после него
    const single = await panel.boundingBox();
    assert.ok(single && Math.abs(single.y + single.height - 748) <= 1, `в обычном окне панель стоит в 4 px над панелью задач (низ ${single && single.y + single.height})`);

    // Шаг 3: полоса во всю длину — группы по дате, колесо, фильтр типа, поиск.
    await page.evaluate(() => {
      const f = (window as any).__drafts;
      const exts = ['xlsx', 'docx', 'pdf', 'txt', 'dwg'];
      f.setEntries(Array.from({ length: 30 }, (_, i) => ({ ...f.draft(`s${i}`), name: i === 7 ? 'Схема П1.pdf' : `Файл ${i}.${exts[i % 5]}`, size: 1000 * i,
        modifiedAt: new Date(Date.now() - i * 2 * 86_400_000).toISOString() })));
    });
    await panel.locator('[data-draft-id="s29"]').waitFor();
    const strip = await panel.boundingBox();
    assert.equal(await panel.getAttribute('data-drafts-view'), 'strip', 'по умолчанию — полоса');
    assert.ok(strip && Math.abs(strip.height - 150) <= 1 && Math.abs(strip.width - 1272) <= 1 && Math.abs(strip.x - 4) <= 1, `полоса во всю ширину с отступом 4 px и высотой 150 (${JSON.stringify(strip)})`);
    assert.ok(await panel.locator('[data-drafts-group="Сегодня"]').count() === 1 && await panel.locator('[data-drafts-group="Раньше"]').count() === 1, 'подписи групп по дате');
    const scroller = panel.locator('[data-drafts-strip]');
    assert.ok(await panel.getByRole('button', { name: 'Прокрутить вправо' }).isVisible(), 'справа кнопка «›», пока дальше есть файлы');
    const box = (await scroller.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(100);
    assert.ok(await scroller.evaluate((el) => el.scrollLeft) > 0, 'колесо листает полосу вбок');
    assert.ok(await panel.getByRole('button', { name: 'Прокрутить влево' }).isVisible(), 'после прокрутки слева кнопка «‹»');
    await panel.getByRole('button', { name: 'Таблицы', exact: true }).click();
    assert.equal(await panel.locator('[data-draft-id]').count(), 6, 'фильтр «Таблицы» оставляет только XLSX');
    assert.equal(await panel.locator('[data-drafts-count]').innerText(), '6 из 30');
    assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('flux_drafts_panel') || '{}').kind === 'table'), 'фильтр сохраняется в настройках рабочего места');
    await panel.getByRole('button', { name: 'Все', exact: true }).click();
    await panel.getByLabel('Поиск по черновикам').fill('схема');
    assert.equal(await panel.locator('[data-draft-id]').count(), 1, 'поиск по имени');
    await panel.getByLabel('Поиск по черновикам').fill('');
    await panel.getByRole('button', { name: /^Сортировка/ }).click();
    assert.equal(await panel.locator('[data-draft-id]').first().getAttribute('data-draft-id'), 's0', 'сортировка по размеру: в группе «Сегодня» один файл');
    await panel.getByRole('button', { name: 'По убыванию' }).click();
    assert.equal(await panel.locator('[data-draft-id]').last().getAttribute('data-draft-id'), 's29', 'порядок ↑ не ломает группы по дате');
    assert.deepEqual(errors, [], 'нет ошибок страницы');
    completed = true;
    console.log('Проверки панели черновиков пройдены');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
