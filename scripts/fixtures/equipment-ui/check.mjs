import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../node_modules/playwright-core/index.mjs';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror:${error.message}`));
page.on('console', (message) => { if (message.type() === 'error') errors.push(`console:${message.text()}`); });
page.on('response', (response) => { if (response.status() >= 400) errors.push(`http${response.status()}:${response.url()}`); });

const system = (id, name, category, components) => ({ id, name, category, monoblocks: [{ id: `${id}-mono`, name: 'Основной блок', components }] });
const specs = (groups) => JSON.stringify({ groups });
const systems = [
  system('ahu-1', 'AHU-101', 'AHU', [
    { id: 'block-1', itemCode: 'B-1', name: 'Вентиляторная секция ВР-80', equipType: 'Вентилятор ВР-80', role: 'БЛОК', version: 2, hasConflict: false, status: 'OK', tags: [{ id: 'tag-1', identifier: 'AHU-101-FAN' }], specs: specs([
      { title: 'Аэродинамика', params: [{ key: 'Расход воздуха', value: '12500', unit: 'м³/ч' }, { key: 'Полное давление', value: '850', unit: 'Па' }] },
      { title: 'Электродвигатель', params: [{ key: 'Мощность', value: '5.5', unit: 'кВт' }, { key: 'Напряжение', value: '400', unit: 'В' }] },
      { title: 'Габариты', params: [{ key: 'Ширина', value: '820', unit: 'мм' }, { key: 'Высота', value: '760', unit: 'мм' }] },
    ]) },
    { id: 'motor-1', itemCode: 'M-1', name: 'Электродвигатель 160М6', equipType: 'Электродвигатель', role: 'ДВИГАТЕЛЬ', parentElementId: 'block-1', version: 1, hasConflict: false, status: 'OK', tags: [{ id: 'tag-2', identifier: 'AHU-101-M1' }], specs: specs([{ title: 'Электрические', params: [{ key: 'Мощность', value: '5.5', unit: 'кВт' }] }]) },
  ]),
  system('fan-1', 'FAN-201', 'FAN', [
    { id: 'fan-201', itemCode: 'F-201', name: 'Радиальный вентилятор ВР-80', equipType: 'Радиальный вентилятор', role: 'ВЕНТИЛЯТОР', version: 1, hasConflict: false, status: 'OK', tags: [{ id: 'tag-3', identifier: 'FAN-201' }], specs: specs([{ title: 'Производительность', params: [{ key: 'Расход воздуха', value: '4200', unit: 'м³/ч' }, { key: 'Давление', value: '650', unit: 'Па' }] }]) },
  ]),
];

page.route('**/api/**', async (route) => {
  const endpoint = new URL(route.request().url()).pathname;
  let body = {};
  if (endpoint === '/api/equipment/categories') body = { categories: [
    { id: 'AHU', label: 'Центральные кондиционеры', composite: true },
    { id: 'FAN', label: 'Радиальные вентиляторы' },
    { id: 'VALVE', label: 'Клапаны' },
    { id: 'CURTAIN', label: 'Воздушные завесы' },
  ] };
  else if (endpoint === '/api/projects/equipment-fixture/systems') body = { systems };
  else if (endpoint === '/api/projects/equipment-fixture/tags') body = { tags: [] };
  else if (endpoint.endsWith('/e3/summary')) body = [];
  else if (endpoint.includes('/settings/equip_visibility_mode')) body = { user: 'admin' };
  else if (endpoint.includes('/settings/equip_visibility')) body = { global: '{}' };
  else if (endpoint.includes('/settings/equip_conflict_mode')) body = { global: 'wait' };
  else if (endpoint.includes('/settings/equip_category_view_')) body = { global: '{}' };
  else if (endpoint === '/api/equipment/view-templates') body = { views: [] };
  else if (endpoint.includes('/catalog-source') && endpoint.includes('/block-1')) body = {
    mode: 'hybrid', matches: [], effective: [{ group: 'Аэродинамика', key: 'Расход воздуха', value: '12500', unit: 'м³/ч', source: 'xml' }], warnings: [],
    discrepancies: [{ group: 'Аэродинамика', key: 'Расход воздуха', xmlValue: '12500', catalogValue: '13000', xmlUnit: 'м³/ч', catalogUnit: 'м³/ч', sourceRef: { file: 'Каталог.pdf', pages: '12' } }],
  };
  else if (endpoint.includes('/catalog-source')) body = { mode: 'xml', matches: [], effective: [], warnings: [], discrepancies: [] };
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});

const noOverflow = async (label, width) => {
  const geometry = await page.evaluate(() => {
    const root = document.querySelector('#root > div');
    const header = root?.querySelector('.fx-head');
    const canvas = root?.querySelector('main[aria-label="Рабочая книга"]');
    const buttons = [...(header?.querySelectorAll('button') || [])].map((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.right <= (header.getBoundingClientRect().right + 1);
    });
    return {
      bodyWidth: document.documentElement.scrollWidth,
      bodyHeight: document.documentElement.scrollHeight,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      rootWidth: root?.clientWidth || 0,
      rootScroll: root?.scrollWidth || 0,
      headerWidth: header?.clientWidth || 0,
      headerScroll: header?.scrollWidth || 0,
      headerButtonsFit: buttons.every(Boolean),
      canvasWidth: canvas?.getBoundingClientRect().width || 0,
      overflowers: [...(root?.querySelectorAll('*') || [])].filter((el) => el.scrollWidth > el.clientWidth + 4).slice(0, 40).map((el) => ({ tag: el.tagName, cls: el.className?.baseVal || el.className, width: el.clientWidth, scroll: el.scrollWidth, text: el.textContent?.trim().slice(0, 60) })),
    };
  });
  if (geometry.bodyWidth > width + 1 || geometry.bodyHeight > geometry.viewportHeight + 1 || geometry.rootScroll > geometry.rootWidth + 2 || !geometry.headerButtonsFit) {
    throw new Error(`${label} layout overflow at ${width}px: ${JSON.stringify(geometry)}`);
  }
  return geometry;
};

try {
  await page.goto(process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4191');
  await page.getByRole('navigation', { name: 'Категории оборудования' }).waitFor();
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: 'AHU-101', exact: true }).click();
  await page.getByRole('button', { name: /Вентиляторная секция ВР-80/ }).first().click();
  if (!await page.getByText('Аэродинамика', { exact: true }).isVisible()) throw new Error('real BlockCard parameter groups did not render');
  const markedParam = page.getByLabel(/Аэродинамика · Расход воздуха\. Расхождение:/);
  await markedParam.waitFor();
  if (!await markedParam.getByText('Расхождение', { exact: true }).isVisible()) throw new Error('catalog/XML discrepancy was not marked on its effective parameter row');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    const geometry = await markedParam.evaluate((el) => { const rect = el.getBoundingClientRect(); const style = getComputedStyle(el); return { width: rect.width, height: rect.height, right: rect.right, viewport: innerWidth, background: style.backgroundColor }; });
    if (geometry.width < 100 || geometry.height < 28 || geometry.right > geometry.viewport + 1) throw new Error(`discrepancy row layout is invalid in ${theme}: ${JSON.stringify(geometry)}`);
    await page.screenshot({ path: path.join('/tmp', `flux-equipment-catalog-discrepancy-${theme}.png`) });
  }
  await page.getByRole('button', { name: 'Радиальные вентиляторы', exact: false }).click();
  if (!await page.getByText('Ничего не выбрано').isVisible()) throw new Error('category change kept stale detail selection');
  await page.getByRole('button', { name: 'FAN-201', exact: true }).click();
  await page.getByRole('button', { name: /Радиальный вентилятор ВР-80/ }).first().click();
  if (!await page.getByText('Производительность', { exact: true }).isVisible()) throw new Error('category selection did not show the selected fan detail');

  for (const width of [1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      const geometry = await noOverflow('equipment', width);
      await page.screenshot({ path: path.join('/tmp', `flux-equipment-ui-equipment-${width}-${theme}.png`) });
      if (geometry.bodyWidth > width) throw new Error(`equipment document overflow ${width}px ${theme}`);
    }
  }

  await page.getByRole('button', { name: 'Выгрузка', exact: true }).click();
  await page.getByRole('tab', { name: 'Столбцы', exact: true }).click();
  const search = page.getByPlaceholder('Мощность, расход…');
  await search.fill('Расход воздуха');
  const airGroup = page.locator('details').filter({ has: page.getByText('Аэродинамика', { exact: true }) }).first();
  if ((await airGroup.getAttribute('open')) === null) throw new Error('search did not open the matching characteristic section');
  const amount = page.getByRole('button', { name: /Расход воздуха/ }).first();
  await amount.click();
  if (!await page.getByLabel('Заголовок столбца').last().inputValue()) throw new Error('selecting a parameter did not add a column');

  const sheetWidths = {};
  for (const width of [720, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      const geometry = await noOverflow('export', width);
      if (geometry.canvasWidth < 500 && width === 720) throw new Error(`sheet canvas is too narrow at 720px: ${JSON.stringify(geometry)}`);
      sheetWidths[`${width}-${theme}`] = geometry.canvasWidth;
      await page.screenshot({ path: path.join('/tmp', `flux-equipment-ui-export-${width}-${theme}.png`) });
    }
  }
  await page.getByRole('tab', { name: 'Данные', exact: true }).click();
  await page.getByRole('button', { name: /Радиальные вентиляторы/ }).click();
  if (!await page.getByText('Радиальные вентиляторы', { exact: true }).last().isVisible()) throw new Error('equipment category scope could not be selected');
  if (errors.length) throw new Error(`browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ categoryChange: 'passed', blockCard: 'passed', exportGroupSearchAndPick: 'passed', sheetWidths, themes: ['light', 'dark'], screenshots: [1024, 1440].flatMap((w) => ['light', 'dark'].map((t) => `/tmp/flux-equipment-ui-equipment-${w}-${t}.png`)).concat([720, 1024, 1440].flatMap((w) => ['light', 'dark'].map((t) => `/tmp/flux-equipment-ui-export-${w}-${t}.png`))) }, null, 2));
} finally {
  await browser.close();
}
