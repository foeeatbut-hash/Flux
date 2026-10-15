import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../../../node_modules/playwright-core/index.mjs';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(fixtureDir, '../../..');
const fixtureProjectId = 'equipment-panel-fixture';
const port = Number(process.env.FLUX_EQUIPMENT_PANEL_PORT || 4198);
const url = `http://127.0.0.1:${port}/`;
const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', path.join(fixtureDir, 'vite.config.ts'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
const UNIT = JSON.parse(await fs.readFile(path.join(fixtureDir, 'UNIT.json'), 'utf8'));
const fixtureComponents = UNIT.monoblocks.flatMap(monoblock => monoblock.components);
assert.equal(UNIT.name, '3700-B01-AS-001A');
assert.equal(fixtureComponents.length, 31, 'fixture must keep all concept positions');
assert.equal(fixtureComponents.find(component => component.itemCode === '1.1/клапан1')?.parentElementId, 'comp-2');
assert.equal(fixtureComponents.find(component => component.itemCode === '1.1/клапан1/привод1')?.parentElementId, 'comp-3');
const adaptedUnit = {
  ...UNIT,
  monoblocks: UNIT.monoblocks.map((monoblock) => ({
    ...monoblock,
    components: monoblock.components.map((component) => ({
      ...component,
      specs: JSON.stringify(component.specs || { groups: [] }),
      version: component.version || 1,
      hasConflict: Boolean(component.hasConflict),
      status: component.status || 'OK',
      tags: component.tags || [],
    })),
  })),
};
let browser;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(url)).ok) break; } catch { /* Vite is starting. */ }
    if (attempt === 99) throw new Error('Equipment panel fixture did not start');
    await delay(100);
  }
  browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const screenshots = [];
  const errors = [];

  async function open(theme, width, state) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    page.on('pageerror', error => errors.push(`${state}/${theme}/${width}: ${error.message}`));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${state}/${theme}/${width}: HTTP ${response.status()} ${response.url()}`); });
    await page.route('**/api/**', async route => {
      const endpoint = new URL(route.request().url()).pathname;
      let body = {};
      if (endpoint === '/api/equipment/categories') body = { categories: [
        { id: 'AHU', label: 'Центральные кондиционеры', composite: true },
        { id: 'FAN', label: 'Радиальные вентиляторы' }, { id: 'VALVE', label: 'Клапаны' }, { id: 'CURTAIN', label: 'Воздушные завесы' },
      ] };
      else if (endpoint === `/api/projects/${fixtureProjectId}/systems`) body = { systems: [adaptedUnit] };
      else if (endpoint === `/api/projects/${fixtureProjectId}/tags`) body = { tags: [] };
      else if (endpoint.includes('/settings/equip_visibility_mode')) body = { user: 'admin' };
      else if (endpoint.includes('/settings/equip_visibility')) body = { global: '{}' };
      else if (endpoint.includes('/settings/equip_conflict_mode')) body = { global: 'wait' };
      else if (endpoint.includes('/settings/equip_category_view_')) body = { global: '{}' };
      else if (endpoint === '/api/equipment/view-templates') body = { views: [] };
      else if (endpoint.endsWith('/sources')) body = { sources: [] };
      else if (endpoint.endsWith('/e3/summary')) body = [];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    await page.getByRole('button', { name: /3700-B01-AS-001A/ }).first().click();
    if (state === 'block') await page.getByTestId('equipment-unit-block-comp-2').click();
    if (state === 'valve') await page.getByTestId('equipment-unit-child-comp-3').click();
    const testId = state === 'unit' ? 'equipment-unit-overview' : state === 'block' ? 'equipment-selected-comp-2' : 'equipment-selected-comp-3';
    await page.getByTestId(testId).waitFor();
    const expectedText = state === 'unit' ? UNIT.name : fixtureComponents.find(component => component.id === (state === 'block' ? 'comp-2' : 'comp-3')).name;
    await page.getByText(expectedText, { exact: false }).first().waitFor();
    const shot = path.join('/tmp', `equipment-panel-${state}-${width}-${theme}.png`);
    await page.screenshot({ path: shot, scale: 'css', animations: 'disabled' });
    const stat = await fs.stat(shot);
    assert.ok(stat.size <= 300 * 1024, `${shot} exceeds 300 KiB (${stat.size})`);
    screenshots.push({ state, width, theme, path: shot, bytes: stat.size });
    const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(geometry.scrollWidth <= geometry.width + 1, `${state}/${theme}/${width}: horizontal overflow ${JSON.stringify(geometry)}`);
    if (state === 'block') await page.getByTestId('equipment-compact-navigation').waitFor();
    await page.close();
  }
  for (const width of [1440, 1100]) for (const theme of ['light', 'dark']) for (const state of ['unit', 'block', 'valve']) await open(theme, width, state);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', screens: screenshots }, null, 2));
} finally {
  await browser?.close();
  vite.kill();
}
