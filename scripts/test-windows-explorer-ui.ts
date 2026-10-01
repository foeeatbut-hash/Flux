/** Браузерная проверка Проводника с имитацией нативного файлового моста. */
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';
let passed = 0; let failed = 0;
const ok = (name: string, value: boolean) => { if (value) { passed++; console.log('✓', name); } else { failed++; console.error('✗', name); } };

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${BASE}/scripts/fixtures/windows-explorer-ui.html`);
    await page.getByRole('heading', { name: 'Файлы Windows' }).waitFor();
    await page.getByRole('row', { name: /Проекты/ }).waitFor();
    ok('Нативный sidebar загружает подключённые папки и список', await page.getByRole('button', { name: 'Документы' }).isVisible() && await page.getByRole('row', { name: /Инструкция\.docx/ }).isVisible());

    await page.getByRole('row', { name: /Проекты/ }).dblclick();
    await page.getByRole('row', { name: /Отчёт\.xlsx/ }).waitFor();
    ok('Двойное нажатие входит в папку и обновляет путь', (await page.getByTestId('route').textContent())?.includes('path=Проекты') || await page.getByRole('button', { name: 'Проекты', exact: true }).isVisible());
    await page.getByRole('textbox', { name: 'Поиск по имени' }).fill('Отчёт');
    ok('Поиск по имени оставляет совпадение', await page.getByRole('row', { name: /Отчёт\.xlsx/ }).count() === 1 && await page.getByRole('row', { name: /Архив/ }).count() === 0);

    await page.getByRole('button', { name: 'Свойства Отчёт.xlsx' }).click();
    await page.getByRole('dialog', { name: /Свойства/ }).waitFor();
    ok('Свойства показывают проекты, теги и историю', await page.getByText('Проект 1 · текущий').isVisible() && await page.getByText('AHU-01', { exact: true }).count() >= 1 && await page.getByText(/История файла/).isVisible());
    await page.getByRole('button', { name: 'Сохранить свойства' }).click();
    ok('Свойства отправляются только в windowsFiles bridge', await page.evaluate(() => (window as any).__windowsFilesCalls.some((request: any) => request.action === 'setMetadata')));

    await page.evaluate(() => (window as any).__go('/windows-files?root=desktop-id&path=Проекты&target=Проекты%2FОтчёт.xlsx&properties=1'));
    await page.getByRole('dialog', { name: /Свойства · Отчёт\.xlsx/ }).waitFor();
    ok('Deep link свойств загружает родительскую папку и выбирает целевой файл', await page.evaluate(() => (window as any).__windowsFilesCalls.some((request: any) => request.action === 'list' && request.ref.relativePath === 'Проекты')) && await page.getByText('Проект 1 · текущий').isVisible());
    await page.getByRole('button', { name: 'Закрыть', exact: true }).click();

    await page.getByRole('button', { name: /Создать в Flux/ }).click();
    await page.getByRole('dialog', { name: 'Новый файл Flux' }).waitFor();
    await page.getByRole('button', { name: 'Создать черновик' }).click();
    await page.getByRole('dialog', { name: 'Новый файл Flux' }).waitFor({ state: 'detached' });
    ok('Создание нового документа записывает локальный черновик и открывает ref', await page.evaluate(() => (window as any).__windowsFilesCalls.some((request: any) => request.action === 'createDraft')) && (await page.getByTestId('route').textContent())?.startsWith('/windows-file?root='));
    await page.evaluate(() => (window as any).__go('/windows-files?root=desktop-id&path=Проекты'));
    await page.getByRole('row', { name: /Новый документ\.docx/ }).click();
    await page.getByRole('button', { name: /Опубликовать/ }).click();
    ok('Публикация черновика запускается отдельно', await page.evaluate(() => (window as any).__windowsFilesCalls.some((request: any) => request.action === 'publishDraft')));

    await page.getByRole('button', { name: 'Плитки' }).click();
    ok('Переключение на плитки работает', await page.getByRole('button', { name: /Отчёт\.xlsx/ }).count() === 1);
    for (const width of [1440, 1024, 768, 600]) {
      await page.setViewportSize({ width, height: 820 });
      for (const dark of [false, true]) {
        await page.evaluate((enabled) => document.documentElement.classList.toggle('dark', enabled), dark);
        const size = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        ok(`Без горизонтального переполнения при ${width}px (${dark ? 'тёмная' : 'светлая'} тема)`, size.scroll <= size.client + 2);
      }
    }
    ok('Нет загрузки файловых байтов или метаданных на сервер компании', await page.evaluate(() => (window as any).__windowsFilesCalls.every((request: any) => !['upload', 'projectWrite'].includes(request.action))));
    ok('Нет ошибок браузера', errors.length === 0);
    if (errors.length) console.error(errors.slice(0, 5));
  } finally { await browser.close(); }
  console.log(`${passed} проверок пройдено, ${failed} провалено`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
