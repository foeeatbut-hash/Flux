import { testCredentials } from './testCredentials';
/** Синтетическая выгрузка .xlsx: новый файл, точные байты, импорт в Таблицу. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { makeXlsx, loginPage } from './officeHarness';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = testCredentials();
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FRAME = 'iframe[title="Flux Office — Таблица"]';
let token = '';
let failures = 0;
const ok = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) console.log('  ✓', name);
  else { failures++; console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)); }
};
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const call = async (method: string, url: string, body?: Buffer) => {
  const response = await fetch(BASE + url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/octet-stream' } : {}) },
    body,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { /* бинарный ответ */ }
  return { status: response.status, bytes, json };
};
const until = async (probe: () => Promise<boolean>, ms: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 250) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return probe();
};

(async () => {
  if (!existsSync('public/genoffice/sheets/index.html')) {
    console.error('Таблица не собрана: node tools/genoffice/build.mjs sheets'); process.exit(2);
  }
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); }
  catch { console.error('нет playwright-core'); process.exit(2); }
  const created: string[] = [];
  let browser: any;
  try {
    const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(LOGIN) });
    token = (await login.json().catch(() => ({})))?.token || '';
    ok('вход выполнен', !!token);
    if (!token) throw new Error('не удалось получить токен');

    const original = await makeXlsx();
    const name = `__проба выгрузки ${Date.now().toString(36)}.xlsx`;
    const made = await call('POST', `/api/office/files/new?${new URLSearchParams({ name, where: 'exports' })}`, original);
    const id = String(made.json?.id || '');
    if (id) created.push(id);
    ok('новая выгрузка сохраняет исходные байты XLSX', made.status === 200 && !!id && made.json?.name === name, made.json);
    const stored = id ? await call('GET', `/api/files/${id}/raw`) : null;
    ok('сервер записал бинарник выгрузки без изменения', !!stored && stored.status === 200 && sha(stored.bytes) === sha(original));

    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const outside: string[] = [];
    page.on('request', (request: any) => {
      const url = String(request.url());
      if (!url.startsWith(BASE) && !url.startsWith('blob:') && !url.startsWith('data:')) outside.push(url);
    });
    await loginPage(page, BASE, LOGIN);
    await page.goto(`${BASE}/#/office-sheet?file=${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' });
    const frame = page.frameLocator(FRAME);
    ok('выгрузка открылась Таблицей', await until(async () => page.locator(FRAME).count().then((count) => count === 1), 15000));
    const dataLoaded = await until(async () => {
      const child = page.frames().find((candidate: any) => candidate.url().includes('/genoffice/sheets/'));
      if (!child) return false;
      return child.evaluate(() => {
        const api = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
        const workbook = api?.getActiveWorkbook();
        const sheets = workbook?.getSheets?.() || [];
        const values = sheets[0]?.getRange(0, 0, 2, 2)?.getValues?.() || [];
        return sheets.some((sheet: any) => sheet.getSheetName() === 'Перечень') &&
          JSON.stringify(values).includes('Позиция') && JSON.stringify(values).includes('Насос');
      }).catch(() => false);
    }, 45000);
    ok('в редактор импортированы строки из выгрузки', dataLoaded);
    ok('лента появилась после готовности книги', await until(async () => {
      const text = await frame.locator('body').innerText().catch(() => '');
      return /Главная/.test(text) && /Вставка/.test(text);
    }, 10000));
    ok('окно Flux сняло загрузочный экран только после готовности редактора',
      await until(async () => !(await page.getByText('Открывается…').isVisible().catch(() => false)), 10000));
    ok('проба не отправляла запросы наружу', outside.length === 0, outside.slice(0, 4));
  } catch (error: any) {
    ok('живая проверка завершилась', false, String(error?.message || error));
  } finally {
    for (const id of created) await call('DELETE', `/api/files/${id}`).catch(() => {});
    await browser?.close().catch(() => {});
  }
  console.log(failures ? `ПРОВАЛОВ: ${failures}` : 'ВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(failures ? 1 : 0);
})();
