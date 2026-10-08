/**
 * Раздел «Нет данных» в Chromium: вкладка со счётчиком, группы, список «что ·
 * где · почему», отбор и поиск, переход по ссылке на запись (справочник,
 * каталог, подбор, атрибуты проекта), пересчёт после правки без перезагрузки,
 * обе темы, замеры вёрстки и тишина в консоли. Сервер подменён ответами теста.
 *
 * Запуск (нужен Vite): FLUX_UI_URL=http://127.0.0.1:5187 npx tsx scripts/test-e3-gaps-ui.ts
 * Снимки: SHOTS=1 — в /tmp/e3-gaps/shots.
 */
import { mkdirSync } from 'node:fs';
import type { E3Attribute } from '../e3/attributes';
import { ioBook } from './fixtures/e3-io-book';

const BASE = process.env.FLUX_UI_URL || 'http://127.0.0.1:5173';
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOTS = process.env.SHOTS === '1';
let passed = 0; let failed = 0;
const ok = (name: string, value: boolean, detail?: unknown) => { if (value) { passed++; console.log(`✓ ${name}`); } else { failed++; console.error(`✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`); } };

const attr = (name: string, o: Partial<E3Attribute>): E3Attribute => ({
  name, title: `${name} (описание)`, carrier: 'Изделие', attrClass: 'Двигатели', service: false, fromFlux: true, script: '', comment: '', source: { kind: 'none' }, classes: [], conflict: 'flux', ...o,
});
const component = (id: string, name: string, equipType: string, tag: string, more: Record<string, unknown> = {}) => ({ id, itemCode: id, name, equipType, tags: [{ identifier: tag }], ...more });
const systems = [{
  id: 's1', name: 'П-1', category: 'c', monoblocks: [{ name: 'МБ-1', components: [
    component('c1', 'Клапан воздушный', 'Клапан', 'K-1'), component('c3', 'Вентилятор канальный', 'Вентилятор', 'F-1'),
    component('c2', 'Двигатель вентилятора', 'Двигатель', 'M-1', { role: 'ДВИГАТЕЛЬ', parentElementId: 'c3' }),
  ] }],
}];

(async () => {
  const { chromium } = await import('playwright-core');
  if (SHOTS) mkdirSync('/tmp/e3-gaps/shots', { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      const attrs = { version: 1, updatedAt: '', items: [attr('MOTOR_POWER', {}), attr('MOTOR_VOLT', { source: { kind: 'param', name: 'Напряжение питания' } })] };
      let book = ioBook();
      // Решение без названия схемы: оно же имя блока в E3, вставлять нечего
      book = { ...book, solutions: [...book.solutions, { ...book.solutions[0], id: '99.99.99', mainClass: 'Воздуховод', name: '', features: {} }] };
      let solutionReads = 0;
      await page.route('**/api/catalog/workspace', (r) => r.fulfill({ json: { rights: { edit: true, import: true } } }));
      await page.route('**/api/catalog/e3-attributes', (r) => r.fulfill({ json: attrs }));
      await page.route('**/api/catalog/e3-solutions', (r) => { solutionReads++; return r.fulfill({ json: book }); });
      await page.route('**/api/catalog/e3-solutions/io-row', (r) => {
        const body = r.request().postDataJSON();
        book = { ...book, version: book.version + 1, ioTable: book.ioTable.map((x) => (x.id === body.row.id ? { ...x, ...body.row } : x)) };
        return r.fulfill({ json: { book, revisionId: 'r' } });
      });
      await page.route('**/api/catalog/e3-solutions/solution', (r) => {
        const body = r.request().postDataJSON();
        book = { ...book, version: book.version + 1, solutions: book.solutions.map((x) => (x.id === body.id ? { ...x, ...body.patch } : x)) };
        return r.fulfill({ json: { book, revisionId: 'r' } });
      });
      await page.route('**/api/projects/p1/systems', (r) => r.fulfill({ json: { systems } }));
      await page.route('**/api/projects/p1/e3-profile', (r) => r.fulfill({ json: { version: 1, answers: {}, updatedAt: '' } }));
      const t = `[${theme}]`;

      await page.goto(`${BASE}/scripts/fixtures/e3-gaps-ui.html?theme=${theme}`);
      const gapsTab = page.getByRole('tab', { name: /Нет данных/ });
      await gapsTab.waitFor();
      await page.waitForFunction(() => /Нет данных\s*\d+/.test(document.querySelector('[role=tab][aria-selected=false]:last-child')?.textContent || ''));
      const label = (await gapsTab.textContent()) || '';
      const total = Number(label.replace(/\D/g, ''));
      ok(`${t} вкладка «Нет данных» со счётчиком в названии`, total > 0, label);
      await gapsTab.click();

      // Группы и счётчики
      const nav = page.getByRole('navigation', { name: 'Группы пробелов' });
      const navText = (await nav.textContent()) || '';
      ok(`${t} группы: все, атрибуты, каталог, проект`, ['Все', 'Атрибуты', 'Каталог', 'Проект'].every((w) => navText.includes(w)), navText);
      const groupCount = async (name: string) => Number(((await nav.getByRole('button', { name: new RegExp(`^${name}`) }).textContent()) || '').replace(/\D/g, '') || 0);
      const [cAll, cAttr, cCat, cProj] = [await groupCount('Все'), await groupCount('Атрибуты'), await groupCount('Каталог'), await groupCount('Проект')];
      ok(`${t} счётчики групп сходятся: все = атрибуты + каталог + проект`, cAll === cAttr + cCat + cProj && cAttr >= 1 && cCat >= 1 && cProj >= 1, [cAll, cAttr, cCat, cProj]);
      const heads = await page.locator('table.fx-table thead th').allTextContents();
      ok(`${t} столбцы: состояние, что, где, почему, ссылка`, heads.join('|').startsWith('Состояние|Что|Где|Почему'), heads);

      const geometry = await page.evaluate(() => {
        const tr = [...document.querySelectorAll<HTMLElement>('table.fx-table tbody tr')].map((r) => r.getBoundingClientRect().height);
        const th = document.querySelector<HTMLElement>('table.fx-table thead th')!;
        const side = document.querySelector<HTMLElement>('nav[aria-label="Группы пробелов"]')!;
        const li = document.querySelector<HTMLElement>('nav[aria-label="Группы пробелов"] .fx-li')!;
        const cs = getComputedStyle(document.querySelector<HTMLElement>('table.fx-table tbody td')!);
        const heavy = [...document.querySelectorAll<HTMLElement>('table.fx-table *, nav[aria-label="Группы пробелов"] *')].filter((e) => Number(getComputedStyle(e).fontWeight) > 600 && e.textContent?.trim()).length;
        const tools = document.querySelector<HTMLElement>('.fx-tools')!;
        const scroller = document.querySelector<HTMLElement>('table.fx-table')!.parentElement!;
        const link = document.querySelector<HTMLElement>('table.fx-table tbody tr button')!.getBoundingClientRect();
        return { rowMin: Math.min(...tr), rowMax: Math.max(...tr), thH: th.getBoundingClientRect().height, side: side.getBoundingClientRect().width, li: li.getBoundingClientRect().height, tools: tools.getBoundingClientRect().height,
          hscroll: document.documentElement.scrollWidth > window.innerWidth || scroller.scrollWidth > scroller.clientWidth + 1, linkRight: link.right, width: window.innerWidth, font: parseFloat(cs.fontSize), heavy };
      });
      ok(`${t} строка 28–40 px, шапка таблицы 28 px, пункт группы 32 px, панель 40 px, левый список 208 px`, geometry.rowMin >= 28 && geometry.rowMax <= 40 && Math.round(geometry.thH) === 28 && Math.round(geometry.li) === 32 && geometry.tools >= 40 && geometry.tools <= 41 && Math.round(geometry.side) === 208, geometry);
      ok(`${t} без горизонтальной прокрутки, кнопка-ссылка видна целиком, текст не мельче 12 px, жирного нет`, !geometry.hscroll && geometry.linkRight <= geometry.width && geometry.font >= 12 && geometry.heavy === 0, geometry);
      if (SHOTS) await page.screenshot({ path: `/tmp/e3-gaps/shots/${theme}-list.png` });

      // Отбор и поиск
      const rowsCount = () => page.locator('table.fx-table tbody tr').count();
      await page.getByRole('button', { name: /^Каталог/ }).click();
      ok(`${t} группа «Каталог» оставляет её строки`, (await rowsCount()) === cCat, [await rowsCount(), cCat]);
      await page.getByLabel('Вид пробела').selectOption({ index: 1 });
      const byKind = await rowsCount();
      ok(`${t} отбор по виду сужает список`, byKind >= 1 && byKind <= cCat, byKind);
      await page.getByLabel('Вид пробела').selectOption('');
      await page.getByLabel('Поиск по пробелам').fill('MOTOR_POWER');
      await page.getByRole('button', { name: /^Все/ }).click();
      ok(`${t} поиск находит запись по имени`, (await rowsCount()) >= 1 && ((await page.locator('table.fx-table tbody').textContent()) || '').includes('MOTOR_POWER'));
      await page.getByLabel('Поиск по пробелам').fill('такого-нет-нигде');
      ok(`${t} пустой поиск — понятное «Ничего не найдено»`, await page.getByText('Ничего не найдено').isVisible());
      await page.getByLabel('Поиск по пробелам').fill('');

      // Ссылка: справочник атрибутов, «По типам», открыт атрибут
      await page.getByLabel('Поиск по пробелам').fill('MOTOR_POWER');
      await page.getByRole('button', { name: /Открыть: MOTOR_POWER/ }).first().click();
      await page.getByRole('dialog').waitFor();
      ok(`${t} ссылка на атрибут: вкладка «Справочник атрибутов», вид «По типам», диалог источника`,
        (await page.getByRole('tab', { name: 'Справочник атрибутов' }).getAttribute('aria-selected')) === 'true'
        && ((await page.getByRole('dialog').textContent()) || '').includes('MOTOR_POWER')
        && (await page.getByRole('button', { name: 'По типам' }).getAttribute('aria-pressed')) === 'true'
        && ((await page.locator('aside[aria-label="Типы оборудования"] [aria-current=true]').textContent()) || '').includes('Двигатель'));
      if (SHOTS) await page.screenshot({ path: `/tmp/e3-gaps/shots/${theme}-link-attr.png` });
      await page.keyboard.press('Escape');

      // Ссылка: решение без названия схемы; правка → список пересчитывается без перезагрузки
      await page.getByRole('tab', { name: /Нет данных/ }).click();
      await page.getByLabel('Поиск по пробелам').fill('');
      await page.getByRole('button', { name: /^Каталог/ }).click();
      const noNameRows = page.locator('table.fx-table tbody tr').filter({ hasText: 'Не задано название схемы' });
      ok(`${t} в каталоге есть решение без названия схемы`, (await noNameRows.count()) === 1);
      ok(`${t} пробела «строка IO без изделия» больше нет`, (await page.locator('table.fx-table tbody tr').filter({ hasText: /имя изделия|без изделия/ }).count()) === 0);
      await noNameRows.first().getByRole('button', { name: /Открыть/ }).click();
      const dlg = page.getByRole('dialog', { name: /99\.99\.99/ });
      await dlg.waitFor();
      ok(`${t} ссылка на решение: «Типовые решения», открыта карточка решения`, (await page.getByRole('tab', { name: 'Типовые решения' }).getAttribute('aria-selected')) === 'true');
      if (SHOTS) await page.screenshot({ path: `/tmp/e3-gaps/shots/${theme}-link-solution.png` });
      const reads = solutionReads;
      await dlg.getByLabel('Название схемы').fill('Воздуховод_тест');
      await dlg.getByRole('button', { name: 'Сохранить' }).click();
      await dlg.waitFor({ state: 'detached' });
      await page.getByRole('tab', { name: /Нет данных/ }).click();
      await page.getByRole('button', { name: /^Каталог/ }).click();
      await page.waitForFunction(() => ![...document.querySelectorAll('table.fx-table tbody tr')].some((r) => r.textContent?.includes('Не задано название схемы')));
      ok(`${t} после правки в каталоге запись исчезла из списка без перезагрузки страницы`, true);
      const newLabel = ((await page.getByRole('tab', { name: /Нет данных/ }).textContent()) || '');
      ok(`${t} счётчик во вкладке уменьшился`, Number(newLabel.replace(/\D/g, '')) < total, [label, newLabel]);
      ok(`${t} данные перечитаны с сервера`, solutionReads > reads, [reads, solutionReads]);

      // Ссылки на позиции проекта
      await page.getByRole('button', { name: /^Проект/ }).click();
      const attrRow = page.locator('table.fx-table tbody tr').filter({ hasText: 'Нет значений' }).first();
      const attrTag = ((await attrRow.locator('td').nth(1).textContent()) || '').trim();
      ok(`${t} позиция без значений атрибутов «Да» попала в проектные пробелы`, !!attrTag, attrTag);
      await attrRow.getByRole('button', { name: /Открыть/ }).click();
      await page.waitForSelector('table.fx-table tbody tr.is-sel');
      const hot = ((await page.locator('table.fx-table tbody tr.is-sel td').first().textContent()) || '').trim();
      ok(`${t} ссылка на позицию: «Атрибуты проекта», строка выделена`, (await page.getByRole('tab', { name: 'Атрибуты проекта' }).getAttribute('aria-selected')) === 'true' && hot === attrTag, [hot, attrTag]);
      if (SHOTS) await page.screenshot({ path: `/tmp/e3-gaps/shots/${theme}-link-position.png` });

      await page.getByRole('tab', { name: /Нет данных/ }).click();
      await page.getByRole('button', { name: /^Проект/ }).click();
      const selRow = page.locator('table.fx-table tbody tr').filter({ hasNotText: 'Нет значений' }).first();
      if (await selRow.count()) {
        const selTag = ((await selRow.locator('td').nth(1).textContent()) || '').trim();
        await selRow.getByRole('button', { name: /Открыть/ }).click();
        const sel = page.getByRole('dialog', { name: /Подбор решения/ });
        await sel.waitFor();
        ok(`${t} ссылка на подбор: открыто окно подбора этой позиции`, ((await sel.textContent()) || '').includes(selTag), selTag);
        if (SHOTS) await page.screenshot({ path: `/tmp/e3-gaps/shots/${theme}-link-selection.png` });
        await page.keyboard.press('Escape');
      } else ok(`${t} ссылка на подбор: есть строка подбора`, false);

      ok(`${t} раздел жив без ошибок в консоли`, errors.length === 0, errors);
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(`\nПройдено ${passed}, провалено ${failed}`);
  if (failed) process.exit(1);
})().catch((e) => { console.error('✗', e?.message || e); process.exit(1); });
