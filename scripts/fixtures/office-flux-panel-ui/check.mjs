import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../node_modules/playwright-core/index.mjs';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const requests = [];
page.on('pageerror', (error) => requests.push(`pageerror:${error.message}`));
page.on('console', (message) => { if (message.type() === 'error') requests.push(`console:${message.text()}`); });
page.on('response', (response) => { if (response.status() >= 400) requests.push(`http${response.status()}:${response.url()}`); });
page.route('**/api/**', async (route) => {
  const url = new URL(route.request().url());
  const endpoint = url.pathname;
  let body = {};
  if (endpoint === '/api/projects') body = { projects: [{ id: 'p1', name: 'Альфа' }, { id: 'p2', name: 'Бета' }] };
  else if (/\/api\/projects\/[^/]+\/tags$/.test(endpoint)) {
    requests.push(`tags:${decodeURIComponent(endpoint.split('/')[3])}`);
    const secondProject = endpoint.includes('/p2/');
    if (secondProject) await new Promise((resolve) => setTimeout(resolve, 250));
    body = { tags: [{ id: 't1', identifier: secondProject ? 'P-201' : 'P-101', department: 'Механика', metadata: { mainName: 'Насос', dynamicFields: {} } }] };
  } else if (/\/api\/projects\/[^/]+\/systems$/.test(endpoint)) {
    requests.push(`systems:${decodeURIComponent(endpoint.split('/')[3])}`);
    body = { systems: [] };
  } else if (endpoint === '/api/catalog') body = { classes: [], manufacturers: [], families: [], components: [] };
  else if (endpoint === '/api/vdr/registers') body = { registers: [] };
  else if (endpoint.endsWith('/meta')) body = { name: 'Пробный документ' };
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});

try {
  await page.goto(process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4190');
  await page.waitForSelector('#flux-project-picker');
  await page.waitForTimeout(250);
  for (const width of [320, 460]) {
    await page.setViewportSize({ width, height: 760 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.querySelector('#root > div').classList.toggle('dark', value === 'dark'), theme);
      await page.screenshot({ path: path.join('/tmp', `flux-panel-${width}-${theme}.png`), fullPage: true });
      const geometry = await page.evaluate(() => ({
        body: document.body.scrollWidth,
        viewport: innerWidth,
        panel: document.querySelector('aside')?.getBoundingClientRect().width,
        panelScroll: document.querySelector('aside')?.scrollWidth,
        client: document.querySelector('aside')?.clientWidth,
      }));
      if (geometry.body > width || geometry.panelScroll > geometry.client) throw new Error(`horizontal overflow ${width}px ${theme}: ${JSON.stringify(geometry)}`);
    }
  }
  await page.getByLabel('Выбрать строку P-101', { exact: true }).check();
  await page.getByLabel('Выбрать проект для данных Flux').selectOption('p2');
  if (await page.getByLabel('Выбрать строку P-101', { exact: true }).count()) throw new Error('previous project rows remained visible while the new project was loading');
  await page.getByLabel('Выбрать строку P-201', { exact: true }).waitFor();
  if (await page.getByLabel('Выбрать строку P-201', { exact: true }).isChecked()) throw new Error('row selection leaked between projects');
  if (!requests.includes('tags:p2')) throw new Error(`project selection did not load p2: ${requests}`);
  await page.locator('#flux-section-picker').selectOption('export');
  await page.getByLabel('Источник для экспорта').selectOption('equipment');
  await page.waitForTimeout(150);
  if (!requests.includes('systems:p2')) throw new Error(`export source selection did not load equipment: ${requests}`);
  if (requests.some((item) => item.startsWith('console:') || item.startsWith('pageerror:') || item.startsWith('http'))) throw new Error(`browser errors: ${requests}`);
  console.log(JSON.stringify({ widths: [320, 460], themes: ['light', 'dark'], projectSelection: 'p2', exportSource: 'equipment', requests, screenshots: [320, 460].flatMap((width) => ['light', 'dark'].map((theme) => `/tmp/flux-panel-${width}-${theme}.png`)) }, null, 2));
} finally {
  await browser.close();
}
