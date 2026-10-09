/** Проверяет GenOffice в настоящем слое окон при двух открытых DOCX. */
import { createServer } from 'vite';
import { makeDocx, makeXlsx } from './officeHarness';

const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const check = (name: string, value: unknown, detail?: unknown) => {
  if (!value) throw new Error(`✗ ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`✓ ${name}`);
};

async function main() {
  const vite = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] } } });
  await vite.listen();
  const address = vite.httpServer?.address();
  const base = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : '';
  if (!base) throw new Error('Не получен адрес тестового сервера');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    const navigations: string[] = [];
    const allOfficeNavigations: string[] = [];
    let exported = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('framenavigated', frame => { if (frame.url().includes('/genoffice/')) allOfficeNavigations.push(frame.url()); if (frame.url().includes('/genoffice/docs/index.html')) navigations.push(frame.url()); });
    await page.route('**/api/projects/local-project/tags', route => route.fulfill({ json: { tags: [{ id: 'tag-42', identifier: 'TAG-42', name: 'Насос' }] } }));
    await page.route('**/api/office/files/new?*', route => { exported++; return route.fulfill({ json: { id: `export-${exported}`, name: `tags-${exported}.xlsx`, sha256: `sha-${exported}`, size: 1024, folderId: null } }); });
    const docx = await makeDocx();
    const xlsx = await makeXlsx();
    await page.addInitScript((contents: { docx: string; xlsx: string }) => {
      (window as any).__workspaceDocxBase64 = contents.docx;
      (window as any).__workspaceXlsxBase64 = contents.xlsx;
      (window as any).__workspaceSeedNames = ['one.docx', 'two.docx', 'copy.xlsx'];
    }, { docx: docx.toString('base64'), xlsx: xlsx.toString('base64') });
    await page.goto(`${base}/scripts/fixtures/windows-file-office-workspace.html#/`);
    await page.locator('[data-desk]').waitFor({ timeout: 10000 }).catch(async error => {
      console.log('SHELL DEBUG', page.url(), await page.locator('body').innerText().catch(() => ''), errors);
      throw error;
    });
    const hrefs = ['/windows-file?root=mock-root&path=one.docx', '/windows-file?root=mock-root&path=two.docx'];
    await page.evaluate((paths: string[]) => paths.forEach(path => (window as any).__windowStore.getState().open(path)), hrefs);
    await page.waitForFunction(() => (window as any).__windowStore.getState().windows.length === 2, null, { timeout: 10000 });
    await page.locator('[data-win]').nth(1).waitFor();
    const ids: string[] = await page.evaluate(() => (window as any).__windowStore.getState().windows.map((item: any) => item.id));
    const frameFor = (id: string) => page.locator(`[data-win="${id}"] iframe[title="Flux Office — Документ"]`);
    for (const id of ids) {
      await frameFor(id).waitFor({ timeout: 20000 });
      await page.waitForTimeout(1500);
      const debug = await page.locator(`[data-win="${id}"]`).innerText();
      const calls = await page.evaluate(() => (window as any).__workspaceOfficeCalls.map((call: any) => ({ action: call.action, app: call.app, channel: call.channel })));
      if (!(await frameFor(id).evaluate(el => !!(el as HTMLIFrameElement).contentDocument?.querySelector('.ProseMirror')))) console.log('FRAME DEBUG', id, debug, await frameFor(id).evaluate(el => { const node=el as HTMLIFrameElement, r=node.getBoundingClientRect(); return { src: node.getAttribute('src'), rect:[r.width,r.height], html: node.contentDocument?.body?.innerText.slice(0, 200), loaded: node.contentDocument?.readyState, scripts:[...node.contentDocument!.scripts].map(x=>x.src).slice(0,8) }; }), calls);
      const child = page.frames().find(frame => frame.url().includes('/genoffice/docs/index.html') && frame.frameElement().then((element: any) => element?.evaluate((el: Element) => (el.closest('[data-win]') as HTMLElement | null)?.dataset.win === id)).catch(() => false));
      const iframe = frameFor(id);
      await iframe.waitForFunction(el => (el as HTMLIFrameElement).contentDocument?.querySelector('.ProseMirror')?.textContent?.includes('Проба Flux Office'), null, { timeout: 45000 });
      const result = await iframe.evaluate(el => { const node=el as HTMLIFrameElement, r = node.getBoundingClientRect(); return { rect: [r.width, r.height], body: node.contentDocument?.body?.innerText || '' }; });
      check(`окно ${id} загрузило DOCX в реальном GenOffice с ненулевой площадью`, result.rect[0] > 0 && result.rect[1] > 0 && result.body.includes('Проба Flux Office'), result);
      void child;
    }
    const first = ids[0];
    const initial = await frameFor(first).evaluate(el => {
      const node = el as HTMLIFrameElement;
      (window as any).__initialWorkspaceFrame = node;
      return { token: node.contentWindow?.crypto.randomUUID(), rect: [node.getBoundingClientRect().width, node.getBoundingClientRect().height] };
    });
    await page.evaluate((id: string) => (window as any).__windowStore.getState().minimize(id), ids[1]);
    await page.evaluate((id: string) => (window as any).__windowStore.getState().focus(id), first);
    const child = page.frames().find(frame => frame.url().includes('/genoffice/docs/index.html'));
    if (!child) throw new Error('Не найден frame GenOffice после восстановления активного окна');
    await child.evaluate(() => window.parent.postMessage({ flux: 'office', op: 'flux:open-panel' }, location.origin));
    await page.getByRole('button', { name: 'Вставить все' }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Вставить все' }).click();
    await page.getByRole('status').filter({ hasText: 'Таблица вставлена' }).waitFor({ timeout: 15000 });
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLIFrameElement>('iframe[title="Flux Office — Документ"]')].some(el => el.contentDocument?.body?.innerText.includes('TAG-42')), null, { timeout: 15000 });
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.waitForFunction(() => (window as any).__workspaceFileCalls.some((call: any) => call.action === 'write'), null, { timeout: 45000 });
    const after = await frameFor(first).evaluate(el => {
      const node = el as HTMLIFrameElement;
      const r = node.getBoundingClientRect();
      return { sameNode: node === (window as any).__initialWorkspaceFrame, token: node.contentWindow?.crypto.randomUUID, rect: [r.width, r.height], body: node.contentDocument?.body?.innerText || '' };
    });
    check('вставка и Save в WindowsLayer сохранили DOM-узел и содержимое редактора', after.sameNode && after.rect[0] > 0 && after.rect[1] > 0 && /TAG-42/.test(after.body), after);
    await page.evaluate((id: string) => (window as any).__windowStore.getState().minimize(id), first);
    await page.evaluate((id: string) => (window as any).__windowStore.getState().focus(id), first);
    check('сворачивание и возврат не скрывают/перезапускают редактор', await frameFor(first).evaluate(el => { const node=el as HTMLIFrameElement; return node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && /TAG-42/.test(node.contentDocument?.body?.innerText || ''); }));
    await page.locator(`[data-win="${first}"]`).getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.waitForFunction((id: string) => !(window as any).__windowStore.getState().windows.some((item: any) => item.id === id), first, { timeout: 15000 });
    await page.waitForTimeout(1200);
    check('закрытие окна удаляет именно его и оно не открывается повторно само', await page.evaluate((id: string) => !(window as any).__windowStore.getState().windows.some((item: any) => item.id === id) && (window as any).__windowStore.getState().windows.length === 1, first));
    check('после Close соседний документ остаётся смонтирован', await frameFor(ids[1]).count() === 1);
    const second = ids[1];
    await page.evaluate((id: string) => (window as any).__windowStore.getState().focus(id), second);
    const secondFrame = page.frames().find(frame => frame.url().includes('/genoffice/docs/index.html'));
    if (!secondFrame) throw new Error('Не найден редактор соседнего документа после close');
    await secondFrame.evaluate(() => window.parent.postMessage({ flux: 'office', op: 'flux:open-panel' }, location.origin));
    await page.getByRole('button', { name: 'Вставить все' }).waitFor({ timeout: 15000 }).catch(async error => {
      console.log('EXPORT PANEL DEBUG', await page.evaluate(() => ({ windows: (window as any).__windowStore.getState().windows.map((item: any) => ({ id: item.id, path: item.path, href: item.href, minimized: item.minimized })), sidebars: [...document.querySelectorAll('[aria-label="Flux"]')].length, editorFrames: [...document.querySelectorAll('iframe[title="Flux Office — Документ"]')].map((el: any) => ({ rect: [el.getBoundingClientRect().width, el.getBoundingClientRect().height], text: el.contentDocument?.body?.innerText.slice(-100) })) })), await secondFrame.evaluate(() => (window as any).__fluxBridge?.events));
      throw error;
    });
    await page.getByRole('button', { name: 'Вставить все' }).click();
    await page.getByRole('status').filter({ hasText: 'Таблица вставлена' }).waitFor({ timeout: 15000 });
    await page.waitForFunction((id: string) => [...document.querySelectorAll<HTMLIFrameElement>(`[data-win="${id}"] iframe[title="Flux Office — Документ"]`)].some(el => el.contentDocument?.body?.innerText.includes('TAG-42')), second, { timeout: 15000 });
    check('до выгрузки исходный Docs содержит незаписанную вставку Flux', await frameFor(second).evaluate(el => (el as HTMLIFrameElement).contentDocument?.body?.innerText.includes('TAG-42')));
    await page.locator('#flux-section-picker').selectOption('export');
    await page.getByRole('button', { name: 'Книга Flux', exact: true }).waitFor({ timeout: 15000 });
    const sourceWasErrorFreeBeforeHandoff = errors.length === 0;
    check('до handoff исходный Docs не выдаёт ошибок', sourceWasErrorFreeBeforeHandoff, errors);
    await page.evaluate(() => {
      const original = history.pushState.bind(history);
      history.pushState = ((state: any, title: string, url?: string | URL | null) => {
        const next = String(url || '');
        (window as any).__workspaceHandoffUrl = next;
        return original(state, title, next.includes('/office-sheet?file=export-1') ? '#/windows-file?root=mock-root&path=copy.xlsx' : url);
      }) as typeof history.pushState;
    });
    const exportFrameBefore = await frameFor(second).evaluate(el => { const node=el as HTMLIFrameElement; (window as any).__exportSourceFrame=node; return { src:node.getAttribute('src'), body:node.contentDocument?.body?.innerText.slice(0,120), token:(node.contentWindow as any).__workspaceSourceToken || ((node.contentWindow as any).__workspaceSourceToken=crypto.randomUUID()) }; });
    const readCountBeforeExport = await page.evaluate(() => (window as any).__workspaceFileCalls.filter((call: any) => call.action === 'read').map((call: any) => String(call.ref?.relativePath || '').split('/').pop()));
    await page.getByRole('button', { name: 'Книга Flux', exact: true }).click();
    await page.waitForFunction(() => (window as any).__windowStore.getState().windows.some((item: any) => item.href === '/windows-file?root=mock-root&path=copy.xlsx'), null, { timeout: 15000 }).catch(async error => { console.log('HANDOFF DEBUG', await page.evaluate(() => ({ hash: location.hash, log: (window as any).__workspaceHandoffUrl, windows: (window as any).__windowStore.getState().windows.map((item: any) => item.href) }))); throw error; });
    const exportState = await page.evaluate((id: string) => ({ windows: (window as any).__windowStore.getState().windows.map((item: any) => ({ id: item.id, path: item.path, href: item.href })), sourceKept: (window as any).__windowStore.getState().windows.some((item: any) => item.id === id && item.path === '/windows-file') }), second);
    await page.waitForTimeout(2000);
    const sourceFrameCount = await frameFor(second).count();
    if (!sourceFrameCount) throw new Error(`Исходное DOCX-окно потеряло iframe: ${JSON.stringify({ exportState, windows: await page.evaluate(() => (window as any).__windowStore.getState().windows.map((item: any) => ({ id: item.id, path: item.path, href: item.href }))), sourceDialog: await page.locator(`[data-win="${second}"]`).innerText().catch(() => ''), lifecycle: await page.evaluate(() => (window as any).__workspaceDiagnosticEvents().filter((event: any) => event.event === 'office.lifecycle').map((event: any) => event.data)) })}`);
    const oldAfterExport = await frameFor(second).evaluate(el => { const node=el as HTMLIFrameElement, r=node.getBoundingClientRect(); return { sameNode:node===(window as any).__exportSourceFrame, src:node.getAttribute('src'), frameUrl:node.contentWindow?.location.href, rect:[r.width,r.height], ready:node.contentDocument?.readyState, token:(node.contentWindow as any).__workspaceSourceToken, body:node.contentDocument?.body?.innerText || '' }; });
    const exportLifecycle = await page.evaluate(() => (window as any).__workspaceDiagnosticEvents().filter((event: any) => event.event === 'office.lifecycle').map((event: any) => event.data));
    const readCountAfterExport = await page.evaluate(() => (window as any).__workspaceFileCalls.filter((call: any) => call.action === 'read').map((call: any) => String(call.ref?.relativePath || '').split('/').pop()));
    check('handoff same-route local XLSX opens a new window without remounting the source DOCX', exported === 1 && exportState.sourceKept && exportState.windows.some((item: any) => item.href === '/windows-file?root=mock-root&path=copy.xlsx') && oldAfterExport.sameNode && oldAfterExport.rect[0] > 0 && oldAfterExport.rect[1] > 0 && oldAfterExport.body.includes('Проба Flux Office') && oldAfterExport.body.includes('TAG-42') && readCountAfterExport.filter((name: string) => name === 'two.docx').length === readCountBeforeExport.filter((name: string) => name === 'two.docx').length, { exportState, exportFrameBefore, oldAfterExport, navigations:allOfficeNavigations, lifecycle:exportLifecycle, readCountBeforeExport, readCountAfterExport });
    const copyWindowId = await page.evaluate(() => (window as any).__windowStore.getState().windows.find((item: any) => item.href === '/windows-file?root=mock-root&path=copy.xlsx')?.id as string);
    const copySheetFrame = page.locator(`[data-win="${copyWindowId}"] iframe[title="Flux Office — Таблица"]`);
    await copySheetFrame.waitFor({ timeout: 15000 });
    await copySheetFrame.waitForFunction(el => !!((el as HTMLIFrameElement).contentWindow as any).__fluxSheets?.univerRef?.current?.univerAPI?.getActiveWorkbook(), null, { timeout: 45000 });
    const copiedWorkbook = await copySheetFrame.evaluate(el => { const book=((el as HTMLIFrameElement).contentWindow as any).__fluxSheets?.univerRef?.current?.univerAPI?.getActiveWorkbook(); return book?.getSheets().map((sheet: any) => sheet.getSheetName()) || []; });
    check('same-route handoff действительно открыл новый локальный XLSX', copiedWorkbook.length > 0, copiedWorkbook);
    await page.locator(`[data-win="${copyWindowId}"]`).getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.waitForFunction((id: string) => !(window as any).__windowStore.getState().windows.some((item: any) => item.id === id), copyWindowId, { timeout: 15000 });
    check('действия породили только исходные два frame load', navigations.length === 2, navigations);
    const lifecycle = await page.evaluate(() => (window as any).__workspaceDiagnosticEvents().filter((event: any) => event.event === 'office.lifecycle'));
    const docsLifecycle = lifecycle.filter((event: any) => event.data.app === 'docs');
    check('handoff не размонтирует исходный Docs и пишет unmount только для закрытого окна', docsLifecycle.filter((event: any) => event.data.stage === 'unmount').length === 1 && new Set(docsLifecycle.filter((event: any) => event.data.stage === 'mount').map((event: any) => event.data.instance)).size === 2, lifecycle.map((event: any) => event.data));
    check('диагностика видит готовность Docs и успешный close guard', docsLifecycle.some((event: any) => event.data.stage === 'editor-ready') && docsLifecycle.some((event: any) => event.data.stage === 'close-guard' && event.data.outcome === 'ok'), lifecycle.map((event: any) => event.data));
    check('диагностика не содержит имени файла или содержимого книги', !JSON.stringify(lifecycle).includes('one.docx') && !JSON.stringify(lifecycle).includes('TAG-42'));
    await page.locator(`[data-win="${second}"]`).getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.waitForFunction((id: string) => !(window as any).__windowStore.getState().windows.some((item: any) => item.id === id), second, { timeout: 20000 });
    const savedOnDirtyClose = await page.evaluate(() => (window as any).__workspaceFileCalls.some((call: any) => call.action === 'write' && call.ref?.relativePath === 'two.docx'));
    check('после handoff close исходного Docs сохраняет незаписанный TAG-42 в файл', savedOnDirtyClose);
  } finally { await browser.close(); await vite.close(); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
