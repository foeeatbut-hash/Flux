/**
 * Проверка панели «Создать» на настоящем рабочем столе Windows в fixture.
 *
 * Панель одна на рабочий стол и Проводник (src/components/files/CreatePanel):
 * здесь проверяется, что стол показывает те же пункты и то же окно имени, что
 * Проводник, а не их копию.
 */
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const KINDS = ['Папку', 'Документ Word', 'Книгу Excel', 'Текстовый файл', 'Архив ZIP'];
const MENU = 'body > [data-context-menu]';

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  let passed = 0;
  let failed = 0;
  const check = (name: string, value: boolean) => {
    if (value) { passed++; console.log('✓', name); }
    else { failed++; console.error('✗', name); }
  };
  type Page = Awaited<ReturnType<typeof browser.newPage>>;

  /** Страница фикстуры: Проводник уже открыт, рабочий стол показывается по требованию. */
  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`${BASE}/scripts/fixtures/windows-explorer-ui.html`);
    await page.getByRole('heading', { name: 'Проводник' }).waitFor();
    await page.getByRole('row', { name: /Проекты/ }).waitFor();
    return page;
  };
  const showDesktop = async (page: Page) => {
    await page.evaluate(async () => {
      (window as any).__showWindowsDesktop();
      const modulePath = '/src/store/windowStore.ts';
      const windowStoreModule = await import(modulePath);
      windowStoreModule.useWindowStore.setState({
        activeDisplayId: 1,
        displayOrigin: { x: 0, y: 0, w: 1280, h: 820 },
        area: { x: 0, y: 0, w: 1280, h: 780 },
      });
    });
    const desktopArea = page.locator('section[aria-label="Рабочий стол Windows"] > div.relative');
    await desktopArea.waitFor();
    await page.getByRole('button', { name: 'Системная папка' }).waitFor();
    await page.waitForFunction(() => !document.querySelector('section[aria-label="Рабочий стол Windows"]')?.textContent?.includes('Читаем Рабочий стол Windows'), undefined, { timeout: 3000 });
    const bounds = await desktopArea.boundingBox();
    if (!bounds) throw new Error('Не нашлась область рабочего стола Windows');
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    await page.evaluate(({ x, y }) => {
      const target = document.querySelector('section[aria-label="Рабочий стол Windows"] > div.relative > div.absolute') as HTMLElement | null
        || document.elementFromPoint(x, y) as HTMLElement | null;
      target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
    }, point);
  };
  const labels = async (page: Page) => page.locator(MENU).last().locator('button').allInnerTexts();

  try {
    // Один и тот же набор в Проводнике и на столе: пункты читаются из меню, а не из исходников
    const compare = await open();
    try {
      await compare.locator('main').click({ button: 'right', position: { x: 600, y: 400 } });
      await compare.locator(MENU).first().getByRole('button', { name: 'Создать', exact: true }).hover();
      await compare.getByRole('button', { name: 'В Windows', exact: true }).hover();
      await compare.locator(MENU).last().getByRole('button', { name: 'Папку', exact: true }).waitFor();
      const explorerWindows = await labels(compare);
      await compare.getByRole('button', { name: 'В Flux', exact: true }).hover();
      // Подменю меняется через четверть секунды: до того на экране ещё прежний раздел
      await compare.waitForTimeout(450);
      await compare.locator(MENU).last().getByRole('button', { name: 'Архив ZIP', exact: true }).waitFor();
      const explorerFlux = await labels(compare);
      await compare.keyboard.press('Escape');

      await showDesktop(compare);
      const menu = compare.locator(MENU).first();
      await menu.getByRole('button', { name: 'Создать Windows', exact: true }).hover();
      await compare.locator(MENU).last().getByRole('button', { name: 'Папку', exact: true }).waitFor();
      const deskWindows = await labels(compare);
      await menu.getByRole('button', { name: 'Создать в Flux', exact: true }).hover();
      await compare.waitForTimeout(450);
      await compare.locator(MENU).last().getByRole('button', { name: 'Архив ZIP', exact: true }).waitFor();
      const deskFlux = await labels(compare);
      check('Рабочий стол: раздел «Создать Windows» — пять пунктов, включая Архив ZIP', JSON.stringify(deskWindows) === JSON.stringify(KINDS));
      check('Рабочий стол: раздел «Создать в Flux» — те же пять пунктов', JSON.stringify(deskFlux) === JSON.stringify(KINDS));
      check('Пункты раздела Windows на столе и в Проводнике совпадают', JSON.stringify(deskWindows) === JSON.stringify(explorerWindows));
      check('Пункты раздела Flux на столе и в Проводнике совпадают', JSON.stringify(deskFlux) === JSON.stringify(explorerFlux));
    } finally {
      await compare.close();
    }

    for (const item of [
      { label: 'Папку', title: 'Новая папка Flux', name: 'Новая папка' },
      { label: 'Архив ZIP', title: 'Новый архив Flux', name: 'Новый архив.zip' },
    ]) {
      // Each case gets its own fixture instance so UI state cannot leak between modal checks.
      const page = await open();
      try {
        await showDesktop(page);
        const menu = page.locator(MENU);
        await menu.getByRole('button', { name: 'Создать в Flux', exact: true }).hover();
        await menu.getByRole('button', { name: item.label, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: item.title });
        await dialog.waitFor();
        check(`${item.label}: открывается модальное окно «${item.title}»`, await dialog.isVisible());
        check(`${item.label}: имя по умолчанию — «${item.name}»`, await page.getByLabel('Имя').inputValue() === item.name);
        check(`${item.label}: текст хранения объясняет Flux и сохранение в Windows позже`, await dialog.getByText('Объект сохранится только в Flux. Позже его можно сохранить в Windows.', { exact: true }).isVisible());
      } finally {
        await page.close();
      }
    }

    // Новое: ZIP в Windows. Создаётся черновик и сразу публикуется, как остальные файлы Windows
    const zipPage = await open();
    try {
      await showDesktop(zipPage);
      const menu = zipPage.locator(MENU);
      await menu.getByRole('button', { name: 'Создать Windows', exact: true }).hover();
      await menu.getByRole('button', { name: 'Архив ZIP', exact: true }).click();
      const dialog = zipPage.getByRole('dialog', { name: 'Новый файл Windows' });
      await dialog.waitFor();
      check('Архив ZIP в Windows: имя по умолчанию — «Новый архив.zip»', await zipPage.getByLabel('Имя').inputValue() === 'Новый архив.zip');
      await dialog.getByRole('button', { name: 'Создать', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      check('Архив ZIP в Windows: createDraft, затем publishDraft', await zipPage.evaluate(() => {
        const calls = (window as any).__windowsFilesCalls as { action: string; name?: string }[];
        const draft = calls.findIndex((request) => request.action === 'createDraft' && request.name === 'Новый архив.zip');
        return draft >= 0 && calls.slice(draft + 1).some((request) => request.action === 'publishDraft');
      }));
    } finally {
      await zipPage.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`${passed} проверок пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
