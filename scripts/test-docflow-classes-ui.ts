/** Настройки и ручное назначение класса: только подтверждённый план меняет тег. */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const base = process.env.FLUX_UI_URL || 'http://127.0.0.1:5174';
const shots = process.env.EXPLORER_SHOTS || '/tmp/flux-docflow-shots';
const check = (name: string, condition: unknown) => { if (!condition) throw new Error(`✗ ${name}`); console.log(`✓ ${name}`); };
(async () => {
  await mkdir(shots, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/scripts/fixtures/windows-explorer-ui.html?docflow=1&screen=docflow&tab=settings`);
    await page.getByRole('button', { name: 'Классы оборудования', exact: true }).click();
    const fill = page.getByRole('button', { name: 'Заполнить классы…' });
    await page.getByRole('button', { name: 'Добавить соответствие' }).click();
    check('Незаполненную строку нельзя сохранить или применить к тегам', await page.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled() && await fill.isDisabled());
    await page.getByLabel('Тип оборудования 1').fill(' ahu ');
    await page.getByLabel('Класс каталога 1').selectOption('class-fan');
    check('До сохранения заполнение недоступно', await fill.isDisabled());
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.waitForFunction(() => (window as any).__classStand.events.includes('settings'));
    await fill.waitFor({ state: 'visible' });
    await fill.click();
    const dialog = page.getByRole('dialog', { name: 'Классы оборудования — предпросмотр' });
    await dialog.getByRole('row', { name: /П1.*AHU.*FAN/ }).waitFor();
    check('Предпросмотр показывает строку без изменения тега', await page.evaluate(() => (window as any).__classStand.value === '' && !(window as any).__classStand.events.includes('apply')));
    for (const width of [1440, 1024]) {
      if (width === 1024) {
        await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
        await dialog.waitFor({ state: 'detached' });
        await page.setViewportSize({ width, height: 900 });
        await fill.click();
        await dialog.getByRole('row', { name: /П1.*AHU.*FAN/ }).waitFor();
      }
      for (const dark of [false, true]) {
        await page.evaluate(enabled => { document.documentElement.classList.toggle('dark', enabled); document.documentElement.classList.remove('flux-glass'); }, dark);
        await dialog.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => undefined))); });
        check('Предпросмотр непрозрачен', await dialog.evaluate(el => getComputedStyle(el).opacity === '1'));
        const bounds = await dialog.boundingBox();
        await page.screenshot({ path: `${shots}/docflow-classes-preview-${width}-${dark ? 'dark' : 'light'}.png` });
        console.log('PREVIEW_BOUNDS', JSON.stringify({ width, dark, bounds }));
        check(`Предпросмотр помещается: ${width}, ${dark ? 'dark' : 'light'}`, !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
      }
    }
    await dialog.getByRole('button', { name: 'Применить (1)' }).click();
    await dialog.getByText('Классы назначены по подтверждённому плану.').waitFor();
    check('Применение записывает класс после настроек', await page.evaluate(() => (window as any).__classStand.value === 'class-fan' && (window as any).__classStand.events.join(',') === 'settings,apply'));
    await dialog.getByRole('button', { name: 'Отменить заполнение' }).click();
    await dialog.waitFor({ state: 'detached' });
    check('Отмена возвращает прежнее значение', await page.evaluate(() => (window as any).__classStand.value === '' && (window as any).__classStand.events.at(-1) === 'undo'));
    await fill.click(); await dialog.getByRole('button', { name: 'Применить (1)' }).click();
    await dialog.getByText('Классы назначены по подтверждённому плану.').waitFor();
    await dialog.getByRole('button', { name: 'Отменить заполнение' }).click(); await dialog.waitFor({ state: 'detached' });
    check('Повтор после отмены снова применим и отменяем', await page.evaluate(() => (window as any).__classStand.events.join(',') === 'settings,apply,undo,apply,undo'));
    await page.evaluate(() => { (window as any).__classStand.denied = 'Нет права назначать классы'; });
    await fill.click(); await dialog.getByText('Нет права назначать классы').waitFor();
    check('Отказ сервера виден и применение недоступно', await dialog.getByRole('button', { name: 'Применить (0)' }).isDisabled());
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.evaluate(() => { (window as any).__classStand.denied = ''; (window as any).__classStand.pending = true; });
    await fill.click(); await dialog.getByRole('status').waitFor();
    check('Во время построения плана применение и закрытие заблокированы', await dialog.getByRole('button', { name: 'Применить (0)' }).isDisabled() && await dialog.getByRole('button', { name: 'Закрыть', exact: true }).isDisabled());
    await page.evaluate(() => { (window as any).__classStand.pending = false; (window as any).__classStand.release(); });
    await dialog.getByRole('row', { name: /П1.*AHU.*FAN/ }).waitFor();
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    for (const width of [1440, 1024]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(enabled => { document.documentElement.classList.toggle('dark', enabled); document.documentElement.classList.remove('flux-glass'); }, dark);
      const pane = page.getByRole('region', { name: 'Классы оборудования' });
      const geometry = await pane.evaluate(el => { const r = el.getBoundingClientRect(); const c = getComputedStyle(el); return { width: r.width, scroll: el.scrollWidth, client: el.clientWidth, opacity: c.opacity }; });
      check(`Настройки помещаются и непрозрачны: ${width}, ${dark ? 'dark' : 'light'}`, geometry.width > 0 && geometry.scroll <= geometry.client + 1 && geometry.opacity === '1');
      await page.screenshot({ path: `${shots}/docflow-classes-${width}-${dark ? 'dark' : 'light'}.png` });
    }
    await page.goto(`${base}/scripts/fixtures/windows-explorer-ui.html?docflow=1&screen=tagclass`);
    await page.getByLabel('Класс Каталога тега').selectOption('class-ahu');
    await page.getByRole('button', { name: 'Предпросмотр класса…' }).click();
    const tagDialog = page.getByRole('dialog', { name: 'Классы оборудования — предпросмотр' });
    await tagDialog.getByRole('row', { name: /П1.*AHU/ }).waitFor();
    check('Ручной выбор тега сначала показывает план', await page.evaluate(() => (window as any).__classStand.value === ''));
    for (const dark of [false, true]) {
      await page.setViewportSize({ width: 1024, height: 900 });
      await page.evaluate(enabled => { document.documentElement.classList.toggle('dark', enabled); document.documentElement.classList.remove('flux-glass'); }, dark);
      await tagDialog.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => undefined))); });
      check('Окно ручного выбора непрозрачно', await tagDialog.evaluate(el => getComputedStyle(el).opacity === '1'));
      await page.screenshot({ path: `${shots}/docflow-classes-tag-1024-${dark ? 'dark' : 'light'}.png` });
    }
    await tagDialog.getByRole('button', { name: 'Применить (1)' }).click();
    await tagDialog.getByText('Классы назначены по подтверждённому плану.').waitFor();
    check('Ручной выбор применяется только после подтверждения', await page.evaluate(() => (window as any).__classStand.value === 'class-ahu'));
    check('Ошибок страницы нет', errors.length === 0);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
