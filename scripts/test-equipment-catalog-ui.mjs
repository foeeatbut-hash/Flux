import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../node_modules/playwright-core/index.mjs';
const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/equipment-catalog-ui');
const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 880, height: 900 } });
const failures = [];
let saved = null;
let previewValues = null;
page.on('pageerror', error => failures.push(error.message));
page.on('response', response => { if (response.status() >= 400) failures.push(`HTTP ${response.status()} ${response.url()}`); });
page.route('**/api/equipment/component/catalog-fixture/catalog-source', async route => {
  if (route.request().method() === 'PUT') { saved = route.request().postDataJSON(); return route.fulfill({ json: { ok: true, binding: { modelId: 'vf20' } } }); }
  return route.fulfill({ json: { mode: 'hybrid', matches: [], effective: [
    { group: 'Параметры', key: 'Расход воздуха', value: '100', unit: 'м³/ч', source: 'xml' },
    { group: 'Параметры', key: 'Привод', value: 'ручной', source: 'xml' },
  ], discrepancies: [], warnings: [] } });
});
page.route('**/api/catalog', route => route.fulfill({ json: {
  classes: [{ id: 'valves', code: 'valve', title: { ru: 'Клапаны' } }], manufacturers: [{ id: 'maker', name: 'Завод' }], components: [],
  families: [{ id: 'vf20', classId: 'valves', manufacturerId: 'maker', code: 'VF-20', title: { ru: 'Клапан VF-20' }, status: 'full',
    params: [{ key: 'drive', label: { ru: 'Привод' }, kind: 'choice', default: 'manual', values: [{ code: 'manual', label: { ru: 'Ручной' } }, { code: 'electric', label: { ru: 'Электрический' } }] }],
    specs: [{ label: { ru: 'Расход воздуха' }, value: { ru: '120' }, unit: 'м³/ч' }, { label: { ru: 'Привод' }, value: { ru: 'электрический' } }], positions: [] }],
  meta: { vf20: { updatedAt: '2026-10-01T00:00:00.000Z' } },
} }));
page.route('**/api/equipment/component/catalog-fixture/catalog-source/preview', async route => {
  const request = route.request().postDataJSON();
  previewValues = request.values;
  const electric = request.values?.drive === 'electric';
  return route.fulfill({ json: { code: 'VF-20', manufacturer: 'Завод', changes: [
    { group: 'Параметры', key: 'Расход воздуха', before: '100 м³/ч', after: '120 м³/ч' },
    ...(electric ? [{ group: 'Параметры', key: 'Привод', before: 'ручной', after: 'электрический' }] : []),
  ] } });
});
try {
  await page.goto(process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4196');
  await page.getByRole('textbox', { name: 'Поиск модели каталога' }).fill('VF-20');
  await page.getByRole('button', { name: /VF-20/ }).first().click();
  if (saved) throw new Error('selecting a catalog family wrote data before explicit apply');
  await page.getByRole('button', { name: 'Характеристики' }).click();
  await page.getByRole('combobox', { name: 'Привод' }).selectOption('electric');
  await page.getByText('Изменения относительно карточки').waitFor();
  const previewDeadline = Date.now() + 5000;
  while (previewValues?.drive !== 'electric' && Date.now() < previewDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  if (previewValues?.drive !== 'electric') throw new Error('variant preview did not include the chosen family value');
  if (saved) throw new Error('changing a family variant wrote data before explicit apply');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    const bounds = await page.locator('main').evaluate(element => { const box = element.getBoundingClientRect(); return { width: box.width, right: box.right, viewport: innerWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }; });
    if (bounds.scrollWidth > bounds.clientWidth + 1) throw new Error(`catalog content overflows horizontally in ${theme}: ${JSON.stringify(bounds)}`);
    if (bounds.right > bounds.viewport + 1) throw new Error(`catalog panel overflows in ${theme}: ${JSON.stringify(bounds)}`);
    await page.screenshot({ path: path.join('/tmp', `flux-equipment-catalog-ui-${theme}.png`) });
  }
  await page.getByRole('button', { name: 'Принять параметр' }).first().click();
  const saveDeadline = Date.now() + 5000;
  while (!saved && Date.now() < saveDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  if (!Array.isArray(saved?.acceptedCatalogParams) || saved.acceptedCatalogParams.length !== 1 || saved.acceptedCatalogParams[0] !== 'Параметры||Расход воздуха') throw new Error(`single-parameter apply wrote an invalid accepted address: ${JSON.stringify(saved)}`);
  saved = null;
  await page.reload();
  await page.getByRole('textbox', { name: 'Поиск модели каталога' }).fill('VF-20');
  await page.getByRole('button', { name: /VF-20/ }).first().click();
  await page.getByRole('button', { name: 'Характеристики' }).click();
  previewValues = null;
  await page.getByRole('combobox', { name: 'Привод' }).selectOption('electric');
  const allPreviewDeadline = Date.now() + 5000;
  while (previewValues?.drive !== 'electric' && Date.now() < allPreviewDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  await page.getByRole('button', { name: 'Принять все различия' }).click();
  const allSaveDeadline = Date.now() + 5000;
  while (!saved && Date.now() < allSaveDeadline) await new Promise(resolve => setTimeout(resolve, 20));
} catch (error) {

  throw error;
} finally { await browser.close(); }
if (!saved) throw new Error('explicit catalog acceptance did not persist');
if (saved.expectedVersion !== 1 || saved.values?.drive !== 'electric' || saved.acceptedCatalogParams?.length !== 2) throw new Error(`variant or version was not persisted: ${JSON.stringify(saved)}`);
if (failures.length) throw new Error(`browser errors: ${failures.join('; ')}`);
console.log(JSON.stringify({ previewOnlyBeforeAccept: true, singleAndAllApply: true, accepted: saved.acceptedCatalogParams, expectedVersion: saved.expectedVersion, variant: saved.values, screenshots: ['light', 'dark'].map(theme => `/tmp/flux-equipment-catalog-ui-${theme}.png`) }, null, 2));
