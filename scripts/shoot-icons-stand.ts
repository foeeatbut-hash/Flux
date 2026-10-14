/**
 * Снимки значков для docs/stand/icons/: рабочий стол, Пуск, панель задач и
 * Проводник (таблица и крупные значки) в светлой и тёмной теме, 1366×768.
 *
 * Берёт настоящие компоненты на стендах с подменённым мостом, поэтому снимки
 * честно показывают то, что нарисовано в коде, а не макет.
 *
 * Запуск: FLUX_UI_URL=http://127.0.0.1:5197 FLUX_CHROME=… npx tsx scripts/shoot-icons-stand.ts [папка]
 */
import { mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';

const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = process.argv[2] || 'docs/stand/icons';
const MAX_BYTES = 300 * 1024;

(async () => {
  const { chromium } = await import('playwright-core');
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const saved: string[] = [];
  const errors: string[] = [];
  const shot = async (page: import('playwright-core').Page, name: string, clip?: { x: number; y: number; width: number; height: number }) => {
    const path = `${OUT}/${name}.png`;
    await page.screenshot({ path, ...(clip ? { clip } : {}) });
    const size = statSync(path).size;
    if (size > MAX_BYTES) errors.push(`${path}: ${Math.round(size / 1024)} КБ — больше ${MAX_BYTES / 1024} КБ`);
    saved.push(`${path} ${Math.round(size / 1024)} КБ`);
  };
  try {
    for (const theme of ['light', 'dark'] as const) {
      const open = async (url: string, scale = 1) => {
        const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: scale });
        page.on('pageerror', (error) => errors.push(`${url}: ${error}`));
        await page.goto(`${BASE}/scripts/fixtures/${url}`);
        return page;
      };
      // Рабочий стол, Пуск
      for (const scene of ['desktop', 'start'] as const) {
        const page = await open(`icons-shell.html?scene=${scene}&theme=${theme}`);
        await page.getByRole('button', { name: 'Пуск' }).waitFor();
        await page.waitForTimeout(1200);
        await shot(page, `${scene}-${theme}`);
        await page.close();
      }
      // Панель задач крупно: две точки на пиксель, чтобы разобрать рисунок
      {
        const page = await open(`icons-shell.html?scene=desktop&theme=${theme}`, 2);
        await page.getByRole('button', { name: 'Пуск' }).waitFor();
        await page.waitForTimeout(1200);
        await shot(page, `taskbar-${theme}`, { x: 0, y: 720, width: 683, height: 48 });
        await page.close();
      }
      // Проводник: таблица и крупные значки
      for (const [layout, label] of [['details', 'Таблица'], ['large', 'Крупные значки']] as const) {
        const page = await open(`windows-explorer-ui.html?mix=1`);
        await page.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
        await page.getByRole('row', { name: /Договор\.docx/ }).waitFor();
        // Служебная строка адреса стенда в кадр не нужна
        await page.evaluate(() => document.querySelector('[data-testid="route"]')?.remove());
        if (layout !== 'details') {
          await page.getByRole('button', { name: 'Просмотреть' }).click();
          await page.locator('[data-context-menu]').getByRole('button', { name: label, exact: true }).click();
        }
        await page.waitForTimeout(800);
        await shot(page, `explorer-${layout}-${theme}`);
        await page.close();
      }
    }
  } finally { await browser.close(); }
  console.log(saved.join('\n'));
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
})();
