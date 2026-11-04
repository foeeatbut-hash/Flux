import os from 'node:os';
import path from 'node:path';
import { chromium } from '../../../node_modules/playwright-core/index.mjs';
import { pickXmlFile } from './picker.mjs';
const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  for (const width of ['narrow', 'wide']) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: width === 'narrow' ? 360 : 1100, height: 850 }, colorScheme: theme });
    page.on('pageerror', error => { throw error; });
    await page.goto(`${process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192'}/importer.html?width=${width}&theme=${theme}`);
    const logs = () => page.evaluate(() => window.__importLog);
    await page.getByRole('button', { name: 'Выбрать XML-файл' }).click();
    await pickXmlFile(page);
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
    // Партия XML-импорта запоминается для строки «можно отменить импорт» (как у старого пути)
    const remembered = await page.evaluate(() => JSON.parse(localStorage.getItem('flux_last_import_project-fixture') || 'null'));
    if (remembered?.batchId !== 'batch-xml-1') throw new Error(`XML import batch was not remembered for undo: ${JSON.stringify(remembered)}`);
    // План построен до записи: после успеха «Подтвердить» на нём дал бы 409
    if (await page.getByRole('button', { name: /Подтвердить импорт/ }).count()) throw new Error('Confirm button stayed active on a stale plan after a successful import');
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
  {
    // Тег файла уже привязан к другому оборудованию: предупреждение сводкой и у строки, «Связать» молча нет
    const takenPage = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    takenPage.on('pageerror', error => { throw error; });
    await takenPage.goto(`${process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192'}/importer.html?taken=1`);
    await takenPage.getByRole('button', { name: 'Выбрать XML-файл' }).click();
    await pickXmlFile(takenPage);
    await takenPage.getByRole('button', { name: 'Показать план' }).click();
    await takenPage.getByRole('heading', { name: /Предпросмотр/ }).waitFor();
    await takenPage.getByRole('alert').filter({ hasText: 'уже привязаны к другому оборудованию' }).filter({ hasText: 'Чужой бак · установка L99' }).waitFor();
    await takenPage.getByTestId('tag-taken').first().waitFor();
    if (!(await takenPage.getByRole('button', { name: 'Подтвердить импорт' }).isDisabled())) throw new Error('Confirm must wait for an explicit choice on a taken tag');
    await takenPage.getByRole('button', { name: /Действие с тегом L23$/ }).click();
    await takenPage.getByRole('option', { name: /^Пропустить/ }).click();
    if (await takenPage.getByRole('button', { name: 'Подтвердить импорт' }).isDisabled()) throw new Error('Explicit choice must unlock the import');
    await takenPage.close();
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
  await pickXmlFile(racePage);
  await racePage.getByRole('button', { name: 'Показать план' }).click();
  await racePage.getByRole('button', { name: 'Переключить проект' }).click();
  await racePage.waitForTimeout(650);
  if (await racePage.getByRole('heading', { name: /Предпросмотр/ }).count()) throw new Error('A preview from the previous project reappeared after switching projects');
  if ((await racePage.evaluate(() => window.__importLog)).some(entry => entry.url.endsWith('/apply'))) throw new Error('Stale preview was submitted after a project switch');
  await racePage.close();
  const applyRacePage = await browser.newPage({ viewport: { width: 700, height: 850 } });
  await applyRacePage.goto(`${process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192'}/importer.html?race=1`);
  await applyRacePage.getByRole('button', { name: 'Выбрать XML-файл' }).click();
  await pickXmlFile(applyRacePage);
  await applyRacePage.getByRole('button', { name: 'Показать план' }).click();
  await applyRacePage.getByRole('heading', { name: /Предпросмотр/ }).waitFor();
  await applyRacePage.getByRole('button', { name: 'Подтвердить импорт' }).click();
  await applyRacePage.getByRole('button', { name: 'Переключить проект' }).click();
  await applyRacePage.waitForTimeout(650);
  if (await applyRacePage.getByTestId('import-done').innerText()) throw new Error('A delayed apply callback ran after switching projects');
  if (await applyRacePage.evaluate(() => localStorage.getItem('flux.equipmentSources.local.v1'))) throw new Error('A delayed apply saved a binding after switching projects');
  await applyRacePage.close();
  // Панель плана на длинном плане: таблица в одну строку на позицию, без вложенной прокрутки,
  // с закреплёнными шапкой и подвалом, групповыми действиями и фильтром-сводкой
  for (const theme of ['light', 'dark']) {
    const planPage = await browser.newPage({ viewport: { width: 1100, height: 700 }, colorScheme: theme });
    planPage.on('pageerror', error => { throw error; });
    await planPage.goto(`${process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192'}/importer.html?initial=1&rows=31&theme=${theme}`);
    await planPage.getByRole('heading', { name: /Предпросмотр/ }).waitFor();
    const table = planPage.getByRole('table');
    await table.waitFor();
    const rowCount = await table.locator('tbody tr').count();
    if (rowCount !== 32) throw new Error(`Plan table must have one row per position (32), got ${rowCount}`);
    const geometry = await planPage.evaluate(() => {
      const section = document.querySelector('[aria-label="План импорта"]');
      const nested = Array.from(section.querySelectorAll('*')).filter(el => /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1).length;
      const heights = Array.from(section.querySelectorAll('tbody tr')).map(row => Math.round(row.getBoundingClientRect().height));
      const selects = section.querySelectorAll('select').length;
      return { nested, maxRow: Math.max(...heights), selects, scroll: document.documentElement.scrollWidth, width: innerWidth };
    });
    if (geometry.nested) throw new Error(`Plan list must not scroll inside itself: ${JSON.stringify(geometry)}`);
    if (geometry.maxRow > 40) throw new Error(`Plan rows must be a single line (<=40px): ${JSON.stringify(geometry)}`);
    if (geometry.selects) throw new Error(`Plan must use Flux selects, not native: ${JSON.stringify(geometry)}`);
    if (geometry.scroll > geometry.width + 1) throw new Error(`Horizontal overflow: ${JSON.stringify(geometry)}`);
    await planPage.evaluate(() => window.scrollTo(0, 900));
    await planPage.waitForTimeout(150);
    const pinned = await planPage.evaluate(() => {
      const head = document.querySelector('[aria-label="План импорта"] thead th').getBoundingClientRect();
      const confirm = Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('Подтвердить импорт')).getBoundingClientRect();
      return { headTop: Math.round(head.top), confirmBottom: Math.round(confirm.bottom), viewport: innerHeight };
    });
    if (pinned.headTop > 1 || pinned.confirmBottom > pinned.viewport) throw new Error(`Table header and confirm footer must stay pinned: ${JSON.stringify(pinned)}`);
    await planPage.screenshot({ path: path.join(os.tmpdir(), `equipment-plan-table-${theme}.png`) });
    await planPage.evaluate(() => window.scrollTo(0, 0));
    // Сводка — фильтр: «Новых» оставляет новые позиции, а пункт «Требуют выбора» ведёт к спорной
    await planPage.getByRole('button', { name: /^Требуют выбора/ }).click();
    if (await table.locator('tbody tr').count() !== 1) throw new Error('Filter "Требуют выбора" must leave only the undecided row');
    if (!(await planPage.getByRole('button', { name: 'Подтвердить импорт' }).isDisabled())) throw new Error('Confirm must stay disabled while a tag choice is open');
    // Групповые действия: все новые — «Создать», все точные — «Связать»
    await planPage.getByRole('button', { name: /^Все/ }).click();
    await planPage.getByRole('button', { name: /^Связать все точные/ }).click();
    await planPage.getByRole('button', { name: /^Создать все новые/ }).click();
    const labels = await table.locator('tbody tr button[aria-haspopup="listbox"]').evaluateAll(buttons => buttons.map(button => button.textContent.trim()));
    if (labels.filter(text => text === 'Связать').length !== 4 || labels.filter(text => text === 'Создать').length < 26) throw new Error(`Bulk actions did not apply: ${JSON.stringify(labels)}`);
    // Спорная строка решается из списка действий, после чего импорт можно подтвердить
    await table.getByRole('button', { name: /Действие с тегом L23-DM-010A/ }).click();
    await planPage.getByRole('option', { name: /^Связать с L23-DM-010A-1/ }).click();
    await planPage.getByRole('button', { name: 'Подтвердить импорт' }).click();
    await planPage.getByText(/^Импортирован:/).waitFor();
    const applied = (await planPage.evaluate(() => window.__importLog)).find(entry => entry.url.endsWith('/apply'));
    const decided = applied?.body?.tagLinks?.find(link => link.identifier === 'L23-DM-010A');
    if (decided?.action !== 'link' || decided.existingTagId !== 'tag-x1') throw new Error(`Apply must carry the chosen tag link: ${JSON.stringify(decided)}`);
    if (applied.body.tagLinks.filter(link => link.action === 'link').length !== 5) throw new Error('Apply must carry 4 exact links plus the decided one');
    await planPage.close();
  }
  // Настоящий план содержит корневую запись установки (__unit__) с тем же ключом, что у тега
  // установки: селектор тега один (в её строке), а групповое «Создать все новые» считает тег один раз
  {
    const unitPage = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    unitPage.on('pageerror', error => { throw error; });
    await unitPage.goto(`${process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192'}/importer.html?initial=1&rows=31&unitRow=1`);
    await unitPage.getByRole('heading', { name: /Предпросмотр/ }).waitFor();
    const unitSelectors = await unitPage.getByRole('table').getByRole('button', { name: /Действие с тегом L23$/ }).count();
    if (unitSelectors !== 1) throw new Error(`Unit tag must have exactly one action selector, got ${unitSelectors}`);
    const bulk = await unitPage.getByRole('button', { name: /^Создать все новые/ }).innerText();
    // 31 позиция: 4 точных совпадения и 1 спорная — остальные 26 создаются, плюс тег установки (28 — это дубль строки)
    if (!/· 27$/.test(bulk.trim())) throw new Error(`Bulk create must count the unit tag once: ${bulk}`);
    await unitPage.close();
  }
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
