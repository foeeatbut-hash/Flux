import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../node_modules/playwright-core/index.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const output = process.env.OFFICE_CELL_ACTIONS_UI_DIR || '/tmp/flux-office-cell-actions-ui';
const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

try {
  await page.goto(process.env.OFFICE_CELL_ACTIONS_UI_URL);
  await page.getByRole('heading', { name: 'Перечень' }).waitFor();
  for (const width of [390, 760, 1280]) {
    await page.setViewportSize({ width, height: 820 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => window.__cellActionsFixture.setTheme(value), theme);
      await page.getByRole('button', { name: 'Открыть действия с двумя ячейками' }).click();
      const dialog = page.getByRole('dialog', { name: 'Действия с заголовочными ячейками' });
      await dialog.waitFor();
      const geometry = await page.evaluate(() => ({ body: document.documentElement.scrollWidth, viewport: innerWidth, dialog: document.querySelector('[role=dialog]')?.getBoundingClientRect().width }));
      if (geometry.body > width || geometry.dialog > width) throw new Error(`dialog overflow at ${width}px/${theme}: ${JSON.stringify(geometry)}`);
      await dialog.getByText(/Выходная ячейка/).waitFor();
      await dialog.getByText(/Вторая ячейка/).waitFor();
      await dialog.getByText(/DrivePower · equipment/).waitFor();
      await dialog.getByText(/MotorPower · equipment/).waitFor();
      const screenshot = path.join(output, `${width}-${theme}-editable.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await dialog.getByRole('button', { name: 'Закрыть' }).click();
      await page.getByText('Действия закрыты').waitFor();

      await page.getByRole('button', { name: 'Открыть только для просмотра' }).click();
      const readOnly = page.getByRole('dialog', { name: 'Действия с заголовочными ячейками' });
      await readOnly.getByText('Документ открыт только для просмотра.').waitFor();
      if (await readOnly.getByRole('button', { name: 'Проверить объединение' }).isEnabled()) throw new Error(`read-only merge action enabled at ${width}px/${theme}`);
      await page.screenshot({ path: path.join(output, `${width}-${theme}-readonly.png`), fullPage: true });
      await readOnly.getByRole('button', { name: 'Закрыть' }).click();
    }
  }
  if (errors.length) throw new Error(`browser errors: ${errors.join('; ')}`);
  const ops = await page.evaluate(() => window.__cellActionsFixture.ops);
  if (ops.filter((item) => item.type === 'cancel').length !== 12) throw new Error(`cancel callbacks missing: ${JSON.stringify(ops)}`);
  console.log(JSON.stringify({ viewports: [390, 760, 1280], themes: ['light', 'dark'], verified: ['two selected anchors and ordered parameter aliases', 'dialog cancel', 'readonly status and disabled merge action', 'responsive geometry'], callbacks: ops.map((item) => item.type) }, null, 2));
} finally { await browser.close(); }
