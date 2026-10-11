import path from 'node:path';
import { createServer } from 'vite';

const fixtureConfig = path.resolve('scripts/fixtures/guide-tour-ui/vite.config.ts');
const chromePath = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const widths = (process.env.GUIDE_UI_WIDTHS || '320,390,760,1280').split(',').map((value) => Number(value));
const themes = process.env.GUIDE_UI_THEMES === 'light' ? [false] : process.env.GUIDE_UI_THEMES === 'dark' ? [true] : [false, true];
let failures = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  if (pass) console.log(`✓ ${name}`);
  else { failures++; console.error(`✗ ${name}`, detail ?? ''); }
};

async function run(): Promise<void> {
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let browser: any;
try {
  vite = await createServer({ configFile: fixtureConfig, logLevel: 'error' });
  await vite.listen();
  const addr = vite.httpServer?.address();
  if (!addr || typeof addr === 'string') throw new Error('Vite не открыл локальный fixture');
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });

  for (const width of widths) {
    for (const dark of themes) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
      const errors: string[] = [];
      page.on('pageerror', (error: Error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${addr.port}/`, { waitUntil: 'networkidle' });
      if (dark) await page.locator('button').getByText('Тема').click();
      const next = page.getByRole('button', { name: 'Далее', exact: true });
      await next.click();
      await page.getByRole('button', { name: 'Цель', exact: true }).click();
      await page.waitForTimeout(350);
      const finish = page.getByRole('button', { name: 'Завершить', exact: true });
      check(`${width}px ${dark ? 'тёмная' : 'светлая'}: клик не подтверждает результат`, await finish.isDisabled());

      const actual = await page.locator('div.absolute.pointer-events-auto').boundingBox().catch(() => null);
      const targetBox = await page.locator('[data-tour="fixture-target"]').boundingBox();
      const tipStyle = await page.locator('div.absolute.pointer-events-auto').getAttribute('style');
      const computedStyle = await page.locator('div.absolute.pointer-events-auto').evaluate((node) => ({
        position: getComputedStyle(node).position,
        top: getComputedStyle(node).top,
        left: getComputedStyle(node).left,
        parent: (node.parentElement && getComputedStyle(node.parentElement).position) || '',
      }));
      check(`${width}px ${dark ? 'тёмная' : 'светлая'}: подсказка помещается по ширине`, !!actual && actual.x >= 0 && actual.x + actual.width <= width + 0.5, actual);
      check(`${width}px ${dark ? 'тёмная' : 'светлая'}: подсказка помещается по высоте`, !!actual && actual.y >= 0 && actual.y + actual.height <= 800 + 0.5, actual);
      if (!dark) console.log(`  геометрия ${width}px: цель (${Math.round(targetBox?.x || 0)}, ${Math.round(targetBox?.y || 0)}), подсказка (${Math.round(actual?.x || 0)}, ${Math.round(actual?.y || 0)}, ${Math.round(actual?.width || 0)}×${Math.round(actual?.height || 0)}), style=${tipStyle}, computed=${JSON.stringify(computedStyle)}`);
      check(`${width}px ${dark ? 'тёмная' : 'светлая'}: нет горизонтальной прокрутки`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `/tmp/guide-spotlight-${width}-${dark ? 'dark' : 'light'}.png` });

      await page.getByRole('button', { name: 'Показать результат', exact: true }).click();
      await page.waitForTimeout(350);
      check(`${width}px ${dark ? 'тёмная' : 'светлая'}: после реального статуса шаг завершён`, await finish.isEnabled());
      check(`${width}px ${dark ? 'тёмная' : 'светлая'}: ошибок страницы нет`, errors.length === 0, errors);
      await page.close();
    }
  }

  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await page.goto(`http://127.0.0.1:${addr.port}/`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  check('возврат к шагу не запускает действие рабочего интерфейса', await page.locator('#effect-count').textContent() === 'Действие пользователя: 0');
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  check('пауза не выполняет действие рабочего интерфейса', await page.locator('#effect-count').textContent() === 'Действие пользователя: 0');
  await page.getByRole('button', { name: 'Завершить демонстрацию' }).click();
  check('отмена не выполняет действие рабочего интерфейса', await page.locator('#effect-count').textContent() === 'Действие пользователя: 0');
  await page.close();

  const emptyProjectPage = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await emptyProjectPage.goto(`http://127.0.0.1:${addr.port}/?empty-project`, { waitUntil: 'networkidle' });
  check('пустой проект показывает обязательную ветку контекста', await emptyProjectPage.getByText('Проект не выбран').isVisible());
  check('обязательный выбор проекта нельзя пропустить или завершить дальше', await emptyProjectPage.getByRole('button', { name: 'Далее', exact: true }).isDisabled() && await emptyProjectPage.getByRole('button', { name: 'Пропустить шаг' }).count() === 0);
  await emptyProjectPage.getByRole('button', { name: 'Пауза' }).click();
  await emptyProjectPage.getByRole('button', { name: 'Выбрать проект' }).click();
  check('выбор проекта во время паузы не меняет прогресс до возобновления', await emptyProjectPage.getByRole('button', { name: 'Далее', exact: true }).isDisabled());
  await emptyProjectPage.getByRole('button', { name: 'Продолжить' }).click();
  await emptyProjectPage.waitForTimeout(350);
  check('ветка пустого проекта подтверждается фактическим выбранным проектом', await emptyProjectPage.getByRole('button', { name: 'Далее', exact: true }).isEnabled());
  await emptyProjectPage.close();
} catch (error) {
  failures++;
  console.error('✗ UI fixture:', error instanceof Error ? error.stack : error);
} finally {
  await browser?.close().catch(() => undefined);
  await vite?.close().catch(() => undefined);
}

console.log(`\n${failures ? `${failures} проверок UI не пройдено` : 'Проверки подсветки Guide пройдены'}`);
process.exit(failures ? 1 : 0);
}

void run();
