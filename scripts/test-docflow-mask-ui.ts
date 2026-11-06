/** Проверка маски по рабочей папке на настоящем экране настроек с мостом стенда. */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const base = process.env.FLUX_UI_URL || 'http://127.0.0.1:5174';
const shots = process.env.EXPLORER_SHOTS || '/tmp/flux-docflow-shots';
let passed = 0; let failed = 0;
const ok = (name: string, value: boolean) => { if (value) { passed++; console.log('✓', name); } else { failed++; console.error('✗', name); } };

(async () => {
  await mkdir(shots, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/scripts/fixtures/windows-explorer-ui.html?docflow=1&screen=docflow&tab=settings`);
    await page.getByRole('button', { name: 'Маски', exact: true }).click();
    const scan = page.getByRole('button', { name: 'Проверить на файлах рабочей папки', exact: true });
    ok('Конструктор позволяет проверить рабочую папку без вставки имён вручную', await scan.count() === 1);
    if (!await scan.count()) return;
    await scan.click();
    const table = page.getByRole('table', { name: 'Разбор файлов рабочей папки' });
    await table.waitFor();
    const row = table.getByRole('row', { name: /3700-B01-E02-004_A\.pdf/ });
    ok('Имя из рабочей папки разбирается на шифр, тип и ревизию', /3700-B01-E02-004.*E02.*A.*читается/.test(await row.innerText()));
    ok('У неправильного имени показана причина', /имя не читается|нет поля/.test(await table.getByRole('row', { name: /черновик\.docx/ }).innerText()));
    const ignore = page.getByLabel('Не документ (служебные файлы)');
    await ignore.fill('черновик.docx');
    ok('Исключение применяется до сохранения настроек', /Не документ/.test(await table.getByRole('row', { name: /черновик\.docx/ }).innerText()));
    const mask = page.getByLabel(/^Маска имени файла \(без расширения\)/);
    await mask.fill('{шифр}#{ред}');
    await row.getByText('читается', { exact: true }).waitFor({ state: 'detached' });
    ok('Правка маски пересчитывает уже прочитанные файлы', await row.getByText('читается', { exact: true }).count() === 0);
    const calls = await page.evaluate(() => (window as any).__windowsFilesCalls as Array<{ action: string; ref?: { relativePath: string } }>);
    ok('Проверка читает назначенную папку и подпапки без изменения файлов', calls.some((x) => x.action === 'resolvePortableFolder') && calls.some((x) => x.action === 'list' && x.ref?.relativePath === 'Проекты/Архив') && calls.every((x) => ['resolvePortableFolder', 'list'].includes(x.action)));
    ok('Маска и исключения не сохраняются автоматически', await page.evaluate(() => !(window as any).__docflowPosts.length));
    for (const dark of [false, true]) {
      await page.evaluate((v) => document.documentElement.classList.toggle('dark', v), dark);
      const layout = await table.evaluate((el) => ({ width: el.getBoundingClientRect().width, rows: [...el.querySelectorAll('tbody tr')].map((tr) => tr.getBoundingClientRect().height), font: getComputedStyle(el).fontSize }));
      ok(`Таблица читается в ${dark ? 'тёмной' : 'светлой'} теме`, layout.width > 400 && layout.rows.every((h) => h >= 28 && h <= 40) && parseFloat(layout.font) >= 12);
      await page.locator('.fx-page').screenshot({ path: `${shots}/docflow-mask-${dark ? 'dark' : 'light'}.png` });
    }
    // Ошибка чтения не должна выглядеть пустой успешно проверенной папкой.
    await page.evaluate(() => {
      const bridge = (window as any).electron.windowsFiles;
      const original = bridge.invoke;
      bridge.invoke = (request: any) => request.action === 'list' ? Promise.resolve({ ok: false, error: { code: 'ACCESS_DENIED', message: 'Нет доступа к рабочей папке' } }) : original(request);
    });
    await scan.click();
    await page.getByRole('alert').filter({ hasText: 'Нет доступа к рабочей папке' }).waitFor();
    ok('При отказе чтения показана ошибка, прежний результат убран', await table.count() === 0);
    ok('Нет ошибок страницы', errors.length === 0);
  } finally {
    await browser.close();
    console.log(`${passed} проверок пройдено, ${failed} провалено`);
    process.exitCode = failed ? 1 : 0;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
