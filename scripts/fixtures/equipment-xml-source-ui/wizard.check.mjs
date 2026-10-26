import { chromium } from '../../../node_modules/playwright-core/index.mjs';

const base = process.env.FLUX_FIXTURE_URL || 'http://127.0.0.1:4192';
const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const failures = [];
const assert = (ok, message, details) => { if (!ok) failures.push(`${message}${details === undefined ? '' : `: ${JSON.stringify(details)}`}`); };
const makePage = async (width, theme, route = 'wizard.html') => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
  page.on('pageerror', error => failures.push(`pageerror: ${error.stack || error.message}`));
  const url = new URL(`${base}/${route}`);
  url.searchParams.set('theme', theme);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  return page;
};
const logs = page => page.evaluate(() => (window).__wizardLog || []);
try {
  for (const [label, width] of [['narrow', 390], ['medium', 768], ['wide', 1440]]) for (const theme of ['light', 'dark']) {
    const page = await makePage(width, theme);
    await page.getByText('doc-a.csv', { exact: true }).waitFor({ timeout: 30000 });
    await page.getByText(/позиц\./).first().waitFor({ timeout: 30000 });
    const mainBackground = await page.locator('main').evaluate(element => {
      const background = getComputedStyle(element).backgroundColor;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D context is unavailable');
      context.fillStyle = background;
      context.fillRect(0, 0, 1, 1);
      return {
        background,
        rgba: Array.from(context.getImageData(0, 0, 1, 1).data),
        darkClass: document.documentElement.classList.contains('dark'),
      };
    });
    const [red, green, blue, alpha] = mainBackground.rgba;
    const themeApplied = theme === 'dark'
      ? mainBackground.darkClass && alpha === 255 && Math.max(red, green, blue) < 80
      : !mainBackground.darkClass && alpha === 255 && Math.min(red, green, blue) > 240;
    assert(themeApplied, `${theme} theme is applied to the rendered wizard`, mainBackground);
    const layout = await page.locator('.fx-dialog').evaluate(dialog => {
        const workspace = dialog.querySelector(':scope > .flex-1.min-h-0');
        const main = workspace?.children[1];
        const footerButton = Array.from(dialog.querySelectorAll('button')).find(button => button.textContent.includes('Проверить и импортировать'));
        const buttonRect = footerButton?.getBoundingClientRect();
        const dialogRect = dialog.getBoundingClientRect();
        const footerRect = footerButton?.parentElement?.getBoundingClientRect();
        const overflowing = Array.from(dialog.querySelectorAll('*')).flatMap(element => {
          const rect = element.getBoundingClientRect();
          return rect.right > dialogRect.right + 1 || rect.left < dialogRect.left - 1
            ? [{ tag: element.tagName, className: typeof element.className === 'string' ? element.className : '', left: rect.left, right: rect.right, width: rect.width }]
            : [];
        }).slice(0, 12);
        return {
          dialogWidth: dialog.clientWidth,
          dialogScrollWidth: dialog.scrollWidth,
          overflowing,
          workspaceWidth: workspace?.clientWidth || 0,
          workspaceScrollWidth: workspace?.scrollWidth || 0,
          mainWidth: main?.getBoundingClientRect().width || 0,
          mainScrollWidth: main?.scrollWidth || 0,
          footerButton: footerButton && buttonRect ? {
            left: buttonRect.left, right: buttonRect.right, dialogLeft: dialogRect.left, dialogRight: dialogRect.right,
            top: buttonRect.top, bottom: buttonRect.bottom, footerTop: footerRect?.top, footerBottom: footerRect?.bottom,
            width: footerButton.clientWidth, height: footerButton.clientHeight, scrollWidth: footerButton.scrollWidth, scrollHeight: footerButton.scrollHeight,
          } : null,
        };
    });
    assert(layout.dialogScrollWidth <= layout.dialogWidth && layout.workspaceScrollWidth <= layout.workspaceWidth, 'responsive wizard has no horizontal clipping', layout);
    if (label !== 'wide') assert(layout.mainWidth >= layout.dialogWidth * 0.75 && layout.mainScrollWidth <= layout.mainWidth, 'responsive wizard keeps its preview usable', layout);
    assert(layout.footerButton && layout.footerButton.left >= layout.footerButton.dialogLeft && layout.footerButton.right <= layout.footerButton.dialogRight && layout.footerButton.scrollWidth <= layout.footerButton.width, 'responsive wizard footer action wraps within the dialog', layout.footerButton);
    assert(layout.footerButton && layout.footerButton.top >= layout.footerButton.footerTop && layout.footerButton.bottom <= layout.footerButton.footerBottom && layout.footerButton.scrollHeight <= layout.footerButton.height, 'responsive wizard footer action fits vertically', layout.footerButton);
    if (label !== 'medium') await page.screenshot({ path: `/tmp/equipment-import-wizard-${label}-${theme}.png`, fullPage: true });
    await page.close();
  }

  const page = await makePage(1080, 'light');
  await page.getByText('doc-a.csv', { exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: /Проверить и импортировать 1 позиц\./ }).click();
  await page.getByRole('button', { name: 'Импортировать 1', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  let entries = await logs(page);
  assert(entries.some(entry => entry.path.endsWith('/equipment/import-draft-plan')), 'document route uses the production import-draft plan');
  assert(!entries.some(entry => entry.path.endsWith('/equipment/import-draft')), 'document plan performs no write before confirmation');
  await page.getByRole('button', { name: 'Импортировать 1', exact: true }).click();
  await page.getByTestId('wizard-done').filter({ hasText: 'wizard-imported' }).waitFor({ timeout: 30000 });
  entries = await logs(page);
  const firstCommit = entries.find(entry => entry.path.endsWith('/equipment/import-draft'));
  assert(firstCommit?.body?.sourceBinding?.kind === 'document' && firstCommit.body.sourceBinding.id === 'doc-a', 'first document commit retains its source binding', firstCommit?.body?.sourceBinding);
  assert(firstCommit?.body?.sourceBinding?.expectedLedgerRevision === 41, 'first document commit uses initial ledger revision', firstCommit?.body?.sourceBinding);
  const firstCommitIndex = entries.indexOf(firstCommit);
  const refreshIndex = entries.findIndex((entry, index) => index > firstCommitIndex && entry.path.includes('/document-bindings') && entry.data?.revision === 42);
  assert(refreshIndex > firstCommitIndex, 'wizard refreshes the binding ledger after the first commit and observes revision 42');
  await page.evaluate(() => (window).__wizardLoadSecondDocument());
  await page.getByText('doc-b.csv', { exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: /doc-b\.csv/ }).click();
  await page.getByRole('button', { name: /Проверить и импортировать 1 позиц\./ }).click();
  await page.getByRole('button', { name: 'Импортировать 1', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  const apply = page.getByRole('button', { name: 'Импортировать 1', exact: true });
  await apply.click();
  await page.waitForFunction(() => (window).__wizardState?.secondDraftPending === true, null, { timeout: 30000 });
  const secondCommit = (await logs(page)).filter(entry => entry.path.endsWith('/equipment/import-draft'))[1];
  assert(secondCommit?.body?.sourceBinding?.id === 'doc-b' && secondCommit.body.sourceBinding.expectedLedgerRevision === 42, 'second document commit uses the refreshed compare-and-swap revision', secondCommit?.body?.sourceBinding);
  assert(await apply.isDisabled(), 'a separate deferred document response disables repeated confirmation while in flight');
  await page.evaluate(() => (window).__wizardResolveSecondDraft());
  await page.getByTestId('wizard-done').filter({ hasText: 'wizard-imported' }).waitFor({ timeout: 30000 });
  await page.close();

  const cadPage = await makePage(1100, 'dark', 'wizard.html?cad=1');
  await cadPage.getByText('L23.xml', { exact: true }).waitFor({ timeout: 30000 });
  // План строится в том же окне, сам: ни второго окна, ни повторного выбора файла.
  await cadPage.getByRole('heading', { name: /Предпросмотр/ }).waitFor({ timeout: 30000 });
  let cadEntries = await logs(cadPage);
  assert(cadEntries.some(entry => entry.path.endsWith('/equipment/parse-calc')), 'CAD XML takes the production parse-calc route');
  assert(!cadEntries.some(entry => entry.path.endsWith('/equipment/source-import/apply')), 'CAD XML parse does not write before user confirmation');
  assert(!(await cadPage.getByRole('button', { name: /Выбрать XML/ }).count()), 'CAD XML plan does not ask to pick the file again');
  assert(!(await cadPage.locator('[aria-modal="true"]').count()), 'CAD XML plan opens no second dialog');
  await cadPage.screenshot({ path: `${process.env.FLUX_SHOTS || '/tmp'}/wizard-cad-inline.png` });
  assert(await cadPage.getByLabel('Тег оборудования').inputValue() === 'L23', 'CAD XML source tag is populated from the selected XML');
  const previewBody = cadEntries.find(entry => entry.path.endsWith('/equipment/source-import/preview'))?.body;
  assert(previewBody?.category === 'vent', 'CAD XML import uses the category from the wizard header', previewBody?.category);
  cadEntries = await logs(cadPage);
  assert(cadEntries.some(entry => entry.path.endsWith('/equipment/source-import/preview')), 'CAD XML routes into the production XML-source plan dialog');
  assert(!cadEntries.some(entry => entry.path.endsWith('/equipment/source-import/apply')), 'XML-source plan performs no write before confirmation');
  await cadPage.getByRole('button', { name: 'Подтвердить импорт' }).click();
  await cadPage.getByTestId('wizard-done').filter({ hasText: 'wizard-imported' }).waitFor({ timeout: 30000 });
  cadEntries = await logs(cadPage);
  assert(cadEntries.some(entry => entry.path.endsWith('/equipment/source-import/apply')), 'XML source is applied only after explicit confirmation');
  await cadPage.close();

  // Группа «…001ABC»: в окне три установки, подтверждение загружает все по очереди.
  const groupPage = await makePage(1100, 'light', 'wizard.html?cad=group');
  await groupPage.getByRole('heading', { name: /Предпросмотр/ }).waitFor({ timeout: 30000 });
  for (const member of ['3700-B01-AS-001A', '3700-B01-AS-001B', '3700-B01-AS-001C']) assert(await groupPage.getByRole('checkbox', { name: member }).isChecked(), `group member ${member} is offered and checked`);
  await groupPage.screenshot({ path: `${process.env.FLUX_SHOTS || '/tmp'}/wizard-cad-group.png` });
  await groupPage.getByRole('button', { name: /Подтвердить импорт · 3 установки/ }).click();
  await groupPage.waitForFunction(() => (window).__wizardLog.filter(entry => entry.path.endsWith('/source-import/apply')).length === 3, null, { timeout: 30000 });
  const groupApplies = (await logs(groupPage)).filter(entry => entry.path.endsWith('/source-import/apply'));
  assert(groupApplies.map(entry => entry.body.tagIdentifier).join() === '3700-B01-AS-001A,3700-B01-AS-001B,3700-B01-AS-001C', 'each group member is imported with its own tag', groupApplies.map(entry => entry.body.tagIdentifier));
  assert(new Set(groupApplies.map(entry => entry.body.expectedLedgerRevision)).size === 3, 'each group member plans against the refreshed ledger revision', groupApplies.map(entry => entry.body.expectedLedgerRevision));
  await groupPage.getByText('Импортировано. Позиции появились').waitFor({ timeout: 30000 });
  await groupPage.getByRole('button', { name: 'Пути установок' }).click();
  await groupPage.getByRole('region', { name: 'Пути установок' }).or(groupPage.getByLabel('Пути установок')).first().waitFor({ timeout: 30000 });
  assert(await groupPage.getByRole('button', { name: 'Сменить папку' }).count() === 1, 'paths panel lists the bound unit with a folder action');
  await groupPage.screenshot({ path: `${process.env.FLUX_SHOTS || '/tmp'}/wizard-paths.png` });
  await groupPage.close();

  if (failures.length) throw new Error(failures.join('\n'));
  console.log(JSON.stringify({ result: 'passed', checks: ['production DocImportWizard XML and document routes', 'no pre-confirm writes', 'document sourceBinding and refreshed CAS revision', 'deferred confirm disabled', 'narrow/wide light/dark screenshots'] }));
} finally { await browser.close(); }
