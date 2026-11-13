import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const base = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
import { findChrome } from './chromePath';
const chrome = findChrome();
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
        f.make('c1', 'Опросный лист.xlsx', stamps[0], { parent: { rootId: 'root', relativePath: 'Проект/Вложенная' } }),
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

    // Шаг 5: меню, клавиши, перетаскивание на папку, сведения, напоминание, настройки.
    const reset = async (stamps: Record<number, string>) => {
      await page.evaluate((st) => {
      const f = (window as any).__drafts;
      f.calls.length = 0; f.published.length = 0; f.trashed.length = 0; f.toasts.setState({ toasts: [] });
      for (const key of Object.keys(f.realFiles)) delete f.realFiles[key];
      f.publish.getState().clear();
      f.windows.setState({ windows: [] });
      f.settings.getState().set({ view: 'compact', compactMode: 'grid', columns: 4, kind: 'all', state: null, group: 'date', sort: 'modified', dir: 'desc', pinned: [], kept: [], snoozeUntil: 0, remindDays: 14, dropPublish: true, closeOutside: true, openOn: 'click', badge: 'unsent', groupLabels: true });
      f.setEntries([
        f.make('a1', 'Письмо.docx', st[0], { parent: { rootId: 'root', relativePath: 'Проект/Вложенная' } }),
        f.make('a2', 'Схема.pdf', st[1]), f.make('a3', 'Бланки', st[2], { kind: 'directory', size: 0 }), f.make('a4', 'Узел.dwg', st[3]),
      ]);
      f.store.setState({ projectNames: { p1: 'Проект П-1' }, review: false, sheet: false });
      }, stamps);
      // Источник обновляется по событию моста с паузой: без ожидания проверка видела бы прежний список.
      await page.waitForFunction(() => { const f = (window as any).__drafts; return f.store.getState().entries.length === 4 && f.store.getState().entries.some((e: any) => e.draftId === 'a3'); });
    };
    const fresh = { 0: iso(0), 1: iso(1), 2: iso(20), 3: iso(40) };
    const tile = (id: string) => panel.locator(`[data-draft-id="${id}"]`);
    await reset(fresh);
    await tile('a2').waitFor();
    // Меню правой кнопки: восемь пунктов, «Добавить в ВДР» отключён с причиной.
    await tile('a2').click({ button: 'right' });
    const menu = page.locator('[data-context-menu]');
    await menu.waitFor();
    const labels = await menu.locator('.fx-menu-item').evaluateAll((els) => els.map((el) => el.querySelector('span.flex-1')?.textContent));
    assert.deepEqual(labels, ['Открыть', 'Опубликовать в проект…', 'Добавить в ВДР…', 'Закрепить первым', 'Переименовать', 'Показать в Проводнике', 'Свойства', 'Удалить'], 'пункты меню черновика');
    const vdr = menu.getByRole('button', { name: /^Добавить в ВДР/ });
    assert.ok(await vdr.isDisabled() && /после публикации/i.test(await vdr.getAttribute('title') || ''), '«Добавить в ВДР…» отключён, и сказано почему');
    assert.ok(await panel.isVisible(), 'щелчок по меню не закрывает панель');
    await menu.getByRole('button', { name: /^Свойства/ }).click();
    assert.ok(await page.evaluate(() => (window as any).__drafts.windows.getState().windows.some((w: any) => String(w.href).includes('properties=1') && decodeURIComponent(String(w.href)).includes('Схема.pdf'))), '«Свойства» открывают свойства черновика');
    assert.ok(await panel.isVisible(), 'после пункта меню панель осталась открытой');
    await tile('a4').click({ button: 'right' });
    await menu.getByRole('button', { name: /^Закрепить первым/ }).click();
    assert.equal(await panel.locator('[data-drafts-body] [data-draft-id]').first().getAttribute('data-draft-id'), 'a4', 'закреплённый черновик первым');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('flux_drafts_panel') || '{}').pinned), ['a4'], 'закрепление сохраняется');
    await tile('a4').click({ button: 'right' });
    assert.ok(await menu.getByRole('button', { name: /^Открепить/ }).isVisible(), 'у закреплённого — «Открепить»');
    await page.keyboard.press('Escape');
    assert.ok(await panel.isVisible(), 'Esc закрывает меню, а не панель');
    await page.evaluate(() => (window as any).__drafts.windows.setState({ windows: [] }));
    await tile('a2').dblclick();
    assert.ok(await page.evaluate(() => (window as any).__drafts.windows.getState().windows.some((w: any) => String(w.href).startsWith('/windows-file') && String(w.href).includes('draft=a2'))), 'двойной щелчок открывает черновик');
    // Переименовать (F2) и Удалить (Del) на выбранной плитке.
    await tile('a2').focus();
    await page.keyboard.press('F2');
    await page.getByRole('dialog').getByRole('textbox').fill('Схема П1.pdf');
    await page.keyboard.press('Enter');
    await panel.getByText('Схема П1.pdf').first().waitFor();
    assert.ok(await page.evaluate(() => (window as any).__drafts.calls.some((c: any) => c.action === 'rename' && c.name === 'Схема П1.pdf' && c.ref.draftId === 'a2')), 'F2 переименовывает через мост');
    await tile('a2').focus();
    await page.keyboard.press('Delete');
    await tile('a2').waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => (window as any).__drafts.trashed), ['Схема П1.pdf'], 'Del отправляет в корзину Flux');
    // Сведения при наведении — не раньше 500 мс.
    // Плитка исчезла под курсором: карточка с её сведениями не остаётся (pointerleave у удалённой плитки не придёт).
    await page.evaluate(() => (window as any).__drafts.toasts.setState({ toasts: [] })); // тост «В корзине Flux» мог лечь поверх плитки
    await page.mouse.move(1200, 5); // плитка могла сама оказаться под неподвижным курсором: pointerenter приходит только при движении
    const doomed = (await tile('a3').boundingBox())!;
    await page.mouse.move(doomed.x + doomed.width / 2, doomed.y + doomed.height / 2);
    await page.locator('[data-draft-details]', { hasText: 'Бланки' }).waitFor();
    await page.evaluate(() => { const f = (window as any).__drafts; f.setEntries(f.entries().filter((e: any) => e.draftId !== 'a3')); });
    await page.locator('[data-draft-details]').waitFor({ state: 'detached' });
    await page.mouse.move(1200, 5);
    const letter = (await tile('a1').boundingBox())!;
    await page.mouse.move(letter.x + letter.width / 2, letter.y + letter.height / 2);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('[data-draft-details]').count(), 0, 'сведения не раньше 500 мс');
    await page.locator('[data-draft-details]', { hasText: 'Письмо.docx' }).waitFor();
    const details = await page.locator('[data-draft-details]').innerText();
    assert.ok(details.includes('Письмо.docx') && details.includes('Проект П-1') && details.includes('черновик'), `сведения: имя, проект, состояние (${details.replace(/\n/g, ' | ')})`);
    await page.mouse.move(letter.x + 200, 5);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-draft-details]').count(), 0, 'сведения исчезают, когда курсор ушёл');

    // Перетаскивание на папку проекта: подсветка, подтверждение, «Оставить копию», занятое имя.
    const drag = async (id: string, targetName: string, drop = true, modifiers: string[] = []) => {
      const from = (await tile(id).boundingBox())!;
      const to = (await page.locator('[data-mini-explorer]').getByText(targetName, { exact: true }).boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + 40, from.y - 30, { steps: 4 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
      await page.mouse.move(to.x + to.width / 2 + 2, to.y + to.height / 2 + 1, { steps: 2 });
      if (!drop) return;
      for (const key of modifiers) await page.keyboard.down(key);
      await page.mouse.up();
      for (const key of modifiers) await page.keyboard.up(key);
    };
    await drag('a1', 'Проект', false);
    assert.equal(await page.locator('[data-mini-explorer] [data-draft-drop="true"]').count(), 1, 'папка под курсором подсвечена «опубликовать сюда»');
    assert.ok(await page.getByText('Опубликовать сюда', { exact: true }).isVisible(), 'у курсора подсказка «Опубликовать сюда»');
    await page.mouse.up();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const text = await dialog.innerText();
    assert.ok(text.includes('«Письмо.docx»') && text.includes('«Проект»') && text.includes('Оставить копию в черновиках'), `подтверждение: что, куда, копия (${text.replace(/\n/g, ' | ')})`);
    assert.equal(await page.evaluate(() => (window as any).__drafts.calls.filter((c: any) => c.action === 'move').length), 0, 'до подтверждения ничего не перенесено');
    assert.equal(await dialog.getByRole('checkbox').isChecked(), false, 'копия по умолчанию не отмечена');
    await dialog.getByRole('button', { name: 'Отмена' }).click();
    assert.equal(await page.evaluate(() => (window as any).__drafts.calls.filter((c: any) => c.action === 'move' || c.action === 'publishDraft').length), 0, 'отмена ничего не публикует');
    // Занятое имя в папке назначения.
    await page.evaluate(() => { (window as any).__drafts.realFiles['Проект'] = ['Письмо.docx']; });
    await drag('a1', 'Проект');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Опубликовать', exact: true }).click();
    await page.waitForFunction(() => (window as any).__drafts.published.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).__drafts.published), [{ name: 'Письмо (2).docx', parent: 'Проект' }], 'занятое имя получает «(2)»');
    const order = await page.evaluate(() => (window as any).__drafts.calls.filter((c: any) => ['move', 'copy', 'publishDraft'].includes(c.action)).map((c: any) => `${c.action}${c.name ? ':' + c.name : ''}`));
    assert.deepEqual(order, ['move:Письмо.docx', 'move:Письмо (2).docx', 'publishDraft'], 'перенос с повтором имени, затем публикация');
    await tile('a1').waitFor({ state: 'detached' });
    // С копией: исходный черновик остаётся.
    await drag('a4', 'Архив');
    await dialog.waitFor();
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Опубликовать', exact: true }).click();
    await page.waitForFunction(() => (window as any).__drafts.published.length === 2);
    assert.ok(await page.evaluate(() => (window as any).__drafts.calls.some((c: any) => c.action === 'copy' && !('carryMeta' in c) && c.parent.relativePath === 'Архив')), 'с галочкой — копия без локальных свойств');
    assert.equal(await tile('a4').count(), 1, 'исходный черновик остался в панели');
    // Ctrl при отпускании отмечает «Оставить копию» заранее.
    await drag('a4', 'Проект', true, ['Control']);
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('checkbox').isChecked(), true, 'Ctrl при отпускании — копия отмечена');
    await dialog.getByRole('button', { name: 'Отмена' }).click();
    // Настройка «перетаскивание публикует» выключена — окна нет, но причина названа.
    await page.evaluate(() => (window as any).__drafts.settings.getState().set({ dropPublish: false }));
    await drag('a4', 'Проект');
    await page.waitForTimeout(200);
    assert.equal(await page.getByRole('dialog').count(), 0, 'при выключенной настройке окна публикации нет');
    assert.ok(await page.evaluate(() => (window as any).__drafts.toasts.getState().toasts.some((t: any) => /выключена в настройках/.test(t.message))), 'причина названа');
    await page.evaluate(() => (window as any).__drafts.settings.getState().set({ dropPublish: true }));
    // Отпустили в пустое место: наружу не вытаскивается, подсказка путь.
    await page.evaluate(() => (window as any).__drafts.toasts.setState({ toasts: [] }));
    await drag('a4', 'Проект', false);
    await page.mouse.move(900, 600, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(() => (window as any).__drafts.toasts.getState().toasts.some((t: any) => /остаётся во Flux/.test(t.message)));

    // Напоминание: «N черновика старше 14 дней — Разобрать / Позже».
    await reset(fresh);
    const reminder = panel.locator('[data-drafts-reminder]');
    await reminder.waitFor();
    assert.equal((await reminder.innerText()).replace(/\s+/g, ' ').trim(), '2 черновика старше 14 дней Разобрать Позже', 'текст напоминания');
    await reminder.getByRole('button', { name: 'Позже' }).click();
    assert.equal(await reminder.count(), 0, '«Позже» скрывает напоминание');
    assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('flux_drafts_panel') || '{}').snoozeUntil) > Date.now() + 20 * 3600_000, '«Позже» усыпляет примерно на сутки');
    await page.evaluate(() => (window as any).__drafts.settings.getState().set({ snoozeUntil: 0, remindDays: 0 }));
    assert.equal(await reminder.count(), 0, 'срок «никогда» выключает напоминание');
    await page.evaluate(() => (window as any).__drafts.settings.getState().set({ remindDays: 30 }));
    assert.match((await reminder.innerText()).replace(/\s+/g, ' '), /^1 черновик старше 30 дней/, 'срок 30 дней: старше — один');
    await page.evaluate(() => (window as any).__drafts.settings.getState().set({ remindDays: 14 }));
    await reminder.getByRole('button', { name: 'Разобрать', exact: true }).click();
    const review = panel.locator('[data-drafts-review]');
    await review.waitFor();
    assert.equal(await panel.locator('[data-draft-id]').count(), 2, 'разбор показывает только старые');
    await review.getByRole('button', { name: 'Оставить все' }).click();
    assert.deepEqual((await page.evaluate(() => JSON.parse(localStorage.getItem('flux_drafts_panel') || '{}').kept)).sort(), ['a3', 'a4'], '«Оставить все» запоминает черновики');
    assert.equal(await panel.locator('[data-draft-id]').count(), 0, 'оставленные уходят из разбора');
    await review.getByRole('button', { name: 'Готово' }).click();
    assert.equal(await panel.locator('[data-draft-id]').count(), 4, 'после разбора в панели по-прежнему все черновики');
    assert.equal(await reminder.count(), 0, 'об оставленных напоминание молчит');
    await page.evaluate(() => (window as any).__drafts.settings.getState().set({ kept: [] }));
    await panel.getByRole('button', { name: /^Разобрать старые/ }).click();
    await review.getByRole('button', { name: 'Удалить все' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
    await page.waitForFunction(() => (window as any).__drafts.trashed.length === 2);
    assert.deepEqual((await page.evaluate(() => (window as any).__drafts.trashed)).sort(), ['Бланки', 'Узел.dwg'], '«Удалить все» — в корзину Flux после вопроса');
    await reset(fresh);
    await panel.getByRole('button', { name: /^Разобрать старые/ }).click();
    await review.getByRole('button', { name: 'Опубликовать все' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Опубликовать', exact: true }).click();
    await page.waitForFunction(() => (window as any).__drafts.published.length === 2);
    assert.equal(await page.evaluate(() => (window as any).__drafts.calls.filter((c: any) => c.action === 'move').length), 0, 'на месте — без переноса');
    // Полоса: напоминание — кнопка в шапке.
    await reset(fresh);
    await page.evaluate(() => (window as any).__drafts.settings.getState().set({ view: 'strip' }));
    await panel.getByRole('button', { name: 'Разобрать · 2' }).click();
    assert.equal(await panel.getAttribute('data-drafts-view'), 'compact', '«Разобрать» в полосе открывает компактную панель');
    assert.equal(await panel.locator('[data-drafts-review]').count(), 1);

    // Настройки: лист, значения, сохранение, Esc по слоям.
    await reset(fresh);
    await panel.getByRole('button', { name: 'Настройки панели' }).click();
    const sheet = page.locator('[data-drafts-settings]');
    await sheet.waitFor();
    const sheetBox = (await sheet.boundingBox())!;
    assert.ok(sheetBox.x >= 0 && sheetBox.y >= 0 && sheetBox.x + sheetBox.width <= 1280, 'лист настроек в пределах окна');
    for (const title of ['Вид панели', 'Полоса: ряды', 'Полоса: значки', 'Компактная: столбцы', 'Компактная: показ', 'Подписи групп', 'Сортировка', 'Группы', 'Черновики', 'Папки-черновики', 'Точка состояния', 'Счётчик на кнопке', 'Открывать', 'Закрывать щелчком вне панели', 'Перетаскивание на папку публикует', 'Напоминать о старых']) {
      assert.ok(await sheet.locator('.fx-set-text', { hasText: title }).count() >= 1, `в настройках есть «${title}»`);
    }
    await sheet.getByRole('group', { name: 'Столбцы плиток' }).getByRole('button', { name: '5' }).click();
    assert.ok(Math.abs((await panel.boundingBox())!.width - 480) <= 1, 'столбцы 5 — панель шире');
    await sheet.getByRole('switch', { name: 'Подписи групп' }).click();
    assert.equal(await panel.locator('[data-drafts-body] h3').count(), 0, 'подписи групп выключены');
    await sheet.getByRole('group', { name: 'Напоминание о старых' }).getByRole('button', { name: 'Никогда' }).click();
    assert.equal(await panel.locator('[data-drafts-reminder]').count(), 0, 'напоминание выключено в настройках');
    await sheet.getByRole('group', { name: 'Счётчик на кнопке' }).getByRole('button', { name: 'Нет' }).click();
    assert.equal(await page.locator('[data-drafts-button="1"] span.rounded-full').count(), 0, 'счётчик на кнопке выключен');
    await sheet.getByRole('group', { name: 'Счётчик на кнопке' }).getByRole('button', { name: 'Все' }).click();
    assert.equal(await page.locator('[data-drafts-button="1"]').getByText('4', { exact: true }).count(), 1, 'счётчик «все» показывает все черновики');
    await sheet.getByRole('switch', { name: 'Закрывать щелчком вне панели' }).click();
    await page.mouse.click(900, 200);
    assert.ok(await panel.isVisible(), 'без «закрывать щелчком вне» панель остаётся');
    await page.keyboard.press('Escape');
    assert.equal(await sheet.count(), 0, 'Esc сначала закрывает лист настроек');
    assert.ok(await panel.isVisible(), 'а панель остаётся');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('flux_drafts_panel') || '{}'));
    assert.deepEqual([saved.columns, saved.groupLabels, saved.remindDays, saved.badge, saved.closeOutside], [5, false, 0, 'all', false], 'настройки сохраняются на рабочем месте');
    // Открытие наведением.
    await page.evaluate(() => { const f = (window as any).__drafts; f.store.getState().close(); f.settings.getState().set({ openOn: 'hover' }); });
    await page.locator('[data-drafts-button="1"]').hover();
    await panel.waitFor();
    // Лист над полосой.
    await page.evaluate(() => { const f = (window as any).__drafts; f.store.getState().close(); f.settings.getState().set({ view: 'strip', openOn: 'click' }); });
    await page.locator('[data-drafts-button="1"]').click();
    await panel.getByRole('button', { name: 'Настройки панели' }).click();
    await page.waitForTimeout(300); // лист появляется со сдвигом fx-rise-in
    const above = (await sheet.boundingBox())!;
    const stripBox = (await panel.boundingBox())!;
    assert.ok(above.y + above.height <= stripBox.y + 1 && above.y >= 0, `над полосой лист настроек стоит выше неё (${JSON.stringify(above)})`);
    await sheet.getByRole('button', { name: 'Сбросить' }).click();
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('flux_drafts_panel') || '{}'))).columns, 4, '«Сбросить» возвращает умолчания');
    await page.evaluate(() => (window as any).__drafts.store.getState().close());
    assert.deepEqual(errors, [], 'нет ошибок страницы');
    completed = true;
    console.log('Проверки панели черновиков пройдены');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
