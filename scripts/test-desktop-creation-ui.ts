/** Проверка окон создания Flux на настоящем рабочем столе Windows в fixture. */
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  let passed = 0;
  let failed = 0;
  const check = (name: string, value: boolean) => {
    if (value) { passed++; console.log('✓', name); }
    else { failed++; console.error('✗', name); }
  };

  try {
    for (const item of [
      { label: 'Папку', title: 'Новая папка Flux', name: 'Новая папка' },
      { label: 'Архив ZIP', title: 'Новый архив Flux', name: 'Новый архив.zip' },
    ]) {
      // Each case gets its own fixture instance so UI state cannot leak between modal checks.
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      try {
        await page.goto(`${BASE}/scripts/fixtures/windows-explorer-ui.html`);
        await page.getByRole('heading', { name: 'Проводник' }).waitFor();
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

        const menu = page.locator('body > [data-context-menu]');
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
  } finally {
    await browser.close();
  }
  console.log(`${passed} проверок пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
