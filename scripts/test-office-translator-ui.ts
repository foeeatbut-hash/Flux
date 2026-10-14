/**
 * Панель «Переводчик» окна Flux с фальшивым редактором (scripts/fixtures/translator-harness.tsx):
 * чтение → перевод → подтверждение → предпросмотр → применение → запись с токеном; отказ записи →
 * откат; ворота против обычного сохранения; устаревшие. Снимки Word и Таблицы в обеих темах.
 *
 *   FLUX_UI_URL=http://127.0.0.1:5201 FLUX_CHROME=… tsx scripts/test-office-translator-ui.ts   (SHOTS=1 — снимки)
 */
import { mkdirSync } from 'node:fs';
const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5201';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOTS = process.env.SHOTS === '1';
const OUT = 'docs/codex/task-02-ui';
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`✓ ${name}`); } else { failed++; console.error(`✗ ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)); }
};

(async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const open = async (query: string, width = 420) => {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      page.setDefaultTimeout(8000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${BASE}/scripts/fixtures/translator-harness.html?${query}`);
      await page.waitForSelector('[aria-label="Перевод документа"]');
      return { page, errors };
    };
    const log = (page: any): Promise<string[]> => page.evaluate(() => (window as any).__fake.log.slice());
    const rows = (page: any) => page.locator('[data-testid="tr-row"]');
    const button = (page: any, name: string) => page.getByRole('button', { name, exact: true });

    console.log('— Word: чтение, перевод, подтверждение, запись');
    {
      const { page, errors } = await open('app=docs');
      await button(page, 'Прочитать').click();
      await page.waitForSelector('[data-testid="tr-row"]');
      check('прочитано 4 фрагмента, актуальный пропущен по умолчанию', (await rows(page).count()) === 4 && (await rows(page).nth(3).innerText()).includes('Пропущен'));
      check('режимов Word: 5', (await page.locator('select').nth(2).locator('option').count()) === 5);
      check('«Применить» неактивна до перевода', await button(page, 'Применить').isDisabled().catch(() => true));
      await button(page, 'Перевести').click();
      check('переведено, требуют проверки 3', (await page.getByText('К записи: 3 · проверить: 3').count()) === 1);
      check('плашка в переводе сохранена', (await rows(page).nth(1).locator('textarea').inputValue()).includes(''));
      check('«Применить» неактивна, пока есть непроверенные', await button(page, 'Применить').isDisabled());
      await button(page, 'Предпросмотр').click();
      await page.waitForSelector('[aria-label="Предпросмотр"]');
      check('предпросмотр показан редактором, документ не менялся', (await page.locator('[aria-label="Предпросмотр"]').count()) === 1 && (await log(page)).includes('editor.preview') && !(await log(page)).some((l) => l.startsWith('editor.apply')));
      await rows(page).nth(0).getByRole('button', { name: 'Подтвердить' }).click();
      await rows(page).nth(1).getByRole('button', { name: 'Пропустить' }).click();
      await rows(page).nth(2).getByRole('button', { name: 'Подтвердить' }).click();
      check('после решения по всем «Применить» доступна', await button(page, 'Применить').isEnabled());
      // Обычное сохранение, начатое во время постановки, ждёт её конца
      await page.evaluate(() => { (window as any).__fake.hold = 300; });
      await button(page, 'Применить').click();
      await page.waitForTimeout(60);
      await page.evaluate(() => (window as any).__ordinarySave());
      await page.waitForFunction(() => (window as any).__fake.log.includes('ordinary-save'));
      const order = await log(page);
      const iOrdinary = order.indexOf('ordinary-save');
      const iSave = order.findIndex((l) => l.startsWith('file.save'));
      check('порядок: правки → постановка → запись с токеном', order.findIndex((l) => l.startsWith('file.committed')) < order.findIndex((l) => l.startsWith('editor.apply')) && order.findIndex((l) => l.startsWith('editor.apply')) < iSave, order);
      check('запись несёт токен и 2 записи журнала', /file\.save:token=tok-1:base=h1:records=2/.test(order[iSave]), order[iSave]);
      check('обычное сохранение дождалось конца постановки', iOrdinary > iSave, order);
      await page.waitForFunction(() => document.body.innerText.includes('Применено фрагментов: 2'));
      check('после записи документ перечитан: переведённые стали актуальными', (await rows(page).nth(0).innerText()).includes('Актуален'));
      check('пропущенный остался без записи (одна плашка p2 не писалась)', (await page.evaluate(() => (window as any).__fake.records.map((r: any) => r.key))).join() === 'p1,p3');
      check('без ошибок страницы', errors.length === 0, errors);
      await page.close();
    }

    console.log('— Word: отказ записи → откат; отказ редактора');
    {
      const { page } = await open('app=docs');
      await button(page, 'Прочитать').click();
      await page.waitForSelector('[data-testid="tr-row"]');
      await button(page, 'Перевести').click();
      await page.getByRole('button', { name: 'Подтвердить' }).first().waitFor();
      for (let i = await page.getByRole('button', { name: 'Подтвердить' }).count(); i > 0; i--) await page.getByRole('button', { name: 'Подтвердить' }).first().click();
      await page.evaluate(() => { (window as any).__fake.refuseSave = true; });
      await button(page, 'Применить').click();
      await page.waitForSelector('[role="alert"]');
      const alert = await page.locator('[role="alert"]').innerText();
      check('ошибка по-русски, перевод отменён', /Файл изменили/.test(alert) && /Перевод в документе отменён/.test(alert), alert);
      check('вызван откат своего шага', (await log(page)).includes('editor.rollback:step-1'));
      check('журнал не изменился', (await page.evaluate(() => (window as any).__fake.records.length)) === 0);
      await page.evaluate(() => { (window as any).__fake.refuseSave = false; (window as any).__fake.applyCode = 'protected-changed'; });
      await button(page, 'Применить').click();
      await page.waitForFunction(() => document.body.innerText.includes('плашка Flux'));
      check('отказ редактора: понятные слова, записи нет', (await log(page)).filter((l) => l.startsWith('file.save')).length === 1);
      await page.close();
    }

    console.log('— Word: «В новый файл», устаревшие, только чтение');
    {
      const { page } = await open('app=docs');
      await button(page, 'Прочитать').click();
      await page.waitForSelector('[data-testid="tr-row"]');
      await button(page, 'Обновить устаревшие').click();
      check('остался один устаревший, переведён заново', (await page.getByText('К записи: 1 · проверить: 1').count()) === 1);
      await page.getByRole('button', { name: 'Устарели1' }).waitFor().catch(() => {});
      await page.getByRole('button', { name: 'Подтвердить' }).first().click();
      await button(page, 'В новый файл').first().click();
      await page.waitForFunction(() => document.body.innerText.includes('Применено фрагментов: 1'));
      const order = await log(page);
      check('новый DOCX: копия с журналом, запись в оригинал не шла', order.some((l) => l.startsWith('file.copy:Перевод.docx:8:1')) && !order.some((l) => l.startsWith('file.save')), order);
      await page.close();
      const ro = await open('app=docs&readonly=1');
      await button(ro.page, 'Прочитать').click();
      await ro.page.waitForSelector('[data-testid="tr-row"]');
      await button(ro.page, 'Перевести').click();
      for (let i = await ro.page.getByRole('button', { name: 'Подтвердить' }).count(); i > 0; i--) await ro.page.getByRole('button', { name: 'Подтвердить' }).first().click();
      check('только чтение: запись недоступна', await button(ro.page, 'Применить').isDisabled());
      await ro.page.close();
    }

    console.log('— Таблица: 6 режимов, шапка, новая книга');
    {
      const { page } = await open('app=sheets');
      check('режимов Excel: 6', (await page.locator('select').nth(2).locator('option').count()) === 6);
      check('области: документ, лист, выделение, шапка', (await page.locator('select').nth(0).locator('option').count()) === 4);
      await page.locator('select').nth(2).selectOption('inline-after');
      check('разделитель и порядок появились', (await page.getByText('Разделитель', { exact: true }).count()) === 1 && (await page.getByText('Порядок', { exact: true }).count()) === 1);
      await page.locator('select').nth(2).selectOption('new-file');
      await button(page, 'Прочитать').click();
      await page.waitForSelector('[data-testid="tr-row"]');
      check('адрес ячейки в подписи', (await rows(page).nth(0).innerText()).includes('Лист1 · A1'));
      await button(page, 'Перевести').click();
      for (let i = await page.getByRole('button', { name: 'Подтвердить' }).count(); i > 0; i--) await page.getByRole('button', { name: 'Подтвердить' }).first().click();
      await button(page, 'В новый файл').last().click();
      await page.waitForFunction(() => document.body.innerText.includes('Применено фрагментов'));
      check('новая книга: сохранение копии движком с журналом', (await log(page)).some((l) => l.startsWith('file.sheets-copy:')), await log(page));
      await page.close();
    }

    console.log('— Узкая ширина 360 и снимки');
    for (const app of ['docs', 'sheets']) for (const theme of ['light', 'dark']) {
      const { page } = await open(`app=${app}&theme=${theme}`, 360);
      await button(page, 'Прочитать').click();
      await page.waitForSelector('[data-testid="tr-row"]');
      await button(page, 'Перевести').click();
      await rows(page).nth(0).getByRole('button', { name: 'Подтвердить' }).click();
      await button(page, 'Предпросмотр').click();
      await page.waitForSelector('[aria-label="Предпросмотр"]');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const small = await page.evaluate(() => [...document.querySelectorAll('section *')].filter((el) => el.children.length === 0 && el.textContent?.trim() && parseFloat(getComputedStyle(el).fontSize) < 12).length);
      const heavy = await page.evaluate(() => [...document.querySelectorAll('section *')].filter((el) => el.textContent?.trim() && Number(getComputedStyle(el).fontWeight) > 600).length);
      check(`${app}/${theme}: нет горизонтальной прокрутки, шрифт ≥ 12, вес ≤ 600`, overflow <= 0 && small === 0 && heavy === 0, { overflow, small, heavy });
      if (SHOTS) {
        mkdirSync(OUT, { recursive: true });
        await page.screenshot({ path: `${OUT}/translator-${app}-${theme}.png`, clip: { x: 0, y: 0, width: 360, height: 800 } });
      }
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(`\nПройдено: ${passed}, провалено: ${failed}`);
  process.exit(failed ? 1 : 0);
})();
