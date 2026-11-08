import { chromium, type Page } from 'playwright-core';
const base = process.env.FLUX_UI_URL || 'http://127.0.0.1:5174';
const check = (name: string, condition: unknown) => { if (!condition) throw new Error(`✗ ${name}`); console.log(`✓ ${name}`); };
const stand = '/scripts/fixtures/windows-explorer-ui.html?docflow=1&createfiles=1';
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Создать и связать файлы — предпросмотр' });
const start = async (page: Page) => { await page.goto(`${base}${stand}&screen=filecell`); const create = page.getByRole('button', { name: 'Создать…' }); await create.waitFor({ state: 'visible' }); await create.click(); };
const preview = async (page: Page) => { await dialog(page).getByRole('button', { name: 'Показать план' }).click(); await dialog(page).getByRole('row', { name: /i1_B\.docx/ }).waitFor(); };
const confirm = async (page: Page) => { await dialog(page).getByRole('button', { name: 'Создать и связать (1)' }).click(); await dialog(page).getByText('Файлы созданы и связаны.', { exact: false }).waitFor(); };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await start(page);
    check('Ревизия B не показывает прежний файл A', await page.locator('[data-file-link="file"]').count() === 0);
    await preview(page);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(button => button.textContent?.trim() === 'Создать и связать (1)' && !button.disabled));
    check('Предпросмотр шаблона не резервирует и не пишет файл', await page.evaluate(() => (window as any).__createStand.events.join(',') === 'plan' && !Object.hasOwn((window as any).__createStand.files, 'Проекты/i1_B.docx')));
    await confirm(page);
    check('Подтверждение выполняет claim → publish → complete и копирует шаблон', await page.evaluate(() => { const s = (window as any).__createStand; return s.events.join(',') === 'plan,claim,publish,complete' && s.files['Проекты/i1_B.docx'] === s.files['Проекты/Шаблон.docx']; }));
    await dialog(page).getByRole('button', { name: 'Готово' }).click();
    await page.getByRole('button', { name: 'Создать…' }).click();
    await dialog(page).getByRole('button', { name: 'Последнее создание (1)…' }).click();
    await dialog(page).getByRole('button', { name: 'Проверить отмену создания' }).click();
    await dialog(page).getByRole('button', { name: 'Отменить создание (1)' }).click();
    await dialog(page).waitFor({ state: 'detached' });
    check('После закрытия undo проверяет файл, удаляет его и отменяет связь', await page.evaluate(() => { const s = (window as any).__createStand; return s.events.slice(-3).join(',') === 'undo-plan,trash,undo' && !Object.hasOwn(s.files, 'Проекты/i1_B.docx'); }));

    await start(page); await page.evaluate(() => { (window as any).__createStand.files['Проекты/i1_B.docx'] = btoa('occupied'); }); await preview(page);
    await dialog(page).getByText(/уже занято на диске/).waitFor();
    check('Занятое имя не перезаписывается и создание недоступно', await dialog(page).getByRole('button', { name: 'Создать и связать (1)' }).isDisabled() && await page.evaluate(() => atob((window as any).__createStand.files['Проекты/i1_B.docx']) === 'occupied' && !(window as any).__createStand.events.includes('publish')));

    await start(page); await page.evaluate(() => { (window as any).__createStand.denied = true; }); await preview(page);
    await dialog(page).getByRole('button', { name: 'Создать и связать (1)' }).click(); await dialog(page).getByText('Нет права создавать файлы').waitFor();
    check('Отказ 403 не меняет диск', await page.evaluate(() => (window as any).__createStand.events.join(',') === 'plan,claim' && !Object.hasOwn((window as any).__createStand.files, 'Проекты/i1_B.docx')));

    await start(page); await dialog(page).getByLabel('Использовать шаблоны типов документов').uncheck(); await dialog(page).getByLabel('Формат нового файла').selectOption('txt');
    await dialog(page).getByRole('button', { name: 'Показать план' }).click(); await dialog(page).getByRole('row', { name: /i1_B\.txt.*Пустой TXT/ }).waitFor();
    await confirm(page); check('Выбор пустого TXT создаёт ноль байтов', await page.evaluate(() => (window as any).__createStand.files['Проекты/i1_B.txt'] === ''));

    await start(page); await page.evaluate(() => { (window as any).__createStand.completeUnknown = true; }); await preview(page); await confirm(page);
    check('Потерянный ответ complete восстанавливается по состоянию без повтора публикации', await page.evaluate(() => (window as any).__createStand.events.filter((x: string) => x === 'publish').length === 1));

    await start(page); await page.evaluate(() => { (window as any).__createStand.completeReject = true; }); await preview(page);
    await dialog(page).getByRole('button', { name: 'Создать и связать (1)' }).click(); await dialog(page).getByText('Связь временно недоступна').waitFor();
    await dialog(page).getByRole('button', { name: 'Отменить подготовку' }).click(); await dialog(page).waitFor({ state: 'detached' });
    check('Отмена незавершённой подготовки проверяет и удаляет созданный файл', await page.evaluate(() => (window as any).__createStand.events.slice(-3).join(',') === 'cancel-plan,trash,cancel'));

    await start(page); await preview(page); await confirm(page);
    await page.evaluate(() => { (window as any).__createStand.files['Проекты/i1_B.docx'] = btoa('edited bytes'); });
    await dialog(page).getByRole('button', { name: 'Проверить отмену создания' }).click(); await dialog(page).getByText(/Файл изменён или перенесён/).waitFor();
    check('Изменённый файл не удаляется при отмене', await page.evaluate(() => atob((window as any).__createStand.files['Проекты/i1_B.docx']) === 'edited bytes' && !(window as any).__createStand.events.includes('trash')));

    await start(page); await page.evaluate(() => { (window as any).__createStand.existing = true; (window as any).__createStand.files['Проекты/i1_B.docx'] = btoa('existing'); }); await preview(page);
    await dialog(page).getByRole('button', { name: 'Ред. B уже есть — открыть' }).click();
    await page.waitForFunction(() => (window as any).__createStand.events.includes('open'));
    check('Существующая ревизия только открывается', await page.evaluate(() => (window as any).__createStand.events.join(',') === 'plan,open'));

    await start(page); await page.evaluate(() => { (window as any).__createStand.pending = true; }); await dialog(page).getByRole('button', { name: 'Показать план' }).click();
    await dialog(page).getByRole('status').waitFor();
    check('Во время предпросмотра закрытие и подтверждение заблокированы', await dialog(page).getByRole('button', { name: 'Закрыть', exact: true }).isDisabled() && await dialog(page).getByRole('button', { name: 'Создать и связать (0)' }).isDisabled());
    await page.waitForFunction(() => typeof (window as any).__createStand.release === 'function');
    await page.evaluate(() => { (window as any).__createStand.pending = false; (window as any).__createStand.release(); }); await dialog(page).getByRole('row', { name: /i1_B\.docx/ }).waitFor();

    await page.goto(`${base}${stand}&screen=docflow&tab=tags`); await page.getByRole('button', { name: 'Создать файлы по тегу…' }).click();
    await dialog(page).getByRole('button', { name: 'Показать план' }).click(); await dialog(page).getByRole('row', { name: /i-manual_B\.docx/ }).waitFor();
    check('Кнопка тега планирует файлы строк комплекта', await page.evaluate(() => (window as any).__createStand.selections[0].itemIds.includes('i-manual')));
    check('Ошибок страницы нет', errors.length === 0);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
