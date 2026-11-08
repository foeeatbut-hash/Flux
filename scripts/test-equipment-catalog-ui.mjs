import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../node_modules/playwright-core/index.mjs';
const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/equipment-catalog-ui');
const root = path.resolve(fixture, '../../..');
const port = 4194;
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', path.join(fixture, 'vite.config.ts'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
for (let attempt = 0; attempt < 100; attempt++) {
  try { if ((await fetch(url)).ok) break; } catch { /* Vite is starting */ }
  if (attempt === 99) { server.kill(); throw new Error('Equipment catalog UI fixture did not start'); }
  await delay(100);
}
const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 880, height: 900 } });
const failures = [];
let saved = null;
let storedBinding = null;
let previewValues = null;
let previewRequest = null;
let published = false;
const requests = { project: 0, common: 0 };
page.on('pageerror', error => failures.push(error.message));
page.on('response', response => { if (response.status() >= 400) failures.push(`HTTP ${response.status()} ${response.url()}`); });
page.route('**/api/equipment/component/catalog-fixture/catalog-source', async route => {
  if (route.request().method() === 'PUT') {
    saved = route.request().postDataJSON();
    const model = saved.catalogueSource === 'common' ? commonFamily : catalogFamily;
    storedBinding = { modelId: model.id, code: model.code, manufacturer: 'Завод', sourceType: 'family', catalogueSource: saved.catalogueSource, revision: 'binding-1', sourceRevision: '2026-10-01T00:00:00.000Z', values: saved.values, snapshot: model };
    return route.fulfill({ json: { ok: true, binding: storedBinding } });
  }
  return route.fulfill({ json: { projectId: 'fixture-project', hasProjectCatalog: true, mode: 'hybrid', ...(published ? { binding: {
    modelId: 'vf20', code: 'VF-20', manufacturer: 'Завод', sourceType: 'family', sourceRevision: '2026-10-01T00:00:00.000Z',
    values: { drive: 'electric' }, snapshot: { ...catalogFamily, sourceType: 'family', sourceRevision: '2026-10-01T00:00:00.000Z' },
    catalogueSource: 'project', revision: 'binding-1',
  }, updateAvailable: { ...catalogFamily, sourceType: 'family', sourceRevision: '2026-10-02T00:00:00.000Z', specs: [{ label: { ru: 'Расход воздуха' }, value: { ru: '130' }, unit: 'м³/ч' }] } } : storedBinding ? { binding: storedBinding } : {}), matches: [], effective: [
    { group: 'Параметры', key: 'Расход воздуха', value: '100', unit: 'м³/ч', source: 'xml' },
    { group: 'Параметры', key: 'Привод', value: 'ручной', source: 'xml' },
  ], discrepancies: [], warnings: [] } });
});
const catalogFamily = { id: 'vf20', classId: 'valves', manufacturerId: 'maker', code: 'VF-20', title: { ru: 'Клапан VF-20' }, status: 'full',
  params: [{ key: 'drive', label: { ru: 'Привод' }, kind: 'choice', default: 'manual', values: [{ code: 'manual', label: { ru: 'Ручной' } }, { code: 'electric', label: { ru: 'Электрический' } }] },
    // Размер без умолчания: пока не выбран, список обязан показывать «Выберите…», а не первый вариант
    { key: 'size', label: { ru: 'Размер' }, kind: 'number' }],
  tables: [{ id: 'sizes', rows: [{ verified: true, values: { size: 100 } }, { verified: true, values: { size: 200 } }] }],
  specs: [{ label: { ru: 'Расход воздуха' }, value: { ru: '120' }, unit: 'м³/ч' }, { label: { ru: 'Привод' }, value: { ru: 'электрический' } }], positions: [] };
const commonFamily = { ...catalogFamily, id: 'vf-common', code: 'CM-20', title: { ru: 'Общий клапан CM-20' } };
page.route('**/api/catalog**', route => {
  const parsed = new URL(route.request().url());
  const project = parsed.pathname === '/api/catalog/project';
  if (project && (parsed.searchParams.get('projectId') !== 'fixture-project' || parsed.searchParams.get('source') !== 'project')) throw new Error(`unexpected project catalog query: ${parsed.search}`);
  requests[project ? 'project' : 'common']++;
  return route.fulfill({ json: {
  classes: [{ id: 'valves', code: 'valve', title: { ru: 'Клапаны' } }], manufacturers: [{ id: 'maker', name: 'Завод' }], components: [],
  families: project ? [published ? { ...catalogFamily, title: { ru: 'Клапан VF-20 новая ревизия' } } : catalogFamily] : [commonFamily],
  meta: { vf20: { updatedAt: published ? '2026-10-02T00:00:00.000Z' : '2026-10-01T00:00:00.000Z' }, 'vf-common': { updatedAt: '2026-10-01T00:00:00.000Z' } },
} }); });
page.route('**/api/equipment/component/catalog-fixture/catalog-source/preview', async route => {
  const request = route.request().postDataJSON();
  previewRequest = request;
  previewValues = request.values;
  const electric = request.values?.drive === 'electric';
  return route.fulfill({ json: { code: 'VF-20', manufacturer: 'Завод', changes: [
    { group: 'Параметры', key: 'Расход воздуха', before: '100 м³/ч', after: '120 м³/ч' },
    ...(electric ? [{ group: 'Параметры', key: 'Привод', before: 'ручной', after: 'электрический' }] : []),
  ] } });
});
try {
  await page.goto(url);
  const source = page.getByLabel('Каталог', { exact: true });
  await source.waitFor();
  if (await source.inputValue() !== 'project') throw new Error('project catalog is not selected by default');
  await page.getByRole('textbox', { name: 'Поиск модели каталога' }).fill('VF-20');
  await page.getByRole('button', { name: /VF-20/ }).first().waitFor();
  await source.selectOption('common');
  await page.getByRole('textbox', { name: 'Поиск модели каталога' }).fill('CM-20');
  const commonPreview = page.waitForResponse(response => response.url().endsWith('/catalog-source/preview') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /CM-20/ }).first().click();
  await commonPreview;
  if (await page.getByRole('button', { name: /VF-20/ }).count()) throw new Error('project search results survived the switch to common');
  if (previewRequest?.catalogueSource !== 'common' || previewRequest?.modelId !== 'vf-common' || saved) throw new Error(`common preview wrote data or used the wrong source: ${JSON.stringify(previewRequest)}`);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.includes('Принять все различия') && !button.disabled));
  const commonSave = page.waitForResponse(response => response.url().endsWith('/catalog-source') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Принять все различия' }).click();
  await commonSave;
  if (saved?.catalogueSource !== 'common' || saved?.modelId !== 'vf-common') throw new Error(`common apply used the wrong source: ${JSON.stringify(saved)}`);
  await page.reload();
  await page.getByLabel('Каталог', { exact: true }).waitFor();
  if (await page.getByLabel('Каталог', { exact: true }).inputValue() !== 'common') throw new Error('reload lost the saved common source');
  await page.getByLabel('Выбранная модель').getByText('CM-20').waitFor();
  saved = null; storedBinding = null;
  await page.reload();
  await page.getByLabel('Каталог', { exact: true }).waitFor();
  if (await page.getByLabel('Каталог', { exact: true }).inputValue() !== 'project') throw new Error('project source was not restored for an unbound position');
  await page.getByRole('textbox', { name: 'Поиск модели каталога' }).fill('VF-20');
  const projectPreview = page.waitForResponse(response => response.url().endsWith('/catalog-source/preview') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /VF-20/ }).first().click();
  await projectPreview;
  if (await page.getByRole('button', { name: /CM-20/ }).count()) throw new Error('common search results survived the switch to project');
  if (previewRequest?.catalogueSource !== 'project') throw new Error('project preview omitted catalogueSource');
  if (requests.project < 2 || requests.common < 1) throw new Error(`catalog cache did not change with source: ${JSON.stringify(requests)}`);
  if (saved) throw new Error('selecting a catalog family wrote data before explicit apply');
  await page.getByRole('button', { name: 'Характеристики' }).click();
  const sizeSelect = page.getByRole('combobox', { name: 'Размер' });
  if (await sizeSelect.inputValue() !== '') throw new Error('unset family parameter pretends to have a value');
  if ((await sizeSelect.locator('option:checked').textContent()) !== 'Выберите…') throw new Error('unset family parameter shows a variant instead of the placeholder');
  const variantPreview = page.waitForResponse(response => response.url().endsWith('/catalog-source/preview') && response.request().method() === 'POST' && response.request().postDataJSON().values?.drive === 'electric');
  await page.getByRole('combobox', { name: 'Привод' }).selectOption('electric');
  await variantPreview;
  await page.getByText('Изменения относительно карточки').waitFor();
  if (previewValues?.drive !== 'electric') throw new Error('variant preview did not include the chosen family value');
  if (saved) throw new Error('changing a family variant wrote data before explicit apply');
  for (const width of [1440, 1024]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => { document.documentElement.classList.toggle('dark', value === 'dark'); document.body.style.backgroundColor = value === 'dark' ? '#0f172a' : '#ffffff'; }, theme);
    const bounds = await page.locator('main').evaluate(element => { const box = element.getBoundingClientRect(); const selector = element.querySelector('select'); const rect = selector?.getBoundingClientRect(); const style = selector && getComputedStyle(selector); return { width: box.width, right: box.right, viewport: innerWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, documentScrollWidth: document.documentElement.scrollWidth, selector: rect && { width: rect.width, height: rect.height, left: rect.left, right: rect.right, fontSize: style?.fontSize, fontWeight: style?.fontWeight } }; });
    if (bounds.scrollWidth > bounds.clientWidth + 1) throw new Error(`catalog content overflows horizontally in ${theme}: ${JSON.stringify(bounds)}`);
    if (bounds.right > bounds.viewport + 1) throw new Error(`catalog panel overflows in ${theme}: ${JSON.stringify(bounds)}`);
    if (bounds.documentScrollWidth > width + 1 || !bounds.selector || bounds.selector.width <= 0 || bounds.selector.height <= 0 || bounds.selector.right > bounds.right + 1) throw new Error(`catalog selector overflows in ${width}/${theme}: ${JSON.stringify(bounds)}`);
    console.log(JSON.stringify({ width, theme, bounds }));
    await page.screenshot({ path: path.join('/tmp', `flux-equipment-catalog-ui-${width}-${theme}.png`), omitBackground: false });
  }
  const singleSave = page.waitForResponse(response => response.url().endsWith('/catalog-source') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Принять параметр' }).first().click();
  await singleSave;
  if (!Array.isArray(saved?.acceptedCatalogParams) || saved.acceptedCatalogParams.length !== 1 || saved.acceptedCatalogParams[0] !== 'Параметры||Расход воздуха') throw new Error(`single-parameter apply wrote an invalid accepted address: ${JSON.stringify(saved)}`);
  if (saved.expectedPublishedRevision !== '2026-10-01T00:00:00.000Z') throw new Error(`single-parameter apply omitted its preview revision: ${JSON.stringify(saved)}`);
  if (saved.catalogueSource !== 'project') throw new Error(`project apply omitted catalogueSource: ${JSON.stringify(saved)}`);
  saved = null;
  await page.reload();
  await page.getByLabel('Выбранная модель').getByText('VF-20').waitFor();
  if (await page.getByLabel('Каталог', { exact: true }).inputValue() !== 'project') throw new Error('reload lost the saved project source');
  await page.getByRole('textbox', { name: 'Поиск модели каталога' }).fill('VF-20');
  await page.getByRole('button', { name: /VF-20/ }).first().click();
  await page.getByRole('button', { name: 'Характеристики' }).click();
  previewValues = null;
  const allPreview = page.waitForResponse(response => response.url().endsWith('/catalog-source/preview') && response.request().method() === 'POST' && response.request().postDataJSON().values?.drive === 'electric');
  await page.getByRole('combobox', { name: 'Привод' }).selectOption('electric');
  await allPreview;
  if (previewValues?.drive !== 'electric') throw new Error('all-parameter preview omitted the chosen family value');
  const allSave = page.waitForResponse(response => response.url().endsWith('/catalog-source') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Принять все различия' }).click();
  await allSave;
  if (saved.expectedPublishedRevision !== '2026-10-01T00:00:00.000Z') throw new Error(`all-parameter apply omitted its preview revision: ${JSON.stringify(saved)}`);
  await page.reload();
  await page.getByRole('textbox', { name: 'Поиск модели каталога' }).fill('VF-20');
  await page.getByRole('button', { name: /VF-20/ }).first().click();
  await page.getByRole('button', { name: 'Характеристики' }).click();
  await page.getByRole('combobox', { name: 'Привод' }).selectOption('electric');
  await page.getByText('Изменения относительно карточки').waitFor();
  published = true;
  await page.evaluate(() => window.__publishCatalogRevision?.());
  await page.getByText(/Опубликована новая ревизия 2026-10-02/).waitFor();
  if (await page.getByRole('combobox', { name: 'Привод' }).inputValue() !== 'electric') throw new Error('publication event changed the selected family variant');
  if (!(await page.getByText('Изменения относительно карточки').isVisible())) throw new Error('publication event cleared the existing preview');
  await page.getByText(/Выбранная модель устарела после публикации/).waitFor();
  await page.getByRole('textbox', { name: 'Поиск модели каталога' }).fill('новая ревизия');
  await page.getByRole('button', { name: /новая ревизия/ }).waitFor();
  await page.getByText(/Параметры и источник значения/).click();
  if (!(await page.getByText('100 м³/ч', { exact: true }).isVisible())) throw new Error('publication event changed the frozen project value');
  if (await page.getByRole('button', { name: 'Принять все различия' }).isEnabled()) throw new Error('stale catalog selection remained applicable after publication');
  await page.getByLabel('Источник', { exact: true }).selectOption('xml');
  if (!(await page.getByRole('button', { name: 'Сохранить режим XML' }).isEnabled())) throw new Error('stale catalog selection prevented saving XML-only mode');
} catch (error) {

  throw error;
} finally { await browser.close(); server.kill(); }
if (!saved) throw new Error('explicit catalog acceptance did not persist');
if (saved.expectedVersion !== 1 || saved.values?.drive !== 'electric' || saved.acceptedCatalogParams?.length !== 2) throw new Error(`variant or version was not persisted: ${JSON.stringify(saved)}`);
if (failures.length) throw new Error(`browser errors: ${failures.join('; ')}`);
console.log(JSON.stringify({ previewOnlyBeforeAccept: true, singleAndAllApply: true, publicationRefreshPreservesSnapshotAndSelection: true, accepted: saved.acceptedCatalogParams, expectedVersion: saved.expectedVersion, variant: saved.values, screenshots: [1440, 1024].flatMap(width => ['light', 'dark'].map(theme => `/tmp/flux-equipment-catalog-ui-${width}-${theme}.png`)) }, null, 2));
