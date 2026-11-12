/**
 * Редакторы подпрограммы в браузере: стенд studio/renderer/editors/harness, обе темы.
 *
 * Страница собирается настоящей сборкой (esbuild, как окно Studio) и открывается с теми же
 * ограничениями CSP. Ожидания привязаны к состоянию (видимый текст, число строк, черновик в
 * window.__files — файлы проекта, как их хранит оболочка), а не к таймерам. Снимки (PNG) — в каталог FLUX_STUDIO_SHOTS, артефактом CI;
 * в git они не кладутся.
 *
 * Проверяется условие критерия плана: правка в визуальном редакторе видна в тексте и наоборот;
 * неверный текст не затирает форму; перетаскивание и клавиши; привязки, условия показа, ввод;
 * предпросмотр в обеих темах и в узком окне; подсказки кода; замеры меры/шрифта/контраста.
 *
 * Запуск: FLUX_CHROME=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npx tsx scripts/test-studio-editor-ui.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import esbuild from 'esbuild';

let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const shots = process.env.FLUX_STUDIO_SHOTS || path.join(os.tmpdir(), 'flux-studio-shots');
const root = path.resolve(__dirname, '..');

async function build(outDir: string) {
  fs.mkdirSync(outDir, { recursive: true });
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'studio/renderer/editors/harness/main.tsx')], outfile: path.join(outDir, 'harness.js'), bundle: true,
    platform: 'browser', format: 'iife', jsx: 'automatic', legalComments: 'none', minify: true, logLevel: 'silent', metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  fs.copyFileSync(path.join(root, 'studio/renderer/editors/harness/index.html'), path.join(outDir, 'index.html'));
  fs.copyFileSync(path.join(root, 'studio/renderer/styles.css'), path.join(outDir, 'styles.css'));
  await require('../studio/build-renderer.cjs').buildFluxCss(outDir);
  return { bytes: Object.values(result.metafile.outputs)[0].bytes };
}

const luminance = (rgb: number[]) => { const [r, g, b] = rgb.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

/** Цвет в любом синтаксисе браузера → rgb (через холст): oklch предпросмотра иначе не разобрать */
async function rgbOf(page: Page, css: string): Promise<number[]> {
  return page.evaluate((value) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#000'; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }, css);
}

/** Меры методологии по вычисленным стилям: кегль не мельче 12, вес 400/500/600, высоты строк и полей */
async function measure(page: Page, label: string) {
  const info = await page.evaluate(() => {
    const visible = [...document.querySelectorAll<HTMLElement>('.ed *')].filter(el => el.offsetParent !== null || el.tagName === 'BODY');
    const withText = visible.filter(el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent!.trim()));
    const size = (el: HTMLElement) => parseFloat(getComputedStyle(el).fontSize);
    const rows = [...document.querySelectorAll<HTMLElement>('.ed-row')].filter(el => el.offsetParent).map(el => el.getBoundingClientRect().height);
    const inputs = [...document.querySelectorAll<HTMLElement>('.ed-props .ed-input')].filter(el => el.offsetParent).map(el => el.getBoundingClientRect().height);
    const buttons = [...document.querySelectorAll<HTMLElement>('.ed-btn:not(.ed-pal-main)')].filter(el => el.offsetParent).map(el => el.getBoundingClientRect().height);
    const cm = document.querySelector('.cm-content');
    return {
      tooSmall: withText.filter(el => size(el) < 12).map(el => `${el.tagName}.${el.className}:${size(el)}`),
      weights: [...new Set(withText.map(el => getComputedStyle(el).fontWeight))],
      upper: withText.filter(el => getComputedStyle(el).textTransform === 'uppercase').length,
      rows, inputs, buttons, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      unlabeled: [...document.querySelectorAll<HTMLInputElement>('.ed input:not([type=checkbox]), .ed select')].filter(i => i.offsetParent && !i.labels?.length && !i.getAttribute('aria-label')).length,
      bg: getComputedStyle(document.body).backgroundColor, fg: getComputedStyle(document.body).color, hasCm: !!cm,
    };
  });
  ok(`${label}: кегль не мельче 12 px (${info.tooSmall.join(', ') || 'везде'})`, info.tooSmall.length === 0);
  ok(`${label}: веса только 400/500/600 (${info.weights.join(',')})`, info.weights.every(w => ['400', '500', '600'].includes(w)));
  ok(`${label}: заглавных нет`, info.upper === 0);
  ok(`${label}: строки структуры по 32 px`, info.rows.every(h => Math.abs(h - 32) < 1.5));
  ok(`${label}: поля свойств по 32 px`, info.inputs.every(h => Math.abs(h - 32) < 1.5));
  ok(`${label}: кнопки по 28 px`, info.buttons.every(h => Math.abs(h - 28) < 1.5 || Math.abs(h - 32) < 1.5));
  ok(`${label}: нет горизонтальной прокрутки страницы`, info.overflowX <= 0);
  ok(`${label}: у полей есть подписи`, info.unlabeled === 0);
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-editors-'));
  fs.mkdirSync(shots, { recursive: true });
  const { bytes } = await build(temp);
  console.log(`Сборка стенда: ${(bytes / 1024).toFixed(0)} КБ (минифицировано, без CDN)`);
  const browser = await chromium.launch({ ...(process.env.FLUX_CHROME ? { executablePath: process.env.FLUX_CHROME } : {}), args: ['--no-sandbox'] });
  try {
    for (const theme of ['light', 'dark'] as const) {
      console.log(`Тема Studio: ${theme}`);
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
      // tsx добавляет в функции вспомогательный __name; в странице его нет
      await page.addInitScript('globalThis.__name = (fn) => fn;');
      if (process.env.DEBUG_CSP) await page.addInitScript("const o = Element.prototype.setAttribute; Element.prototype.setAttribute = function (n, v) { if (n === 'style') console.error('STYLEATTR ' + this.tagName + ' ' + this.className + ' ' + v + ' ' + new Error().stack.split('\\n').slice(2, 5).join('|')); return o.call(this, n, v); }; const d = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText'); Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', { set(v) { console.error('CSSTEXT ' + v + ' ' + new Error().stack.split('\\n').slice(2, 5).join('|')); d.set.call(this, v); }, get() { return d.get.call(this); } });");
      const errors: string[] = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') { errors.push(m.text().slice(0, 200)); if (process.env.DEBUG_CSP) console.log('CSP?', m.text().slice(0, 120), m.location().url.slice(-60), m.location().lineNumber); } });
      await page.goto(`file://${path.join(temp, 'index.html')}?theme=${theme}`);
      await page.getByRole('tab', { name: 'Форма' }).waitFor();
      const draft = () => page.evaluate(() => ({ form: JSON.parse((window as any).__files['form.json']), contract: JSON.parse((window as any).__files['contract.json']), manifest: JSON.parse((window as any).__files['manifest.json']) }));
      const rows = page.locator('.ed-row');
      const shot = (name: string) => page.screenshot({ path: path.join(shots, `studio-editors-${theme}-${name}.png`) });
      const cmText = (testId: string) => page.locator(`[data-testid=${testId}] .cm-content`).innerText();
      const setCm = async (testId: string, text: string) => {
        await page.locator(`[data-testid=${testId}] .cm-content`).click();
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.insertText(text);
      };

      // --- Палитра и методология
      ok(`${theme}: в палитре пять компонентов`, (await page.locator('.ed-pal').count()) === 5);
      await page.locator('.ed-pal[data-kind=field] summary').click();
      const guidance = await page.locator('.ed-pal[data-kind=field] details').innerText();
      ok(`${theme}: «когда применять» поля — текст методологии`, guidance.includes('Placeholder — пример значения') && guidance.includes('fx-input'));
      await page.locator('.ed-pal[data-kind=table] summary').click();
      ok(`${theme}: «когда применять» таблицы — из методологии`, (await page.locator('.ed-pal[data-kind=table] details').innerText()).includes('по правому краю'));
      await measure(page, `${theme}/форма`);
      await shot('1-form');

      // --- Визуальная правка видна в тексте
      const before = await rows.count();
      await rows.filter({ hasText: 'Наименование' }).first().click();
      await page.getByRole('button', { name: 'Добавить: Поле', exact: true }).click();
      await page.waitForFunction(n => document.querySelectorAll('.ed-row').length === n + 1, before);
      ok(`${theme}: новое поле появилось в структуре`, (await rows.count()) === before + 1);
      ok(`${theme}: новое поле встало после выбранного`, (await draft()).form.groups[0].fields[2].label === 'Новое поле');
      await page.getByLabel('Подпись', { exact: true }).fill('Давление');
      await page.getByLabel('Источник', { exact: true }).selectOption('calc.out.pressure');
      await page.getByLabel('Единица', { exact: true }).fill('Па');
      await page.getByRole('tab', { name: 'form.json' }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid=form-json]')?.shadowRoot?.querySelector('.cm-content')?.textContent?.includes('Давление'));
      const text1 = await cmText('form-json');
      ok(`${theme}: правка в визуальном видна в тексте (подпись, привязка, единица)`, text1.includes('"label": "Давление"') && text1.includes('"bind": "calc.out.pressure"') && text1.includes('"unit": "Па"'));
      ok(`${theme}: текст верен`, (await page.getByTestId('text-status').innerText()).includes('Форма верна'));
      await measure(page, `${theme}/текст`);
      await shot('2-text');

      // --- Правка текста видна в визуальном; ошибка не затирает форму
      // Одной строкой: подряд идущие пробелы браузер при вставке в contenteditable превращает в неразрывные
      const edited = JSON.stringify({ ...(await draft()).form, groups: (await draft()).form.groups.map((g: any, i: number) => i === 0 ? { ...g, title: 'Позиция (из текста)' } : g) });
      await setCm('form-json', edited);
      await page.waitForFunction(() => JSON.parse((window as any).__files['form.json']).groups[0].title === 'Позиция (из текста)').catch(async error => { throw new Error(`${error.message}\n${await page.getByTestId('text-status').innerText()}\n${await page.getByTestId('text-problems').innerText().catch(() => '')}`); });
      await page.getByRole('tab', { name: 'Форма' }).click();
      ok(`${theme}: правка текста видна в структуре`, (await rows.first().innerText()).includes('Позиция (из текста)'));
      await page.getByRole('tab', { name: 'form.json' }).click();
      const broken = edited.replace('"title":"Расчёт",', '"title":"Расчёт"\n');
      await setCm('form-json', broken);
      await page.waitForFunction(() => /Текст не принят/.test(document.querySelector('[data-testid=text-status]')?.textContent ?? ''));
      const problem = await page.getByTestId('text-problems').innerText();
      ok(`${theme}: ошибка с номером строки и словами (${problem.split('\n')[0]})`, /Строка \d+/.test(problem) && /Ожидалось/.test(problem));
      ok(`${theme}: подсветка ошибки в редакторе`, (await page.locator('.cm-lintRange-error, .cm-lint-marker-error').count()) > 0);
      ok(`${theme}: черновик остался верным`, (await draft()).form.groups[0].title === 'Позиция (из текста)' && (await draft()).form.groups.length === 2);
      await page.getByRole('tab', { name: /form\.json/ }).locator('.ed-badge').waitFor();
      await shot('3-text-error');
      await page.getByRole('tab', { name: /Форма/ }).click();
      ok(`${theme}: визуальный редактор показывает последнюю верную форму`, (await rows.count()) === before + 1 && (await page.getByTestId('preview').innerText()).includes('Давление'));
      ok(`${theme}: предпросмотр предупреждает об ошибке в тексте`, (await page.getByText('В тексте ошибка').count()) === 1);
      await page.getByRole('tab', { name: /form\.json/ }).click();
      await setCm('form-json', edited);
      await page.waitForFunction(() => /Форма верна/.test(document.querySelector('[data-testid=text-status]')?.textContent ?? ''));
      ok(`${theme}: после исправления текст снова принят`, true);

      // --- Клавиши
      await page.getByRole('tab', { name: 'Форма' }).click();
      await rows.filter({ hasText: 'Проект' }).first().focus();
      await page.keyboard.press('Alt+ArrowDown');
      await page.waitForFunction(() => JSON.parse((window as any).__files['form.json']).groups[0].fields[1].label === 'Проект');
      ok(`${theme}: Alt+стрелка переставляет поле`, (await draft()).form.groups[0].fields[0].label === 'Наименование');
      ok(`${theme}: фокус остался на перемещённой строке`, await page.evaluate(() => document.activeElement?.textContent?.includes('Проект') ?? false));
      await page.keyboard.press('ArrowDown');
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-selected') === 'true' && !!document.activeElement?.textContent?.includes('Давление')).catch(async error => { throw new Error(`${error.message}: в фокусе ${await page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.getAttribute('aria-selected')} ${document.activeElement?.textContent}`)}`); });
      ok(`${theme}: стрелка переводит выбор на следующую строку`, true);
      await page.keyboard.press('Alt+ArrowUp');
      await page.waitForFunction(() => JSON.parse((window as any).__files['form.json']).groups[0].fields[1].label === 'Давление');
      ok(`${theme}: Alt+стрелка вверх`, true);
      await page.keyboard.press('Alt+ArrowDown');
      await page.waitForFunction(() => JSON.parse((window as any).__files['form.json']).groups[0].fields[2].label === 'Давление');

      // --- Перетаскивание
      const counts = (await draft()).form.tables.length;
      await page.locator('.ed-pal[data-kind=table] .ed-pal-main').dragTo(page.locator('.ed-row[data-key=t0]'), { targetPosition: { x: 40, y: 4 } });
      await page.waitForFunction(n => JSON.parse((window as any).__files['form.json']).tables.length === n + 1, counts);
      ok(`${theme}: таблица из палитры брошена на строку — встала перед ней`, (await draft()).form.tables[0].title === 'Новая таблица');
      await page.locator('.ed-row[data-key=g0f0]').dragTo(page.locator('.ed-row[data-key=g1]'));
      await page.waitForFunction(() => JSON.parse((window as any).__files['form.json']).groups[1].fields.length === 5);
      ok(`${theme}: поле перетащено в другую группу`, (await draft()).form.groups[1].fields[4].label === 'Наименование');
      await page.locator('.ed-row[data-key=t0]').click();
      await page.keyboard.press('Delete');
      await page.waitForFunction(n => JSON.parse((window as any).__files['form.json']).tables.length === n, counts);
      ok(`${theme}: Delete убирает выбранное`, (await draft()).form.tables[0].title === 'Параметры');

      // --- Привязка, ввод, условия показа, предпросмотр
      await page.locator('.ed-row', { hasText: 'Расход воздуха' }).click();
      ok(`${theme}: поле с условием видно в предпросмотре`, (await page.getByTestId('preview').innerText()).includes('Расход воздуха'));
      ok(`${theme}: единица дописана к значению`, (await page.getByTestId('preview').innerText()).includes('1200 м³/ч'));
      await page.getByLabel('Показывать').selectOption('empty');
      await page.waitForFunction(() => !document.querySelector('[data-testid=preview]')?.textContent?.includes('Расход воздуха'));
      ok(`${theme}: условие «когда пусто» скрыло поле в предпросмотре`, true);
      await page.getByLabel('Показывать').selectOption('filled');
      await page.getByLabel('Источник', { exact: true }).selectOption('');
      await page.locator('.ed-item-findings, [data-testid=item-findings]').waitFor();
      ok(`${theme}: пустой источник значения назван в замечаниях`, (await page.getByTestId('item-findings').innerText()).includes('Источник значения не выбран'));
      ok(`${theme}: у строки красная точка`, (await page.locator('.ed-row[aria-selected=true] .ed-dot').count()) === 1);
      await page.getByLabel('Источник', { exact: true }).selectOption('state.airflow');

      // Предпросмотр: обе темы и узкое окно
      const pv = page.getByTestId('preview');
      const lightBg = await rgbOf(page, await pv.evaluate(el => getComputedStyle(el).backgroundColor));
      await page.getByRole('button', { name: 'Тёмная' }).click();
      const darkBg = await rgbOf(page, await pv.evaluate(el => getComputedStyle(el).backgroundColor));
      ok(`${theme}: тёмный предпросмотр темнее светлого`, luminance(darkBg) < 0.1 && luminance(lightBg) > 0.8);
      for (const name of ['Светлая', 'Тёмная']) {
        await page.getByRole('button', { name }).click();
        const c = await pv.evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el.querySelector('.fx-group-title')!).color, muted: getComputedStyle(el.querySelector('.fx-label')!).color }));
        const bg = await rgbOf(page, c.bg);
        ok(`${theme}/предпросмотр ${name}: основной текст ≥ 4.5:1`, contrast(await rgbOf(page, c.fg), bg) >= 4.5);
        ok(`${theme}/предпросмотр ${name}: второстепенный текст ≥ 4.5:1`, contrast(await rgbOf(page, c.muted), bg) >= 4.5);
        await shot(`4-preview-${name === 'Светлая' ? 'light' : 'dark'}`);
      }
      await page.getByRole('button', { name: 'Узкое' }).click();
      const narrow = await pv.evaluate(el => ({ width: el.getBoundingClientRect().width, overflow: el.scrollWidth - el.clientWidth }));
      ok(`${theme}: узкое окно 360 px без горизонтальной прокрутки (${narrow.width}×${narrow.overflow})`, Math.round(narrow.width) <= 360 && narrow.overflow <= 0);
      await shot('5-form-narrow-dark');
      await page.getByRole('button', { name: 'Обычное' }).click();
      await page.getByRole('button', { name: 'Светлая' }).click();

      // --- Правила и методология
      await page.locator('.ed-row', { hasText: 'Режим' }).click();
      await page.getByLabel('Подпись', { exact: true }).fill('Мгновенный режим *');
      await page.getByRole('tab', { name: /Правила/ }).click();
      const rules = await page.getByTestId('rules-findings').innerText();
      ok(`${theme}: рекламное слово найдено проверкой оформления`, rules.includes('Рекламное слово «мгновенный»'));
      ok(`${theme}: звёздочка найдена и указан раздел методологии`, rules.includes('Звёздочка') && rules.includes('01-design.md'));
      await measure(page, `${theme}/правила`);
      await shot('6-rules');
      await page.getByRole('tab', { name: 'Форма' }).click();
      await page.locator('.ed-row', { hasText: 'Мгновенный' }).click();
      await page.getByLabel('Подпись', { exact: true }).fill('Режим');

      // --- Данные
      await page.getByRole('tab', { name: 'Данные' }).click();
      await page.getByLabel('Оборудование').uncheck();
      await page.getByRole('tab', { name: 'Форма' }).click();
      ok(`${theme}: описание данных без «Оборудования» помечает источники значений красной точкой`, (await page.locator('.ed-dot').count()) >= 3);
      await page.getByRole('tab', { name: 'form.json' }).click();
      ok(`${theme}: и в тексте источники значений названы`, (await page.getByTestId('text-problems').innerText()).includes('не разрешены'));
      await page.getByRole('tab', { name: 'Данные' }).click();
      await shot('7-contract');
      await page.getByRole('button', { name: 'Добавить значение' }).first().click();
      await page.getByLabel('Своё состояние (state): имя 4').fill('extra');
      ok(`${theme}: новое значение попало в описание данных`, (await draft()).contract.state.some((v: any) => v.name === 'extra'));
      await page.getByLabel('Оборудование').check();
      await measure(page, `${theme}/данные`);


      // --- Устойчивость: отмена, блокировка при ошибке в тексте, история и курсор, вкладки, ошибка сохранения
      await page.getByRole('tab', { name: 'Форма' }).click();
      await page.getByRole('button', { name: 'Свойства формы' }).click();
      const rowsBefore = await rows.count();
      await page.getByRole('button', { name: 'Добавить: Группа', exact: true }).click();
      await page.waitForFunction(n => document.querySelectorAll('.ed-row').length === n + 1, rowsBefore);
      await page.getByRole('button', { name: 'Отменить' }).click();
      await page.waitForFunction(n => document.querySelectorAll('.ed-row').length === n, rowsBefore);
      ok(`${theme}: «Отменить» возвращает форму, и текст в файле тоже`, JSON.parse((await page.evaluate(() => (window as any).__files['form.json']))).groups.length === 2);
      await page.getByRole('button', { name: 'Повторить' }).click();
      await page.waitForFunction(n => document.querySelectorAll('.ed-row').length === n + 1, rowsBefore);
      await page.locator('.ed-row[aria-selected=true]').focus();
      await page.keyboard.press('ControlOrMeta+z');
      await page.waitForFunction(n => document.querySelectorAll('.ed-row').length === n, rowsBefore);
      ok(`${theme}: Ctrl+Z на форме отменяет, Ctrl+Shift+Z повторяет`, true);
      await page.locator('.ed-row').first().focus();
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await page.waitForFunction(n => document.querySelectorAll('.ed-row').length === n + 1, rowsBefore);
      await page.keyboard.press('ControlOrMeta+z');
      await page.waitForFunction(n => document.querySelectorAll('.ed-row').length === n, rowsBefore);

      // Ошибка в тексте блокирует правку формы и не даёт стереть набранное
      await page.getByRole('tab', { name: 'form.json' }).click();
      const goodText = await page.evaluate(() => (window as any).__files['form.json']);
      const badText = goodText.replace('"version": 1,', '"version": 1').replace('"version": 1\n', '"version": 1 "x"\n');
      await setCm('form-json', badText);
      await page.waitForFunction(() => /Текст не принят/.test(document.querySelector('[data-testid=text-status]')?.textContent ?? ''));
      await page.getByRole('tab', { name: /Форма/ }).click();
      await page.getByTestId('form-locked').waitFor();
      ok(`${theme}: при ошибке в тексте форма только для чтения, причина названа`, /только просмотр/.test(await page.getByTestId('form-locked').innerText()));
      ok(`${theme}: палитра, структура и свойства недоступны (inert)`, await page.evaluate(() => [...document.querySelectorAll('[data-testid=form-editor] [inert]')].length >= 3));
      const filesBeforeLockedClick = await page.evaluate(() => (window as any).__files['form.json']);
      await page.locator('.ed-pal-main').first().click({ force: true }).catch(() => {});
      ok(`${theme}: клик по палитре при ошибке ничего не меняет`, (await page.evaluate(() => (window as any).__files['form.json'])) === filesBeforeLockedClick);
      await page.getByRole('button', { name: 'Исправить в тексте' }).click();
      ok(`${theme}: текст с ошибкой на месте, не стёрт`, (await cmText('form-json')).includes('"version": 1 "x"'));
      await setCm('form-json', goodText);
      await page.waitForFunction(() => /Форма верна/.test(document.querySelector('[data-testid=text-status]')?.textContent ?? ''));
      await page.getByRole('tab', { name: /Форма/ }).click();
      ok(`${theme}: после исправления форма снова правится`, (await page.getByTestId('form-locked').count()) === 0);

      // История текста и курсор переживают смену вкладки; визуальная правка не уводит курсор
      await page.getByRole('tab', { name: 'form.json' }).click();
      await page.locator('[data-testid=form-json] .cm-content').click();
      await page.keyboard.press('ControlOrMeta+Home');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('End');
      const lineOfCursor = () => page.evaluate(() => document.querySelector('[data-testid=form-json]')?.shadowRoot?.querySelector('.cm-activeLine')?.textContent ?? '');
      const before3 = await lineOfCursor();
      await page.getByRole('tab', { name: 'Форма' }).click();
      await page.getByRole('button', { name: 'Добавить: Таблица', exact: true }).click();
      await page.waitForFunction(() => JSON.parse((window as any).__files['form.json']).tables.length === 2);
      await page.getByRole('tab', { name: 'form.json' }).click();
      ok(`${theme}: курсор остался на своей строке после визуальной правки («${before3.trim()}»)`, (await lineOfCursor()) === before3 && before3.includes('"groups"'));
      await page.getByRole('tab', { name: 'Форма' }).click();
      await page.getByRole('button', { name: 'Отменить' }).click();
      await page.waitForFunction(() => JSON.parse((window as any).__files['form.json']).tables.length === 1);

      await page.getByRole('tab', { name: 'Код' }).click();
      const codeView = page.locator('[data-testid="code-view-logic/main.ts"] .cm-content');
      await codeView.click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type('\n// история');
      await page.getByRole('tab', { name: 'Форма' }).click();
      await page.getByRole('tab', { name: 'Код' }).click();
      await codeView.click();
      await page.keyboard.press('ControlOrMeta+z');
      ok(`${theme}: отмена в коде работает после смены вкладки`, !(await codeView.innerText()).includes('// история'));
      ok(`${theme}: изменённый код ушёл в файл проекта`, await page.evaluate(() => (window as any).__files['logic/main.ts'].includes('setup')));

      // Стрелки переключают вкладки
      await page.getByRole('tab', { name: 'Форма' }).click();
      await page.getByRole('tab', { name: 'Форма' }).focus();
      await page.keyboard.press('ArrowRight');
      await page.getByRole('tab', { name: 'form.json', selected: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'ed-tab-text');
      ok(`${theme}: стрелка вправо открывает следующую вкладку, фокус на ней`, true);
      await page.keyboard.press('End');
      await page.getByRole('tab', { name: 'Правила', selected: true }).waitFor();
      await page.keyboard.press('Home');
      await page.getByRole('tab', { name: 'Форма', selected: true }).waitFor();
      ok(`${theme}: Home и End работают`, true);

      // Ошибка сохранения видна
      await page.evaluate(() => { (window as any).__failSave = 'диск переполнен'; });
      await page.locator('.ed-row', { hasText: 'Режим' }).click();
      await page.getByLabel('Подпись', { exact: true }).fill('Режим работы');
      await page.getByTestId('save-error').waitFor();
      ok(`${theme}: ошибка сохранения показана текстом`, (await page.getByTestId('save-error').innerText()).includes('диск переполнен'));
      await page.evaluate(() => { (window as any).__failSave = ''; });
      await page.getByLabel('Подпись', { exact: true }).fill('Режим');
      await page.waitForFunction(() => !document.querySelector('[data-testid=save-error]'));
      ok(`${theme}: после успешного сохранения сообщение пропало`, true);

      // --- Код
      await page.getByRole('tab', { name: 'Код' }).click();
      await page.locator('[data-testid="code-view-logic/main.ts"] .cm-content').waitFor();
      ok(`${theme}: подсветка кода есть`, (await page.locator('[data-testid="code-view-logic/main.ts"] .cm-tok-keyword').count()) > 0);
      ok(`${theme}: образцовый код совпадает с описанием данных`, (await page.getByTestId('code-status').innerText()).includes('совпадают'));
      await page.locator('[data-testid="code-view-logic/main.ts"] .cm-content').click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type("\nconst x = await flux.read('");
      await page.locator('.cm-tooltip-autocomplete li').first().waitFor();
      const options = await page.locator('.cm-tooltip-autocomplete li').allInnerTexts();
      ok(`${theme}: подсказка предлагает только разрешённые данные (${options.map(o => o.split('\n')[0]).join(', ')})`, options.some(o => o.startsWith('equipment')) && !options.some(o => o.startsWith('catalog')));
      await page.keyboard.press('Escape');
      await page.keyboard.type("catalog');");
      await page.getByTestId('code-problems').waitFor();
      ok(`${theme}: чтение неразрешённых данных помечено строкой`, /Строка \d+/.test(await page.getByTestId('code-problems').innerText()) && (await page.getByTestId('code-problems').innerText()).includes('catalog'));
      await shot('8-code');
      await page.getByRole('tab', { name: 'contract.d.ts' }).click();
      await page.locator('[data-testid=types-view] .cm-content').waitFor();
      const dts = await cmText('types-view');
      ok(`${theme}: типы из описания данных показаны`, dts.includes('interface FluxData') && dts.includes('equipType: string'));
      await page.getByRole('tab', { name: 'logic/main.ts' }).click();
      await page.getByLabel('Язык файла').selectOption('python');
      await page.waitForFunction(() => /JSON/.test(document.querySelector('.ed-code-side')?.textContent ?? ''));
      ok(`${theme}: для Python — справка по данным`, (await page.getByTestId('contract-reference').innerText()).includes('compute(input)'));
      await measure(page, `${theme}/код`);
      // CodeMirror пытается поставить style="" (tab-size, скрытая распорка номеров); CSP окна это отклоняет,
      // а те же правила лежат в styles.ts — проверяем, что они действуют, и отделяем это от настоящих ошибок
      await page.getByRole('tab', { name: 'logic/main.ts' }).click();
      const cm = await page.evaluate(() => {
        const content = document.querySelector('[data-testid="code-view-logic/main.ts"]')?.shadowRoot?.querySelector('.cm-content');
        const spacer = document.querySelector('[data-testid="code-view-logic/main.ts"]')?.shadowRoot?.querySelector('.cm-gutter > .cm-gutterElement:first-child');
        return { tab: content ? getComputedStyle(content).tabSize : '', spacer: spacer ? getComputedStyle(spacer).visibility : 'none' };
      });
      ok(`${theme}: запасные правила CodeMirror действуют при CSP без inline-стилей (tab-size ${cm.tab}, распорка ${cm.spacer})`, cm.tab === '4' && cm.spacer === 'hidden');
      const real = errors.filter(error => !error.startsWith('Applying inline style violates'));
      ok(`${theme}: ошибок страницы нет (${real.join('; ') || 'нет'}; отклонённых CSP inline-стилей CodeMirror: ${errors.length - real.length})`, real.length === 0);
      await page.close();
    }
    console.log(`\nРедакторы Studio: ${passed} проверок пройдено, снимки: ${shots}`);
  } finally { await browser.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exit(1); });
