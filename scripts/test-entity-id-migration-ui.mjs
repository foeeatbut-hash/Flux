import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../node_modules/playwright-core/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4176;
const url = `http://127.0.0.1:${port}/scripts/fixtures/entity-id-migration-ui.html`;
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root, stdio: 'ignore', env: { ...process.env, DISABLE_HMR: 'true' },
});
let browser;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(url)).ok) break; } catch { /* Vite поднимается. */ }
    if (attempt === 99) throw new Error('Entity ID migration UI fixture did not start');
    await delay(100);
  }
  browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('response', response => { if (response.status() >= 400) failures.push(`HTTP ${response.status()} ${response.url()}`); });

  await page.goto(url, { waitUntil: 'networkidle' });
  const before = await page.evaluate(() => window.__migrationFixtureCheck());
  assert.equal(before.activeProjectId, 'legacy-p1');
  assert.equal(before.savedProjectId, 'legacy-p1');
  assert.equal(before.bindings.length, 2);
  assert.equal(before.bindings[1].xmlTargetIdentity.version, 1);
  await page.getByRole('button', { name: 'Проверить сопоставление' }).click();
  await page.getByRole('columnheader', { name: 'Прежний номер' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Применить перенос' }).isDisabled(), true);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать сопоставление' }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^flux-entity-id-mapping-.*\.json$/);

  const screenshots = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    const bounds = await page.locator('main').evaluate(element => {
      const box = element.getBoundingClientRect();
      return { width: box.width, right: box.right, viewport: innerWidth, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
    assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, `horizontal overflow in ${theme}: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.right <= bounds.viewport + 1, `panel overflow in ${theme}: ${JSON.stringify(bounds)}`);
    const screenshot = `/tmp/flux-entity-id-migration-${theme}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    screenshots.push(screenshot);
  }
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Применить перенос' }).click();
  await page.getByRole('status').getByText('Перенос применён').waitFor();
  const afterApply = await page.evaluate(() => window.__migrationFixtureCheck());
  assert.equal(afterApply.activeProjectId, 'PRJ-000014');
  assert.equal(afterApply.savedProjectId, 'PRJ-000014');
  assert.deepEqual(afterApply.bindings.map(({ projectId, systemId, elementId, tagId }) => [projectId, systemId, elementId, tagId]), [
    ['PRJ-000014', 'PRJ-000014-SYS-000001', 'PRJ-000014-EQ-000001', 'PRJ-000014-TAG-000001'],
    ['PRJ-000015', 'PRJ-000015-SYS-000001', 'PRJ-000015-EQ-000001', undefined],
  ]);
  const preserved = afterApply.bindings.map(({ rootId, relativePath, selectedFileRef, xmlTargetIdentity }) => ({ rootId, relativePath, selectedFileRef, xmlTargetIdentity }));
  await page.evaluate(() => window.__migrationFixtureReplay());
  assert.deepEqual(await page.evaluate(() => window.__migrationFixtureCheck()), afterApply, 'replay must be idempotent');
  await page.getByRole('button', { name: 'Отменить перенос' }).click();
  await page.getByRole('status').getByText('Перенос отменён').waitFor();
  const afterUndo = await page.evaluate(() => window.__migrationFixtureCheck());
  assert.equal(afterUndo.activeProjectId, 'legacy-p1');
  assert.equal(afterUndo.savedProjectId, 'legacy-p1');
  assert.deepEqual(afterUndo.bindings.map(({ projectId, systemId, elementId, tagId }) => [projectId, systemId, elementId, tagId]), [
    ['legacy-p1', 'same-system', 'same-position', 'same-tag'],
    ['legacy-p2', 'same-system', 'same-position', undefined],
  ]);
  assert.deepEqual(afterUndo.bindings.map(({ rootId, relativePath, selectedFileRef, xmlTargetIdentity }) => ({ rootId, relativePath, selectedFileRef, xmlTargetIdentity })), preserved,
    'Explorer capabilities, paths, and tagless XML target identity must survive apply and undo');

  const historyFetchesBeforeEvent = await page.evaluate(() => window.__migrationFixtureHistoryFetches());
  await page.evaluate(() => window.__migrationFixtureNotify('APPLIED'));
  await page.waitForFunction(() => window.__migrationFixtureCheck().activeProjectId === 'PRJ-000014');
  assert.ok(await page.evaluate(() => window.__migrationFixtureHistoryFetches()) > historyFetchesBeforeEvent,
    'socket notification must reload the authorized history instead of carrying mappings');
  await page.evaluate(() => window.__migrationFixtureNotify('UNDONE'));
  await page.waitForFunction(() => window.__migrationFixtureCheck().activeProjectId === 'legacy-p1');

  await page.setViewportSize({ width: 390, height: 840 });
  const narrowBounds = await page.locator('main').evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  assert.ok(narrowBounds.scrollWidth <= narrowBounds.clientWidth + 1, `horizontal overflow at narrow width: ${JSON.stringify(narrowBounds)}`);
  const narrowScreenshot = '/tmp/flux-entity-id-migration-narrow.png';
  await page.screenshot({ path: narrowScreenshot, fullPage: true });
  screenshots.push(narrowScreenshot);

  await page.goto(`${url}?blocked=1`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Проверить сопоставление' }).click();
  await page.getByRole('alert').getByText('связан со схемой E3').waitFor();
  assert.equal(await page.getByRole('checkbox').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Применить перенос' }).isDisabled(), true);
  const blockedScreenshot = '/tmp/flux-entity-id-migration-blocked.png';
  await page.screenshot({ path: blockedScreenshot, fullPage: true });
  screenshots.push(blockedScreenshot);

  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ previewBeforeApply: true, localApply: true, replayIdempotent: true, twoProjectIsolation: true, undoRestoresIds: true, capabilitiesPreserved: true, blockersPreventApply: true, socketRefetchesAuthorizedHistory: true, download: download.suggestedFilename(), screenshots }, null, 2));
} finally {
  await browser?.close();
  server.kill();
}
