/**
 * End-to-end checks of Flux Office's real add-on against rebuilt GenOffice.
 * The fixture is disposable: `node --import tsx scripts/test-guide-server.ts --fixture`.
 * Run only after Office bridge freeze and editor rebuild:
 * `FLUX_OFFICE_NATIVE_READY=1 node --import tsx scripts/test-office-addon-native-live.ts /tmp/.../fixture.json`
 */
import { chmod, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { chromium } from 'playwright-core';
import { makeDocxWithTable, makeXlsxWithBlankFormula, makeXlsxWithManualRow, loginPage } from './officeHarness';
import { runNativeSheetCellActions } from './officeNativeCellActionsScenarios';
import { runNativeWordCellActions } from './officeNativeWordCellActionsScenarios';

void (async () => {
type Fixture = { baseUrl: string; projectId: string; dataDir: string; admin: { symbol: string; password: string } };
const metadataPath = resolve(process.argv[2] || process.env.FLUX_FIXTURE_META || '');
if (!process.env.FLUX_OFFICE_NATIVE_READY) {
  console.error('Не запускать: ждём injectfreeze от office_model и пересборку редакторов от root.');
  process.exit(2);
}
if (!process.argv[2] && !process.env.FLUX_FIXTURE_META) throw new Error('Передайте путь к private fixture.json из --fixture');
const metadataStat = await stat(metadataPath);
if ((metadataStat.mode & 0o077) !== 0) throw new Error('Fixture metadata должен быть доступен только владельцу (0600)');
const fixture = JSON.parse(await readFile(metadataPath, 'utf8')) as Fixture;
if (!/^https?:\/\/(127\.0\.0\.1|localhost):\d+$/.test(fixture.baseUrl) || !fixture.dataDir.startsWith('/tmp/flux-guide-server-')) {
  throw new Error('Native Office test accepts only the disposable loopback Guide fixture');
}
await chmod(metadataPath, 0o600);
const BASE = fixture.baseUrl.replace(/\/$/, '');
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let failures = 0;
const check = (label: string, good: unknown, detail?: unknown) => {
  if (good) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)); }
};
let token = '';
const api = async (method: string, route: string, body?: unknown) => {
  const response = await fetch(BASE + route, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { /* binary data */ }
  return { status: response.status, bytes, json };
};
const raw = async (method: string, route: string, bytes?: Buffer, headers: Record<string, string> = {}) => {
  const response = await fetch(BASE + route, { method, headers: { Authorization: `Bearer ${token}`, ...(bytes ? { 'Content-Type': 'application/octet-stream' } : {}), ...headers }, body: bytes });
  const result = Buffer.from(await response.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(result.toString('utf8')); } catch { /* OOXML */ }
  return { status: response.status, bytes: result, json };
};
const upload = async (folderId: string, name: string, type: string, bytes: Buffer) => {
  const made = await api('POST', '/api/files', { name, type, folderId, filePath: `/shared/${name}` });
  const id = String(made.json?.file?.id || '');
  check(`${name}: file created inside synthetic project folder`, made.status === 200 && !!id, made.json);
  if (!id) return '';
  const chunk = await api('POST', `/api/files/${encodeURIComponent(id)}/chunk`, { idx: 0, data: bytes.toString('base64') });
  const done = await api('POST', `/api/files/${encodeURIComponent(id)}/done`, { count: 1 });
  check(`${name}: real OOXML bytes uploaded`, chunk.status === 200 && done.status === 200, [chunk.status, done.status]);
  return id;
};
const archiveText = async (fileId: string, part: string) => {
  const response = await raw('GET', `/api/files/${encodeURIComponent(fileId)}/raw`);
  if (response.status !== 200) throw new Error(`Cannot read ${fileId}: ${response.status}`);
  const zip = await JSZip.loadAsync(response.bytes);
  return zip.file(part)?.async('string') || '';
};
const archiveXml = async (fileId: string) => {
  const response = await raw('GET', `/api/files/${encodeURIComponent(fileId)}/raw`);
  if (response.status !== 200) throw new Error(`Cannot read ${fileId}: ${response.status}`);
  const zip = await JSZip.loadAsync(response.bytes);
  return (await Promise.all(Object.values(zip.files).filter((entry) => !entry.dir && entry.name.endsWith('.xml')).map((entry) => entry.async('string')))).join('\n');
};
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const xmlText = (xml: string) => xml.replace(/<[^>]*>/g, '').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'");
const hasEmptyFormulaTarget = async (fileId: string) =>
  /<c\b[^>]*\br="A2"[^>]*><f>IF\(FALSE,1,(?:&quot;|"){2}\)<\/f><v>\s*<\/v><\/c>/.test(await archiveText(fileId, 'xl/worksheets/sheet1.xml'));
const sheetCell = async (frame: any, address: string) => frame.locator('body').evaluate((_body: HTMLElement, cellAddress: string) => {
  const api = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
  const sheet = api?.getActiveWorkbook?.()?.getSheets?.().find((item: any) => item.getSheetName() === 'Перечень');
  // Нет листа — undefined, а не исключение: проба внутри waitFor не должна
  // обрывать весь прогон, пока книга перезагружается после сохранения.
  if (!sheet) return undefined;
  return sheet.getRange(cellAddress)?.getValues?.()?.[0]?.[0] ?? '';
}, address).catch(() => undefined);
const waitFor = async (probe: () => Promise<boolean>, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await probe()) return true; await new Promise((r) => setTimeout(r, 250)); }
  return probe();
};
let browserErrors: string[] = [];
const openPanel = async (page: any, title: string) => {
  const frame = page.frameLocator(`iframe[title="${title}"]`);
  try {
    await frame.locator('body').waitFor({ state: 'visible', timeout: 45000 });
  } catch (error) {
    const diagnostic = await page.evaluate((expectedTitle: string) => ({
      expectedTitle,
      url: location.href,
      documentText: document.body.innerText.slice(0, 1000),
      frames: [...document.querySelectorAll('iframe')].map((el) => {
        const frame = el as HTMLIFrameElement; const rect = el.getBoundingClientRect();
        let body: any = null;
        try { body = frame.contentDocument?.body ? { title: frame.contentDocument.title, text: frame.contentDocument.body.innerText.slice(0, 1200), className: frame.contentDocument.body.className, html: frame.contentDocument.body.innerHTML.slice(0, 1000) } : null; } catch (e) { body = { error: String(e) }; }
        return { title: frame.title, src: frame.getAttribute('src'), rect: [rect.x, rect.y, rect.width, rect.height], body };
      }),
    }), title).catch((reason: any) => ({ diagnosticError: String(reason) }));
    const path = `/tmp/office-addon-native-${title.includes('Таблица') ? 'sheets' : 'docs'}-frame-failure.png`;
    await page.screenshot({ path, fullPage: true }).catch(() => {});
    console.error('NATIVE_FRAME_OPEN_DIAGNOSTIC', JSON.stringify({ ...diagnostic, error: String(error), screenshot: path }));
    throw error;
  }
  await frame.locator('body').evaluate((body: HTMLElement) => {
    window.parent.postMessage({ flux: 'office', op: 'flux:open-panel' }, location.origin);
  });
  await page.getByRole('complementary', { name: 'Flux Office' }).waitFor({ timeout: 10000 });
  return frame;
};
const navigateOffice = async (page: any, route: string) => {
  const url = `${BASE}/#${route}`;
  // Use a fresh app page/context for each editor so the window manager consumes
  // exactly one initial hash and never restores duplicate office windows.
  await page.goto(url, { waitUntil: 'domcontentloaded' });
};
const waitForSheetFile = async (frame: any) => {
  return waitFor(async () => frame.locator('body').evaluate(() => {
    const hooks = (window as any).__fluxSheets;
    const workbook = hooks?.univerRef?.current?.univerAPI?.getActiveWorkbook?.();
    if (!hooks?.lazyWorkbookRef?.current || !workbook || workbook.getId() === 'new-workbook') return false;
    const canvas = document.getElementById(`univer-sheet-main-canvas_${workbook.getId()}`);
    const bounds = canvas?.getBoundingClientRect();
    return !!bounds && bounds.width >= 200 && bounds.height >= 100;
  }).catch(() => false), 30000);
};
const loadSheetAddress = async (frame: any, address: string) => {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/i.exec(address);
  if (!match) throw new Error(`Invalid fixture cell address: ${address}`);
  const row = Number(match[2]) - 1;
  const column = match[1]!.toUpperCase().split('').reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  const nameBox = frame.locator('input.univer-box-border').first();
  await nameBox.fill(address);
  await nameBox.press('Enter');
  return waitFor(async () => frame.locator('body').evaluate((_body: HTMLElement, { row, column }: { row: number; column: number }) => {
    const runtime = (window as any).__fluxSheets;
    const workbook = runtime?.univerRef?.current?.univerAPI?.getActiveWorkbook?.();
    const sheet = workbook?.getSheets?.().find((item: any) => item.getSheetName() === 'Перечень');
    const lazy = runtime?.lazyWorkbookRef?.current;
    const loaded = lazy?.loadedRanges?.get?.(sheet?.getSheetId?.());
    return !!sheet && (lazy?.flags?.preloadComplete === true || !!loaded && row >= loaded.startRow && row <= loaded.endRow && column >= loaded.startColumn && column <= loaded.endColumn);
  }, { row, column }).catch(() => false), 15000);
};
const confirmPreview = async (page: any, panel: any, button: any, label: string) => {
  const enabled = await waitFor(async () => await button.isEnabled().catch(() => false), 10000);
  if (!enabled) {
    const details = { reason: 'confirm disabled after preview', alert: await panel.getByRole('alert').allTextContents().catch(() => []), panel: await panel.innerText().catch(() => '') };
    console.error(`${label}_CONFIRM_DIAGNOSTIC`, JSON.stringify(details));
    return { ok: false, details };
  }
  await button.click();
  const alert = panel.getByRole('alert');
  const status = panel.getByRole('status');
  const settled = await waitFor(async () => (await alert.count()) > 0 || (await status.count()) > 0, 15000);
  const details = {
    settled,
    alert: await alert.allTextContents().catch(() => []),
    status: await status.allTextContents().catch(() => []),
    panel: await panel.innerText().catch(() => ''),
    browserErrors: browserErrors.slice(-15),
    replies: await page.evaluate(() => (window as any).__fluxPlanReplies || []),
  };
  console.log(`${label}_CONFIRM_DIAGNOSTIC`, JSON.stringify(details));
  check(`${label} confirmation reaches applied status or a clear UI error`, settled && (details.status.length > 0 || details.alert.length > 0), details);
  return { ok: settled && details.status.length > 0 && details.alert.length === 0, details };
};
const clickSheetGrid = async (frame: any) => {
  const canvases = frame.locator('canvas');
  const ready = await waitFor(async () => {
    const items = await canvases.evaluateAll((nodes: HTMLCanvasElement[]) => nodes.map((el) => {
      const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, x: r.x, y: r.y, area: r.width * r.height, id: el.id, cls: el.className };
    }));
    return items.some((item: any) => item.width >= 200 && item.height >= 100);
  }, 15000);
  const items = await canvases.evaluateAll((nodes: HTMLCanvasElement[]) => nodes.map((el) => {
    const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, x: r.x, y: r.y, area: r.width * r.height, id: el.id, cls: el.className };
  }));
  if (!ready) throw new Error(`Sheets grid canvas did not become visible; canvas geometry=${JSON.stringify(items)}`);
  const index = items.map((item: any, i: number) => ({ ...item, index: i })).filter((item: any) => item.width >= 200 && item.height >= 100).sort((a: any, b: any) => b.area - a.area)[0].index;
  const target = canvases.nth(index);
  const box = await target.boundingBox();
  if (!box) throw new Error(`Sheets grid canvas has no bounding box: ${JSON.stringify(items[index])}`);
  await target.click({ position: { x: Math.min(45, Math.max(1, box.width - 1)), y: Math.min(20, Math.max(1, box.height - 1)) }, timeout: 10000 });
  return items[index];
};
const capture = async (page: any, frame: any, suffix: string) => {
  const metrics = await page.getByRole('complementary', { name: 'Flux Office' }).evaluate((el: HTMLElement) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return { x: r.x, y: r.y, width: r.width, height: r.height, background: cs.backgroundColor, color: cs.color, editor: (() => {
      const f = document.querySelector('iframe[title^="Flux Office —"]') as HTMLIFrameElement | null;
      const b = f?.getBoundingClientRect(); return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
    })() };
  });
  check(`${suffix}: addon and actual editor have nonzero geometry`, metrics.width > 0 && metrics.height > 0 && (metrics.editor?.height || 0) > 0, metrics);
  await page.screenshot({ path: `/tmp/office-addon-native-${suffix}.png`, fullPage: true });
  return metrics;
};

let folderId = '';
const created: string[] = [];
let browser: any;
let page: any;
try {
  const login = await api('POST', '/api/login', fixture.admin);
  token = String(login.json?.token || '');
  check('synthetic fixture admin authenticated', login.status === 200 && !!token);
  if (!token) throw new Error('Fixture login failed');
  const folder = await api('POST', '/api/folders', { name: `__office_addon_native_${Date.now()}`, projectId: fixture.projectId });
  folderId = String(folder.json?.folder?.id || '');
  check('isolated files folder belongs to fixture project', folder.status === 200 && !!folderId, folder.json);
  if (!folderId) throw new Error('Could not create fixture project folder');

  const stamp = Date.now().toString(36);
  const docxId = await upload(folderId, `__native_${stamp}.docx`, 'DOCX', await makeDocxWithTable());
  const templateTargetId = await upload(folderId, `__native_template_target_${stamp}.docx`, 'DOCX', await makeDocxWithTable());
  if (process.env.FLUX_OFFICE_NATIVE_DIAG === '1') {
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const diagnosticPage = await (await browser.newContext({ viewport: { width: 1440, height: 960 } })).newPage();
    const events: Array<{ at: number; type: string; value: string }> = [];
    const clean = (value: unknown) => String(value).replace(/(token|password|authorization)([=: ]+)[^&\s,]*/gi, '$1$2[redacted]').replace(/([?&](?:token|auth|session)=)[^&\s]*/gi, '$1[redacted]');
    await diagnosticPage.addInitScript(`(() => {
      const trace = [];
      window.__officeRemoveTrace = trace;
      const describe = (node) => ({
        tag: node && (node.tagName || node.nodeName) || '', id: node && node.id || '', className: node && typeof node.className === 'string' ? node.className : '',
        text: String(node && node.textContent || '').replace(/\\s+/g, ' ').slice(0, 160),
        parentTag: node && node.parentNode && (node.parentNode.tagName || node.parentNode.nodeName) || '',
        parentClass: node && node.parentNode && typeof node.parentNode.className === 'string' ? node.parentNode.className : '',
      });
      const elementRemove = Element.prototype.remove;
      Element.prototype.remove = function() {
        if (trace.length < 100) trace.push({ kind: 'Element.remove', node: describe(this), stack: new Error('Element.remove trace').stack });
        return elementRemove.call(this);
      };
      const nodeRemoveChild = Node.prototype.removeChild;
      Node.prototype.removeChild = function(child) {
        try { return nodeRemoveChild.call(this, child); }
        catch (error) {
          if (trace.length < 100) trace.push({ kind: 'Node.removeChild.throw', parent: describe(this), node: describe(child), error: String(error && error.message || error), stack: new Error('Node.removeChild trace').stack });
          throw error;
        }
      };
    })()`);
    diagnosticPage.on('console', (message: any) => { if (message.type() === 'error') events.push({ at: Date.now(), type: 'console.error', value: clean(message.text()) }); });
    diagnosticPage.on('pageerror', (error: any) => events.push({ at: Date.now(), type: 'pageerror', value: clean(error?.stack || error?.message || error) }));
    diagnosticPage.on('requestfailed', (request: any) => events.push({ at: Date.now(), type: 'requestfailed', value: clean(`${request.url()} ${request.failure()?.errorText || ''}`) }));
    diagnosticPage.on('response', (response: any) => { if (response.status() >= 400) events.push({ at: Date.now(), type: `http-${response.status()}`, value: clean(response.url()) }); });
    await loginPage(diagnosticPage, BASE, fixture.admin, false);
    await diagnosticPage.goto(`${BASE}/#/office-doc?file=${encodeURIComponent(docxId)}`, { waitUntil: 'domcontentloaded' });
    await diagnosticPage.waitForTimeout(5000);
    const dom = await diagnosticPage.evaluate(() => ({
      iframes: [...document.querySelectorAll('iframe')].map((frame) => ({ title: frame.title, src: frame.getAttribute('src'), rect: (() => { const r = frame.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })() })),
      frames: window.frames.length,
      title: document.title,
    }));
    const frameBodies = await Promise.all(diagnosticPage.frames().map(async (frame: any) => ({
      url: clean(frame.url()), name: clean(frame.name()),
      body: await frame.locator('body').evaluate((body: HTMLElement) => ({ text: body.innerText.slice(0, 500), classes: [...body.querySelectorAll('*')].map((el) => (el as HTMLElement).className).filter((value) => typeof value === 'string' && /doc-page|editor|loading/i.test(value)).slice(0, 15) })).catch((error: any) => ({ error: clean(error?.message || error) })),
      removals: await frame.evaluate(() => {
        const trace: any[] = (window as any).__officeRemoveTrace || [];
        const bridge = trace.filter((item) => /flux-bridge/i.test(String(item.stack || '')));
        const thrown = trace.filter((item) => item.kind === 'Node.removeChild.throw');
        return { calls: trace.length, firstBridgeRemoval: bridge[0] || null, bridgeRemovals: bridge.slice(0, 8), thrown: thrown.slice(0, 4) };
      }).catch((error: any) => ({ error: clean(error?.message || error) })),
    })));
    await diagnosticPage.screenshot({ path: '/tmp/office-addon-native-docs-minimal.png', fullPage: true }).catch(() => {});
    console.log('NATIVE_DOCS_MINIMAL_DIAGNOSTIC', JSON.stringify({ dom, frameBodies, events: events.sort((a, b) => a.at - b.at).slice(0, 30) }));
    await browser.close(); browser = null;
    await api('DELETE', `/api/files/${encodeURIComponent(docxId)}`).catch(() => {});
    await api('DELETE', `/api/folders/${encodeURIComponent(folderId)}`).catch(() => {});
    process.exit(0);
  }
  const xlsxId = await upload(folderId, `__native_${stamp}.xlsx`, 'XLSX', await makeXlsxWithManualRow());
  const formulaId = await upload(folderId, `__native_formula_${stamp}.xlsx`, 'XLSX', await makeXlsxWithBlankFormula());
  created.push(...[docxId, templateTargetId, xlsxId, formulaId].filter(Boolean));
  check('DOCX fixture is a true table with adjacent content', /<w:tbl>/.test(await archiveText(docxId, 'word/document.xml')) && /Текст после поля/.test(await archiveText(docxId, 'word/document.xml')));
  const xlsxZip = await JSZip.loadAsync((await raw('GET', `/api/files/${xlsxId}/raw`)).bytes);
  check('XLSX fixture contains a real sheet, formula, and unrelated manual/custom part', /<sheet name="Перечень"/.test(await archiveText(xlsxId, 'xl/workbook.xml')) && /SUM\(B2:B3\)/.test(await archiveText(xlsxId, 'xl/worksheets/sheet1.xml')) && /MANUAL_KEEP/.test(await archiveText(xlsxId, 'xl/worksheets/sheet1.xml')) && !!xlsxZip.file('customXml/item1.xml'));
  check('formula fixture target contains an empty-result formula, not an empty cell', await hasEmptyFormulaTarget(formulaId));

  const { existsSync } = await import('node:fs');
  if (!existsSync('public/genoffice/docs/index.html') || !existsSync('public/genoffice/sheets/index.html') || !existsSync('dist/genoffice/docs/index.html') || !existsSync('dist/genoffice/sheets/index.html')) {
    throw new Error('Missing rebuilt GenOffice editors in public/ and served dist/; native tests are not run against mocks or stale sources');
  }
  const [publicDocs, distDocs, publicSheets, distSheets] = await Promise.all([
    import('node:fs/promises').then(({ readFile }) => readFile('public/genoffice/docs/index.html')),
    import('node:fs/promises').then(({ readFile }) => readFile('dist/genoffice/docs/index.html')),
    import('node:fs/promises').then(({ readFile }) => readFile('public/genoffice/sheets/index.html')),
    import('node:fs/promises').then(({ readFile }) => readFile('dist/genoffice/sheets/index.html')),
  ]);
  if (!publicDocs.equals(distDocs) || !publicSheets.equals(distSheets)) throw new Error('Served dist/ editors differ from rebuilt public/ assets; run npm build after GenOffice rebuild');
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  let context: any = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  page = await context.newPage();
  const outside: string[] = [];
  browserErrors = [];
  const monitorPage = async (target: any) => {
    await target.addInitScript(`window.__fluxPlanReplies = []; window.addEventListener('message', (event) => {
      if (event.origin !== location.origin) return;
      const data = event.data || {};
      if (data.payload && data.payload.channel === 'flux:office-plan-applied') window.__fluxPlanReplies.push(data.payload.args[0]);
    });`);
    target.on('console', (message: any) => { if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`.slice(0, 500)); });
    target.on('pageerror', (error: any) => browserErrors.push(`pageerror: ${error?.stack || error?.message || error}`.slice(0, 1000)));
    target.on('requestfailed', (request: any) => browserErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ''}`.slice(0, 500)));
    target.on('response', async (response: any) => { if (response.status() >= 400) { browserErrors.push(`http-${response.status()}: ${response.url()}`.slice(0, 500)); if (response.url().includes('/office-state')) console.error('OFFICE_STATE_SAVE_FAILURE', JSON.stringify({ status: response.status(), request: response.request().postData(), response: await response.text().catch(() => '') })); } });
    target.on('request', (request: any) => {
      const url = String(request.url());
      if (!url.startsWith(BASE) && !url.startsWith('blob:') && !url.startsWith('data:') && !url.startsWith('ws://127.0.0.1') && !url.startsWith('ws://localhost')) outside.push(url);
    });
  };
  await monitorPage(page);
  const resetPage = async (dark = false) => {
    await context.close().catch(() => {});
    context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    page = await context.newPage();
    await monitorPage(page);
    await loginPage(page, BASE, fixture.admin, dark);
  };
  await loginPage(page, BASE, fixture.admin, false);

  console.log('\n1. Native Word editor, table anchor, add-on, save and reopen');
  await navigateOffice(page, `/office-doc?file=${encodeURIComponent(docxId)}`);
  const docs = await openPanel(page, 'Flux Office — Документ');
  check('ordinary Word ribbon remains available', await docs.getByText('Главная', { exact: true }).first().isVisible().catch(() => false) && await docs.getByText('Вставка', { exact: true }).first().isVisible().catch(() => false));
  const editor = docs.locator('.ProseMirror').first();
  await editor.waitFor({ timeout: 12000 }).catch(async (error: any) => {
    const diagnostic = await docs.locator('body').evaluate((body: HTMLElement) => ({
      text: body.innerText.slice(0, 1200),
      editable: [...body.querySelectorAll('[contenteditable]')].map((el) => ({ tag: el.tagName, cls: (el as HTMLElement).className, editable: el.getAttribute('contenteditable'), text: el.textContent?.slice(0, 120) })),
      classes: [...body.querySelectorAll('*')].map((el) => (el as HTMLElement).className).filter((value) => typeof value === 'string' && /editor|document|page|loading/i.test(value)).slice(0, 40),
    })).catch((reason: any) => ({ diagnosticError: String(reason) }));
    await page.screenshot({ path: '/tmp/office-addon-native-docs-failure.png', fullPage: true }).catch(() => {});
    console.error('DOCS_FRAME_DIAGNOSTIC', JSON.stringify(diagnostic));
    throw error;
  });
  check('actual GenOffice document rendered its two-cell table', await editor.locator('table tr').count() >= 2 && (await editor.innerText()).includes('Ручная строка'));
  const secondCell = editor.locator('table tr').first().locator('td,th').nth(1);
  await secondCell.click();
  await page.getByRole('button', { name: /2\. Поля и шапка/ }).click();
  const panel = page.getByRole('complementary', { name: 'Flux Office' });
  await panel.getByLabel('Найти поле Flux').fill('Расход воздуха');
  const field = panel.getByRole('button', { name: /Расход воздуха/ }).first();
  await field.waitFor({ timeout: 15000 });
  await field.click();
  await waitFor(async () => panel.getByRole('button', { name: 'Привязать поле' }).isEnabled());
  await panel.getByRole('button', { name: 'Привязать поле' }).click();
  check('binding UI reported saved anchor state', await waitFor(async () => (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json?.schema?.anchors?.length > 0));
  await docs.locator('.ProseMirror').click();
  await page.keyboard.press('Control+s');
  check('Word field instruction was saved into actual DOCX XML', await waitFor(async () => /DOCPROPERTY\s+"flux:/.test(await archiveText(docxId, 'word/document.xml'))));
  const headerPanel = page.getByRole('complementary', { name: 'Flux Office' });
  const firstHeader = (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json?.schema?.anchors?.[0];
  const sourceAnchorId = String(firstHeader?.id || '');
  // Пересобираем шапку через интерфейс; вставка сохраняет исходный текст ячейки.
  const literalPartRemovers = headerPanel.getByRole('button', { name: 'Удалить часть заголовка', exact: true });
  while (await literalPartRemovers.count()) await literalPartRemovers.first().click();
  await headerPanel.getByRole('button', { name: 'Добавить оператор *' }).click();
  await headerPanel.getByRole('button', { name: 'Текст', exact: true }).click();
  await headerPanel.getByLabel('Текст заголовка 3').fill('2');
  await headerPanel.getByRole('button', { name: 'Текст', exact: true }).click();
  await headerPanel.getByLabel('Текст заголовка 4').fill(' м³/ч');
  await headerPanel.getByRole('button', { name: 'Текст', exact: true }).click();
  for (let part = 5; part > 1; part--) await headerPanel.getByRole('button', { name: `Переместить часть ${part} выше` }).click();
  await headerPanel.getByLabel('Текст заголовка 1').fill('Расход: ');
  await headerPanel.getByRole('button', { name: 'Сохранить схему' }).click();
  const customHeaderState = await waitFor(async () => {
    const state = (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json;
    return state?.schema?.anchors?.[0]?.parts?.length === 5 && state.schema.anchors[0].parts[0]?.text === 'Расход: ';
  });
  const customHeaderXml = await archiveText(docxId, 'word/document.xml');
  const customHeaderText = xmlText(customHeaderXml);
  check('Word header schema saves prefix, protected field, arithmetic operator, numeric operand, and unit suffix in order', customHeaderState && (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json?.schema?.anchors?.[0]?.parts?.map((part: any) => part.kind).join(',') === 'text,field,operator,text,text', (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json?.schema?.anchors?.[0]?.parts);
  check('native Word paragraph serializes custom prefix, field token, arithmetic, and suffix', customHeaderText.includes('Расход: ') && customHeaderText.includes('Расход воздуха') && customHeaderText.includes('*2 м³/ч') && /DOCPROPERTY\s+"flux:/.test(customHeaderXml), customHeaderText.slice(0, 700));
  const templateName = `Native Template ${stamp}`;
  await headerPanel.getByLabel('Название шаблона').fill(templateName);
  await headerPanel.getByRole('button', { name: 'Сохранить шаблон' }).click();
  const templateSaved = await waitFor(async () => (await api('GET', '/api/project-data/office/templates')).json?.templates?.some((item: any) => item.name === templateName));
  check('saved Word header template is available to this project', templateSaved, (await api('GET', '/api/project-data/office/templates')).json?.templates?.map((item: any) => item.name));
  for (let remove = 0; remove < 4; remove++) await headerPanel.getByRole('button', { name: 'Удалить часть заголовка' }).last().click();
  await headerPanel.getByRole('button', { name: 'Сохранить схему' }).click();
  const restoredHeader = await waitFor(async () => {
    const state = (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json;
    return state?.schema?.anchors?.[0]?.parts?.length === 1 && state.schema.anchors[0].parts[0]?.kind === 'field';
  });
  check('removing temporary text and arithmetic restores the original protected binding', restoredHeader && /DOCPROPERTY\s+"flux:/.test(await archiveText(docxId, 'word/document.xml')) && !xmlText(await archiveText(docxId, 'word/document.xml')).includes('Расход: '));
  const restoredHeaderInEditor = await waitFor(async () => await editor.locator('table tr').count() >= 2 && await editor.locator('[data-instr-field*="flux:"]').count() > 0, 15000);
  check('Word editor has reloaded the saved table and protected field before native mark checks', restoredHeaderInEditor);
  const docXml = await archiveText(docxId, 'word/document.xml');
  check('Word table, surrounding text, and manual row survive field insertion', /Слева до поля/.test(docXml) && /Текст после поля/.test(docXml) && /Ручная строка/.test(docXml));
  const renderedField = editor.locator('[data-instr-field*="flux:"]').first();
  const renderedFieldCount = await renderedField.count();
  const renderedFieldMarkup = renderedFieldCount ? await renderedField.evaluate((el: HTMLElement) => ({ tag: el.tagName, cls: el.className, instruction: el.getAttribute('data-instr-field'), html: el.outerHTML.slice(0, 700), parent: el.parentElement?.outerHTML.slice(0, 1000) })) : null;
  const pmState = await docs.locator('body').evaluate(() => {
    const w = window as any;
    const ctx = w.__fluxCtxRef?.current;
    const pm = ctx?.editor;
    return { ctxKeys: Object.keys(ctx || {}).slice(0, 40), html: pm?.getHTML?.()?.slice(0, 3000) };
  }).catch((error: any) => ({ error: String(error) }));
  console.log('WORD_RENDERED_FIELD_DIAGNOSTIC', JSON.stringify({ count: renderedFieldCount, markup: renderedFieldMarkup, pmState }));
  check('real Word editor round-trips the protected Flux field mark', renderedFieldCount > 0 && String(renderedFieldMarkup?.instruction || '').includes('flux:'));
  if (renderedFieldCount) {
    const editorTextBeforeBackspace = await editor.innerText();
    await renderedField.click();
    await page.keyboard.press('Backspace');
    const liveMarkerSurvivesBackspace = await waitFor(async () => await renderedField.count() > 0, 3000);
    const editorTextAfterBackspace = await editor.innerText();
    check('Backspace at a protected Flux marker leaves its live mark and text intact', liveMarkerSurvivesBackspace && editorTextAfterBackspace === editorTextBeforeBackspace, { liveMarkerSurvivesBackspace, before: editorTextBeforeBackspace, after: editorTextAfterBackspace });
    await page.keyboard.press('Control+s');
    check('Backspace protection survives saving the actual field instruction', await waitFor(async () => /DOCPROPERTY\s+"flux:/.test(await archiveText(docxId, 'word/document.xml'))));
  }
  const suffix = editor.getByText('Текст после поля', { exact: true });
  if (await suffix.count()) {
    await suffix.click(); await page.keyboard.press('End');
    await page.evaluate(() => navigator.clipboard.writeText('NATIVE_PASTE'));
    await docs.locator('body').evaluate(`() => {
      window.__fluxUndoKeys = [];
      document.addEventListener('keydown', function(event) {
        if (event.key.toLowerCase() === 'z' && (event.ctrlKey || event.metaKey)) window.__fluxUndoKeys.push({ key: event.key, ctrl: event.ctrlKey, meta: event.metaKey, defaultPrevented: event.defaultPrevented, active: document.activeElement && document.activeElement.className });
      }, true);
    }`);
    await docs.locator('body').evaluate(`(() => {
      const editor = window.__fluxCtxRef.current.editor;
      window.__fluxUndoTrace = [];
      const record = (event) => { if (window.__fluxUndoTrace.length < 40) window.__fluxUndoTrace.push(event); };
      const sync = editor.state.plugins.find((plugin) => plugin.key === 'y-sync$').getState(editor.state);
      const manager = editor.state.plugins.find((plugin) => plugin.key === 'y-undo$').getState(editor.state).undoManager;
      editor.on('transaction', ({ transaction }) => record({ kind: 'pm', changed: transaction.docChanged, history: transaction.getMeta('addToHistory'), meta: Object.keys(transaction.meta) }));
      sync.doc.on('afterTransaction', (transaction) => record({ kind: 'y', changed: transaction.changed.size, history: transaction.meta.get('addToHistory'), origin: transaction.origin && transaction.origin.key || typeof transaction.origin, tracked: manager.trackedOrigins.has(transaction.origin) }));
    })()`);
    const readUndoState = async () => docs.locator('body').evaluate(() => {
      const w = window as any; const e = w.__fluxCtxRef?.current?.editor; const active = document.activeElement as HTMLElement | null; const result: any = {
        collabActive: w.__fluxCollab?.active,
        editorFocused: !!e?.isFocused,
        activeTag: active?.tagName,
        activeClass: active?.className,
        canUndo: e?.can?.().undo?.(),
        extensions: [],
        plugins: [],
        keyboardEvents: w.__fluxUndoKeys || [],
        trace: w.__fluxUndoTrace || [],
      };
      for (const extension of e?.extensionManager?.extensions || []) result.extensions.push(String(extension.name || ''));
      for (const plugin of e?.state?.plugins || []) {
        const pluginState = plugin.getState?.(e.state); const manager = pluginState?.undoManager || pluginState?.manager || pluginState;
        const item: any = { key: String(plugin.key || ''), stateKeys: Object.keys(pluginState || {}).slice(0, 16) };
        if (manager && typeof manager === 'object') {
          item.managerConstructor = manager.constructor?.name || '';
          item.undoStack = Array.isArray(manager.undoStack) ? manager.undoStack.length : null;
          item.redoStack = Array.isArray(manager.redoStack) ? manager.redoStack.length : null;
          item.canUndo = typeof manager.canUndo === 'function' ? manager.canUndo() : undefined;
          if (manager.trackedOrigins && typeof manager.trackedOrigins[Symbol.iterator] === 'function') {
            item.trackedOrigins = [];
            for (const origin of manager.trackedOrigins as Iterable<any>) item.trackedOrigins.push(typeof origin === 'function' ? `function:${origin.name || ''}` : typeof origin);
            item.trackedOrigins = item.trackedOrigins.slice(0, 12);
          }
        }
        result.plugins.push(item);
      }
      return result;
    }).catch((error: any) => ({ error: String(error) }));
    const undoBeforePaste = await readUndoState();
    await page.keyboard.press('Control+v');
    check('paste works in ordinary adjacent Word table text', await waitFor(async () => (await editor.innerText()).includes('NATIVE_PASTE')));
    const undoAfterPaste = await readUndoState();
    await page.keyboard.press('Control+z');
    const undoResult = await waitFor(async () => !(await editor.innerText()).includes('NATIVE_PASTE'), 3000);
    const undoAfterKey = await readUndoState();
    let commandUndoResult: any = null;
    if (!undoResult) commandUndoResult = await docs.locator('body').evaluate(() => {
      const editor = (window as any).__fluxCtxRef?.current?.editor;
      try { return editor?.commands?.undo?.() ?? null; } catch (error) { return String(error); }
    }).catch((error: any) => String(error));
    const undoAfterCommand = commandUndoResult === null ? null : await readUndoState();
    console.log('WORD_UNDO_DIAGNOSTIC', JSON.stringify({ beforePaste: undoBeforePaste, afterPaste: undoAfterPaste, afterKeyboard: undoAfterKey, commandUndoResult, afterCommand: undoAfterCommand, pasteStillPresent: !undoResult, savedField: /DOCPROPERTY\s+"flux:/.test(await archiveText(docxId, 'word/document.xml')) }));
    check('undo reverts only the ordinary text paste and retains field', undoResult && /DOCPROPERTY\s+"flux:/.test(await archiveText(docxId, 'word/document.xml')));
  } else check('Word fixture suffix cell is addressable for paste/undo', false);

  console.log('\n1a. Native Word row fill, repeat, and manual row retention');
  let wordFillRan = false;
  await page.getByRole('button', { name: /1\. Выборка/ }).click();
  await panel.getByRole('button', { name: 'Обновить выборку' }).click();
  await waitFor(async () => (await panel.getByRole('grid', { name: 'Предпросмотр выборки' }).getByText(/FAN_HIGH/).count()) > 0);
  check('Word fixture query exposes both synthetic equipment entities', await panel.getByText(/FAN_LOW/).count() > 0 && await panel.getByText(/FAN_HIGH/).count() > 0);
  await panel.getByRole('checkbox', { name: 'Выбрать все строки' }).check();
  await page.getByRole('button', { name: /3\. Обновление/ }).click();
  const wordPreview = panel.getByRole('button', { name: 'Предпросмотр заполнения' });
  check('Word native row fill is available in the rebuilt add-on', await wordPreview.isEnabled().catch(() => false));
  if (await wordPreview.isEnabled().catch(() => false)) {
    const prePreviewXml = await archiveText(docxId, 'word/document.xml');
    const prePreviewState = (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json;
    await wordPreview.click();
    const wordConfirm = panel.getByRole('button', { name: 'Подтвердить и заполнить' });
    const previewReady = await wordConfirm.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    const previewXml = await archiveText(docxId, 'word/document.xml');
    const previewState = (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json;
    check('Word changes remain in preview until explicit confirmation', previewReady && previewXml === prePreviewXml && JSON.stringify(previewState?.rows || []) === JSON.stringify(prePreviewState?.rows || []), { buttonVisible: previewReady, xmlUnchanged: previewXml === prePreviewXml, beforeRows: prePreviewState?.rows?.length, previewRows: previewState?.rows?.length });
    const wordApply = await confirmPreview(page, panel, wordConfirm, 'WORD');
    const wordRowsReady = wordApply.ok && await waitFor(async () => ((await api('GET', `/api/project-data/files/${docxId}/office-state`)).json?.rows?.length || 0) >= 2, 15000);
    if (!wordRowsReady) console.error('WORD_APPLY_RESULT_DIAGNOSTIC', JSON.stringify({ ...wordApply.details, officeState: (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json, xmlRows: (await archiveText(docxId, 'word/document.xml')).match(/<w:tr[\s\S]*?<\/w:tr>/g)?.length }));
    if (wordRowsReady) {
    wordFillRan = true;
    let wordState = (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json;
    let wordXml = await archiveText(docxId, 'word/document.xml');
    check('Word fill wrote both entity row identities once', wordState?.rows?.filter((r: any) => !String(r.entityId).startsWith('manual:')).length === 2, wordState?.rows);
    check('Word fill preserves the unrelated physical manual table row', wordXml.includes('Ручная строка') && wordXml.includes('Текст после поля'));
    check('Word generated rows contain actual source values 900 and 1200', /900/.test(wordXml) && /1200/.test(wordXml), wordXml.match(/<w:tr[\s\S]*?<\/w:tr>/g));
    const rowMarkersAfterFill = [...wordXml.matchAll(/w:name="(FLUXROW_[^"]+)"/g)].map((match) => match[1]);
    check('Word native table serialized unique durable row bookmarks', rowMarkersAfterFill.length >= 2 && new Set(rowMarkersAfterFill).size === rowMarkersAfterFill.length, rowMarkersAfterFill);
    check('Word row metadata maps generated rows to their physical bookmark markers', wordState?.rows?.filter((r: any) => Object.values(r.cells || {}).some((marker: any) => rowMarkersAfterFill.includes(String(marker)))).length >= 2, wordState?.rows);
    let manualGeneratedRowMarker = '';
    const editorWritable = await waitFor(async () => await docs.locator('body').evaluate(() => !!(window as any).__fluxCtxRef?.current?.editor?.isEditable).catch(() => false), 15000);
    const generatedRowReady = await waitFor(async () => await editor.locator('table tr').filter({ hasText: '900' }).count() > 0, 15000);
    check('Word editor remains writable after native fill', editorWritable && await panel.getByText(/Документ открыт только для просмотра/).count() === 0, { editorWritable, panelText: await panel.innerText().catch(() => '') });
    const generatedTr = editor.locator('table tr').filter({ hasText: '900' }).first();
    if (editorWritable && generatedRowReady && await generatedTr.count()) {
      const generatedRowXml = (wordXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || []).find((row) => />900<\//.test(row)) || '';
      manualGeneratedRowMarker = generatedRowXml.match(/w:name="(FLUXROW_[^"]+)"/)?.[1] || '';
      await generatedTr.locator('td,th').last().click();
      await page.keyboard.press('End'); await page.keyboard.type('NATIVE_DOCS_MANUAL_EDIT'); await page.keyboard.press('Control+s');
      await waitFor(async () => (await archiveText(docxId, 'word/document.xml')).includes('NATIVE_DOCS_MANUAL_EDIT'), 15000);
      const editedWordXml = await archiveText(docxId, 'word/document.xml');
      check('manual edit to a generated Word row persisted with its original durable marker', editedWordXml.includes('NATIVE_DOCS_MANUAL_EDIT') && !!manualGeneratedRowMarker && editedWordXml.includes(`w:name="${manualGeneratedRowMarker}"`), { manualGeneratedRowMarker, edited: editedWordXml.includes('NATIVE_DOCS_MANUAL_EDIT') });
    } else check('generated Word row with value 900 is editable in the real table', false, { editorWritable, generatedRowReady, panelText: await panel.innerText().catch(() => ''), liveRows: await editor.locator('table tr').count() });
    const sourceRows = await api('POST', '/api/project-data/office/query', { projectId: fixture.projectId, query: { entity: 'element', columns: ['name', 'param:Аэродинамика|Расход воздуха'], filters: [], sort: [], limit: 20, excludedEntityIds: [] } });
    const fanHigh = sourceRows.json?.rows?.find((item: any) => item.values?.name?.value === 'FAN_HIGH');
    const rawComponentId = fanHigh?.entityId ? decodeURIComponent(String(fanHigh.entityId).split(':').at(-1) || '') : '';
    const updateSource = rawComponentId ? await api('POST', `/api/equipment/component/${encodeURIComponent(rawComponentId)}/override`, { group: 'Аэродинамика', key: 'Расход воздуха', value: '1500' }) : { status: 0, json: null };
    check('Word repeat source changed through actual project-data edit API', updateSource.status === 200, updateSource.json);
    const refreshedSource = await api('POST', '/api/project-data/office/query', { projectId: fixture.projectId, query: { entity: 'element', columns: ['name', 'param:Аэродинамика|Расход воздуха'], filters: [], sort: [], limit: 20, excludedEntityIds: [] } });
    const refreshedFanHigh = refreshedSource.json?.rows?.find((item: any) => item.values?.name?.value === 'FAN_HIGH');
    check('Word repeat query returns the new source value 1500 before preview', refreshedSource.status === 200 && String(refreshedFanHigh?.values?.['param:Аэродинамика|Расход воздуха']?.value) === '1500', refreshedFanHigh?.values);
    await page.getByRole('button', { name: /1\. Выборка/ }).click();
    await panel.getByRole('button', { name: 'Обновить выборку' }).click();
    check('Word repeat selection refresh returns the updated FAN_HIGH row', await waitFor(async () => await panel.getByRole('row').filter({ hasText: 'FAN_HIGH' }).count() > 0, 15000), await panel.getByRole('grid').innerText().catch(() => ''));
    await panel.getByRole('checkbox', { name: 'Выбрать все строки' }).check();
    await page.getByRole('button', { name: /3\. Обновление/ }).click();
    const repeatPreviewButton = panel.getByRole('button', { name: 'Предпросмотр заполнения' });
    const repeatPreviewEnabled = await waitFor(async () => repeatPreviewButton.isEnabled().catch(() => false), 15000);
    check('Word repeat preview waits for selected rows and current document state', repeatPreviewEnabled, await panel.innerText().catch(() => ''));
    if (repeatPreviewEnabled) await repeatPreviewButton.click();
    const repeatConfirm = panel.getByRole('button', { name: 'Подтвердить и заполнить' });
    const repeatPreviewSettled = repeatPreviewEnabled && await waitFor(async () => await repeatConfirm.isVisible().catch(() => false) || await panel.getByRole('alert').count() > 0, 30000);
    const repeatPreviewVisible = await repeatConfirm.isVisible().catch(() => false);
    const repeatPreviewAlerts = await panel.getByRole('alert').allTextContents().catch(() => []);
    check('Word repeat preview resolves to a confirmation without an error', repeatPreviewSettled && repeatPreviewVisible && !repeatPreviewAlerts.some((alert: string) => alert.trim()), { visible: repeatPreviewVisible, alert: repeatPreviewAlerts, status: await panel.getByRole('status').allTextContents().catch(() => []) });
    const wordRepeatApply = repeatPreviewVisible ? await confirmPreview(page, panel, repeatConfirm, 'WORD_REPEAT') : { ok: false, details: { reason: 'Repeat preview did not return confirmation' } };
    if (wordRepeatApply.ok) await waitFor(async () => (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json?.rows?.length >= 2, 15000);
    wordState = (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json;
    wordXml = await archiveText(docxId, 'word/document.xml');
    check('Word repeat preserves edited generated row and updates unaffected source value', wordXml.includes('NATIVE_DOCS_MANUAL_EDIT') && /1500/.test(wordXml), wordXml.match(/<w:tr[\s\S]*?<\/w:tr>/g));
    check('Word repeat retains two distinct stable entity identities', new Set(wordState.rows.filter((r: any) => !String(r.entityId).startsWith('manual:')).map((r: any) => r.entityId)).size === 2, wordState.rows);
    check('Word bookmark names are unique after repeat/save', (() => { const names = [...wordXml.matchAll(/<w:bookmarkStart\b[^>]*\bw:name="([^"]+)"/g)].map((m) => m[1]); return names.length > 0 && new Set(names).size === names.length; })());
    const rowMarkersAfterRepeat = [...wordXml.matchAll(/w:name="(FLUXROW_[^"]+)"/g)].map((match) => match[1]);
    check('Word repeat did not duplicate durable FLUXROW bookmarks or change the manually edited row identity', rowMarkersAfterRepeat.length === 2 && new Set(rowMarkersAfterRepeat).size === 2 && rowMarkersAfterRepeat.includes(manualGeneratedRowMarker), { rowMarkersAfterRepeat, manualGeneratedRowMarker });
    } else check('Word fill confirmation produced persisted entity rows', false, 'See WORD_CONFIRM_DIAGNOSTIC and WORD_APPLY_RESULT_DIAGNOSTIC');
  }
  const docsLight = await capture(page, docs, 'docs-light');
  await resetPage(false);
  await navigateOffice(page, `/office-doc?file=${encodeURIComponent(docxId)}`);
  const reopenedDocs = await openPanel(page, 'Flux Office — Документ');
  const reopenedDoc = reopenedDocs.locator('.ProseMirror');
  await reopenedDoc.waitFor({ timeout: 15000 });
  check('saved Word anchor and adjacent cell text survive actual editor reopen', await reopenedDoc.locator('table tr').count() >= 2 && (await archiveText(docxId, 'word/document.xml')).includes('DOCPROPERTY'));
  if (wordFillRan) check('Word generated rows, updated source, and manual cell edit survive reopen', await reopenedDoc.locator('table tr').count() >= 4 && (await archiveText(docxId, 'word/document.xml')).includes('NATIVE_DOCS_MANUAL_EDIT') && /1500/.test(await archiveText(docxId, 'word/document.xml')));

  console.log('\n1b. Native template is rebound to the target document anchor');
  await resetPage(false);
  await navigateOffice(page, `/office-doc?file=${encodeURIComponent(templateTargetId)}`);
  const targetDocs = await openPanel(page, 'Flux Office — Документ');
  const targetEditor = targetDocs.locator('.ProseMirror').first();
  await targetEditor.waitFor({ timeout: 15000 });
  await targetEditor.locator('table tr').first().locator('td,th').nth(1).click();
  await page.getByRole('button', { name: /2\. Поля и шапка/ }).click();
  const targetPanel = page.getByRole('complementary', { name: 'Flux Office' });
  await targetPanel.getByLabel('Найти поле Flux').fill('Расход воздуха');
  await targetPanel.getByRole('button', { name: /Расход воздуха/ }).first().click();
  await waitFor(async () => targetPanel.getByRole('button', { name: 'Привязать поле' }).isEnabled());
  await targetPanel.getByRole('button', { name: 'Привязать поле' }).click();
  const targetAnchor = await waitFor(async () => !!(await api('GET', `/api/project-data/files/${templateTargetId}/office-state`)).json?.schema?.anchors?.[0]?.id);
  const targetAnchorId = String((await api('GET', `/api/project-data/files/${templateTargetId}/office-state`)).json?.schema?.anchors?.[0]?.id || '');
  check('target document has its own native Word anchor UUID', !!targetAnchor && !!targetAnchorId && targetAnchorId !== sourceAnchorId, { sourceAnchorId, targetAnchorId });
  await targetPanel.getByRole('button', { name: templateName, exact: true }).click();
  const templateAnchorMapping = targetPanel.getByLabel('Целевая ячейка для якоря шаблона 1');
  const templateMappingReady = await waitFor(async () => await templateAnchorMapping.count() > 0 || (await targetPanel.getByRole('status').filter({ hasText: /Шаблон ожидает уточнения/ }).count() === 0 && await targetPanel.getByText('Шаблон сопоставлен с этим документом. Сохраните схему, чтобы применить его.').count() > 0), 15000);
  check('template opening finishes loading its mapping decision', templateMappingReady);
  if (await templateAnchorMapping.count()) {
    const candidateIds = await templateAnchorMapping.locator('option').evaluateAll((options: HTMLOptionElement[]) => options.map((option) => option.value).filter(Boolean));
    check('ambiguous template slot offers the real target document anchor as a candidate', candidateIds.includes(targetAnchorId), { targetAnchorId, candidateIds });
    if (candidateIds.includes(targetAnchorId)) await templateAnchorMapping.selectOption(targetAnchorId);
  }
  const templateReady = await waitFor(async () => await targetPanel.getByRole('status').filter({ hasText: /Шаблон ожидает уточнения/ }).count() === 0 && await targetPanel.getByText('Шаблон сопоставлен с этим документом. Сохраните схему, чтобы применить его.').count() > 0 && await targetPanel.getByRole('button', { name: 'Сохранить схему' }).isEnabled().catch(() => false));
  check('ambiguous template mapping is explicitly resolved to the target anchor', templateReady, { targetAnchorId, panel: await targetPanel.innerText().catch(() => '') });
  if (templateReady) await targetPanel.getByRole('button', { name: 'Сохранить схему' }).click();
  const mappedTemplateState = await waitFor(async () => {
    const state = (await api('GET', `/api/project-data/files/${templateTargetId}/office-state`)).json;
    const anchor = state?.schema?.anchors?.[0];
    const parts = anchor?.parts || [];
    return anchor?.id === targetAnchorId && parts.map((part: any) => part.kind).join(',') === 'text,field,operator,text,text' &&
      parts[0]?.text === 'Расход: ' && parts[1]?.binding?.anchorId === targetAnchorId && parts[2]?.operator === '*' &&
      parts[3]?.text === '2' && parts[4]?.text === ' м³/ч';
  });
  check('cross-document template applies all five header parts and rebinds its field to the target UUID', templateReady && mappedTemplateState, (await api('GET', `/api/project-data/files/${templateTargetId}/office-state`)).json?.schema);
  const targetXml = await archiveText(templateTargetId, 'word/document.xml');
  check('cross-document template persists the target bookmark and no source UUID in target OOXML', targetXml.includes(`FLUX_${targetAnchorId.replaceAll('-', '')}`) && !targetXml.includes(sourceAnchorId.replaceAll('-', '')));
  check('cross-document template writes its custom prefix, arithmetic, and field token into target Word XML', xmlText(targetXml).includes('Расход: ') && xmlText(targetXml).includes('*2 м³/ч') && /DOCPROPERTY\s+"flux:/.test(targetXml), xmlText(targetXml).slice(0, 700));

  console.log('\n1c. Explicitly removing a field token persists through native Word reopen');
  await resetPage(false);
  await navigateOffice(page, `/office-doc?file=${encodeURIComponent(docxId)}`);
  const removeDocs = await openPanel(page, 'Flux Office — Документ');
  await removeDocs.locator('.ProseMirror').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /2\. Поля и шапка/ }).click();
  const removePanel = page.getByRole('complementary', { name: 'Flux Office' });
  await removePanel.getByRole('button', { name: 'Удалить привязку поля' }).click();
  await removePanel.getByRole('button', { name: 'Сохранить схему' }).click();
  const tokenRemoved = await waitFor(async () => {
    const state = (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json;
    return state?.schema?.anchors?.[0]?.parts?.length === 0 && !/DOCPROPERTY\s+"flux:/.test(await archiveText(docxId, 'word/document.xml'));
  });
  check('removing the binding explicitly deletes the native Word field instruction while retaining surrounding table content', tokenRemoved && (await archiveText(docxId, 'word/document.xml')).includes('Текст после поля') && (await archiveText(docxId, 'word/document.xml')).includes('Ручная строка'));
  await resetPage(false);
  await navigateOffice(page, `/office-doc?file=${encodeURIComponent(docxId)}`);
  const removedDocs = await openPanel(page, 'Flux Office — Документ');
  await removedDocs.locator('.ProseMirror').waitFor({ timeout: 15000 });
  check('explicit field removal survives reopening the actual DOCX', !/DOCPROPERTY\s+"flux:/.test(await archiveText(docxId, 'word/document.xml')) && await removedDocs.locator('[data-instr-field*="flux:"]').count() === 0);

  console.log('\n2. Native Sheets editor, selected cell, fill/repeat/manual rows');
  await resetPage(false);
  await navigateOffice(page, `/office-sheet?file=${encodeURIComponent(xlsxId)}`);
  let sheets = await openPanel(page, 'Flux Office — Таблица');
  const sheetFrameState = await sheets.locator('body').evaluate((body: HTMLElement) => ({
    title: document.title,
    text: body.innerText.slice(0, 1000),
    canvases: [...body.querySelectorAll('canvas')].map((el) => { const r = el.getBoundingClientRect(); return { id: el.id, cls: el.className, width: el.width, height: el.height, rect: [r.x, r.y, r.width, r.height], visible: r.width > 0 && r.height > 0 }; }),
    active: { tag: document.activeElement?.tagName, cls: (document.activeElement as HTMLElement | null)?.className },
  }));
  console.log('SHEETS_EDITOR_FRAME_DIAGNOSTIC', JSON.stringify(sheetFrameState));
  await page.screenshot({ path: '/tmp/office-addon-native-sheets-before-anchor.png', fullPage: true });
  const ribbonReady = await waitFor(async () => await sheets.getByText('Главная', { exact: true }).first().isVisible().catch(() => false) && await sheets.getByText('Вставка', { exact: true }).first().isVisible().catch(() => false), 15000);
  check('ordinary Excel ribbon remains available', ribbonReady, sheetFrameState);
  check('Excel editor loaded the actual file before selection', await waitForSheetFile(sheets));
  check('Excel loaded its real manual row into the editable grid', await waitFor(async () => sheets.locator('body').evaluate(() => {
    const api = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
    return api?.getActiveWorkbook?.()?.getSheets?.().find((sheet: any) => sheet.getSheetName() === 'Перечень')?.getRange('A5')?.getValues?.()?.[0]?.[0] === 'MANUAL_KEEP';
  }).catch(() => false), 15000));
  const nameBox = sheets.locator('input.univer-box-border').first();
  const gridCanvas = await clickSheetGrid(sheets);
  await nameBox.fill('A1'); await nameBox.press('Enter');
  console.log('SHEETS_GRID_CANVAS_SELECTED', JSON.stringify(gridCanvas));
  await page.getByRole('button', { name: /2\. Поля и шапка/ }).click();
  let sheetPanel = page.getByRole('complementary', { name: 'Flux Office' });
  await sheetPanel.getByLabel('Найти поле Flux').fill('Расход воздуха');
  await sheetPanel.getByRole('button', { name: /Расход воздуха/ }).first().click();
  await waitFor(async () => sheetPanel.getByRole('button', { name: 'Привязать поле' }).isEnabled());
  await sheetPanel.getByRole('button', { name: 'Привязать поле' }).click();
  check('selected real A1 cell became a persisted Excel anchor', await waitFor(async () => (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json?.schema?.anchors?.some((a: any) => a.kind === 'excel-range')));
  await page.keyboard.press('Control+s');
  check('Excel anchor metadata is present in actual workbook defined names', await waitFor(async () => /FLUX_ANCHOR_/.test(await archiveText(xlsxId, 'xl/workbook.xml'))));
  await waitForSheetFile(sheets);
  await sheetPanel.getByRole('button', { name: 'Добавить оператор *' }).click();
  await sheetPanel.getByRole('button', { name: 'Текст', exact: true }).click();
  await sheetPanel.getByLabel('Текст заголовка 3').fill('2');
  await sheetPanel.getByRole('button', { name: 'Текст', exact: true }).click();
  await sheetPanel.getByLabel('Текст заголовка 4').fill(' м³/ч');
  await sheetPanel.getByRole('button', { name: 'Текст', exact: true }).click();
  for (let part = 5; part > 1; part--) await sheetPanel.getByRole('button', { name: `Переместить часть ${part} выше` }).click();
  await sheetPanel.getByLabel('Текст заголовка 1').fill('Расход: ');
  await sheetPanel.getByRole('button', { name: 'Сохранить схему' }).click();
  const customSheetHeaderState = await waitFor(async () => {
    const state = (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json;
    return state?.schema?.anchors?.[0]?.parts?.length === 5 && state.schema.anchors[0].parts[0]?.text === 'Расход: ';
  });
  const expectedSheetHeader = 'Расход: Аэродинамика · Расход воздуха*2 м³/ч';
  check('Sheets schema persists ordered prefix, protected field, arithmetic, operand, and suffix', customSheetHeaderState && (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json?.schema?.anchors?.[0]?.parts?.map((part: any) => part.kind).join(',') === 'text,field,operator,text,text');
  check('custom header cell is loaded in the native workbook before reading it', await loadSheetAddress(sheets, 'A1'));
  check('native Excel A1 displays the custom ordered header', await waitFor(async () => await sheetCell(sheets, 'A1') === expectedSheetHeader), await sheetCell(sheets, 'A1'));
  await page.keyboard.press('Control+s');
  check('custom Sheets header is serialized into the actual workbook parts', await waitFor(async () => xmlText(await archiveXml(xlsxId)).includes(expectedSheetHeader)));
  for (let remove = 0; remove < 4; remove++) await sheetPanel.getByRole('button', { name: 'Удалить часть заголовка' }).last().click();
  await sheetPanel.getByRole('button', { name: 'Сохранить схему' }).click();
  const restoredSheetHeader = await waitFor(async () => {
    const state = (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json;
    return state?.schema?.anchors?.[0]?.parts?.length === 1 && state.schema.anchors[0].parts[0]?.kind === 'field';
  });
  const fieldOnlyHeaderLoaded = await loadSheetAddress(sheets, 'A1');
  check('Sheets custom text and arithmetic can be removed while preserving the field binding', restoredSheetHeader && fieldOnlyHeaderLoaded && await waitFor(async () => await sheetCell(sheets, 'A1') === 'Аэродинамика · Расход воздуха'), await sheetCell(sheets, 'A1'));
  await page.keyboard.press('Control+s');
  await clickSheetGrid(sheets);
  check('field-only A1 stays loaded for the protected-edit check', await loadSheetAddress(sheets, 'A1'));
  const protectedHeader = await sheets.locator('body').evaluate(() => {
    const api = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
    return api?.getActiveWorkbook?.()?.getSheets?.().find((item: any) => item.getSheetName() === 'Перечень')?.getRange('A1')?.getValues?.()?.[0]?.[0];
  });
  await sheets.locator('input.univer-box-border').first().fill('A1');
  await sheets.locator('input.univer-box-border').first().press('Enter');
  await sheets.locator('canvas[id^="univer-sheet-main-canvas_"]').first().focus();
  await page.keyboard.type('FORBIDDEN_HEADER'); await page.keyboard.press('Enter');
  const headerAfterEdit = await sheets.locator('body').evaluate(() => {
    const api = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
    return api?.getActiveWorkbook?.()?.getSheets?.().find((item: any) => item.getSheetName() === 'Перечень')?.getRange('A1')?.getValues?.()?.[0]?.[0];
  });
  check('ordinary typing cannot replace the persisted protected Excel header', typeof protectedHeader === 'string' && protectedHeader.includes('Расход воздуха') && headerAfterEdit === protectedHeader, { protectedHeader, headerAfterEdit });
  await page.keyboard.press('Escape');
  await sheetPanel.getByRole('button', { name: 'Удалить привязку поля' }).click();
  await sheetPanel.getByRole('button', { name: 'Сохранить схему' }).click();
  const removedSheetBinding = await waitFor(async () => {
    const state = (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json;
    return state?.schema?.anchors?.[0]?.parts?.length === 0;
  });
  const removedHeaderLoaded = await loadSheetAddress(sheets, 'A1');
  check('explicitly removing the Sheets field token leaves the anchor and clears its rendered header', removedSheetBinding && removedHeaderLoaded && await waitFor(async () => (await sheetCell(sheets, 'A1')) === ''), { state: (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json?.schema?.anchors?.[0], cell: await sheetCell(sheets, 'A1') });
  const manualCellLoaded = await loadSheetAddress(sheets, 'A5');
  check('token removal leaves unrelated manual cell and formula workbook untouched', manualCellLoaded && await sheetCell(sheets, 'A5') === 'MANUAL_KEEP' && await hasEmptyFormulaTarget(formulaId));
  await sheets.locator('input.univer-box-border').first().fill('A1');
  await sheets.locator('input.univer-box-border').first().press('Enter');
  await sheetPanel.getByLabel('Найти поле Flux').fill('Расход воздуха');
  await sheetPanel.getByRole('button', { name: /Расход воздуха/ }).first().click();
  await waitFor(async () => sheetPanel.getByRole('button', { name: 'Привязать поле' }).isEnabled());
  await sheetPanel.getByRole('button', { name: 'Привязать поле' }).click();
  const reboundSheetField = await waitFor(async () => {
    const state = (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json;
    return state?.schema?.anchors?.[0]?.parts?.some((part: any) => part.kind === 'field' && part.binding?.fieldKey);
  });
  const reboundHeaderLoaded = await loadSheetAddress(sheets, 'A1');
  check('field token can be rebound to the same real A1 anchor after removal', reboundSheetField && reboundHeaderLoaded && await waitFor(async () => await sheetCell(sheets, 'A1') === 'Аэродинамика · Расход воздуха'));
  const reboundManualCellLoaded = await loadSheetAddress(sheets, 'A5');
  check('rebind preserves unrelated manual and formula cells', reboundManualCellLoaded && await sheetCell(sheets, 'A5') === 'MANUAL_KEEP' && await hasEmptyFormulaTarget(formulaId));
  await page.keyboard.press('Control+s');
  await capture(page, sheets, 'sheets-light');
  let beforeRepeat = (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json;
  check('saved schema has a stable anchor id and project binding', beforeRepeat?.schema?.anchors?.some((a: any) => a.id && a.parts?.some((part: any) => part.kind === 'field' && part.binding?.fieldKey)), beforeRepeat?.schema);

  const anchor = beforeRepeat?.schema?.anchors?.find((a: any) => a.kind === 'excel-range');
  if (anchor?.id && beforeRepeat?.baseHash) {
    const catalog = await api('GET', `/api/project-data/catalog?projectId=${encodeURIComponent(fixture.projectId)}`);
    const seed = await api('POST', '/api/project-data/office/query', { projectId: fixture.projectId, query: { entity: 'element', columns: ['name'], filters: [], sort: [], limit: 10, excludedEntityIds: [] } });
    const seeded = await api('PUT', `/api/project-data/files/${xlsxId}/office-state`, {
      baseHash: beforeRepeat.baseHash, sourceRevision: seed.json?.revision || catalog.json?.revision || '', schema: beforeRepeat.schema,
      rows: [{ entityId: 'manual:native-fixture-row', entityType: 'manual', sourceId: '', sourceRevision: seed.json?.revision || '', anchorIds: [anchor.id], cells: { [anchor.id]: 'A5' } }],
    });
    check('fixture records the unrelated physical manual row at its real OOXML address', seeded.status === 200 && seeded.json?.ok, seeded.json);
    // Fixture API изменил байты книги вне редактора и завершил прежний сеанс.
    // Открываем актуальный файл в одном новом окне, как после внешней правки.
    await resetPage(false);
    await navigateOffice(page, `/office-sheet?file=${encodeURIComponent(xlsxId)}`);
    sheets = await openPanel(page, 'Flux Office — Таблица');
    sheetPanel = page.getByRole('complementary', { name: 'Flux Office' });
    check('manual-row fixture reopened from its actual file version', await waitForSheetFile(sheets));
    beforeRepeat = (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json;
  } else check('Excel fixture anchor exists before seeding its manual row identity', false, beforeRepeat?.schema);

  // Data fill is intentionally enabled only through real preview + explicit confirm.
  // The repeat/manual-row assertions inspect both OOXML cells and saved row identities.
  await page.getByRole('button', { name: /1\. Выборка/ }).click();
  await sheetPanel.getByRole('button', { name: 'Обновить выборку' }).click();
  await waitFor(async () => (await sheetPanel.getByText(/FAN_HIGH/).count()) > 0, 15000);
  check('fixture query returns its actual stable equipment row', await sheetPanel.getByText(/FAN_HIGH/).count() > 0);
  // The selection checkbox is scoped to the row that displays the fixture identity.
  check('fixture query exposes both stable equipment identities', await sheetPanel.getByText(/FAN_LOW/).count() > 0 && await sheetPanel.getByText(/FAN_HIGH/).count() > 0);
  await sheetPanel.getByRole('checkbox', { name: 'Выбрать все строки' }).check();
  await page.getByRole('button', { name: /3\. Обновление/ }).click();
  const preview = sheetPanel.getByRole('button', { name: 'Предпросмотр заполнения' });
  const sheetPreviewReady = await waitFor(async () => await preview.isEnabled().catch(() => false), 30000);
  if (sheetPreviewReady) {
    await preview.click();
    const sheetConfirm = sheetPanel.getByRole('button', { name: 'Подтвердить и заполнить' });
    const sheetPreviewVisible = await sheetConfirm.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    check('fill stays in preview until explicit confirmation', sheetPreviewVisible);
    // Confirmation is a deliberate UI action against only the disposable file.
    const sheetApply = await confirmPreview(page, sheetPanel, sheetConfirm, 'SHEETS');
    const sheetRowsReady = sheetApply.ok && await waitFor(async () => (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json?.rows?.length > 0, 10000);
    if (!sheetRowsReady) console.error('SHEETS_APPLY_RESULT_DIAGNOSTIC', JSON.stringify({ ...sheetApply.details, officeState: (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json, workbookXml: (await archiveText(xlsxId, 'xl/worksheets/sheet1.xml')).slice(0, 2500) }));
    let state = (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json;
    check('first fill wrote stable row metadata', state?.rows?.some((r: any) => r.entityId && !String(r.entityId).startsWith('manual:')), state?.rows);
    check('both selected fixture entities were written exactly once', ['FAN_LOW', 'FAN_HIGH'].every((name) => state?.rows?.filter((r: any) => r.values?.name === name || r.values?.['name'] === name).length === 1) || state?.rows?.filter((r: any) => !String(r.entityId).startsWith('manual:')).length === 2, state?.rows);
    check('first fill preserved unrelated manual row metadata at A5', state?.rows?.some((r: any) => String(r.entityId).startsWith('manual:') && Object.values(r.cells || {}).includes('A5')), state?.rows);
    // Change a generated row through the real sheet cell, then rerun preview/apply.
    // This checks the native writer against current OOXML; stable entity identity must not duplicate.
    if (!sheetRowsReady) {
      check('native Sheets fill confirmation produced rows for manual/repeat verification', false, 'See SHEETS_CONFIRM_DIAGNOSTIC and SHEETS_APPLY_RESULT_DIAGNOSTIC');
    }
    if (sheetRowsReady) {
    const generated = state?.rows?.find((r: any) => !String(r.entityId).startsWith('manual:') && Number(r.values?.[anchor.id]) === 900);
    const address = generated?.cells?.[state.schema?.anchors?.[0]?.id];
    if (address) {
      check('Excel editor reacquired writable lease after filling', await waitFor(async () => await sheetPanel.getByText(/Документ открыт только для просмотра/).count() === 0, 20000) && await waitForSheetFile(sheets));
      await sheets.locator('input.univer-box-border').first().fill(address); await sheets.locator('input.univer-box-border').first().press('Enter');
      await sheets.locator('canvas[id^="univer-sheet-main-canvas_"]').first().focus();
      await page.keyboard.type('NATIVE_MANUAL_EDIT'); await page.keyboard.press('Enter'); await page.keyboard.press('Control+s');
      await waitFor(async () => (await archiveText(xlsxId, 'xl/worksheets/sheet1.xml')).includes('NATIVE_MANUAL_EDIT'), 15000);
      const editedXml = await archiveText(xlsxId, 'xl/worksheets/sheet1.xml');
      check('manual edit to generated row persisted in actual OOXML cell', editedXml.includes('NATIVE_MANUAL_EDIT'), editedXml.match(/<row[^>]*>[\s\S]*?NATIVE_MANUAL_EDIT[\s\S]*?<\/row>/)?.[0]);
      const sourceQuery = await api('POST', '/api/project-data/office/query', { projectId: fixture.projectId, query: { entity: 'element', columns: ['name', 'param:Аэродинамика|Расход воздуха'], filters: [], sort: [], limit: 20, excludedEntityIds: [] } });
      const changedSource = sourceQuery.json?.rows?.find((item: any) => item.values?.name?.value === 'FAN_HIGH');
      const rawComponentId = changedSource?.entityId ? decodeURIComponent(String(changedSource.entityId).split(':').at(-1) || '') : '';
      const sourceUpdate = rawComponentId ? await api('POST', `/api/equipment/component/${encodeURIComponent(rawComponentId)}/override`, { group: 'Аэродинамика', key: 'Расход воздуха', value: '2000' }) : { status: 0, json: null };
      check('fixture source entity updated through its real edit API', sourceUpdate.status === 200, sourceUpdate.json);
      // Re-run the real query/preview/confirm cycle; the edited entity must be treated as
      // a conflict/manual row, while unrelated A5 remains untouched.
      await page.getByRole('button', { name: /1\. Выборка/ }).click();
      await sheetPanel.getByRole('button', { name: 'Обновить выборку' }).click();
      await waitFor(async () => (await sheetPanel.getByText(/FAN_HIGH/).count()) > 0, 15000);
      await sheetPanel.getByRole('checkbox', { name: 'Выбрать все строки' }).check();
      await page.getByRole('button', { name: /3\. Обновление/ }).click();
      await sheetPanel.getByRole('button', { name: 'Предпросмотр заполнения' }).click();
      const sheetRepeatConfirm = sheetPanel.getByRole('button', { name: 'Подтвердить и заполнить' });
      await sheetRepeatConfirm.waitFor({ state: 'visible', timeout: 10000 });
      console.log('SHEETS_BEFORE_REPEAT', JSON.stringify({ state: (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json, values: await sheets.locator('body').evaluate(() => {
        const runtime = (window as any).__fluxSheets;
        const sheet = runtime?.univerRef?.current?.univerAPI?.getActiveWorkbook?.()?.getActiveSheet?.();
        const lazy = runtime?.lazyWorkbookRef?.current;
        return { name: sheet?.getSheetName(), a6: sheet?.getRange('A6')?.getValues?.(), a7: sheet?.getRange('A7')?.getValues?.(), flags: lazy?.flags, loaded: lazy?.loadedRanges ? [...lazy.loadedRanges] : [], sheets: runtime?.univerRef?.current?.univerAPI?.getActiveWorkbook?.()?.getSheets?.().map((item: any) => ({ name: item.getSheetName(), id: item.getSheetId() })) };
      }).catch(() => null) }));
      await sheets.locator('body').evaluate(`(() => {
        window.__fluxRangeReads = [];
        const sheet = window.__fluxSheets.univerRef.current.univerAPI.getActiveWorkbook().getActiveSheet();
        const proto = Object.getPrototypeOf(sheet), original = proto.getRange;
        proto.getRange = function(...args) {
          const range = original.apply(this, args), read = range.getValues, name = this.getSheetName();
          range.getValues = function(...params) { const values = read.apply(this, params); if (window.__fluxRangeReads.length < 100) window.__fluxRangeReads.push({ sheet: name, row: range.getRow(), col: range.getColumn(), values }); return values; };
          return range;
        };
      })()`);
      const sheetRepeatApply = await confirmPreview(page, sheetPanel, sheetRepeatConfirm, 'SHEETS_REPEAT');
      console.log('SHEETS_REPEAT_READS', JSON.stringify(await sheets.locator('body').evaluate(() => (window as any).__fluxRangeReads || [])));
      check('Sheets repeat fill completed without a save or version error', sheetRepeatApply.ok, sheetRepeatApply.details.alert);
      if (sheetRepeatApply.ok) await waitFor(async () => !!(await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json?.rows, 10000);
      state = (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json;
      const repeatXml = await archiveText(xlsxId, 'xl/worksheets/sheet1.xml');
      check('repeat update preserved changed generated cell text', repeatXml.includes('NATIVE_MANUAL_EDIT'), repeatXml.match(/<row[^>]*>[\s\S]*?NATIVE_MANUAL_EDIT[\s\S]*?<\/row>/)?.[0]);
      check('repeat update wrote the updated source value 2000 into actual workbook XML', />2000<\/(?:v|t)>/.test(repeatXml), (repeatXml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || []).slice(-3));
      check('repeat update kept exactly one row for the stable entity', state.rows.filter((r: any) => r.entityId === generated.entityId).length === 1, state.rows);
      check('repeat update preserved unrelated manual row identity and physical value', state.rows.some((r: any) => String(r.entityId).startsWith('manual:') && Object.values(r.cells || {}).includes('A5')) && repeatXml.includes('MANUAL_KEEP'), state.rows);
    } else check('fill returned a verifiable generated cell address', false, generated);
    }
  } else {
    check('native fill preview enabled for selected fixture row', false, await sheetPanel.innerText().catch(() => ''));
  }

  console.log('\n3. Empty-result formula target remains protected');
  await resetPage(false);
  await navigateOffice(page, `/office-sheet?file=${encodeURIComponent(formulaId)}`);
  const formulaFrame = page.frameLocator('iframe[title="Flux Office — Таблица"]');
  check('formula editor loaded the actual workbook', await waitForSheetFile(formulaFrame));
  console.log('FORMULA_GRID_CANVAS_SELECTED', JSON.stringify(await clickSheetGrid(formulaFrame)));
  await formulaFrame.locator('input.univer-box-border').first().fill('A1');
  await formulaFrame.locator('input.univer-box-border').first().press('Enter');
  await openPanel(page, 'Flux Office — Таблица');
  let formulaPanel = page.getByRole('complementary', { name: 'Flux Office' });
  await page.getByRole('button', { name: /2\. Поля и шапка/ }).click();
  await formulaPanel.getByLabel('Найти поле Flux').fill('name');
  await formulaPanel.getByRole('button', { name: /Наименование|Название/ }).first().click();
  await waitFor(async () => formulaPanel.getByRole('button', { name: 'Привязать поле' }).isEnabled());
  await formulaPanel.getByRole('button', { name: 'Привязать поле' }).click();
  let formulaState = (await api('GET', `/api/project-data/files/${formulaId}/office-state`)).json;
  check('formula workbook has saved field anchor before preview', await waitFor(async () => (formulaState = (await api('GET', `/api/project-data/files/${formulaId}/office-state`)).json)?.schema?.anchors?.length > 0));
  const formulaAnchor = formulaState?.schema?.anchors?.find((item: any) => item.kind === 'excel-range');
  const entityQuery = await api('POST', '/api/project-data/office/query', { projectId: fixture.projectId, query: { entity: 'element', columns: ['name', 'param:Аэродинамика|Расход воздуха'], filters: [], sort: [], limit: 20, excludedEntityIds: [] } });
  const formulaEntity = entityQuery.json?.rows?.find((item: any) => item.values?.name?.value === 'FAN_HIGH');
  const formulaSeed = formulaAnchor?.id && formulaEntity?.entityId ? await api('PUT', `/api/project-data/files/${formulaId}/office-state`, {
    baseHash: formulaState.baseHash, sourceRevision: entityQuery.json.revision, schema: formulaState.schema,
    rows: [{ entityId: formulaEntity.entityId, entityType: 'element', sourceId: 'equipment', sourceRevision: entityQuery.json.revision, anchorIds: [formulaAnchor.id], cells: { [formulaAnchor.id]: 'A2' }, values: { [`param:Аэродинамика|Расход воздуха`]: 1200 } }],
  }) : { status: 0, json: null };
  check('formula test maps a real selected entity row to physical target A2', formulaSeed.status === 200 && formulaSeed.json?.ok, formulaSeed.json);
  await resetPage(false);
  await navigateOffice(page, `/office-sheet?file=${encodeURIComponent(formulaId)}`);
  const reopenedFormulaFrame = await openPanel(page, 'Flux Office — Таблица');
  formulaPanel = page.getByRole('complementary', { name: 'Flux Office' });
  check('formula fixture reopened after its external metadata write', await waitForSheetFile(reopenedFormulaFrame));
  await page.getByRole('button', { name: /1\. Выборка/ }).click();
  await formulaPanel.getByRole('button', { name: 'Обновить выборку' }).click();
  await waitFor(async () => (await formulaPanel.getByRole('grid', { name: 'Предпросмотр выборки' }).getByText(/FAN_HIGH/).count()) > 0);
  await formulaPanel.getByRole('row').filter({ hasText: 'FAN_HIGH' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: /3\. Обновление/ }).click();
  await formulaPanel.getByRole('button', { name: 'Предпросмотр заполнения' }).click();
  const confirmFormula = formulaPanel.getByRole('button', { name: 'Подтвердить и заполнить' });
  await confirmFormula.waitFor({ state: 'visible', timeout: 10000 });
  check('formula target remains a real formula with an empty displayed result', await hasEmptyFormulaTarget(formulaId));
  if (await confirmFormula.isEnabled().catch(() => false)) {
    await confirmPreview(page, formulaPanel, confirmFormula, 'FORMULA');
    check('native apply preserves an empty-result formula and reports the skipped row', await hasEmptyFormulaTarget(formulaId) && (await formulaPanel.getByRole('alert').count() > 0 || await formulaPanel.getByRole('status').filter({ hasText: /Без замены оставлены строки с ручными правками: 1/ }).count() > 0));
  } else {
    check('preview disables confirmation when a formula target is occupied', true);
  }
  const formulaAfter = (await api('GET', `/api/project-data/files/${formulaId}/office-state`)).json;
  check('formula refusal keeps exactly the original entity-to-A2 row identity', formulaAfter?.rows?.length === 1 && formulaAfter.rows[0].entityId === formulaEntity?.entityId && formulaAfter.rows[0].cells?.[formulaAnchor?.id] === 'A2', formulaAfter?.rows);

  await runNativeSheetCellActions({ fixture, folderId, stamp, created, api, raw, upload, check, waitFor, resetPage, navigateOffice, openPanel, waitForSheetFile, clickSheetGrid, page: () => page });
  await runNativeWordCellActions({ folderId, stamp, created, api, raw, upload, check, waitFor, resetPage, navigateOffice, openPanel, page: () => page });

  // Theme screenshot is a second actual editor session; does not alter the workbook.
  await resetPage(true);
  await navigateOffice(page, `/office-doc?file=${encodeURIComponent(docxId)}`);
  const darkDocs = await openPanel(page, 'Flux Office — Документ');
  const darkDocsMetrics = await capture(page, darkDocs, 'docs-dark');
  check('Word dark and light themes use distinct add-on surfaces', darkDocsMetrics.background !== docsLight.background && darkDocsMetrics.background !== 'rgb(255, 255, 255)');
  await resetPage(true);
  await navigateOffice(page, `/office-sheet?file=${encodeURIComponent(xlsxId)}`);
  const darkFrame = await openPanel(page, 'Flux Office — Таблица');
  const darkMetrics = await capture(page, darkFrame, 'sheets-dark');
  check('dark theme uses a dark actual add-on surface', darkMetrics.background !== 'rgb(255, 255, 255)' && darkMetrics.background !== 'rgba(0, 0, 0, 0)');
  await context.close();

  console.log('\n4. Issued Office revision is immutable and draft is an exact copy');
  const beforeIssue = await raw('GET', `/api/files/${encodeURIComponent(docxId)}/raw`);
  const sourceSha = sha256(beforeIssue.bytes);
  const revisionState = (await api('GET', `/api/project-data/files/${encodeURIComponent(docxId)}/office-state`)).json;
  const embeddedSourceKinds = [...new Set([
    ...(revisionState?.rows || []).map((row: any) => String(row.sourceId || '')),
    ...(revisionState?.schema?.anchors || []).flatMap((anchor: any) => (anchor.parts || []).map((part: any) => String(part?.binding?.sourceId || ''))),
  ].filter(Boolean))].sort();
  const expectedSourceKind = embeddedSourceKinds.join(',') || 'document';
  const expectedSourceRevision = String(revisionState?.sourceRevision || '');
  const staleIssue = await api('POST', `/api/office/revisions/${encodeURIComponent(docxId)}/issue`, { sourceSha: '0'.repeat(64) });
  check('issuing against a stale content hash is rejected without a revision', staleIssue.status === 409, staleIssue.json);
  const issued = await api('POST', `/api/office/revisions/${encodeURIComponent(docxId)}/issue`, { sourceSha, sourceKind: 'spoofed-client-kind', sourceRevision: 'spoofed-client-revision', schemaVersion: 1 });
  const issuedRevision = issued.json?.revision;
  check('current disposable Word file can be issued as an immutable revision', issued.status === 201 && issuedRevision?.status === 'ISSUED' && issuedRevision.sha256 === sourceSha, issued.json);
  check('issue provenance comes from embedded bindings and the server project fingerprint, not client metadata', !!expectedSourceRevision && issuedRevision?.sourceKind === expectedSourceKind && issuedRevision?.sourceRevision === expectedSourceRevision && issuedRevision?.sourceKind !== 'spoofed-client-kind' && issuedRevision?.sourceRevision !== 'spoofed-client-revision', { expectedSourceKind, expectedSourceRevision, actualSourceKind: issuedRevision?.sourceKind, actualSourceRevision: issuedRevision?.sourceRevision });
  const issueAgain = await api('POST', `/api/office/revisions/${encodeURIComponent(docxId)}/issue`, { sourceSha });
  check('repeating the same issue request is idempotent', issueAgain.status === 200 && issueAgain.json?.unchanged === true && issueAgain.json?.revision?.id === issuedRevision?.id);
  const revisions = await api('GET', `/api/office/revisions/${encodeURIComponent(docxId)}`);
  check('revision history exposes the issued snapshot and derived provenance', revisions.status === 200 && revisions.json?.revisions?.some((item: any) => item.id === issuedRevision?.id && item.sourceKind === expectedSourceKind && item.sourceRevision === expectedSourceRevision));
  const rejectedSave = await raw('PUT', `/api/office/files/${encodeURIComponent(docxId)}/content`, beforeIssue.bytes, { 'X-Base-Sha256': sourceSha });
  check('ordinary native file-save API rejects writes to an issued revision', rejectedSave.status === 423 && rejectedSave.json?.code === 'OFFICE_REVISION_ISSUED', rejectedSave.json);
  const afterRejectedSave = await raw('GET', `/api/files/${encodeURIComponent(docxId)}/raw`);
  check('rejected save leaves the issued file byte-for-byte unchanged', sha256(afterRejectedSave.bytes) === sourceSha);
  const madeDraft = await api('POST', `/api/office/revisions/${encodeURIComponent(docxId)}/draft`, { revisionId: issuedRevision?.id, sourceSha: issuedRevision?.sha256 });
  const draftId = String(madeDraft.json?.fileId || '');
  if (draftId) created.push(draftId);
  check('new revision draft is created from the selected issued snapshot', madeDraft.status === 201 && !!draftId && madeDraft.json?.revision?.status === 'DRAFT' && madeDraft.json?.revision?.parentRevisionId === issuedRevision?.id, madeDraft.json);
  const originalAfterDraft = await raw('GET', `/api/files/${encodeURIComponent(docxId)}/raw`);
  const draftInitial = draftId ? await raw('GET', `/api/files/${encodeURIComponent(draftId)}/raw`) : { status: 0, bytes: Buffer.alloc(0), json: null };
  check('draft starts with the exact issued OOXML bytes and leaves source untouched', sha256(draftInitial.bytes) === issuedRevision?.sha256 && sha256(originalAfterDraft.bytes) === sourceSha);
  const draftZip = await JSZip.loadAsync(draftInitial.bytes);
  const draftDocument = await draftZip.file('word/document.xml')?.async('string');
  if (draftDocument?.includes('Ручная строка')) draftZip.file('word/document.xml', draftDocument.replace('Ручная строка', 'ЧЕРНОВИК_РЕВИЗИИ'));
  const changedDraftBytes = Buffer.from(await draftZip.generateAsync({ type: 'nodebuffer' }));
  const changedDraft = await raw('PUT', `/api/office/files/${encodeURIComponent(draftId)}/content`, changedDraftBytes, { 'X-Base-Sha256': sha256(draftInitial.bytes) });
  check('draft revision remains writable through the ordinary native file-save API', changedDraft.status === 200, changedDraft.json);
  const compare = await api('GET', `/api/office/revisions/${encodeURIComponent(docxId)}/compare?from=${encodeURIComponent(issuedRevision?.id || '')}&to=${encodeURIComponent(madeDraft.json?.revision?.id || '')}`);
  check('revision comparison reads immutable issued bytes and current draft bytes', compare.status === 200 && compare.json?.documentChanged === true && compare.json?.sourceChanged === false && compare.json?.beforeSha === issuedRevision?.sha256 && compare.json?.afterSha === sha256(changedDraftBytes) && Array.isArray(compare.json?.bindings?.changed), compare.json);
  const originalFinal = await raw('GET', `/api/files/${encodeURIComponent(docxId)}/raw`);
  check('editing the new draft never mutates the issued source document', sha256(originalFinal.bytes) === sourceSha);

  console.log('\n5. Issued XLSX is read-only in the native grid; its draft remains writable');
  const xlsxBeforeIssue = await raw('GET', `/api/files/${encodeURIComponent(xlsxId)}/raw`);
  const xlsxSourceSha = sha256(xlsxBeforeIssue.bytes);
  const xlsxIssued = await api('POST', `/api/office/revisions/${encodeURIComponent(xlsxId)}/issue`, { sourceSha: xlsxSourceSha });
  const xlsxRevision = xlsxIssued.json?.revision;
  check('disposable XLSX can be issued as an immutable revision', xlsxIssued.status === 201 && xlsxRevision?.status === 'ISSUED' && xlsxRevision.sha256 === xlsxSourceSha, xlsxIssued.json);
  await resetPage(false);
  await navigateOffice(page, `/office-sheet?file=${encodeURIComponent(xlsxId)}`);
  const issuedSheetFrame = await openPanel(page, 'Flux Office — Таблица');
  const issuedSheetPanel = page.getByRole('complementary', { name: 'Flux Office' });
  check('issued XLSX opens in the actual native grid and announces read-only mode', await waitForSheetFile(issuedSheetFrame) && await waitFor(async () => await issuedSheetPanel.getByText(/Документ открыт только для просмотра/).count() > 0, 15000));
  // Без подгрузки A1 пустая ячейка равна пустой, и запрет записи прошёл бы впустую.
  const issuedHeaderLoaded = await loadSheetAddress(issuedSheetFrame, 'A1');
  const issuedHeader = await sheetCell(issuedSheetFrame, 'A1');
  check('issued XLSX header is loaded before the read-only typing check', issuedHeaderLoaded && typeof issuedHeader === 'string' && issuedHeader !== '', issuedHeader);
  await issuedSheetFrame.locator('input.univer-box-border').first().fill('A1');
  await issuedSheetFrame.locator('input.univer-box-border').first().press('Enter');
  await issuedSheetFrame.locator('canvas[id^="univer-sheet-main-canvas_"]').first().focus();
  await page.keyboard.type('FORBIDDEN_ISSUED_XLSX'); await page.keyboard.press('Enter');
  check('native grid typing cannot modify an issued XLSX header', await sheetCell(issuedSheetFrame, 'A1') === issuedHeader && await waitFor(async () => sha256((await raw('GET', `/api/files/${encodeURIComponent(xlsxId)}/raw`)).bytes) === xlsxSourceSha));
  const issuedNameBox = issuedSheetFrame.locator('input.univer-box-border').first();
  await issuedNameBox.fill('B1'); await issuedNameBox.press('Enter');
  const activeRange = await issuedSheetFrame.locator('body').evaluate(() => {
    const api = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
    return api?.getActiveWorkbook?.()?.getActiveSheet?.()?.getActiveRange?.()?.getA1Notation?.() || '';
  });
  await issuedNameBox.fill('A5'); await issuedNameBox.press('Enter');
  await issuedSheetFrame.locator('canvas[id^="univer-sheet-main-canvas_"]').first().focus();
  await page.keyboard.press('Control+c');
  const copiedManualCell = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  check('issued grid still supports cell navigation and copying manual content', String(activeRange).includes('B1') && copiedManualCell.includes('MANUAL_KEEP'), { activeRange, copiedManualCell });
  const xlsxDraftResult = await api('POST', `/api/office/revisions/${encodeURIComponent(xlsxId)}/draft`, { revisionId: xlsxRevision?.id, sourceSha: xlsxRevision?.sha256 });
  const xlsxDraftId = String(xlsxDraftResult.json?.fileId || '');
  if (xlsxDraftId) created.push(xlsxDraftId);
  check('issued XLSX produces a draft revision for native editing', xlsxDraftResult.status === 201 && !!xlsxDraftId && xlsxDraftResult.json?.revision?.status === 'DRAFT', xlsxDraftResult.json);
  await resetPage(false);
  await navigateOffice(page, `/office-sheet?file=${encodeURIComponent(xlsxDraftId)}`);
  const draftSheetFrame = await openPanel(page, 'Flux Office — Таблица');
  const draftSheetPanel = page.getByRole('complementary', { name: 'Flux Office' });
  check('XLSX draft reopens in the actual native grid with editing enabled', await waitForSheetFile(draftSheetFrame) && await waitFor(async () => await draftSheetPanel.getByText(/Документ открыт только для просмотра/).count() === 0));
  await draftSheetFrame.locator('input.univer-box-border').first().fill('Z20');
  await draftSheetFrame.locator('input.univer-box-border').first().press('Enter');
  await draftSheetFrame.locator('canvas[id^="univer-sheet-main-canvas_"]').first().focus();
  await page.keyboard.type('NATIVE_XLSX_DRAFT_EDIT'); await page.keyboard.press('Enter'); await page.keyboard.press('Control+s');
  check('native XLSX draft edit persists while the issued source remains byte-identical', await waitFor(async () => xmlText(await archiveXml(xlsxDraftId)).includes('NATIVE_XLSX_DRAFT_EDIT')) && sha256((await raw('GET', `/api/files/${encodeURIComponent(xlsxId)}/raw`)).bytes) === xlsxSourceSha);
  check('no external request was made by live editors', outside.length === 0, outside.slice(0, 5));
  check('live editors completed without uncaught runtime exceptions', !browserErrors.some((error) => error.startsWith('pageerror:')), browserErrors.filter((error) => error.startsWith('pageerror:')));
  await context.close();
  } catch (error: any) {
  if (page) {
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      text: document.body.innerText.slice(0, 1000),
      frames: [...document.querySelectorAll('iframe')].map((el) => { const f = el as HTMLIFrameElement; const r = el.getBoundingClientRect(); let body: any = null; try { body = f.contentDocument?.body ? { title: f.contentDocument.title, text: f.contentDocument.body.innerText.slice(0, 1000), canvases: [...f.contentDocument.querySelectorAll('canvas')].map((c) => { const b = c.getBoundingClientRect(); return { id: c.id, width: c.width, height: c.height, rect: [b.x, b.y, b.width, b.height] }; }) } : null; } catch (e) { body = { error: String(e) }; } return { title: f.title, src: f.getAttribute('src'), rect: [r.x, r.y, r.width, r.height], body }; }),
    })).catch((reason: any) => ({ error: String(reason) }));
    const path = '/tmp/office-addon-native-scenario-failure.png';
    await page.screenshot({ path, fullPage: true }).catch(() => {});
    console.error('NATIVE_SCENARIO_FAILURE_DIAGNOSTIC', JSON.stringify({ diagnostic, browserErrors: browserErrors.slice(-30), screenshot: path }));
  }
  check('native Office add-on scenario completed', false, String(error?.stack || error));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const id of created) await api('DELETE', `/api/files/${encodeURIComponent(id)}`).catch(() => {});
  if (folderId) await api('DELETE', `/api/folders/${encodeURIComponent(folderId)}`).catch(() => {});
}
console.log(failures ? `\nNative Office add-on failures: ${failures}` : '\nNative Office add-on checks passed');
process.exitCode = failures ? 1 : 0;
})();
