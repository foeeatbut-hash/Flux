import { chromium } from '../../../node_modules/playwright-core/index.mjs';

const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const failures = [];
const geometries = [];
const run = async (width, theme) => {
  const page = await browser.newPage({ viewport: { width, height: 850 }, colorScheme: theme });
  page.on('pageerror', error => failures.push(`${width}/${theme}: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') failures.push(`${width}/${theme}: ${message.text()}`); });
  page.on('response', response => { if (response.status() >= 400) failures.push(`${width}/${theme}: HTTP ${response.status()} ${response.url()}`); });
  await page.addInitScript(() => localStorage.setItem('flux.equipmentXmlAutoCheck', '0'));
  await page.goto(`${process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192'}/?width=${width < 500 ? 'narrow' : 'wide'}&theme=${theme}`);
  await page.waitForTimeout(1500);
  if (!(await page.getByRole('button', { name: 'Связать' }).count())) throw new Error(`Panel did not render: ${await page.locator('body').innerText()} ${failures.join(' | ')}`);
  await page.getByRole('button', { name: 'Связать' }).click();
  await page.getByRole('button', { name: 'Выбрать XML' }).click();
  await page.getByText('Проверьте найденный источник перед сохранением').waitFor();
  if (!(await page.getByText('Ревизия', { exact: true }).count())) throw new Error('Preview omits detected revision');
  await page.screenshot({ path: `/tmp/flux-equipment-xml-source-preview-${width}-${theme}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Подтвердить привязку' }).click();
  await page.getByRole('button', { name: 'Проверить' }).waitFor({ timeout: 5000 }).catch(async () => { throw new Error(`Binding did not render: ${await page.locator('body').innerText()}`); });
  await page.getByRole('button', { name: 'Проверить' }).click();
  await page.getByText('Ревизия B · L23.xml', { exact: false }).waitFor();
  await page.getByText('Изменения состава установки', { exact: true }).waitFor();
  const structuralGroup = page.getByRole('group', { name: 'Изменения состава установки' });
  await structuralGroup.getByRole('button', { name: 'Оставить состав' }).click();
  await structuralGroup.getByText('Состав проекта оставлен').waitFor();
  const structuralDecisions = await page.evaluate(() => window.__structuralPayloads);
  if (structuralDecisions?.[0]?.[0]?.id !== 'struct-engine' || structuralDecisions[0][0].action !== 'keep') throw new Error(`Structural decision was not sent: ${JSON.stringify(structuralDecisions)}`);
  await page.getByRole('button', { name: 'Отменить решение' }).click();
  await structuralGroup.getByRole('button', { name: 'Оставить состав' }).waitFor();
  const geometry = await page.evaluate(() => { const panel = document.querySelector('section'); return { width: innerWidth, bodyScroll: document.documentElement.scrollWidth, panelWidth: panel?.clientWidth || 0, panelScroll: panel?.scrollWidth || 0 }; });
  geometries.push({ theme, ...geometry });
  if (geometry.bodyScroll > width + 1 || geometry.panelScroll > geometry.panelWidth + 1) throw new Error(`Horizontal overflow: ${JSON.stringify(geometry)}`);
  await page.screenshot({ path: `/tmp/flux-equipment-xml-source-${width}-${theme}.png`, fullPage: true });
  await page.close();
};

const runTagSwitchRace = async () => {
  const page = await browser.newPage({ viewport: { width: 360, height: 850 } });
  page.on('pageerror', error => failures.push(`tag-switch-race: ${error.message}`));
  await page.goto(`${process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192'}/?width=narrow&race=1`);
  await page.getByRole('button', { name: 'Переключить тег' }).click();
  await page.waitForTimeout(650);
  const text = await page.locator('section').innerText();
  if (!text.includes('XML для тега L24 не привязан') || text.includes('Источник: A')) throw new Error(`Stale source response overwrote the newly selected tag: ${text}`);
  await page.close();
};

const runViewerReadOnly = async () => {
  const page = await browser.newPage({ viewport: { width: 700, height: 850 } });
  page.on('pageerror', error => failures.push(`viewer: ${error.message}`));
  await page.goto(`${process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192'}/?viewer=1`);
  await page.getByRole('button', { name: 'Подробнее' }).click();
  await page.getByText('Ревизия B · L23.xml', { exact: false }).waitFor();
  for (const label of ['Проверить', 'Перепривязать папку', 'Удалить привязку', 'Принять', 'Оставить']) {
    if (await page.getByRole('button', { name: label, exact: true }).count()) throw new Error(`Viewer sees write control: ${label}`);
  }
  const writes = await page.evaluate(() => window.__fixtureWrites);
  if (writes.length) throw new Error(`Viewer performed writes: ${JSON.stringify(writes)}`);
  await page.close();
};

const runUntaggedBindingAndRemap = async (width, theme) => {
  const page = await browser.newPage({ viewport: { width, height: 850 }, colorScheme: theme });
  page.on('pageerror', error => failures.push(`untagged/${width}/${theme}: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') failures.push(`untagged/${width}/${theme}: ${message.text()}`); });
  page.on('response', response => { if (response.status() >= 400) failures.push(`untagged/${width}/${theme}: HTTP ${response.status()} ${response.url()}`); });
  await page.addInitScript(() => localStorage.setItem('flux.equipmentXmlAutoCheck', '0'));
  await page.goto(`${process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192'}/?untagged=1&width=${width < 500 ? 'narrow' : 'wide'}&theme=${theme}`);
  await page.getByRole('button', { name: 'Связать' }).click();
  await page.getByRole('button', { name: 'Выбрать XML' }).click();
  await page.getByText('Проверьте найденный источник перед сохранением').waitFor();
  const confirm = page.getByRole('button', { name: 'Подтвердить привязку' });
  if (!(await confirm.isDisabled())) throw new Error('Tagless binding enabled before an XML node was explicitly selected');
  await page.getByRole('combobox', { name: 'XML-узел' }).selectOption({ label: 'Позиция · L23 · установка 1' });
  if (await confirm.isDisabled()) throw new Error('Tagless binding stayed disabled after selecting an XML node');
  await confirm.click();
  await page.getByRole('button', { name: 'Проверить' }).waitFor();
  const payloads = await page.evaluate(() => window.__sourcePayloads);
  if (payloads?.length !== 1 || payloads[0].tagId !== undefined || payloads[0].xmlTargetIdentity?.fingerprint?.code !== 'L23') throw new Error(`Tagless binding did not send only its explicit XML identity: ${JSON.stringify(payloads)}`);
  await page.getByRole('button', { name: 'Выбрать XML-узел' }).click();
  await page.getByText('Выберите XML-узел и подтвердите перепривязку.').waitFor();
  const remapConfirm = page.getByRole('button', { name: 'Подтвердить перепривязку' });
  if (!(await remapConfirm.isDisabled())) throw new Error('XML remap enabled before selecting a replacement target');
  await page.getByRole('combobox', { name: 'XML-узел' }).selectOption({ label: 'Позиция · L23 · установка 1 · проверенный новый узел' });
  if (await remapConfirm.isDisabled()) throw new Error('XML remap stayed disabled after selecting a replacement target');
  await remapConfirm.click();
  await page.getByText('XML-узел перепривязан после явной проверки.').waitFor();
  const remaps = await page.evaluate(() => window.__sourceRemapPayloads);
  if (remaps?.length !== 1 || remaps[0].xmlTargetIdentity?.componentIndex !== 1 || remaps[0].xmlTargetIdentity?.fingerprint?.code !== 'L23-remapped') throw new Error(`Changed XML target was not explicitly remapped: ${JSON.stringify(remaps)}`);
  const geometry = await page.evaluate(() => { const panel = document.querySelector('section'); return { width: innerWidth, bodyScroll: document.documentElement.scrollWidth, panelWidth: panel?.clientWidth || 0, panelScroll: panel?.scrollWidth || 0 }; });
  geometries.push({ theme, untagged: true, ...geometry });
  if (geometry.bodyScroll > width + 1 || geometry.panelScroll > geometry.panelWidth + 1) throw new Error(`Untagged horizontal overflow: ${JSON.stringify(geometry)}`);
  await page.close();
};

try {
  for (const width of [360, 1100]) for (const theme of ['light', 'dark']) await run(width, theme);
  await runTagSwitchRace();
  await runViewerReadOnly();
  for (const width of [360, 1100]) for (const theme of ['light', 'dark']) await runUntaggedBindingAndRemap(width, theme);
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(JSON.stringify({ result: 'passed', previewBindingRevisionComparison: 'passed', tagSwitchRace: 'passed', geometries, screenshots: [360, 1100].flatMap(width => ['light', 'dark'].flatMap(theme => [`/tmp/flux-equipment-xml-source-preview-${width}-${theme}.png`, `/tmp/flux-equipment-xml-source-${width}-${theme}.png`])) }, null, 2));
} finally { await browser.close(); }
