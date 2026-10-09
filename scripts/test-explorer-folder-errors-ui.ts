/** Ошибка списка не должна становиться ложным «папка пуста» или стирать свежие данные. */
import { mkdir } from 'node:fs/promises';

const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5174';
const CHROME = process.env.FLUX_CHROME || '/usr/bin/chromium';
const SHOTS = process.env.EXPLORER_SHOTS || '/tmp/flux-explorer-folder-errors';
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`✓ ${name}`); }
  else { failed++; console.error(`✗ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
};

(async () => {
  const { chromium } = await import('playwright-core');
  await mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const errors: string[] = [];
  try {
    for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(`${BASE}/scripts/fixtures/windows-explorer-ui.html`);
      await page.locator('[data-windows-explorer]').waitFor();
      await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
      const row = page.getByRole('row', { name: /Инструкция\.docx/ });
      await row.waitFor();
      const go = (path: string) => page.evaluate((target) => (window as any).__go(`/explorer?root=desktop-id&path=${target}`), path);

      await page.evaluate(() => (window as any).__setExplorerListFault('root-denied'));
      await go('Проекты'); await page.getByRole('row', { name: /Отчёт\.xlsx/ }).waitFor();
      await go(''); await page.getByRole('alert').getByText('Windows запретила доступ').waitFor();
      check(`${theme}: отказ списка корня не показывает папку пустой`, await page.getByText('Список папки недоступен.', { exact: true }).count() === 1
        && await page.getByText('Эта папка пуста.', { exact: true }).count() === 0);

      await page.evaluate(() => (window as any).__setExplorerListFault('none'));
      await go('Проекты'); await page.getByRole('row', { name: /Отчёт\.xlsx/ }).waitFor();
      await go(''); await row.waitFor(); await row.click();
      check(`${theme}: файл выбран перед обновлением`, await row.getAttribute('aria-selected') === 'true');
      await page.evaluate(() => (window as any).__setExplorerListFault('refresh-denied'));
      await page.locator('[data-windows-explorer]').focus(); await page.keyboard.press('F5');
      await page.getByRole('alert').getByText('Windows запретила доступ').waitFor();
      check(`${theme}: ошибка обновления сохраняет строки и выделение`, await row.isVisible() && await row.getAttribute('aria-selected') === 'true');

      await page.evaluate(() => (window as any).__setExplorerListFault('partial'));
      await page.locator('[data-windows-explorer]').focus(); await page.keyboard.press('F5');
      const warning = page.getByRole('status').getByText('Недоступных объектов пропущено: 2', { exact: true });
      await warning.waitFor(); await row.waitFor();
      const geometry = await page.locator('[data-windows-explorer] main').evaluate((main) => {
        const r = main.getBoundingClientRect(); const w = main.querySelector('[role="status"]')!.getBoundingClientRect();
        return { width: r.width, height: r.height, warningWidth: w.width, warningHeight: w.height };
      });
      check(`${theme}: доступные соседи и счётчик недоступных объектов видимы`, await row.isVisible()
        && geometry.width > 0 && geometry.height > 0 && geometry.warningWidth > 0 && geometry.warningHeight > 0, geometry);
      await page.screenshot({ path: `${SHOTS}/folder-errors-${theme}.png` });
      await page.close();
    }
    check('Состояния отказа списка не создают ошибок браузера', errors.length === 0, errors);
  } finally { await browser.close(); }
  console.log(`\n${passed} проверок пройдено, ${failed} провалено`);
  process.exitCode = failed ? 1 : 0;
})();
