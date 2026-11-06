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

    // Шаг 4: компактная панель — меры, столбцы, список, фильтры, низ.
    const iso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    await page.evaluate((stamps) => {
      const f = (window as any).__drafts;
      f.setEntries([
        f.make('c1', 'Опросный лист.xlsx', stamps[0], { metadata: { fileId: 'c1', tags: [], projectIds: ['p1'], revision: '', responsible: '', history: [] } }),
        f.make('c2', 'Письмо.docx', stamps[1]), f.make('c3', 'Схема.pdf', stamps[3]), f.make('c4', 'Бланки', stamps[20], { kind: 'directory', size: 0 }), f.make('c5', 'Узел.dwg', stamps[40]),
        ...Array.from({ length: 8 }, (_, i) => f.make(`d${i}`, `Таблица ${i}.xlsx`, stamps[0])),
      ]);
      f.store.setState({ projectNames: { p1: 'Проект П-1' } });
      f.windows.setState({ windows: [{ id: 'w1', href: '/windows-file?root=root&path=x&draft=c1' }] });
      f.settings.getState().set({ view: 'compact', kind: 'all', state: null });
    }, { 0: iso(0), 1: iso(1), 3: iso(3), 20: iso(20), 40: iso(40) } as Record<number, string>);
    await panel.locator('[data-draft-id="c5"]').waitFor();
    await page.waitForTimeout(300);
    assert.equal(await panel.getAttribute('data-drafts-view'), 'compact');
    const compact = (await panel.boundingBox())!;
    assert.ok(Math.abs(compact.width - 400) <= 1 && Math.abs(compact.height - 540) <= 1 && Math.abs(compact.y + compact.height - 748) <= 1, `компактная панель 400 × 540 в 4 px над панелью задач (${JSON.stringify(compact)})`);
    const header = (await panel.locator('header').boundingBox())!;
    const footer = (await panel.locator('footer').boundingBox())!;
    assert.ok(Math.abs(header.height - 36) <= 1 && Math.abs(footer.height - 36) <= 1, `шапка и низ по 36 px (${header.height}, ${footer.height})`);
    const lefts = () => panel.locator('[data-drafts-body] [data-draft-id]').evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().left))).size);
    for (const [columns, width] of [[3, 320], [4, 400], [5, 480], [6, 560]] as const) {
      await page.evaluate((n) => (window as any).__drafts.settings.getState().set({ columns: n }), columns);
      await page.waitForTimeout(80);
      assert.equal(await lefts(), columns, `столбцов плиток: ${columns}`);
      assert.ok(Math.abs((await panel.boundingBox())!.width - width) <= 1, `ширина растёт со столбцами: ${columns} → ${width}`);
    }
    await page.evaluate(() => (window as any).__drafts.settings.getState().set({ columns: 4 }));
    assert.equal(await panel.locator('[data-draft-id="c1"]').getAttribute('aria-label'), 'Опросный лист.xlsx, правится', 'открытый в окне черновик — «правится»');
    await panel.getByRole('button', { name: 'Список' }).click();
    const row = (await panel.locator('[data-draft-id="c2"]').boundingBox())!;
    assert.ok(Math.abs(row.height - 28) <= 0.5, `строка списка 28 px (${row.height})`);
    assert.equal(await panel.locator('[data-draft-id="c1"]').getAttribute('title'), 'Проект П-1', 'проект — в подсказке строки');
    assert.equal(await panel.locator('[data-draft-id="c2"]').getAttribute('title'), 'Не в проекте');
    assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('flux_drafts_panel') || '{}').compactMode === 'list'), 'вид «Список» сохраняется');
    await panel.getByRole('button', { name: 'не в проекте', exact: true }).click();
    assert.equal(await panel.locator('[data-draft-id]').count(), 12, 'фильтр «не в проекте» убирает черновик из проекта');
    assert.equal(await panel.getByRole('button', { name: 'не в проекте', exact: true }).getAttribute('aria-pressed'), 'true');
    await panel.getByRole('button', { name: 'не в проекте', exact: true }).click();
    assert.equal(await panel.locator('[data-draft-id]').count(), 13, 'повторный щелчок снимает фильтр состояния');
    await panel.getByRole('button', { name: 'правится', exact: true }).click();
    assert.equal(await panel.locator('[data-draft-id]').count(), 1, 'фильтр «правится» — только открытый');
    await panel.getByRole('button', { name: 'правится', exact: true }).click();
    await panel.getByRole('button', { name: 'Чертежи', exact: true }).click();
    assert.equal(await panel.locator('[data-draft-id]').count(), 2, 'фильтр типа в компактной панели: PDF и DWG');
    await panel.getByRole('button', { name: 'Все', exact: true }).click();
    await panel.getByRole('button', { name: /^Сортировка/ }).click();
    assert.equal(await panel.getByRole('button', { name: /^Сортировка: Имя/ }).count(), 1, 'сортировка перебирает ключи: Размер, затем Имя');
    await panel.getByRole('button', { name: 'Плитки' }).click();
    // Низ панели: «Создать ▾» создаёт черновик на столе Windows, «Разобрать старые» отбирает давние.
    await panel.getByRole('button', { name: 'Создать' }).click();
    await page.getByRole('button', { name: 'Папку' }).click();
    await page.getByRole('textbox', { name: 'Имя' }).fill('Новый раздел');
    await page.getByRole('dialog').getByRole('button', { name: 'Создать', exact: true }).click();
    await panel.locator('[data-drafts-body]').getByText('Новый раздел').waitFor();
    const created = await page.evaluate(() => (window as any).__drafts.calls.find((c: any) => c.action === 'createDraftFolder'));
    assert.deepEqual(created?.parent, { rootId: 'root', relativePath: '' }, 'новая папка Flux создаётся на рабочем столе Windows');
    assert.ok(await panel.getByRole('button', { name: /^Разобрать старые · 2$/ }).isVisible(), 'старше 14 дней — две (папка и чертёж)');
    await panel.getByRole('button', { name: /^Разобрать старые/ }).click();
    assert.equal(await panel.locator('[data-draft-id]').count(), 2, '«Разобрать старые» оставляет только давние');
    assert.equal(await panel.locator('[data-drafts-count]').innerText(), '2 из 2');
    await panel.getByRole('button', { name: /^Разобрать старые/ }).click();
    assert.equal(await panel.locator('[data-draft-id]').count(), 14, 'повторный щелчок возвращает все черновики');
    await panel.getByRole('button', { name: 'В Проводнике' }).click();
    assert.ok(await page.evaluate(() => (window as any).__drafts.windows.getState().windows.some((w: any) => String(w.href).startsWith('/explorer?root=root'))), '«В Проводнике» открывает рабочий стол Windows');
    // Оформление: кегль не мельче 12, веса 400/500/600.
    const bad = await panel.evaluate((el) => {
      const out: string[] = [];
      for (const node of el.querySelectorAll('*')) {
        // Метка типа на значке (XLSX, DWG) — часть рисунка, а не текст интерфейса.
        if (node.closest('[aria-hidden="true"]') || ![...node.childNodes].some((child) => child.nodeType === 3 && child.textContent?.trim())) continue;
        const style = getComputedStyle(node);
        if (parseFloat(style.fontSize) < 12 || ![400, 500, 600].includes(Number(style.fontWeight))) out.push(`${node.textContent?.trim().slice(0, 20)}: ${style.fontSize}/${style.fontWeight}`);
      }
      return out;
    });
    assert.deepEqual(bad, [], 'кегль не мельче 12 px, веса 400/500/600');
    assert.deepEqual(errors, [], 'нет ошибок страницы');
    completed = true;
    console.log('Проверки панели черновиков пройдены');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
