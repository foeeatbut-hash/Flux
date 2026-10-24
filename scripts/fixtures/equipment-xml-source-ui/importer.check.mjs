import os from 'node:os';
import path from 'node:path';
import { chromium } from '../../../node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  for (const width of ['narrow', 'wide']) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: width === 'narrow' ? 360 : 1100, height: 850 }, colorScheme: theme });
    page.on('pageerror', error => { throw error; });
    await page.goto(`${process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192'}/importer.html?width=${width}&theme=${theme}`);
    const logs = () => page.evaluate(() => window.__importLog);
    await page.getByRole('button', { name: 'Выбрать XML-файл' }).click();
    await page.getByRole('button', { name: 'Показать план' }).click();
    await page.getByRole('heading', { name: /Предпросмотр/ }).waitFor();
    await page.getByText(/ручных значений\. Импорт ждёт отдельного разрешения конфликта/).waitFor();
    if ((await logs()).some(entry => entry.url.endsWith('/apply'))) throw new Error('Preview triggered an import write');
    if (await page.evaluate(() => localStorage.getItem('flux.equipmentSources.local.v1'))) throw new Error('Local source capability was saved before import apply');
    await page.screenshot({ path: path.join(os.tmpdir(), `equipment-source-import-${width}-${theme}.png`), fullPage: true });
    const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    if (geometry.scroll > geometry.width + 1) throw new Error(`Horizontal overflow: ${JSON.stringify(geometry)}`);
    await page.getByRole('button', { name: 'Подтвердить импорт' }).click();
    await page.getByText('Импортирован: system-1 · L23 · baselineApplied=false').waitFor();
    const bindingStore = await page.evaluate(() => JSON.parse(localStorage.getItem('flux.equipmentSources.local.v1') || '{}'));
    if (!Object.values(bindingStore).some((binding) => binding.sourceId === 'source-1')) throw new Error('Successful import did not save the local source capability');
    const entries = await logs();
    const apply = entries.find(entry => entry.url.endsWith('/apply'));
    if (!apply || apply.body.tagIdentifier !== 'L23' || apply.body.selection !== undefined || apply.body.previewToken !== 'fixture-preview-token' || apply.body.tagLinks[0]?.action !== 'create') throw new Error(`Apply contract mismatch: ${JSON.stringify(apply)}`);
    await page.close();
  }
  for (const theme of ['light', 'dark']) {
    const initialPage = await browser.newPage({ viewport: { width: 900, height: 850 }, colorScheme: theme });
    initialPage.on('pageerror', error => { throw error; });
    await initialPage.goto((process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192') + '/importer.html?initial=1&theme=' + theme);
    // Файл из очереди мастера: план появляется сам, без повторного выбора файла и папки.
    await initialPage.getByRole('heading', { name: /Предпросмотр/ }).waitFor();
    if (await initialPage.getByLabel('Тег оборудования').inputValue() !== 'L23') throw new Error('Queued file did not seed the tag');
    if (await initialPage.getByRole('button', { name: /Выбрать XML/ }).count()) throw new Error('Queued file still asks to pick the XML again');
    const reads = await initialPage.evaluate(() => (window).__importLog.filter(row => row.url.endsWith('/source-import/preview')).length);
    if (reads !== 1) throw new Error(`Queued file must build exactly one plan, got ${reads}`);
    await initialPage.close();
  }
  const initialRace = await browser.newPage({ viewport: { width: 900, height: 850 } });
  await initialRace.goto((process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192') + '/importer.html?initial=1&race=1');
  await initialRace.getByRole('button', { name: 'Переключить проект' }).click();
  await initialRace.waitForTimeout(800);
  if (await initialRace.getByRole('button', { name: 'Показать план' }).count()) throw new Error('Previous project initial file appeared after project change');
  await initialRace.close();
  const racePage = await browser.newPage({ viewport: { width: 700, height: 850 } });
  await racePage.goto(`${process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192'}/importer.html?race=1`);
  await racePage.getByRole('button', { name: 'Выбрать XML-файл' }).click();
  await racePage.getByRole('button', { name: 'Показать план' }).click();
  await racePage.getByRole('button', { name: 'Переключить проект' }).click();
  await racePage.waitForTimeout(650);
  if (await racePage.getByRole('heading', { name: /Предпросмотр/ }).count()) throw new Error('A preview from the previous project reappeared after switching projects');
  if ((await racePage.evaluate(() => window.__importLog)).some(entry => entry.url.endsWith('/apply'))) throw new Error('Stale preview was submitted after a project switch');
  await racePage.close();
  const applyRacePage = await browser.newPage({ viewport: { width: 700, height: 850 } });
  await applyRacePage.goto(`${process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192'}/importer.html?race=1`);
  await applyRacePage.getByRole('button', { name: 'Выбрать XML-файл' }).click();
  await applyRacePage.getByRole('button', { name: 'Показать план' }).click();
  await applyRacePage.getByRole('heading', { name: /Предпросмотр/ }).waitFor();
  await applyRacePage.getByRole('button', { name: 'Подтвердить импорт' }).click();
  await applyRacePage.getByRole('button', { name: 'Переключить проект' }).click();
  await applyRacePage.waitForTimeout(650);
  if (await applyRacePage.getByTestId('import-done').innerText()) throw new Error('A delayed apply callback ran after switching projects');
  if (await applyRacePage.evaluate(() => localStorage.getItem('flux.equipmentSources.local.v1'))) throw new Error('A delayed apply saved a binding after switching projects');
  await applyRacePage.close();
  const documentPage = await browser.newPage({ viewport: { width: 900, height: 850 }, colorScheme: 'dark' });
  await documentPage.goto(`${process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192'}/importer.html?document=1`);
  await documentPage.getByText('L23.xlsx', { exact: true }).waitFor();
  const docLogs = () => documentPage.evaluate(() => window.__importLog);
  if ((await docLogs()).some(entry => entry.url.endsWith('/import-draft'))) throw new Error('Document plan triggered a write before human confirmation');
  await documentPage.getByRole('button', { name: 'Импортировать 1', exact: true }).click();
  await documentPage.getByText('Документ импортирован · shared-document-binding-1').waitFor();
  const docCommit = (await docLogs()).find(entry => entry.url.endsWith('/equipment/import-draft'));
  const source = docCommit?.body?.sourceBinding;
  if (source?.kind !== 'document' || source.id !== 'shared-document-binding-1' || source.expectedLedgerRevision !== 7 || source.fileName !== 'L23.xlsx' || source.revision !== 'R2' || source.sha256 !== 'c'.repeat(64) || source.locator?.folderKey !== 'a'.repeat(64) || source.locator?.anchors?.[0]?.relativePath !== 'R2') throw new Error(`Document revision commit lost its typed identity or portable provenance: ${JSON.stringify(source)}`);
  await documentPage.close();
  console.log(JSON.stringify({ result: 'passed', importer: 'XML preview-only-until-confirmed and document reimport payload identity/provenance checked', viewports: [360, 1100], themes: ['light', 'dark'] }));
} finally { await browser.close(); }
