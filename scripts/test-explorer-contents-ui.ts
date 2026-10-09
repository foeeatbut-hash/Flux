import { checks, launch, openStand } from './fixtures/explorer-shell/harness';

const { ok, done } = checks();
const FOCUS = process.env.EXPLORER_CONTENTS_FOCUS;
(async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openStand(browser, 'contents.html', '', { width: 1000, height: 700 });
    await page.locator('[data-entry-key="fixture-1"]').waitFor();
    if (FOCUS !== 'grouping') {
    ok('Панель виртуально отображает список файлов', await page.locator('[data-entry-key]').count() < 80);
    ok('Сортировку и вид задаёт общая командная строка, а содержимое не дублирует mini-toolbar', await page.locator('[data-pane-control]').count() === 0);
    for (const [label, id] of [['Огромные значки', 'extraLarge'], ['Крупные значки', 'large'], ['Обычные значки', 'medium'], ['Мелкие значки', 'small'], ['Список', 'list'], ['Таблица', 'details'], ['Плитки', 'tiles'], ['Содержимое', 'content']]) {
      await page.getByRole('button', { name: 'Просмотреть' }).click();
      await page.locator('[data-context-menu]').getByRole('button', { name: label, exact: true }).click();
      ok(`Общая командная строка переключает вид «${label}»`, await page.evaluate((expected) => (window as any).__fixtureView?.layout === expected, id));
    }
    await page.getByRole('button', { name: 'Просмотреть' }).click();
    await page.locator('[data-context-menu]').getByRole('button', { name: 'Список', exact: true }).click();
    ok('Список выводит элементы в колонках сверху вниз', await page.locator('[data-entry-flow="column-major"]').count() > 0);
    await page.getByRole('button', { name: 'Просмотреть' }).click();
    await page.locator('[data-context-menu]').getByRole('button', { name: 'Мелкие значки', exact: true }).click();
    ok('Мелкие значки занимают строки высотой 32 пикселя', await page.locator('[data-virtual-row]').first().evaluate((element) => Math.round(element.getBoundingClientRect().height) === 32));
    await page.getByRole('button', { name: 'Просмотреть' }).click();
    await page.locator('[data-context-menu]').getByRole('button', { name: 'Таблица', exact: true }).click();
    await page.getByRole('columnheader').first().click({ button: 'right' });
    await page.getByRole('dialog', { name: 'Столбцы и порядок' }).getByRole('checkbox', { name: 'Теги' }).check();
    await page.getByRole('button', { name: 'Готово' }).click();
    ok('Меню заголовка включает столбец метаданных', await page.getByRole('columnheader').count() === 5);
    await page.getByRole('columnheader').first().click({ button: 'right' });
    await page.getByRole('dialog', { name: 'Столбцы и порядок' }).getByRole('checkbox', { name: 'Автор' }).check();
    await page.getByRole('button', { name: 'Готово' }).click();
    await page.waitForFunction(() => (window as any).__contentsBridgeCalls.some((request: any) => request.action === 'systemProperties'));
    await page.getByRole('cell', { name: 'Стендовый автор' }).first().waitFor();
    ok('Автор загружается лениво из systemProperties для видимых строк', await page.evaluate(() => (window as any).__contentsBridgeCalls.every((request: any) => request.action !== 'systemProperties' || !!request.ref.rootId)));
    await page.getByRole('button', { name: 'Сортировать' }).click();
    await page.locator('[data-context-menu]').getByRole('button', { name: 'Размер', exact: true }).click();
    ok('Общая командная строка применяет сортировку по размеру', await page.evaluate(() => (window as any).__fixtureView.sort === 'size'));
    }
    await page.getByRole('button', { name: 'Сортировать' }).click();
    const groupBy = page.locator('[data-context-menu]').first().getByRole('button', { name: 'Группировать', exact: true });
    await groupBy.hover();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-context-menu] button')].some((button) => button.textContent?.trim() === 'Группировать' && button.getAttribute('aria-expanded') === 'true'));
    await page.locator('[data-context-menu]').last().getByRole('button', { name: 'Тип', exact: true }).click();
    ok('Общая командная строка применяет группировку по типу', await page.evaluate(() => (window as any).__fixtureView.group === 'type'));
    if (FOCUS !== 'grouping') {
      await page.locator('[data-entry-key="fixture-1"]').dblclick();
      ok('Двойной щелчок открывает выбранный файл', await page.evaluate(() => (window as any).__opened === 'fixture-1'));
      ok('Панель не создаёт ошибок браузера', errors.length === 0, errors);
    }
    await page.close();
  } finally { await browser.close(); }
  process.exitCode = done();
})();
