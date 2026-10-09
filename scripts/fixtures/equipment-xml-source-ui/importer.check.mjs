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
    await page.screenshot({ path: `/tmp/equipment-source-import-${width}-${theme}.png`, fullPage: true });
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
  console.log(JSON.stringify({ result: 'passed', importer: 'preview-only-until-confirmed, apply payload checked', viewports: [360, 1100], themes: ['light', 'dark'] }));
} finally { await browser.close(); }
