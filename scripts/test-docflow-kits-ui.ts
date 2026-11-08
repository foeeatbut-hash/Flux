/** Редактор проектного комплекта: проверка черновика, сохранения и переноса. */
import { chromium } from 'playwright-core';

const base = process.env.FLUX_UI_URL || 'http://127.0.0.1:5174';
const check = (name: string, condition: unknown) => { if (!condition) throw new Error(`✗ ${name}`); console.log(`✓ ${name}`); };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/scripts/fixtures/windows-explorer-ui.html?docflow=1&screen=docflow&tab=settings`);
    await page.getByRole('button', { name: 'Комплекты', exact: true }).click();
    const editor = page.getByRole('region', { name: 'Комплекты документов' });
    await editor.getByRole('button', { name: 'Вентилятор', exact: true }).click();
    await editor.getByRole('button', { name: 'Добавить документ' }).click();
    const save = page.getByRole('button', { name: 'Сохранить', exact: true });
    check('Пустой тип документа блокирует сохранение', await save.isDisabled());
    await editor.getByLabel('Тип документа 1').selectOption('E02');
    await editor.getByLabel('Стадия 1').selectOption('Р');
    await editor.getByLabel('Единица 1').selectOption('group');
    await editor.getByLabel('Обязательность 1').selectOption('customer');
    await editor.getByLabel('Должность 1').selectOption('ENGINEER');
    await editor.getByLabel('Веха 1').selectOption('START');
    await editor.getByLabel('Рабочих дней 1').fill('12');
    await editor.getByLabel('Условие по параметру').check();
    check('Пустой параметр условия блокирует сохранение', await save.isDisabled());
    await editor.getByLabel('Параметр 1').fill('Двигатель||Мощность');
    await editor.getByLabel('Условие 1').selectOption('equals');
    await editor.getByLabel('Значение 1').fill('10');
    await save.click();
    await page.waitForFunction(() => (window as any).__classStand.events.includes('settings'));
    const saved = await page.evaluate(() => (window as any).__docflowPosts.find((p: any) => p.url === '/api/docflow/settings').body.config.kits);
    check('Все поля строки отправлены при сохранении', JSON.stringify(saved) === JSON.stringify([{ classId: 'class-fan', items: [{ docType: 'E02', stage: 'Р', unit: 'group', necessity: 'customer', responsibleRole: 'ENGINEER', milestone: 'START', workdays: 12, condition: { parameter: 'Двигатель||Мощность', operator: 'equals', value: '10' } }] }]));
    await page.getByRole('button', { name: 'Скопировать из проекта…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Скопировать настройки из проекта' });
    await dialog.getByLabel('Источник').selectOption('project-2');
    for (const box of await dialog.getByRole('checkbox').all()) if ((await box.isChecked()) && !(await box.evaluate(el => el.parentElement?.textContent?.trim() === 'Комплекты'))) await box.uncheck();
    await dialog.getByRole('button', { name: 'Показать различия' }).click();
    await dialog.getByLabel('Предпросмотр различий').getByText('добавится class-ahu').waitFor();
    check('Предпросмотр не записывает перенос', await page.evaluate(() => !(window as any).__classStand.events.includes('copy')));
    await dialog.getByRole('button', { name: 'Применить', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => (window as any).__classStand.events.includes('copy'));
    await editor.getByRole('button', { name: /Установка/ }).click();
    check('Перенесённый комплект показан с полями источника', await editor.getByLabel('Тип документа 1').inputValue() === 'C32' && await editor.getByLabel('Стадия 1').inputValue() === 'П' && await editor.getByLabel('Единица 1').inputValue() === 'project' && await editor.getByLabel('Рабочих дней 1').inputValue() === '7');
    check('Ошибок страницы нет', errors.length === 0);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
