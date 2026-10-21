import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../node_modules/playwright-core/index.mjs';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = process.env.OFFICE_ADDON_UI_DIR || '/tmp';
const kind = process.env.OFFICE_ADDON_KIND === 'docs' ? 'docs' : 'sheets';
const screenshotPrefix = `flux-office-addon-${kind}`;
const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const failures = [];
let expectedConflict = false;
const requests = [];
const screenshotPaths = [];
page.on('pageerror', (error) => failures.push(`pageerror:${error.message}`));
page.on('console', (message) => { if (message.type() === 'error' && !(expectedConflict && message.text().includes('409'))) failures.push(`console:${message.text()}`); });
page.on('response', (response) => { if (response.status() >= 400 && !(expectedConflict && response.status() === 409 && response.url().endsWith('/confirm'))) failures.push(`http${response.status()}:${response.url()}`); });
page.route('**/api/project-data/**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const endpoint = url.pathname;
  let body = {};
  if (endpoint === '/api/project-data/catalog') body = {
    tagFields: [{ path: 'identifier', title: 'Обозначение' }],
    elementFields: [{ path: 'identifier', title: 'Обозначение' }, { path: 'name', title: 'Наименование' }, { path: 'equipType', title: 'Тип' }],
    params: [{ group: 'Основные', key: 'Масса', unit: 'кг' }], aliases: [], metaKeys: [],
  };
  else if (endpoint === '/api/project-data/office/templates' && request.method() === 'GET') body = { templates: [{ id: 'template-1', name: 'Рабочая выборка', scope: 'PERSONAL', ownerId: 'user-1', schema: { version: 1, anchors: [] }, query: { entity: 'element', columns: ['identifier', 'name'], filters: [{ field: 'equipType', op: 'in', value: 'pump|valve' }, { field: 'name', op: 'contains', value: 'P' }], sort: [{ field: 'name', dir: 'desc' }], limit: 1000 } }], pinned: ['template-1'] };
  else if (endpoint.endsWith('/office-state')) {
    if (request.method() === 'PUT') { requests.push({ endpoint: 'office-state-put', body: request.postDataJSON() }); body = { ok: true, baseHash: 'fixture-hash-put', schemaVersion: 1, anchorCount: 1 }; }
    else body = { baseHash: 'fixture-hash-1', sourceRevision: 'fixture-rev-1', schema: { version: 1, anchors: [{ kind: 'excel-range', id: 'anchor-a1', sheetName: 'Лист1', address: 'A1', parts: [{ kind: 'text', text: 'Позиция ' }, { kind: 'field', binding: { fieldKey: 'identifier', sourceId: 'equipment', entityType: 'element', entityId: null, sourceRevision: 'fixture-rev-1', anchorId: 'anchor-a1' } }] }] } };
  } else if (endpoint === '/api/project-data/office/query') {
    const requestBody = request.postDataJSON(); requests.push({ endpoint: 'query', body: requestBody });
    body = { revision: 'fixture-rev-1', total: 2, rows: [
      { entityId: 'e-1', entityType: 'element', sourceId: 'equipment', tag: 'P-101', values: { identifier: { value: 'P-101', revision: 'fixture-rev-1' }, name: { value: 'Pump A' }, equipType: { value: 'pump' }, 'param:Основные|Масса': { value: 120, unit: 'кг' } } },
      { entityId: 'e-2', entityType: 'element', sourceId: 'equipment', tag: 'P-102', values: { identifier: { value: 'P-102', revision: 'fixture-rev-1' }, name: { value: 'Pump B' }, equipType: { value: 'pump' }, 'param:Основные|Масса': { value: 130, unit: 'кг' } } },
    ] };
  } else if (endpoint.endsWith('/preview')) {
    const previewBody = request.postDataJSON(); requests.push({ endpoint: 'preview', body: previewBody });
    body = { planId: 'plan-1', baseHash: previewBody.baseHash, sourceRevision: previewBody.sourceRevision, selectedEntityIds: previewBody.selectedEntityIds, writes: [{ entityId: 'e-1', anchorId: 'anchor-a1', value: 'P-101' }], adds: [], replaces: [], manualRows: [], skips: [], errors: [], conflicts: [] };
  } else if (endpoint.endsWith('/confirm')) {
    if (expectedConflict) {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Документ изменился после предпросмотра' }) });
      return;
    }
    const confirmBody = request.postDataJSON(); requests.push({ endpoint: 'confirm', body: confirmBody });
    body = { status: 'ready-for-editor', writes: [{ entityId: 'e-1', anchorId: 'anchor-a1', value: 'P-101' }] };
  } else if (endpoint.endsWith('/templates') && request.method() === 'POST') {
    const templateBody = request.postDataJSON(); requests.push({ endpoint: 'template-save', body: templateBody });
    body = { template: { id: 'template-2', name: templateBody.name, scope: templateBody.scope, ownerId: 'user-1', schema: templateBody.schema, query: templateBody.query, updatedAt: new Date().toISOString() } };
  } else if (endpoint.includes('/pin')) body = { pinned: ['template-1'] };
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});
page.route('**/api/office/revisions/**', async (route) => {
  const fileId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1) || 'fixture-file');
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documentId: `doc-${fileId}`, fileId, fileName: kind === 'docs' ? 'Пробный документ.docx' : 'Пробная книга.xlsx', revisions: [] }) });
});

try {
  const fixtureUrl = process.env.OFFICE_ADDON_UI_URL || process.env.FLUX_UI_URL || process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4190';
  await page.goto(`${fixtureUrl}${fixtureUrl.includes('?') ? '&' : '?'}kind=${kind}`);
  await page.getByRole('heading', { name: kind === 'docs' ? 'Данные для таблицы · Пробный документ.docx' : 'Данные для таблицы · Пробная книга.xlsx' }).waitFor();
  await page.waitForTimeout(150);
  for (const width of [390, 760, 1280]) {
    await page.setViewportSize({ width, height: 820 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => window.__fluxFixture.setTheme(value), theme);
      await page.screenshot({ path: path.join(outputDir, `${screenshotPrefix}-${width}-${theme}.png`), fullPage: true });
      screenshotPaths.push(path.join(outputDir, `${screenshotPrefix}-${width}-${theme}.png`));
      const geometry = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: innerWidth, panel: document.querySelector('aside')?.getBoundingClientRect().width, scroll: document.querySelector('aside')?.scrollWidth, client: document.querySelector('aside')?.clientWidth }));
      if (geometry.body > width || geometry.scroll > geometry.client) throw new Error(`overflow at ${width}px/${theme}: ${JSON.stringify(geometry)}`);
    }
  }

  // Шаблоны — только по команде ленты, в панели их больше нет
  if (await page.getByRole('button', { name: 'Рабочая выборка', exact: true }).count()) throw new Error('template controls must not stay inside the panel');
  await page.evaluate(() => window.__fluxFixture.command('templates'));
  const library = page.getByRole('dialog', { name: 'Шаблоны шапки' });
  await library.getByText('Рабочая выборка').waitFor();
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.evaluate((value) => window.__fluxFixture.setTheme(value), theme);
    await page.waitForTimeout(300);
    if (theme === 'dark') {
      const color = await library.locator('li span.truncate').first().evaluate((element) => getComputedStyle(element).color);
      const brightness = (value) => (value.match(/\d+/g)?.slice(0, 3).map(Number) || [0, 0, 0]).reduce((sum, item) => sum + item, 0) / 3;
      if (brightness(color) < 100) throw new Error(`dark-mode template name contrast too low: ${color}`);
    }
    const outputFile = path.join(outputDir, `${screenshotPrefix}-templates-${theme}.png`);
    await page.screenshot({ path: outputFile, fullPage: true }); screenshotPaths.push(outputFile);
  }
  await library.getByRole('button', { name: 'Открыть' }).click();
  await page.getByRole('button', { name: '1. Выборка' }).click();
  await page.getByRole('button', { name: 'Обновить выборку' }).click();
  await page.getByRole('checkbox', { name: 'Выбрать строку P-101' }).waitFor();
  for (const width of [390, 760, 1280]) {
    await page.setViewportSize({ width, height: 820 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => window.__fluxFixture.setTheme(value), theme);
      const suffix = `selection-loaded-${width}-${theme}`;
      await page.screenshot({ path: path.join(outputDir, `${screenshotPrefix}-${suffix}.png`), fullPage: true });
      screenshotPaths.push(path.join(outputDir, `${screenshotPrefix}-${suffix}.png`));
      if (theme === 'dark') {
        const colors = await page.evaluate(() => {
          const get = (selector) => getComputedStyle(document.querySelector(selector)).color;
          return { header: get('[role="columnheader"]'), row: get('[role="gridcell"]') };
        });
        const brightness = (color) => { const rgb = color.match(/\d+/g)?.slice(0, 3).map(Number) || [0, 0, 0]; return rgb.reduce((sum, value) => sum + value, 0) / 3; };
        if (brightness(colors.header) < 100 || brightness(colors.row) < 100) throw new Error(`dark-mode text contrast too low: ${JSON.stringify(colors)}`);
      }
    }
  }
  await page.getByRole('checkbox', { name: 'Выбрать строку P-101' }).check();
  await page.getByRole('button', { name: '2. Поля и шапка' }).click();
  await page.getByRole('button', { name: /Наименование/ }).click();
  await page.getByRole('button', { name: 'Привязать поле' }).click();
  await page.getByLabel('Текст заголовка 1').fill('Насос ');
  await page.getByRole('button', { name: 'Текст', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить оператор +' }).click();
  await page.getByRole('button', { name: 'Объединить с выбранным полем' }).click();
  await page.getByRole('group', { name: 'Первое непустое: Обозначение / Наименование', exact: true }).waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => window.__fluxFixture.setTheme(value), theme);
    if (theme === 'dark') {
      const anchorLabel = await page.locator('h4').first().evaluate((element) => getComputedStyle(element).color);
      const brightness = (color) => (color.match(/\d+/g)?.slice(0, 3).map(Number) || [0, 0, 0]).reduce((sum, value) => sum + value, 0) / 3;
      if (brightness(anchorLabel) < 100) throw new Error(`dark-mode anchor label contrast too low: ${anchorLabel}`);
    }
    const outputFile = path.join(outputDir, `${screenshotPrefix}-fields-${theme}.png`);
    await page.screenshot({ path: outputFile, fullPage: true }); screenshotPaths.push(outputFile);
  }
  await page.getByRole('button', { name: 'Сохранить схему' }).click();
  await page.getByRole('button', { name: '3. Обновление' }).click();
  await page.getByRole('button', { name: 'Предпросмотр заполнения' }).click();
  await page.getByText('План заполнения').waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => window.__fluxFixture.setTheme(value), theme);
    const outputFile = path.join(outputDir, `${screenshotPrefix}-plan-${theme}.png`);
    await page.screenshot({ path: outputFile, fullPage: true }); screenshotPaths.push(outputFile);
  }
  await page.getByRole('button', { name: 'Подтвердить и заполнить' }).click();
  await page.waitForFunction(() => window.__fluxFixture.ops.some((item) => item.type === 'apply-plan'));

  const data = await page.evaluate(() => window.__fluxFixture.ops);
  const templateQuery = requests.find((item) => item.endpoint === 'query')?.body?.query;
  const preview = requests.find((item) => item.endpoint === 'preview')?.body;
  const confirm = requests.find((item) => item.endpoint === 'confirm')?.body;
  const metadataWrites = requests.filter((item) => item.endpoint === 'office-state-put').map((item) => item.body);
  if (!data.some((item) => item.type === 'insert-field' && item.binding.sourceId === 'equipment' && item.binding.anchorId === 'anchor-a1' && item.displayText === 'Наименование')) throw new Error(`native binding callback missing or wrong: ${JSON.stringify(data)}`);
  const savedSchema = data.filter((item) => item.type === 'save-schema').at(-1)?.schema;
  if (!savedSchema?.anchors?.[0]?.parts?.some((part) => part.kind === 'operator') || !savedSchema.anchors[0].parts.some((part) => part.kind === 'union')) throw new Error(`schema text/operator/union not saved: ${JSON.stringify(savedSchema)}`);
  if (!templateQuery || !Array.isArray(templateQuery.excludedEntityIds) || templateQuery.excludedEntityIds.length !== 0 || !templateQuery.filters?.some((filter) => filter.op === 'in' && filter.field === 'equipType') || templateQuery.sort?.[0]?.dir !== 'desc' || !templateQuery.filters?.some((filter) => filter.op === 'contains' && filter.field === 'name')) throw new Error(`template query was not restored to server query contract: ${JSON.stringify(templateQuery)}`);
  if (!preview || !Array.isArray(preview.query.excludedEntityIds) || preview.query.excludedEntityIds.length !== 0 || preview.selectedEntityIds?.[0] !== 'e-1' || !confirm?.planId || JSON.stringify(confirm.query) !== JSON.stringify(preview.query)) throw new Error(`preview/confirm contract mismatch: ${JSON.stringify({ preview, confirm })}`);
  if (!data.some((item) => item.type === 'apply-plan' && item.plan.writes[0].entityId === 'e-1' && item.rows?.[0]?.entityId === 'e-old')) throw new Error(`editor apply callback missing or prior binding rows absent: ${JSON.stringify({ data, requests })}`);
  if (metadataWrites.length !== 3 || metadataWrites[0].rows?.[0]?.entityId !== 'e-old' || metadataWrites[1].rows?.[0]?.entityId !== 'e-old' || !metadataWrites[2].rows?.some((row) => row.entityId === 'e-1' && row.values?.['anchor-a1'] === 'P-101')) throw new Error(`metadata writes did not preserve existing bindings and persist applied rows: ${JSON.stringify(metadataWrites)}`);
  if (!(await page.getByRole('status').getByText('Без замены оставлены строки с ручными правками: 1').count())) throw new Error('native bridge manual-row response was not shown to the user');

  // После правки схемы и конфликта подтверждение требует нового предпросмотра.
  const expectFreshPreview = async () => {
    await page.getByRole('button', { name: 'Предпросмотр заполнения' }).waitFor();
    if (await page.getByRole('button', { name: 'Подтвердить и заполнить' }).count()) throw new Error('Stale confirmation survived invalidation');
  };
  await page.getByRole('button', { name: 'Предпросмотр заполнения' }).click();
  await page.getByRole('button', { name: '2. Поля и шапка' }).click();
  await page.getByRole('button', { name: 'Привязать поле' }).click();
  await page.getByRole('button', { name: '3. Обновление' }).click();
  await expectFreshPreview();
  await page.getByRole('button', { name: 'Предпросмотр заполнения' }).click();
  await page.getByRole('button', { name: '2. Поля и шапка' }).click();
  await page.getByLabel('Текст заголовка 1').fill('Обновлённая шапка ');
  await page.getByRole('button', { name: 'Сохранить схему' }).click();
  await page.getByRole('button', { name: '3. Обновление' }).click();
  await expectFreshPreview();
  await page.getByRole('button', { name: 'Предпросмотр заполнения' }).click();
  await page.getByRole('button', { name: 'Подтвердить и заполнить' }).waitFor();
  await page.getByRole('button', { name: 'Проверить', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить и заполнить' }).waitFor();
  await page.evaluate(() => window.__fluxFixture.changeHash());
  await page.getByRole('button', { name: 'Проверить', exact: true }).click();
  await expectFreshPreview();
  await page.getByRole('button', { name: 'Предпросмотр заполнения' }).click();
  await page.getByRole('button', { name: 'Подтвердить и заполнить' }).waitFor();
  const stateReads = await page.evaluate(() => window.__fluxFixture.ops.filter(item => item.type === 'request-state').length);
  expectedConflict = true;
  await page.getByRole('button', { name: 'Подтвердить и заполнить' }).click();
  await page.getByText('Документ изменился после предпросмотра', { exact: true }).waitFor();
  await expectFreshPreview();
  await page.waitForFunction(count => window.__fluxFixture.ops.filter(item => item.type === 'request-state').length > count, stateReads);
  expectedConflict = false;

  // ── Команды ленты «Flux»: окна шаблонов, выгрузка, переводчик, «Исходная шапка» ──
  const shotBoth = async (name) => {
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => window.__fluxFixture.setTheme(value), theme);
      await page.waitForTimeout(300); // кнопки плавно меняют цвет: снимок сразу после смены темы поймал бы середину перехода
      const outputFile = path.join(outputDir, `${screenshotPrefix}-${name}-${theme}.png`);
      await page.screenshot({ path: outputFile, fullPage: true }); screenshotPaths.push(outputFile);
    }
  };
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.evaluate(() => window.__fluxFixture.command('save-template'));
  const saveDialog = page.getByRole('dialog', { name: 'Сохранить шапку как шаблон' });
  await saveDialog.getByLabel('Название шаблона').fill('Общая шапка');
  await saveDialog.getByLabel('Для всех').check();
  await shotBoth('save-template');
  await saveDialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await saveDialog.waitFor({ state: 'detached' });
  const savedTemplate = requests.filter((item) => item.endpoint === 'template-save').at(-1)?.body;
  if (savedTemplate?.scope !== 'SHARED' || savedTemplate?.name !== 'Общая шапка' || !savedTemplate?.schema?.anchors?.length) throw new Error(`shared template save request wrong: ${JSON.stringify(savedTemplate)}`);
  await page.evaluate(() => window.__fluxFixture.command('pinned'));
  await page.getByRole('dialog', { name: 'Закреплённые шаблоны' }).getByText('Рабочая выборка').waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__fluxFixture.command('export'));
  const exportDialog = page.getByRole('dialog', { name: /Выгрузить:/ });
  await exportDialog.waitFor();
  await shotBoth('export');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__fluxFixture.command('translator'));
  await page.getByRole('heading', { name: /Переводчик/ }).waitFor();
  await shotBoth('translator');
  await page.evaluate(() => window.__fluxFixture.command('source-equipment'));
  await page.getByRole('button', { name: '1. Выборка' }).waitFor();
  // «Вставить все» отдаёт хосту таблицу «заголовки + строки»
  await page.getByRole('button', { name: 'Обновить выборку' }).click();
  await page.getByRole('checkbox', { name: 'Выбрать строку P-101' }).waitFor();
  await page.getByRole('button', { name: 'Вставить все' }).click();
  await page.getByRole('status').filter({ hasText: 'Таблица вставлена' }).waitFor();
  const inserted = (await page.evaluate(() => window.__fluxFixture.ops)).filter((item) => item.type === 'insert-table').at(-1);
  if (!inserted || inserted.rows.length !== 3 || inserted.rows[1][0] !== 'P-101') throw new Error(`insert-all table wrong: ${JSON.stringify(inserted)}`);
  // «Исходная шапка»: без шаблона файла — сообщение, с шаблоном — запись снимка той же записью схемы
  await page.evaluate(() => window.__fluxFixture.command('reset-header'));
  await page.getByText('У файла нет шаблона.').waitFor();
  await page.evaluate(() => { window.__fluxFixture.ops.length = 0; window.__fluxFixture.setTemplate({ templateId: 'template-1', name: 'Рабочая выборка', appliedAt: '2026-10-12T10:00:00.000Z', schema: { version: 1, anchors: [{ kind: 'excel-range', id: 'anchor-a1', sheetName: 'Лист1', address: 'A1', parts: [{ kind: 'text', text: 'Исходный заголовок' }] }] } }); });
  await page.getByRole('checkbox', { name: 'Выбрать строку P-101' }).check();
  await page.getByRole('button', { name: '3. Обновление' }).click();
  await page.getByRole('button', { name: 'Проверить' }).click();
  await page.waitForFunction(() => window.__fluxFixture.ops.some((item) => item.type === 'template-change' && item.template?.templateId === 'template-1'));
  await page.getByRole('button', { name: 'Предпросмотр заполнения' }).click();
  await page.getByRole('button', { name: 'Подтвердить и заполнить' }).waitFor();
  await page.evaluate(() => window.__fluxFixture.command('reset-header'));
  await page.getByRole('button', { name: 'Вернуть', exact: true }).click();
  await expectFreshPreview();
  await page.waitForFunction(() => window.__fluxFixture.ops.some((item) => item.type === 'save-schema'));
  const restore = (await page.evaluate(() => window.__fluxFixture.ops)).filter((item) => item.type === 'save-schema').at(-1);
  if (restore.schema.anchors[0].parts[0].text !== 'Исходный заголовок') throw new Error(`reset-header did not write the snapshot schema: ${JSON.stringify(restore)}`);
  if (failures.length) throw new Error(`browser errors: ${failures.join('; ')}`);
  console.log(JSON.stringify({ editorKind: kind, viewports: [390, 760, 1280], themes: ['light', 'dark'], verified: ['template restoration', 'template query without row-specific exclusions', 'field binding bridge', 'text/operator/union schema save', 'preview/confirm optimistic contract', 'editor apply callback', 'schema+row metadata CAS writes'], apiRequests: requests.map(({ endpoint, body }) => ({ endpoint, body })), editorActions: data.map((item) => item.type), screenshots: screenshotPaths }, null, 2));
} finally { await browser.close(); }
