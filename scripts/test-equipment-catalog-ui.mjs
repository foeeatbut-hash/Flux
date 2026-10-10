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
let previewValues = null;
let published = false;
page.on('pageerror', error => failures.push(error.message));
page.on('response', response => { if (response.status() >= 400) failures.push(`HTTP ${response.status()} ${response.url()}`); });
page.route('**/api/equipment/component/catalog-fixture/catalog-source', async route => {
  if (route.request().method() === 'PUT') { saved = route.request().postDataJSON(); return route.fulfill({ json: { ok: true, binding: { modelId: 'vf20' } } }); }
  return route.fulfill({ json: { mode: 'hybrid', ...(published ? { binding: {
    modelId: 'vf20', code: 'VF-20', manufacturer: 'Завод', sourceType: 'family', sourceRevision: '2026-10-01T00:00:00.000Z',
    values: { drive: 'electric' }, snapshot: { ...catalogFamily, sourceType: 'family', sourceRevision: '2026-10-01T00:00:00.000Z' },
  }, updateAvailable: { ...catalogFamily, sourceType: 'family', sourceRevision: '2026-10-02T00:00:00.000Z', specs: [{ label: { ru: 'Расход воздуха' }, value: { ru: '130' }, unit: 'м³/ч' }] } } : {}), matches: [], effective: [
    { group: 'Параметры', key: 'Расход воздуха', value: '100', unit: 'м³/ч', source: 'xml' },
    { group: 'Параметры', key: 'Привод', value: 'ручной', source: 'xml' },
  ], discrepancies: [], warnings: [] } });
});
const catalogFamily = { id: 'vf20', classId: 'valves', manufacturerId: 'maker', code: 'VF-20', title: { ru: 'Клапан VF-20' }, status: 'full',
  params: [{ key: 'drive', label: { ru: 'Привод' }, kind: 'choice', default: 'manual', values: [{ code: 'manual', label: { ru: 'Ручной' } }, { code: 'electric', label: { ru: 'Электрический' } }] }],
  specs: [{ label: { ru: 'Расход воздуха' }, value: { ru: '120' }, unit: 'м³/ч' }, { label: { ru: 'Привод' }, value: { ru: 'электрический' } }], positions: [] };
page.route('**/api/catalog', route => route.fulfill({ json: {
  classes: [{ id: 'valves', code: 'valve', title: { ru: 'Клапаны' } }], manufacturers: [{ id: 'maker', name: 'Завод' }], components: [],
  families: [published ? { ...catalogFamily, title: { ru: 'Клапан VF-20 новая ревизия' } } : catalogFamily],
  meta: { vf20: { updatedAt: published ? '2026-10-02T00:00:00.000Z' : '2026-10-01T00:00:00.000Z' } },
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
  await page.goto(url);
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
  if (saved.expectedPublishedRevision !== '2026-10-01T00:00:00.000Z') throw new Error(`single-parameter apply omitted its preview revision: ${JSON.stringify(saved)}`);
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
console.log(JSON.stringify({ previewOnlyBeforeAccept: true, singleAndAllApply: true, publicationRefreshPreservesSnapshotAndSelection: true, accepted: saved.acceptedCatalogParams, expectedVersion: saved.expectedVersion, variant: saved.values, screenshots: ['light', 'dark'].map(theme => `/tmp/flux-equipment-catalog-ui-${theme}.png`) }, null, 2));
