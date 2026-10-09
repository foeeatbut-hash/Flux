import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'scripts/fixtures/remaining-engineering/vite.config.ts');
const chromePath = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const projectId = 'remaining-eng-project';
const tags: any[] = [
  { id: 'remaining-eng-tag-a', identifier: 'QA-UI-A', department: 'Проверка UI', brand: 'Марка A', fluid: '', wbs: '', projectId, equipmentId: null, createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-02-03T04:05:06.000Z', metadata: JSON.stringify({ mainName: 'Насос с защитой', descriptions: [{ text: 'Статус', status: 'critical', comment: 'Проверить' }], dynamicFields: { Взрыв: 'Да' }, customFlag: true }) },
  { id: 'remaining-eng-tag-b', identifier: 'QA-UI-B', department: 'Проверка UI', brand: 'Марка B', fluid: '', wbs: '', projectId, equipmentId: null, metadata: JSON.stringify({ mainName: 'Насос обычный', descriptions: [], dynamicFields: { Взрыв: 'Нет' } }) },
];
const deleted: string[] = [];
const errors: string[] = [];
let passed = 0;
let failed = 0;
const ok = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)); }
};

(async () => {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: fixture,
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    appType: 'spa',
  });
  let browser: any;
  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (message: any) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    await page.route('**/api/**', async (route: any) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      let body: any = {};
      try { body = request.postDataJSON(); } catch { /* no body */ }
      if (url.pathname === `/api/projects/${projectId}/tags` && method === 'GET') {
        await route.fulfill({ json: { tags } });
      } else if (url.pathname === `/api/projects/${projectId}/dictionaries`) {
        await route.fulfill({ json: { dictionaries: [] } });
      } else if (url.pathname.startsWith('/api/settings/')) {
        await route.fulfill({ json: { global: 'click' } });
      } else if (url.pathname.startsWith('/api/tags/') && method === 'DELETE') {
        const id = url.pathname.split('/').at(-1)!;
        deleted.push(id);
        const index = tags.findIndex(t => t.id === id);
        if (index >= 0) tags.splice(index, 1);
        await route.fulfill({ json: { success: true } });
      } else if (url.pathname.startsWith('/api/tags/') && method === 'PUT') {
        const id = url.pathname.split('/').at(-1)!;
        const tag = tags.find(t => t.id === id);
        if (tag) Object.assign(tag, body);
        await route.fulfill({ json: { tag: tag || null } });
      } else {
        await route.fulfill({ json: {} });
      }
    });

    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Теги' }).waitFor({ timeout: 20000 });
    await page.getByRole('tab', { name: /Дерево связей/ }).click();
    await page.getByText('QA-UI-A', { exact: true }).waitFor({ timeout: 10000 });
    ok('реальный экран реестра показывает фикстурные теги', await page.getByText('QA-UI-A', { exact: true }).count() === 1 && await page.getByText('QA-UI-B', { exact: true }).count() === 1);

    const openExport = async () => {
      await page.getByRole('tab', { name: /Экспорт и импорт/ }).click();
      await page.getByText('Выгрузить →', { exact: true }).click();
      return page.getByRole('dialog', { name: 'Экспорт · Теги' });
    };
    const columnChooser = async (dialog: any) => dialog.getByText(/ID тега · Код тега/).first();
    const exportDialog = await openExport();
    await page.screenshot({ path: '/tmp/registry-export-light.png' });
    const chooser = await columnChooser(exportDialog);
    await chooser.click();
    const allChecks = exportDialog.locator('input[type="checkbox"]');
    const allCount = await allChecks.count();
    let allChecked = true;
    for (let i = 0; i < allCount; i++) allChecked = allChecked && await allChecks.nth(i).isChecked();
    ok('в светлой теме доступны наименование, актуальность и динамическое поле «Взрыв»',
      await exportDialog.getByText('Наименование', { exact: true }).count() === 1
      && await exportDialog.getByText('Актуальность', { exact: true }).count() === 1
      && await exportDialog.getByText('Взрыв', { exact: true }).count() === 1);
    ok('по умолчанию отмечены все поля, включая metadata', allCount >= 17 && allChecked, { allCount, allChecked });
    await exportDialog.getByRole('button', { name: 'CSV', exact: true }).click();
    const fullDownloadPromise = page.waitForEvent('download');
    await exportDialog.getByRole('button', { name: 'Выгрузить', exact: true }).click();
    const fullDownload = await fullDownloadPromise;
    const fullCsv = await readFile(await fullDownload.path(), 'utf8');
    ok('полная выгрузка содержит имя, статус, значение «Взрыв» и непрозрачные metadata',
      fullCsv.includes('Насос с защитой') && fullCsv.includes('Критично') && fullCsv.includes('Взрыв') && fullCsv.includes('customFlag'));

    await page.evaluate(() => document.documentElement.classList.add('dark'));
    const darkDialog = await openExport();
    await page.screenshot({ path: '/tmp/registry-export-dark.png' });
    ok('диалог открыт в тёмной теме без горизонтального переполнения',
      await page.evaluate(() => document.documentElement.classList.contains('dark'))
      && await darkDialog.evaluate((element: HTMLElement) => element.scrollWidth <= element.clientWidth));
    const darkChooser = await columnChooser(darkDialog);
    await darkChooser.click();
    const darkChecks = darkDialog.locator('input[type="checkbox"]');
    for (let i = 0; i < await darkChecks.count(); i++) {
      const label = (await darkChecks.nth(i).locator('xpath=..').innerText()).trim();
      if (!['Код тега', 'Наименование', 'Взрыв'].includes(label)) await darkChecks.nth(i).uncheck();
    }
    const selectedCount = await darkDialog.locator('input[type="checkbox"]:checked').count();
    ok('в тёмной теме можно оставить только выбранные поля', selectedCount === 3 && await darkDialog.getByText('3 столбца').count() === 1, selectedCount);
    await darkDialog.getByRole('button', { name: 'CSV', exact: true }).click();
    const selectedDownloadPromise = page.waitForEvent('download');
    await darkDialog.getByRole('button', { name: 'Выгрузить', exact: true }).click();
    const selectedDownload = await selectedDownloadPromise;
    const selectedCsv = await readFile(await selectedDownload.path(), 'utf8');
    ok('выборочная выгрузка содержит только заголовки и значения отмеченных столбцов',
      selectedCsv.includes('Код тега') && selectedCsv.includes('Наименование') && selectedCsv.includes('Взрыв')
      && selectedCsv.includes('QA-UI-A') && selectedCsv.includes('Насос с защитой') && selectedCsv.includes('Да')
      && !selectedCsv.includes('Марка') && !selectedCsv.includes('customFlag'));

    await page.getByRole('tab', { name: /Дерево связей/ }).click();
    const deleteButtons = page.getByRole('button', { name: 'Удалить тег' });
    await page.getByText('QA-UI-A', { exact: true }).hover();
    await deleteButtons.first().click();
    const dialog = page.getByRole('dialog', { name: 'Удалить тег?' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Отмена' }).click();
    ok('отмена диалога удаления не вызывает DELETE', deleted.length === 0 && tags.length === 2);

    await page.getByText('QA-UI-A', { exact: true }).hover();
    await deleteButtons.first().click();
    const confirm = page.getByRole('dialog', { name: 'Удалить тег?' });
    await confirm.getByRole('button', { name: 'Удалить тег', exact: true }).click();
    await page.getByText('QA-UI-A', { exact: true }).waitFor({ state: 'detached', timeout: 10000 });
    ok('подтверждение удаляет выбранный тег и оставляет соседний', deleted.length === 1 && deleted[0] === 'remaining-eng-tag-a' && tags.length === 1 && tags[0].id === 'remaining-eng-tag-b' && await page.getByText('QA-UI-B', { exact: true }).count() === 1, { deleted, remaining: tags.map(t => t.id) });
    ok('экран работает без ошибок браузера', errors.length === 0, errors);
  } catch (e: any) {
    failed++;
    console.error('  ✗ сценарий прерван:', e?.message || e);
  } finally {
    if (browser) await browser.close();
    await vite.close();
  }
  console.log(`\n${passed} проверок пройдено, ${failed} провалено`);
  if (failed) process.exit(1);
})();
