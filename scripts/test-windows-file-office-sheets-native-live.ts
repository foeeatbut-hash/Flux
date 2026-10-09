/** Реальный WindowsFileHost + WindowsLayer + GenOffice Sheets и Native XLSX sidecar. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { WindowsFilesService } from '../electron/filesystem/service';
import { LocalOfficeSessions, type LocalOfficeRequest } from '../electron/localOfficeSessions';
import { makeXlsx } from './officeHarness';

const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const check = (name: string, value: unknown, detail?: unknown) => {
  if (!value) throw new Error(`✗ ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  console.log(`✓ ${name}`);
};

async function main() {
  const testRoot = await mkdtemp(join(tmpdir(), 'flux-windows-file-sheets-ui-'));
  const desktop = join(testRoot, 'desktop'), userData = join(testRoot, 'private');
  await mkdir(desktop); await mkdir(userData);
  const files = await WindowsFilesService.create({ userData, knownFolders: { desktop }, trashItem: async () => {}, showItemInFolder: () => {}, openPath: async () => '' });
  const rootId = (await files.roots())[0].id;
  const ref = { rootId, relativePath: 'one.xlsx' };
  const original = await makeXlsx();
  await writeFile(join(desktop, ref.relativePath), original);
  const auth = { mayRead: () => true, mayWrite: () => true };
  const pending: any[] = [];
  const manager = new LocalOfficeSessions({ files, userData, resourcesDir: resolve('genoffice-server'), onEvent(_owner, event) { pending.push(event); } });
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
    page.on('pageerror', error => errors.push(error.message));
    page.on('framenavigated', frame => { if (frame.url().includes('/genoffice/')) allOfficeNavigations.push(frame.url()); if (frame.url().includes('/genoffice/sheets/index.html')) navigations.push(frame.url()); });
    await page.route('**/__local-office*', async route => {
      try {
        if (route.request().url().endsWith('/events')) await route.fulfill({ json: { events: pending.splice(0) } });
        else {
          const request = route.request().postDataJSON() as LocalOfficeRequest;
          await route.fulfill({ json: { ok: true, data: await manager.handle(1, request, auth) } });
        }
      } catch (error: any) { await route.fulfill({ json: { ok: false, error: { code: error?.code || 'NATIVE_ERROR', message: String(error?.message || error) } } }); }
    });
    const base64 = original.toString('base64');
    await page.addInitScript(({ seed, endpoint, root }: any) => {
      (window as any).__workspaceDocxBase64 = seed;
      (window as any).__workspaceSeedNames = ['one.xlsx', 'two.xlsx'];
      (window as any).__localOfficeEndpoint = endpoint;
      (window as any).__workspaceRoot = root;
    }, { seed: base64, endpoint: `${base}/__local-office`, root: rootId });
    await page.route('**/api/projects/local-project/tags', route => route.fulfill({ json: { tags: [{ id: 'tag-42', identifier: 'TAG-42', name: 'Насос' }] } }));
    await page.route('**/api/office/files/new?*', route => route.fulfill({ json: { id: 'export-1', name: 'tags-1.xlsx', sha256: 'sha-export-1', size: 1024, folderId: null } }));
    await page.goto(`${base}/scripts/fixtures/windows-file-office-workspace.html?app=sheets&root=${encodeURIComponent(rootId)}#/`);
    await page.locator('[data-desk]').waitFor();
    const href = `/windows-file?root=${encodeURIComponent(rootId)}&path=one.xlsx`;
    await page.evaluate((path: string) => (window as any).__windowStore.getState().open(path), href);
    await page.waitForFunction(() => (window as any).__windowStore.getState().windows.length === 1, null, { timeout: 10000 });
    const id: string = await page.evaluate(() => (window as any).__windowStore.getState().windows[0].id);
    const iframe = page.locator(`[data-win="${id}"] iframe[title="Flux Office — Таблица"]`);
    await iframe.waitFor({ timeout: 20000 });
    await page.getByText('Открывается локальный редактор…').waitFor({ state: 'detached', timeout: 90000 }).catch(async error => {
      console.log('SHEETS DEBUG', await iframe.evaluate(el => { const f=el as HTMLIFrameElement, r=f.getBoundingClientRect(); return { rect:[r.width,r.height], url:f.contentWindow?.location.href, text:f.contentDocument?.body?.innerText.slice(0,700), scripts:[...f.contentDocument!.scripts].map(s=>s.src).slice(0,5) }; }), await page.evaluate(() => (window as any).__workspaceOfficeCalls), errors, manager.size);
      throw error;
    });
    const loaded = await iframe.evaluate(el => {
      const frame = el as HTMLIFrameElement, rect = frame.getBoundingClientRect();
      const api = (frame.contentWindow as any).__fluxSheets?.univerRef?.current?.univerAPI;
      const book = api?.getActiveWorkbook();
      return { rect: [rect.width, rect.height], names: book?.getSheets().map((sheet: any) => sheet.getSheetName()) || [], body: frame.contentDocument?.body?.innerText.slice(0, 800) };
    });
    check('локальная книга открылась в реальном GenOffice с листами и площадью', loaded.rect[0] > 0 && loaded.rect[1] > 0 && loaded.names.includes('Перечень') && loaded.names.includes('Справка'), loaded);
    const child = page.frames().find(frame => frame.url().includes('/genoffice/sheets/index.html'));
    if (!child) throw new Error('Не найден frame GenOffice Sheets');
    await child.evaluate(() => window.parent.postMessage({ flux: 'office', op: 'flux:open-panel' }, location.origin));
    await page.getByRole('button', { name: 'Вставить все' }).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Вставить все' }).click();
    await page.getByRole('status').filter({ hasText: 'Таблица вставлена' }).waitFor({ timeout: 20000 });
    const hasTag = async () => iframe.evaluate(el => {
      const book = ((el as HTMLIFrameElement).contentWindow as any).__fluxSheets?.univerRef?.current?.univerAPI?.getActiveWorkbook();
      return book?.getSheets().some((sheet: any) => sheet.getRange('A1:Z40').getValues().some((row: any[]) => row.some(value => String(value).includes('TAG-42')))) || false;
    });
    for (let n = 0; n < 60 && !(await hasTag()); n++) await page.waitForTimeout(250);
    check('ранняя вставка панели отражена в настоящей книге XLSX', await hasTag());
    const initial = await iframe.evaluate(el => { (window as any).__workspaceSheetFrame = el; return [el.getBoundingClientRect().width, el.getBoundingClientRect().height]; });
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    for (let n = 0; n < 200; n++) {
      const bytes = await files.read(ref).then(data => Buffer.from(data.base64, 'base64'));
      const zip = await JSZip.loadAsync(bytes);
      const all = (await Promise.all(Object.values(zip.files).filter(entry => !entry.dir).map(entry => entry.async('string')))).join('\n');
      if (all.includes('TAG-42')) break;
      await page.waitForTimeout(250);
    }
    const persisted = Buffer.from((await files.read(ref)).base64, 'base64');
    const zip = await JSZip.loadAsync(persisted);
    const allXml = (await Promise.all(Object.values(zip.files).filter(entry => !entry.dir).map(entry => entry.async('string')))).join('\n');
    check('настоящий Native XLSX sidecar сохранил TAG-42 в исходный Windows-файл', allXml.includes('TAG-42'));
    const after = await iframe.evaluate(el => { const node=el as HTMLIFrameElement, r = node.getBoundingClientRect(); return { sameNode: node === (window as any).__workspaceSheetFrame, rect: [r.width, r.height], names: (node.contentWindow as any).__fluxSheets?.univerRef?.current?.univerAPI?.getActiveWorkbook()?.getSheets().map((sheet: any) => sheet.getSheetName()) || [] }; });
    check('после Save Excel editor остаётся непустым в том же iframe', after.sameNode && after.rect[0] > 0 && after.rect[1] > 0 && after.names.includes('Перечень'), after);
    await page.getByRole('button', { name: 'Вставить все' }).click();
    await page.getByRole('status').filter({ hasText: 'Таблица вставлена' }).waitFor({ timeout: 20000 });
    for (let n = 0; n < 60 && !(await hasTag()); n++) await page.waitForTimeout(250);
    check('повторная вставка панели создаёт незаписанную правку перед handoff', await hasTag());
    await page.evaluate((winId: string) => (window as any).__windowStore.getState().minimize(winId), id);
    await page.evaluate((winId: string) => (window as any).__windowStore.getState().focus(winId), id);
    check('minimize/restore сохраняет видимую таблицу в WindowsLayer', await iframe.evaluate(el => { const node=el as HTMLIFrameElement; return node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && !!(node.contentWindow as any).__fluxSheets?.univerRef?.current?.univerAPI?.getActiveWorkbook(); }));
    const errorsBeforeExport = errors.length;
    check('до handoff исходный Sheets не выдаёт ошибок', errorsBeforeExport === 0, errors);
    const sheetsFrameLoadsBeforeExport = navigations.length;
    await page.locator('#flux-section-picker').selectOption('export');
    await page.getByRole('button', { name: 'Книга Flux', exact: true }).waitFor({ timeout: 15000 });
    const beforeExport = await iframe.evaluate(el => { (window as any).__workspaceSheetExportFrame = el; const node=el as HTMLIFrameElement, win=node.contentWindow as any; win.__sheetExportToken ||= crypto.randomUUID(); return { rect:[node.getBoundingClientRect().width,node.getBoundingClientRect().height], token:win.__sheetExportToken }; });
    const hadTagBeforeExport = await hasTag();
    await page.getByRole('button', { name: 'Книга Flux', exact: true }).click();
    await page.waitForFunction(() => (window as any).__windowStore.getState().windows.some((item: any) => item.path === '/office-sheet'), null, { timeout: 15000 });
    await page.waitForTimeout(1000);
    const afterExport = await iframe.evaluate(el => { const node=el as HTMLIFrameElement; return { sameNode:node===(window as any).__workspaceSheetExportFrame, rect:[node.getBoundingClientRect().width,node.getBoundingClientRect().height], book:!!(node.contentWindow as any).__fluxSheets?.univerRef?.current?.univerAPI?.getActiveWorkbook(), token:(node.contentWindow as any).__sheetExportToken }; });
    const hasTagAfterExport = await hasTag();
    check('выгрузка Flux в отдельную книгу не перезапускает настоящий локальный XLSX редактор', hadTagBeforeExport && beforeExport.rect[0] > 0 && beforeExport.rect[1] > 0 && afterExport.sameNode && afterExport.token === beforeExport.token && afterExport.rect[0] > 0 && afterExport.rect[1] > 0 && afterExport.book && hasTagAfterExport && manager.size === 1, { beforeExport, afterExport, hadTagBeforeExport, hasTagAfterExport, navigations:allOfficeNavigations, localSessions:manager.size, errorsBeforeExport, errorsAfterExport:errors.length });
    check('добавлено только ожидаемое окно выгруженной книги', sheetsFrameLoadsBeforeExport === 1 && navigations.length === 2, navigations);
    await page.locator(`[data-win="${id}"]`).getByRole('button', { name: 'Закрыть', exact: true }).click();
    await page.waitForFunction((winId: string) => !(window as any).__windowStore.getState().windows.some((item: any) => item.id === winId), id, { timeout: 15000 });
    const latestAfterClose = Buffer.from((await files.read(ref)).base64, 'base64');
    const closeZip = await JSZip.loadAsync(latestAfterClose);
    const closeXml = (await Promise.all(Object.values(closeZip.files).filter(entry => !entry.dir).map(entry => entry.async('string')))).join('\n');
    check('грязное исходное окно закрывается после handoff и сохраняет TAG-42 в исходный XLSX', closeXml.includes('TAG-42'));
    check('событие handoff добавило только окно книги, исходный frame сохранён', navigations.length === 2, navigations);
    const lifecycle = await page.evaluate(() => (window as any).__workspaceDiagnosticEvents().filter((event: any) => event.event === 'office.lifecycle'));
    check('диагностика фиксирует готовность, dirty и close guard таблицы', lifecycle.some((event: any) => event.data.app === 'sheets' && event.data.stage === 'editor-ready') && lifecycle.some((event: any) => event.data.dirtyKnown === true && event.data.dirty === true) && lifecycle.some((event: any) => event.data.stage === 'close-guard' && event.data.outcome === 'ok'), lifecycle.map((event: any) => event.data));
    check('диагностика не содержит имён файлов или содержимого книги', !JSON.stringify(lifecycle).includes('one.xlsx') && !JSON.stringify(lifecycle).includes('TAG-42'));
    assert.equal(manager.size, 0, 'native Office session should close after pane teardown');
  } finally {
    await browser.close();
    await manager.dispose();
    files.close();
    await vite.close();
    await rm(testRoot, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
