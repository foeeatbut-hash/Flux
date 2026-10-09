import * as XLSX from 'xlsx';
import { existsSync } from 'node:fs';
import { testCredentials } from './testCredentials';
import { loginPage } from './officeHarness';

/** UI regression check for an empty Sheet1 under high-DPI window rendering. */
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = testCredentials();
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FRAME = 'iframe[title="Flux Office — Таблица"]';
const DPR_VALUES = [1.25, 2];
const THEMES = ['light', 'dark'] as const;

let failures = 0;
let token = '';
const check = (name: string, pass: boolean, detail?: unknown) => {
  if (pass) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500));
  }
};

const call = async (method: string, url: string, body?: unknown) => {
  const response = await fetch(BASE + url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { /* response is binary */ }
  return { status: response.status, json, bytes };
};

async function uploadEmptyBook(): Promise<string> {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), 'Sheet1');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const name = `__пустой лист ${Date.now().toString(36)}.xlsx`;
  const created = await call('POST', '/api/files', { name, filePath: `/shared/${name}`, type: 'XLSX' });
  const id = created.json?.file?.id;
  if (!id) throw new Error(`не удалось создать тестовый файл: ${JSON.stringify(created.json)}`);
  const chunk = await call('POST', `/api/files/${id}/chunk`, { idx: 0, data: bytes.toString('base64') });
  if (chunk.status >= 400) throw new Error(`не удалось загрузить пустую книгу (${chunk.status})`);
  const done = await call('POST', `/api/files/${id}/done`, { count: 1 });
  if (done.status >= 400) throw new Error(`не удалось завершить загрузку книги (${done.status})`);
  return id;
}

async function waitFor(probe: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return probe();
}

async function geometry(frame: any): Promise<any> {
  return frame.evaluate(() => {
    const book = (window as any).__fluxSheets?.univerRef?.current?.univerAPI?.getActiveWorkbook();
    const sheet = book?.getActiveSheet();
    const visible = sheet?.getVisibleRange();
    const host = document.querySelector('.spreadsheet')?.getBoundingClientRect();
    const area = document.querySelector('.workbook-area')?.getBoundingClientRect();
    const layout = Object.fromEntries(['.app-shell', '.sheet-body', '.sheet-main', '.workbook-area']
      .map((selector) => {
        const element = document.querySelector(selector);
        const rect = element?.getBoundingClientRect();
        return [selector, rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null];
      }));
    const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>('#univer-container canvas'))
      .map((canvas) => ({
        pixels: [canvas.width, canvas.height],
        rect: canvas.getBoundingClientRect(),
      }))
      .filter((canvas) => canvas.rect.width > 0 && canvas.rect.height > 0)
      .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
    const canvas = canvases[0];
    if (!host || !area || !canvas || !sheet) return null;
    return {
      rows: sheet.getMaxRows(),
      columns: sheet.getMaxColumns(),
      zoom: sheet.getZoom(),
      visibleRows: visible ? visible.endRow - visible.startRow + 1 : 0,
      visibleColumns: visible ? visible.endColumn - visible.startColumn + 1 : 0,
      dpr: window.devicePixelRatio,
      host: { width: host.width, height: host.height },
      area: { width: area.width, height: area.height },
      layout,
      canvas: {
        width: canvas.rect.width,
        height: canvas.rect.height,
        pixelWidth: canvas.pixels[0],
        pixelHeight: canvas.pixels[1],
      },
    };
  });
}

async function runCase(chromium: any, dpr: number, theme: 'light' | 'dark'): Promise<void> {
  const id = await uploadEmptyBook();
  const context = await chromium.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  page.on('console', (message: any) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 180));
  });
  page.on('requestfailed', (request: any) => failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`));
  try {
    await loginPage(page, BASE, LOGIN, theme === 'dark');
    await page.goto(`${BASE}/#/office-sheet?file=${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' });
    const frameLocator = page.locator(FRAME);
    await frameLocator.waitFor({ timeout: 20000 });
    const frame = await waitFor(async () => {
      const found = page.frames().find((candidate: any) => candidate.url().includes('/genoffice/sheets/'));
      return !!found && await found.evaluate(() => {
        const hooks = (window as any).__fluxSheets;
        const book = hooks?.univerRef?.current?.univerAPI?.getActiveWorkbook();
        const sheet = book?.getActiveSheet();
        return book?.getId()?.startsWith('file-') && sheet?.getSheetName() === 'Sheet1';
      }).catch(() => false);
    }, 40000).then(() => page.frames().find((candidate: any) => candidate.url().includes('/genoffice/sheets/')));
    check(`${theme}, DPR ${dpr}: пустой Sheet1 открыт`, !!frame);
    if (!frame) return;
    const overlayGone = await waitFor(async () =>
      !(await page.getByText('Открывается…').isVisible().catch(() => false)), 40000);
    check(`${theme}, DPR ${dpr}: окно готово`, overlayGone);
    await page.waitForTimeout(250);
    const initial = await geometry(frame);
    const initialShot = `/tmp/office-sheets-blank-${theme}-dpr${String(dpr).replace('.', '_')}-initial.png`;
    await page.screenshot({ path: initialShot });
    await page.waitForTimeout(500);
    const after500ms = await geometry(frame);
    await page.waitForTimeout(1000);
    const after1500ms = await geometry(frame);
    const readyShot = `/tmp/office-sheets-blank-${theme}-dpr${String(dpr).replace('.', '_')}-ready.png`;
    await page.screenshot({ path: readyShot });
    const samples = { initial, after500ms, after1500ms };
    check(`${theme}, DPR ${dpr}: пустая книга имеет запас строк и столбцов`,
      after1500ms?.rows >= 1000 && after1500ms?.columns >= 26, samples);
    const fillsBody = (g: any) => !!g && g.layout['.sheet-main']?.width >= g.layout['.sheet-body']?.width * 0.95;
    check(`${theme}, DPR ${dpr}: лист занимает тело окна после готовности`, fillsBody(after1500ms), samples);
    check(`${theme}, DPR ${dpr}: canvas совпадает с шириной viewport после готовности`,
      !!after1500ms && after1500ms.canvas.width >= after1500ms.host.width * 0.9 &&
      after1500ms.canvas.pixelWidth >= after1500ms.host.width * after1500ms.dpr * 0.9, samples);
    check(`${theme}, DPR ${dpr}: окно готовое без изменения размера показывает больше 6 столбцов и 13 строк`,
      after1500ms?.visibleRows > 13 && after1500ms?.visibleColumns > 6, samples);

    const windowRoot = page.locator(FRAME).locator('xpath=ancestor::*[@data-win][1]');
    const maximize = windowRoot.getByRole('button', { name: 'Развернуть' });
    if ((await maximize.getAttribute('title')) !== 'Вернуть размер') await maximize.click();
    await page.waitForTimeout(500);
    const expanded = await geometry(frame);
    check(`${theme}, DPR ${dpr}: после развёртывания видно больше 6 столбцов и 13 строк`,
      !!expanded && expanded.visibleColumns > 6 && expanded.visibleRows > 13, expanded);
    check(`${theme}, DPR ${dpr}: лист занимает тело окна после развёртывания`, fillsBody(expanded), expanded);
    check(`${theme}, DPR ${dpr}: canvas остаётся растянут после развёртывания`,
      !!expanded && expanded.canvas.width >= expanded.host.width * 0.9 &&
      expanded.canvas.pixelWidth >= expanded.host.width * expanded.dpr * 0.9, expanded);
    console.log(`  размеры окна/canvas без ресайза и после развёртывания: ${JSON.stringify({ samples, expanded })}`);
    console.log(`  запросы renderer: ${JSON.stringify({ errors: errors.slice(0, 5), consoleErrors: consoleErrors.slice(0, 5), failedRequests: failedRequests.slice(0, 5) })}`);
    console.log(`  снимки до/после ожидания: ${initialShot}, ${readyShot}`);
    const screenshot = `/tmp/office-sheets-blank-${theme}-dpr${String(dpr).replace('.', '_')}.png`;
    await page.screenshot({ path: screenshot });
    console.log(`  снимок: ${screenshot}`);
    check(`${theme}, DPR ${dpr}: нет ошибок renderer/console/сети`,
      errors.length === 0 && consoleErrors.length === 0 && failedRequests.length === 0,
      { errors: errors.slice(0, 5), consoleErrors: consoleErrors.slice(0, 5), failedRequests: failedRequests.slice(0, 5) });
  } finally {
    await context.close();
    await call('DELETE', `/api/files/${id}`).catch(() => undefined);
  }
}

(async () => {
  if (!existsSync('public/genoffice/sheets/index.html')) {
    console.error('Таблица не собрана: node tools/genoffice/build.mjs sheets');
    process.exit(2);
  }
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); }
  catch { console.error('нет playwright-core'); process.exit(2); }
  token = (await call('POST', '/api/login', LOGIN)).json?.token || '';
  check('вход выполнен', !!token);
  if (!token) process.exit(1);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    for (const dpr of DPR_VALUES) for (const theme of THEMES) await runCase(browser, dpr, theme);
  } catch (error: any) {
    check('проба пустой таблицы не прервалась', false, error?.message ?? String(error));
  } finally {
    await browser.close();
  }
  console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nВСЕ ПРОВЕРКИ ПУСТОЙ ТАБЛИЦЫ ПРОЙДЕНЫ');
  process.exit(failures ? 1 : 0);
})();
