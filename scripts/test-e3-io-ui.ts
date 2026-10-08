/**
 * «Таблица IO» и «Состав блока» в Chromium: строки и правила, правка имени
 * изделия E3 в диалоге, состав блока в окне подбора, обе темы, вёрстка без
 * горизонтальной прокрутки и тишина в консоли. Сервер подменён ответами теста.
 *
 * Запуск (нужен Vite): FLUX_UI_URL=http://127.0.0.1:5173 npx tsx scripts/test-e3-io-ui.ts
 * Снимки: SHOTS=1 — в /tmp/e3-io.
 */
import { mkdirSync } from 'node:fs';
import { ioBook } from './fixtures/e3-io-book';

const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOTS = process.env.SHOTS === '1';
let passed = 0; let failed = 0;
const ok = (name: string, value: boolean, detail?: unknown) => { if (value) { passed++; console.log(`✓ ${name}`); } else { failed++; console.error(`✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`); } };

(async () => {
  const { chromium } = await import('playwright-core');
  if (SHOTS) mkdirSync('/tmp/e3-io', { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      let book = ioBook();
      const puts: any[] = [];
      await page.route('**/api/catalog/e3-solutions', (route) => route.fulfill({ json: book }));
      await page.route('**/api/catalog/e3-solutions/io-row', async (route) => {
        const body = route.request().postDataJSON(); puts.push(body);
        book = { ...book, version: book.version + 1, ioTable: book.ioTable.map((r) => (r.id === body.row.id ? { ...r, ...body.row, edited: true } : r)) };
        return route.fulfill({ json: { book, revisionId: 'r' } });
      });
      const t = `[${theme}]`;

      // Раздел «Таблица IO»
      await page.goto(`${BASE}/scripts/fixtures/e3-io-ui.html?theme=${theme}`);
      await page.getByRole('button', { name: /Таблица IO/ }).click();
      await page.getByRole('heading', { name: 'Таблица IO' }).waitFor();
      await page.getByRole('tab', { name: /Строки/ }).waitFor();
      const rows = await page.locator('table.fx-table tbody tr').count();
      ok(`${t} в таблице все строки листа`, rows === book.ioTable.length, rows);
      const heads = await page.locator('table.fx-table thead th').allTextContents();
      ok(`${t} столбцы: группа, наименование, обозначение, DI DO AI AO, изделие E3`, heads.join('|') === 'Группа|Наименование|Обозначение|DI|DO|AI|AO|Изделие E3', heads.join('|'));
      const rowOf = (re: RegExp) => page.locator('table.fx-table tbody tr', { hasText: re });
      const spring = rowOf(/пружинный, с бк/);
      ok(`${t} имя изделия E3 видно в строке`, (await spring.textContent())?.includes('клапан_DIx2_DOx1') === true);
      const geometry = await page.evaluate(() => {
        const tr = [...document.querySelectorAll<HTMLElement>('table.fx-table tbody tr')].map((r) => r.getBoundingClientRect().height);
        const th = document.querySelector<HTMLElement>('table.fx-table thead th')!;
        const body = document.querySelector<HTMLElement>('.fx-page-body')!;
        const head = document.querySelector<HTMLElement>('.fx-head')!;
        const cs = getComputedStyle(document.querySelector<HTMLElement>('table.fx-table tbody td')!);
        const heavy = [...document.querySelectorAll<HTMLElement>('.fx-page *')].filter((e) => Number(getComputedStyle(e).fontWeight) > 600 && e.textContent?.trim()).length;
        return { rowMin: Math.min(...tr), rowMax: Math.max(...tr), thH: th.getBoundingClientRect().height, head: head.getBoundingClientRect().height, hscroll: body.scrollWidth > body.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth, font: parseFloat(cs.fontSize), heavy };
      });
      ok(`${t} строки таблицы 28–40 px, шапка таблицы 28 px, шапка раздела 44 px`, geometry.rowMin >= 28 && geometry.rowMax <= 40 && Math.round(geometry.thH) === 28 && Math.round(geometry.head) === 44, geometry);
      ok(`${t} без горизонтальной прокрутки, текст не мельче 12 px, жирного нет`, !geometry.hscroll && geometry.font >= 12 && geometry.heavy === 0, geometry);
      if (SHOTS) await page.screenshot({ path: `/tmp/e3-io/${theme}-rows.png` });

      ok(`${t} отбора «Без изделия E3» нет: имя изделия — необязательная справка`, (await page.getByRole('button', { name: /Без изделия E3/ }).count()) === 0);

      // Правка справки об изделии
      await spring.click();
      const dlg = page.getByRole('dialog', { name: /Строка таблицы IO/ });
      await dlg.waitFor();
      ok(`${t} диалог строки: наименование и группа не меняются, число сигналов — правится`, await dlg.getByLabel('Наименование').isDisabled() && await dlg.getByLabel('Число сигналов DO').isEnabled());
      await dlg.getByLabel('Изделие E3').fill('клапан_пружинный_DIx2_DOx1');
      if (SHOTS) await page.screenshot({ path: `/tmp/e3-io/${theme}-row-dialog.png` });
      await dlg.getByRole('button', { name: 'Сохранить' }).click();
      await dlg.waitFor({ state: 'detached' });
      ok(`${t} имя изделия ушло на сервер вместе со всей строкой и версией`, puts.length === 1 && puts[0].row.component === 'клапан_пружинный_DIx2_DOx1' && puts[0].expectedVersion === 3 && puts[0].row.do === 1, puts);
      ok(`${t} после записи в таблице новое имя`, (await rowOf(/пружинный, с бк/).textContent())?.includes('клапан_пружинный_DIx2_DOx1') === true);

      // Правила состава
      await page.getByRole('tab', { name: /Правила состава/ }).click();
      const ruleRows = await page.locator('table.fx-table tbody tr').count();
      ok(`${t} правила состава показаны`, ruleRows === book.ioRules.length, ruleRows);
      const rulesHeads = await page.locator('table.fx-table thead th').allTextContents();
      ok(`${t} столбцы правил`, rulesHeads.join('|') === 'Класс|Правило|Условие|Роль|Строка таблицы IO|Сколько', rulesHeads.join('|'));
      if (SHOTS) await page.screenshot({ path: `/tmp/e3-io/${theme}-rules.png` });
      await rowOf(/Клапан с пружинным приводом/).click();
      const rd = page.getByRole('dialog', { name: /Правило состава/ });
      await rd.waitFor();
      ok(`${t} диалог правила: условие, строка IO и число приводов из признака`, (await rd.getByLabel('Условия').inputValue()).includes('valve.drive = К') && (await rd.getByLabel('Часть наименования').inputValue()) === 'пружинный, с бк');
      if (SHOTS) await page.screenshot({ path: `/tmp/e3-io/${theme}-rule-dialog.png` });
      await rd.getByRole('button', { name: 'Отмена' }).click();
      ok(`${t} раздел жив без ошибок в консоли`, errors.length === 0, errors);

      // Состав блока в окне подбора
      await page.goto(`${BASE}/scripts/fixtures/e3-io-ui.html?theme=${theme}&view=dialog`);
      const sel = page.getByRole('dialog', { name: /Подбор решения/ });
      await sel.waitFor();
      const section = sel.getByRole('region', { name: 'Состав блока' });
      await section.waitFor();
      const composition = await section.locator('tbody tr').allTextContents();
      ok(`${t} состав блока: два привода и статус обогрева, затем итог`, composition.length === 4 && composition[0].includes('ПРИВОД 1') && composition[1].includes('ПРИВОД 2') && composition[2].includes('Обогрев клапана'), composition);
      const totals = (await section.locator('tbody tr').last().locator('td').allTextContents()).join('|');
      ok(`${t} итог: DI 6 · DO 2 · AI 0 · AO 0`, totals === 'Итого|6|2|0|0', totals);
      ok(`${t} сверху «Блок E3: <название схемы>», серого «имя не задано» нет`, ((await sel.textContent()) || '').includes('Блок E3:') && !((await sel.textContent()) || '').includes('имя не задано'));
      ok(`${t} замечаний об имени изделия в составе нет`, !((await section.textContent()) || '').includes('имя изделия'));
      const dim = await page.evaluate(() => { const d = document.querySelector<HTMLElement>('[role=dialog] .fx-dialog')!.getBoundingClientRect(); return { right: d.right, w: window.innerWidth, hs: document.documentElement.scrollWidth > window.innerWidth }; });
      ok(`${t} окно подбора помещается по ширине`, dim.right <= dim.w && !dim.hs, dim);
      if (SHOTS) await page.screenshot({ path: `/tmp/e3-io/${theme}-composition.png` });
      ok(`${t} окно подбора без ошибок в консоли`, errors.length === 0, errors);
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(`\nПройдено ${passed}, провалено ${failed}`);
  if (failed) process.exit(1);
})().catch((e) => { console.error('✗', e?.message || e); process.exit(1); });
