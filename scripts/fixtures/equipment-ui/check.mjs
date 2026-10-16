import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../node_modules/playwright-core/index.mjs';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureProjectId = '7e9f611c-2fd7-49b2-8a40-31ab93337891';
const longUntaggedId = `${fixtureProjectId}-EQ-000001`;
const equipmentGeometryWidths = process.env.FLUX_EQUIPMENT_UI_GEOMETRY_WIDTHS
  ? process.env.FLUX_EQUIPMENT_UI_GEOMETRY_WIDTHS.split(',').map(value => Number(value.trim())).filter(Number.isFinite)
  : [1024, 1440];
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
    { id: 'block-1', itemCode: 'B-1', name: 'Вентиляторная секция ВР-80', equipType: 'Вентилятор ВР-80', role: 'БЛОК', version: 2, hasConflict: false, status: 'OK', catalogSource: { effective: [{ group: 'Аэродинамика', key: 'Полное давление', source: 'catalog' }] }, tags: [{ id: 'tag-1', identifier: 'AHU-101-FAN' }], specs: specs([
      { title: 'Аэродинамика', params: [{ key: 'Расход воздуха', value: '12500', unit: 'м³/ч' }, { key: 'Полное давление', value: '850', unit: 'Па' }] },
      { title: 'Электродвигатель', params: [{ key: 'Мощность', value: '5.5', unit: 'кВт' }, { key: 'Напряжение', value: '400', unit: 'В' }] },
      { title: 'Габариты', params: [{ key: 'Ширина', value: '820', unit: 'мм' }, { key: 'Высота', value: '760', unit: 'мм' }] },
    ]) },
    { id: 'motor-1', itemCode: 'M-1', name: 'Электродвигатель 160М6', equipType: 'Электродвигатель', role: 'ДВИГАТЕЛЬ', parentElementId: 'block-1', version: 1, hasConflict: false, status: 'OK', tags: [{ id: 'tag-2', identifier: 'AHU-101-M1' }], specs: specs([{ title: 'Электрические', params: [{ key: 'Мощность', value: '5.5', unit: 'кВт' }] }]) },
    { id: longUntaggedId, itemCode: 'B-2', name: 'Рама фильтра длинного проекта', equipType: 'Корпус фильтра', role: 'ФИЛЬТР', parentElementId: 'block-1', version: 1, hasConflict: false, status: 'OK', tags: [], specs: specs([{ title: 'Габариты', params: [{ key: 'Ширина', value: '600', unit: 'мм' }] }]) },
    { id: 'mono-general', itemCode: 'Основной блок_общие', name: 'Основные параметры моноблока', equipType: 'МОНОБЛОК', role: 'МОНОБЛОК', version: 1, hasConflict: false, status: 'OK', tags: [], specs: specs([{ title: 'Общие', params: [{ key: 'Масса моноблока', value: '455', unit: 'кг' }] }]) },
    { id: 'orphan-panel', itemCode: 'ORPHAN-1', name: 'Нераспределённая позиция', equipType: 'СЕКЦИЯ', role: 'БЛОК', parentElementId: 'missing-parent', version: 1, hasConflict: false, status: 'OK', tags: [], specs: specs([]) },
    { id: 'cycle-panel-a', itemCode: 'CYCLE-A', name: 'Цикл A', equipType: 'СЕКЦИЯ', role: 'БЛОК', parentElementId: 'cycle-panel-b', version: 1, hasConflict: false, status: 'OK', tags: [], specs: specs([]) },
    { id: 'cycle-panel-b', itemCode: 'CYCLE-B', name: 'Цикл B', equipType: 'СЕКЦИЯ', role: 'БЛОК', parentElementId: 'cycle-panel-a', version: 1, hasConflict: false, status: 'OK', tags: [], specs: specs([]) },
    { id: 'tag-owner-a', itemCode: 'TAG-OWNER-A', name: 'Владелец тега A', equipType: 'СЕКЦИЯ', role: 'БЛОК', tags: [{ id: 'owner-tag-a', identifier: 'TAG-A' }], specs: specs([]) },
    { id: 'tag-owner-b', itemCode: 'TAG-OWNER-B', name: 'Владелец тега B', equipType: 'СЕКЦИЯ', role: 'БЛОК', tags: [{ id: 'owner-tag-b', identifier: 'TAG-B' }], specs: specs([]) },
    { id: 'tag-parent-panel', itemCode: 'TAG-PARENT', name: 'Без родительского тега', equipType: 'СЕКЦИЯ', role: 'БЛОК', tags: [{ id: 'child-tag-parent', identifier: 'TAG-PARENT-CHILD', metadata: { parentId: 'absent-tag' } }], specs: specs([]) },
    { id: 'tag-ambiguous-panel', itemCode: 'TAG-AMBIGUOUS', name: 'Неоднозначная позиция', equipType: 'СЕКЦИЯ', role: 'БЛОК', tags: [{ id: 'child-tag-a', identifier: 'TAG-CHILD-A', metadata: { parentId: 'owner-tag-a' } }, { id: 'child-tag-b', identifier: 'TAG-CHILD-B', metadata: { parentId: 'owner-tag-b' } }], specs: specs([]) },
    { id: 'unit-general', itemCode: '__unit__', name: 'Параметры установки', equipType: 'Установка', role: 'БЛОК', version: 1, hasConflict: false, status: 'OK', tags: [], specs: specs([
      { title: 'Параметры установки', params: [{ key: 'Расход воздуха', value: '8060', unit: 'м³/ч' }, { key: 'Давление в сети', value: '500', unit: 'Па' }, { key: 'Мощность', value: '38.64', unit: 'кВт' }, { key: 'Количество блоков', value: '7', unit: 'шт.' }] },
      { title: 'Автоматика', params: [{ key: 'Система управления', value: 'контроллер' }] },
      { title: 'Примечание к установке', params: [{ key: 'Примечание к монтажу и настройке', value: 'Длинный текст характеристики занимает всю ширину, переносится на несколько строк и не вызывает прокрутку панели по горизонтали.' }] },
    ]) },
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
  else if (endpoint === `/api/projects/${fixtureProjectId}/systems`) body = { systems };
  else if (endpoint === `/api/projects/${fixtureProjectId}/tags`) body = { tags: [] };
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
      equipmentCardWidth: root?.querySelector('[data-share-focus^="equip:"]')?.clientWidth || 0,
      equipmentCardScroll: root?.querySelector('[data-share-focus^="equip:"]')?.scrollWidth || 0,
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
  if (label === 'equipment' && geometry.equipmentCardScroll > geometry.equipmentCardWidth + 1) throw new Error(`equipment card content overflow at ${width}px: ${JSON.stringify(geometry)}`);
  return geometry;
};

try {
  await page.goto(process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4191');
  await page.getByRole('navigation', { name: 'Категории оборудования' }).waitFor();
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: 'AHU-101', exact: true }).click();
  const overview = page.getByTestId('equipment-unit-overview');
  await overview.waitFor();
  await overview.getByText('Общие характеристики моноблока', { exact: true }).waitFor();
  await overview.getByText('Масса моноблока', { exact: true }).waitFor();
  const unassigned = overview.getByTestId('equipment-unassigned');
  await unassigned.getByText('ORPHAN-1', { exact: false }).waitFor();
  await unassigned.getByText('CYCLE-A', { exact: false }).waitFor();
  await unassigned.getByText('Родительский тег не найден', { exact: true }).waitFor();
  await unassigned.getByText('Неоднозначная связь по тегам', { exact: true }).waitFor();
  await unassigned.getByText('Цикл в составе', { exact: true }).waitFor();
  await unassigned.getByText('Родитель не найден', { exact: true }).waitFor();
  await overview.getByRole('button', { name: 'Параметры установки', exact: true }).click();
  const unitPane = page.getByTestId('equipment-selected-unit-general');
  await unitPane.waitFor();
  await unitPane.locator('h4[title="Параметры установки"]').waitFor();
  if (!await unitPane.getByText('8060 м³/ч', { exact: true }).isVisible()) throw new Error('installation characteristic value and unit did not render');
  const noteHeading = unitPane.getByRole('heading', { name: 'Примечание к установке', exact: true });
  const noteToggle = noteHeading.locator('xpath=..');
  if (await noteToggle.getAttribute('aria-expanded') !== 'true') await noteToggle.click();
  const noteSection = noteHeading.locator('xpath=ancestor::section[1]');
  const longNote = noteSection.getByText(/Длинный текст характеристики занимает всю ширину/u);
  await longNote.waitFor();
  await page.setViewportSize({ width: 720, height: 1000 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    const compact = await unitPane.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    if (compact.scroll > compact.width + 1) throw new Error(`installation panel overflowed at narrow width: ${JSON.stringify(compact)}`);
    const narrowPairRows = await Promise.all(['Расход воздуха', 'Давление в сети'].map(label => unitPane.getByText(label, { exact: true }).locator('xpath=..').evaluate(el => { const rect = el.getBoundingClientRect(); return { y: rect.y, right: rect.right, width: rect.width }; })));
    if (narrowPairRows[1].y <= narrowPairRows[0].y) throw new Error(`parameters in one group are not displayed as readable rows: ${JSON.stringify(narrowPairRows)}`);
    const narrowGroups = await Promise.all(['Параметры установки', 'Автоматика'].map(title => unitPane.getByRole('heading', { name: title, exact: true }).locator('xpath=ancestor::section[1]').evaluate(el => { const rect = el.getBoundingClientRect(); return { x: rect.x, y: rect.y }; })));
    if (narrowGroups[1].y <= narrowGroups[0].y) throw new Error(`narrow detail did not stack separate groups: ${JSON.stringify(narrowGroups)}`);
    const narrowNote = await longNote.evaluate(el => { const rect = el.getBoundingClientRect(); return { right: rect.right, viewport: innerWidth }; });
    if (narrowNote.right > narrowNote.viewport + 1) throw new Error(`long installation note overflows at narrow width: ${JSON.stringify(narrowNote)}`);
    await page.screenshot({ path: `/tmp/flux-equipment-unit-720-${theme}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    const geometry = await unitPane.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    if (geometry.scroll > geometry.width + 1) throw new Error(`installation panel overflowed at wide width: ${JSON.stringify(geometry)}`);
    const widePairRows = await Promise.all(['Расход воздуха', 'Давление в сети'].map(label => unitPane.getByText(label, { exact: true }).locator('xpath=..').evaluate(el => { const rect = el.getBoundingClientRect(); return { y: rect.y, right: rect.right, width: rect.width }; })));
    if (widePairRows[1].y <= widePairRows[0].y) throw new Error(`parameters in one group are not displayed as readable rows: ${JSON.stringify(widePairRows)}`);
    const groupCards = await Promise.all(['Параметры установки', 'Автоматика'].map(title => unitPane.getByRole('heading', { name: title, exact: true }).locator('xpath=ancestor::section[1]').evaluate(el => { const rect = el.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right }; })));
    const paneWidth = await unitPane.evaluate(el => el.clientWidth);
    if (paneWidth >= 760 && groupCards[0].x === groupCards[1].x) throw new Error(`wide detail did not place separate groups in responsive columns: ${JSON.stringify({ paneWidth, groupCards })}`);
    if (paneWidth < 760 && groupCards[1].y <= groupCards[0].y) throw new Error(`narrow detail did not stack separate groups: ${JSON.stringify({ paneWidth, groupCards })}`);
    const wideNote = await longNote.evaluate(el => { const rect = el.getBoundingClientRect(); return { right: rect.right, viewport: innerWidth, width: rect.width }; });
    if (wideNote.right > wideNote.viewport + 1 || wideNote.width < 1) throw new Error(`long installation note is not readable at wide width: ${JSON.stringify(wideNote)}`);
    await page.screenshot({ path: `/tmp/flux-equipment-unit-1440-${theme}.png` });
  }
  await page.getByRole('button', { name: /Вентиляторная секция ВР-80/ }).first().click();
  if (!await page.getByText('Аэродинамика', { exact: true }).isVisible()) throw new Error('real BlockCard parameter groups did not render');
  if (await page.locator('[role="alert"]').count()) throw new Error('catalog source fixture rendered an error alert');
  const catalogFact = page.getByText('Полное давление', { exact: true }).locator('xpath=..');
  if (await catalogFact.locator('button[title="Изменить вручную"]').count()) throw new Error('catalog-origin characteristic remained editable in Equipment');
  if (!await catalogFact.getByText('Каталог', { exact: true }).isVisible()) throw new Error('catalog-origin characteristic did not show its read-only origin');
  await page.getByTestId('equipment-catalog-details').locator(':scope > summary').click();
  const catalogDetails = page.getByTestId('equipment-catalog-details');
  await catalogDetails.getByText('Источник параметров', { exact: true }).waitFor();
  await catalogDetails.locator('summary').filter({ hasText: /^Параметры и источник значения/u }).click();
  const markedParam = page.getByLabel(/Аэродинамика · Расход воздуха\. Расхождение:/);
  await markedParam.waitFor();
  if (!await markedParam.getByText('Расхождение', { exact: true }).isVisible()) throw new Error('catalog/XML discrepancy was not marked on its effective parameter row');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    const geometry = await markedParam.evaluate((el) => { const rect = el.getBoundingClientRect(); const style = getComputedStyle(el); return { width: rect.width, height: rect.height, right: rect.right, viewport: innerWidth, background: style.backgroundColor }; });
    if (geometry.width < 100 || geometry.height < 28 || geometry.right > geometry.viewport + 1) throw new Error(`discrepancy row layout is invalid in ${theme}: ${JSON.stringify(geometry)}`);
    await page.screenshot({ path: path.join('/tmp', `flux-equipment-catalog-discrepancy-${theme}.png`) });
  }
  await page.getByRole('button', { name: 'Позиции списком: по типу, с тегами' }).click();
  const positionSearch = page.getByPlaceholder('Тег, название, установка…');
  await positionSearch.fill(longUntaggedId.slice(-12));
  const idRow = page.locator('tbody tr').filter({ hasText: longUntaggedId });
  await idRow.waitFor();
  if (!await idRow.getByText('без тега', { exact: true }).isVisible()) throw new Error('tagless position is not visible in the equipment list');
  if (!await idRow.getByText(longUntaggedId, { exact: true }).isVisible()) throw new Error('position list does not display the full project-scoped ID');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    await page.screenshot({ path: `/tmp/flux-equipment-ui-position-list-long-tagless-id-${theme}.png`, fullPage: true });
  }
  await idRow.click();
  await page.getByText(`ID: ${longUntaggedId}`, { exact: true }).waitFor();
  const detailIdGeometry = await page.getByText(`ID: ${longUntaggedId}`, { exact: true }).evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, rectWidth: el.getBoundingClientRect().width }));
  if (detailIdGeometry.width < 1 || detailIdGeometry.scroll > detailIdGeometry.width + 1) throw new Error(`long project-scoped ID does not wrap in the component card: ${JSON.stringify(detailIdGeometry)}`);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    await page.screenshot({ path: `/tmp/flux-equipment-ui-long-tagless-id-${theme}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Вентиляторная секция ВР-80' }).first().click();
  await page.getByRole('button', { name: 'Радиальные вентиляторы', exact: false }).click();
  if (!await page.getByText('Ничего не выбрано').isVisible()) throw new Error('category change kept stale detail selection');
  await page.getByRole('button', { name: 'FAN-201', exact: true }).click();
  await page.getByRole('button', { name: /Радиальный вентилятор ВР-80/ }).first().click();
  if (!await page.getByText('Производительность', { exact: true }).isVisible()) throw new Error('category selection did not show the selected fan detail');

  for (const width of equipmentGeometryWidths) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      const geometry = await noOverflow('equipment', width);
      await page.screenshot({ path: path.join('/tmp', `flux-equipment-ui-equipment-${width}-${theme}.png`) });
      if (geometry.bodyWidth > width) throw new Error(`equipment document overflow ${width}px ${theme}`);
    }
  }

  if (errors.length) throw new Error(`browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ categoryChange: 'passed', blockCard: 'passed', themes: ['light', 'dark'], unitScreenshots: [720, 1440].flatMap((w) => ['light', 'dark'].map((t) => `/tmp/flux-equipment-unit-${w}-${t}.png`)), screenshots: [1024, 1440].flatMap((w) => ['light', 'dark'].map((t) => `/tmp/flux-equipment-ui-equipment-${w}-${t}.png`)).concat([720, 1024, 1440].flatMap((w) => ['light', 'dark'].map((t) => `/tmp/flux-equipment-ui-export-${w}-${t}.png`))) }, null, 2));
} finally {
  await browser.close();
}
