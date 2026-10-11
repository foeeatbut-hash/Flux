/**
 * End-to-end checks of Flux Office's real add-on against rebuilt GenOffice.
 * The fixture is disposable: `node --import tsx scripts/test-guide-server.ts --fixture`.
 * Run only after Office bridge freeze and editor rebuild:
 * `FLUX_OFFICE_NATIVE_READY=1 node --import tsx scripts/test-office-addon-native-live.ts /tmp/.../fixture.json`
 */
import { chmod, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { chromium } from 'playwright-core';
import { makeDocxWithTable, makeXlsxWithBlankFormula, makeXlsxWithManualRow, loginPage } from './officeHarness';

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
const hasEmptyFormulaTarget = async (fileId: string) =>
  /<c\b[^>]*\br="A2"[^>]*><f>IF\(FALSE,1,(?:&quot;|"){2}\)<\/f><v>\s*<\/v><\/c>/.test(await archiveText(fileId, 'xl/worksheets/sheet1.xml'));
const waitFor = async (probe: () => Promise<boolean>, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await probe()) return true; await new Promise((r) => setTimeout(r, 250)); }
  return probe();
};
const openPanel = async (page: any, title: string) => {
  const frame = page.frameLocator(`iframe[title="${title}"]`);
  await frame.locator('body').waitFor({ state: 'visible', timeout: 45000 });
  await frame.locator('body').evaluate((body: HTMLElement) => {
    window.parent.postMessage({ flux: 'office', op: 'flux:open-panel' }, location.origin);
  });
  await page.getByRole('complementary', { name: 'Flux Office' }).waitFor({ timeout: 10000 });
  return frame;
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
  created.push(...[docxId, xlsxId, formulaId].filter(Boolean));
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await context.newPage();
  const outside: string[] = [];
  page.on('request', (request: any) => {
    const url = String(request.url());
    if (!url.startsWith(BASE) && !url.startsWith('blob:') && !url.startsWith('data:') && !url.startsWith('ws://127.0.0.1') && !url.startsWith('ws://localhost')) outside.push(url);
  });
  await loginPage(page, BASE, fixture.admin, false);

  console.log('\n1. Native Word editor, table anchor, add-on, save and reopen');
  await page.goto(`${BASE}/#/office-doc?file=${encodeURIComponent(docxId)}`, { waitUntil: 'domcontentloaded' });
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
  const docXml = await archiveText(docxId, 'word/document.xml');
  check('Word table, surrounding text, and manual row survive field insertion', /Слева до поля/.test(docXml) && /Текст после поля/.test(docXml) && /Ручная строка/.test(docXml));
  const fieldMark = editor.locator('[data-instr-field*="flux:"]').first();
  check('real Word editor exposes the serialized Flux field marker', await fieldMark.count() > 0);
  if (await fieldMark.count()) {
    await fieldMark.click();
    await page.keyboard.press('Backspace');
    check('Backspace at a protected Flux marker leaves the field instruction intact', /DOCPROPERTY\s+"flux:/.test(await archiveText(docxId, 'word/document.xml')));
  }
  const suffix = editor.getByText('Текст после поля', { exact: true });
  if (await suffix.count()) {
    await suffix.click(); await page.keyboard.press('End');
    await page.evaluate(() => navigator.clipboard.writeText('NATIVE_PASTE'));
    await page.keyboard.press('Control+v');
    check('paste works in ordinary adjacent Word table text', await waitFor(async () => (await editor.innerText()).includes('NATIVE_PASTE')));
    await page.keyboard.press('Control+z');
    check('undo reverts only the ordinary text paste and retains field', await waitFor(async () => !(await editor.innerText()).includes('NATIVE_PASTE')) && /DOCPROPERTY\s+"flux:/.test(await archiveText(docxId, 'word/document.xml')));
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
    wordFillRan = true;
    await wordPreview.click();
    const wordConfirm = panel.getByRole('button', { name: 'Подтвердить и заполнить' });
    check('Word changes remain in preview until explicit confirmation', await wordConfirm.isVisible().catch(() => false));
    if (await wordConfirm.isEnabled().catch(() => false)) await wordConfirm.click();
    await waitFor(async () => ((await api('GET', `/api/project-data/files/${docxId}/office-state`)).json?.rows?.length || 0) >= 2, 30000);
    let wordState = (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json;
    let wordXml = await archiveText(docxId, 'word/document.xml');
    check('Word fill wrote both entity row identities once', wordState?.rows?.filter((r: any) => !String(r.entityId).startsWith('manual:')).length === 2, wordState?.rows);
    check('Word fill preserves the unrelated physical manual table row', wordXml.includes('Ручная строка') && wordXml.includes('Текст после поля'));
    check('Word generated rows contain actual source values 900 and 1200', /900/.test(wordXml) && /1200/.test(wordXml), wordXml.match(/<w:tr[\s\S]*?<\/w:tr>/g));
    const rowMarkersAfterFill = [...wordXml.matchAll(/w:name="(FLUXROW_[^"]+)"/g)].map((match) => match[1]);
    check('Word native table serialized unique durable row bookmarks', rowMarkersAfterFill.length >= 2 && new Set(rowMarkersAfterFill).size === rowMarkersAfterFill.length, rowMarkersAfterFill);
    check('Word row metadata maps generated rows to their physical bookmark markers', wordState?.rows?.filter((r: any) => Object.values(r.cells || {}).some((marker: any) => rowMarkersAfterFill.includes(String(marker)))).length >= 2, wordState?.rows);
    const generatedTr = editor.locator('table tr').filter({ hasText: '900' }).first();
    if (await generatedTr.count()) {
      await generatedTr.locator('td,th').last().click();
      await page.keyboard.press('End'); await page.keyboard.type('NATIVE_DOCS_MANUAL_EDIT'); await page.keyboard.press('Control+s');
      await waitFor(async () => (await archiveText(docxId, 'word/document.xml')).includes('NATIVE_DOCS_MANUAL_EDIT'), 15000);
      check('manual edit to a generated Word row persisted in actual DOCX', (await archiveText(docxId, 'word/document.xml')).includes('NATIVE_DOCS_MANUAL_EDIT'));
    } else check('generated Word row with value 900 is editable in the real table', false);
    const sourceRows = await api('POST', '/api/project-data/office/query', { projectId: fixture.projectId, query: { entity: 'element', columns: ['name', 'param:Аэродинамика|Расход воздуха'], filters: [], sort: [], limit: 20, excludedEntityIds: [] } });
    const fanHigh = sourceRows.json?.rows?.find((item: any) => item.values?.name?.value === 'FAN_HIGH');
    const updateSource = fanHigh?.entityId ? await api('POST', `/api/equipment/component/${encodeURIComponent(fanHigh.entityId)}/override`, { group: 'Аэродинамика', key: 'Расход воздуха', value: '1500' }) : { status: 0, json: null };
    check('Word repeat source changed through actual project-data edit API', updateSource.status === 200, updateSource.json);
    await page.getByRole('button', { name: /1\. Выборка/ }).click();
    await panel.getByRole('button', { name: 'Обновить выборку' }).click();
    await waitFor(async () => (await panel.getByText(/FAN_HIGH/).count()) > 0);
    await panel.getByRole('checkbox', { name: 'Выбрать все строки' }).check();
    await page.getByRole('button', { name: /3\. Обновление/ }).click();
    await panel.getByRole('button', { name: 'Предпросмотр заполнения' }).click();
    await panel.getByRole('button', { name: 'Подтвердить и заполнить' }).click();
    await waitFor(async () => (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json?.rows?.length >= 2, 30000);
    wordState = (await api('GET', `/api/project-data/files/${docxId}/office-state`)).json;
    wordXml = await archiveText(docxId, 'word/document.xml');
    check('Word repeat preserves edited generated row and updates unaffected source value', wordXml.includes('NATIVE_DOCS_MANUAL_EDIT') && /1500/.test(wordXml), wordXml.match(/<w:tr[\s\S]*?<\/w:tr>/g));
    check('Word repeat retains two distinct stable entity identities', new Set(wordState.rows.filter((r: any) => !String(r.entityId).startsWith('manual:')).map((r: any) => r.entityId)).size === 2, wordState.rows);
    check('Word bookmark names are unique after repeat/save', (() => { const names = [...wordXml.matchAll(/<w:bookmarkStart\b[^>]*\bw:name="([^"]+)"/g)].map((m) => m[1]); return names.length > 0 && new Set(names).size === names.length; })());
    const rowMarkersAfterRepeat = [...wordXml.matchAll(/w:name="(FLUXROW_[^"]+)"/g)].map((match) => match[1]);
    check('Word repeat did not duplicate durable FLUXROW bookmarks', rowMarkersAfterRepeat.length === 2 && new Set(rowMarkersAfterRepeat).size === 2, rowMarkersAfterRepeat);
  }
  const docsLight = await capture(page, docs, 'docs-light');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const reopenedDoc = page.frameLocator('iframe[title="Flux Office — Документ"]').locator('.ProseMirror');
  check('saved Word anchor and adjacent cell text survive actual editor reopen', await reopenedDoc.locator('table tr').count() >= 2 && (await archiveText(docxId, 'word/document.xml')).includes('DOCPROPERTY'));
  if (wordFillRan) check('Word generated rows, updated source, and manual cell edit survive reopen', await reopenedDoc.locator('table tr').count() >= 4 && (await archiveText(docxId, 'word/document.xml')).includes('NATIVE_DOCS_MANUAL_EDIT') && /1500/.test(await archiveText(docxId, 'word/document.xml')));

  console.log('\n2. Native Sheets editor, selected cell, fill/repeat/manual rows');
  await page.goto(`${BASE}/#/office-sheet?file=${encodeURIComponent(xlsxId)}`, { waitUntil: 'domcontentloaded' });
  const sheets = await openPanel(page, 'Flux Office — Таблица');
  check('ordinary Excel ribbon remains available', await sheets.getByText('Главная', { exact: true }).first().isVisible().catch(() => false) && await sheets.getByText('Вставка', { exact: true }).first().isVisible().catch(() => false));
  const nameBox = sheets.locator('input.univer-box-border').first();
  await nameBox.fill('A1'); await nameBox.press('Enter');
  await sheets.locator('canvas').first().click({ position: { x: 45, y: 45 } });
  await page.getByRole('button', { name: /2\. Поля и шапка/ }).click();
  const sheetPanel = page.getByRole('complementary', { name: 'Flux Office' });
  await sheetPanel.getByLabel('Найти поле Flux').fill('Расход воздуха');
  await sheetPanel.getByRole('button', { name: /Расход воздуха/ }).first().click();
  await waitFor(async () => sheetPanel.getByRole('button', { name: 'Привязать поле' }).isEnabled());
  await sheetPanel.getByRole('button', { name: 'Привязать поле' }).click();
  check('selected real A1 cell became a persisted Excel anchor', await waitFor(async () => (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json?.schema?.anchors?.some((a: any) => a.kind === 'excel-range')));
  await page.keyboard.press('Control+s');
  check('Excel anchor metadata is present in actual workbook defined names', await waitFor(async () => /FLUX_ANCHOR_/.test(await archiveText(xlsxId, 'xl/workbook.xml'))));
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
    // Reload so the live panel reads exactly the seeded document state.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openPanel(page, 'Flux Office — Таблица');
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
  if (await preview.isEnabled().catch(() => false)) {
    await preview.click();
    check('fill stays in preview until explicit confirmation', await sheetPanel.getByRole('button', { name: 'Подтвердить и заполнить' }).isVisible().catch(() => false));
    // Confirmation is a deliberate UI action against only the disposable file.
    await sheetPanel.getByRole('button', { name: 'Подтвердить и заполнить' }).click();
    await waitFor(async () => (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json?.rows?.length > 0, 20000);
    let state = (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json;
    check('first fill wrote stable row metadata', state?.rows?.some((r: any) => r.entityId && !String(r.entityId).startsWith('manual:')), state?.rows);
    check('both selected fixture entities were written exactly once', ['FAN_LOW', 'FAN_HIGH'].every((name) => state?.rows?.filter((r: any) => r.values?.name === name || r.values?.['name'] === name).length === 1) || state?.rows?.filter((r: any) => !String(r.entityId).startsWith('manual:')).length === 2, state?.rows);
    check('first fill preserved unrelated manual row metadata at A5', state?.rows?.some((r: any) => String(r.entityId).startsWith('manual:') && Object.values(r.cells || {}).includes('A5')), state?.rows);
    // Change a generated row through the real sheet cell, then rerun preview/apply.
    // This checks the native writer against current OOXML; stable entity identity must not duplicate.
    const generated = state?.rows?.find((r: any) => String(r.entityId || '').includes('fan_low')) || state?.rows?.find((r: any) => r.entityId && !String(r.entityId).startsWith('manual:'));
    const address = generated?.cells?.[state.schema?.anchors?.[0]?.id];
    if (address) {
      await sheets.locator('input.univer-box-border').first().fill(address); await sheets.locator('input.univer-box-border').first().press('Enter');
      await page.keyboard.type('NATIVE_MANUAL_EDIT'); await page.keyboard.press('Enter'); await page.keyboard.press('Control+s');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await openPanel(page, 'Flux Office — Таблица');
      const editedXml = await archiveText(xlsxId, 'xl/worksheets/sheet1.xml');
      check('manual edit to generated row persisted in actual OOXML cell', editedXml.includes('NATIVE_MANUAL_EDIT'), editedXml.match(/<row[^>]*>[\s\S]*?NATIVE_MANUAL_EDIT[\s\S]*?<\/row>/)?.[0]);
      const sourceQuery = await api('POST', '/api/project-data/office/query', { projectId: fixture.projectId, query: { entity: 'element', columns: ['name', 'param:Аэродинамика|Расход воздуха'], filters: [], sort: [], limit: 20, excludedEntityIds: [] } });
      const changedSource = sourceQuery.json?.rows?.find((item: any) => item.values?.name?.value === 'FAN_HIGH');
      const sourceUpdate = changedSource?.entityId ? await api('POST', `/api/equipment/component/${encodeURIComponent(changedSource.entityId)}/override`, { group: 'Аэродинамика', key: 'Расход воздуха', value: '1500' }) : { status: 0, json: null };
      check('fixture source entity updated through its real edit API', sourceUpdate.status === 200, sourceUpdate.json);
      // Re-run the real query/preview/confirm cycle; the edited entity must be treated as
      // a conflict/manual row, while unrelated A5 remains untouched.
      await page.getByRole('button', { name: /1\. Выборка/ }).click();
      await sheetPanel.getByRole('button', { name: 'Обновить выборку' }).click();
      await waitFor(async () => (await sheetPanel.getByText(/FAN_HIGH/).count()) > 0, 15000);
      await sheetPanel.getByRole('checkbox', { name: 'Выбрать все строки' }).check();
      await page.getByRole('button', { name: /3\. Обновление/ }).click();
      await sheetPanel.getByRole('button', { name: 'Предпросмотр заполнения' }).click();
      await sheetPanel.getByRole('button', { name: 'Подтвердить и заполнить' }).click();
      await waitFor(async () => !!(await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json?.rows, 20000);
      state = (await api('GET', `/api/project-data/files/${xlsxId}/office-state`)).json;
      const repeatXml = await archiveText(xlsxId, 'xl/worksheets/sheet1.xml');
      check('repeat update preserved changed generated cell text', repeatXml.includes('NATIVE_MANUAL_EDIT'), repeatXml.match(/<row[^>]*>[\s\S]*?NATIVE_MANUAL_EDIT[\s\S]*?<\/row>/)?.[0]);
      check('repeat update wrote the updated source value 1500 into actual workbook XML', /<v>1500<\/v>/.test(repeatXml), repeatXml.match(/<row[^>]*>[\s\S]*?<\/row>/g));
      check('repeat update kept exactly one row for the stable entity', state.rows.filter((r: any) => r.entityId === generated.entityId).length === 1, state.rows);
      check('repeat update preserved unrelated manual row identity and physical value', state.rows.some((r: any) => String(r.entityId).startsWith('manual:') && Object.values(r.cells || {}).includes('A5')) && repeatXml.includes('MANUAL_KEEP'), state.rows);
    } else check('fill returned a verifiable generated cell address', false, generated);
  } else {
    check('native fill preview enabled for selected fixture row', false, await sheetPanel.innerText().catch(() => ''));
  }

  console.log('\n3. Empty-result formula target remains protected');
  await page.goto(`${BASE}/#/office-sheet?file=${encodeURIComponent(formulaId)}`, { waitUntil: 'domcontentloaded' });
  const formulaFrame = page.frameLocator('iframe[title="Flux Office — Таблица"]');
  await formulaFrame.locator('input.univer-box-border').first().fill('A1');
  await formulaFrame.locator('input.univer-box-border').first().press('Enter');
  await formulaFrame.locator('canvas').first().click({ position: { x: 45, y: 45 } });
  const formulaPanel = await openPanel(page, 'Flux Office — Таблица');
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
  await page.getByRole('button', { name: /1\. Выборка/ }).click();
  await formulaPanel.getByRole('button', { name: 'Обновить выборку' }).click();
  await waitFor(async () => (await formulaPanel.getByRole('grid', { name: 'Предпросмотр выборки' }).getByText(/FAN_HIGH/).count()) > 0);
  await formulaPanel.getByRole('row').filter({ hasText: 'FAN_HIGH' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: /3\. Обновление/ }).click();
  await formulaPanel.getByRole('button', { name: 'Предпросмотр заполнения' }).click();
  const confirmFormula = formulaPanel.getByRole('button', { name: 'Подтвердить и заполнить' });
  check('formula target remains a real formula with an empty displayed result', await hasEmptyFormulaTarget(formulaId));
  if (await confirmFormula.isEnabled().catch(() => false)) {
    await confirmFormula.click();
    await page.waitForTimeout(1500);
    check('native apply refuses to overwrite an empty-result formula', await hasEmptyFormulaTarget(formulaId) && await formulaPanel.getByRole('alert').count() > 0);
  } else {
    check('preview disables confirmation when a formula target is occupied', true);
  }
  const formulaAfter = (await api('GET', `/api/project-data/files/${formulaId}/office-state`)).json;
  check('formula refusal keeps exactly the original entity-to-A2 row identity', formulaAfter?.rows?.length === 1 && formulaAfter.rows[0].entityId === formulaEntity?.entityId && formulaAfter.rows[0].cells?.[formulaAnchor?.id] === 'A2', formulaAfter?.rows);

  // Theme screenshot is a second actual editor session; does not alter the workbook.
  await context.close();
  const darkContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const darkPage = await darkContext.newPage();
  await loginPage(darkPage, BASE, fixture.admin, true);
  await darkPage.goto(`${BASE}/#/office-doc?file=${encodeURIComponent(docxId)}`, { waitUntil: 'domcontentloaded' });
  const darkDocs = await openPanel(darkPage, 'Flux Office — Документ');
  const darkDocsMetrics = await capture(darkPage, darkDocs, 'docs-dark');
  check('Word dark and light themes use distinct add-on surfaces', darkDocsMetrics.background !== docsLight.background && darkDocsMetrics.background !== 'rgb(255, 255, 255)');
  await darkPage.goto(`${BASE}/#/office-sheet?file=${encodeURIComponent(xlsxId)}`, { waitUntil: 'domcontentloaded' });
  const darkFrame = await openPanel(darkPage, 'Flux Office — Таблица');
  const darkMetrics = await capture(darkPage, darkFrame, 'sheets-dark');
  check('dark theme uses a dark actual add-on surface', darkMetrics.background !== 'rgb(255, 255, 255)' && darkMetrics.background !== 'rgba(0, 0, 0, 0)');
  check('no external request was made by live editors', outside.length === 0, outside.slice(0, 5));
  await darkContext.close();
} catch (error: any) {
  check('native Office add-on scenario completed', false, String(error?.stack || error));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const id of created) await api('DELETE', `/api/files/${encodeURIComponent(id)}`).catch(() => {});
  if (folderId) await api('DELETE', `/api/folders/${encodeURIComponent(folderId)}`).catch(() => {});
}
console.log(failures ? `\nNative Office add-on failures: ${failures}` : '\nNative Office add-on checks passed');
process.exitCode = failures ? 1 : 0;
})();
