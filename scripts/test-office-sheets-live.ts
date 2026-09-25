/**
 * Таблица Flux Office: открыть книгу Excel из Проводника, поправить ячейку,
 * сохранить.
 *
 * Что стережёт (src/screens/OfficeAppHost.tsx, server/officeHostApps.ts,
 * tools/genoffice/inject/sheets-host.ts, tools/genoffice/shims/*):
 *   - книга открывается в Таблице GenOffice внутри окна Flux, ячейки видны,
 *     внизу — имя файла Flux, а не случайное имя снимка;
 *   - ни ИИ, ни имени Genspark на экране;
 *   - ввод в ячейку пересчитывает формулу, Ctrl+S пишет книгу в сам файл
 *     Flux (главный процесс Таблицы и движок Excel — на сервере);
 *   - тронуто только правленое: второй лист и посторонняя часть (customXml)
 *     байт в байт, формула и имя диапазона на месте;
 *   - прежнее содержимое лежит в откате;
 *   - закрытие окна не теряет правку и убирает окно редактора на сервере;
 *   - ни одного запроса за пределы сервера Flux.
 *
 * Нужны поднятый сервер и собранный редактор (node tools/genoffice/build.mjs sheets).
 * Запуск: npx tsx scripts/test-office-sheets-live.ts
 */
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { makeXlsx, loginPage } from './officeHarness';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FRAME = 'iframe[title="Таблица Flux Office"]';

let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 300))));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
let token = '';
const call = async (method: string, url: string, body?: any) => {
  const res = await fetch(BASE + url, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* байты */ }
  return { status: res.status, json, buf };
};
const until = async (probe: () => Promise<boolean>, ms: number) => {
  for (let t = 0; t < ms; t += 300) { if (await probe()) return true; await new Promise((r) => setTimeout(r, 300)); }
  return probe();
};
const parts = async (b: Buffer) => {
  const z = await JSZip.loadAsync(b);
  const out = new Map<string, Buffer>();
  for (const [n, e] of Object.entries(z.files)) if (!e.dir) out.set(n, await e.async('nodebuffer'));
  return out;
};

/** Перейти к ячейке, как в Excel: адрес в поле имени и Enter */
async function gotoCell(page: any, ref: string): Promise<void> {
  const box = page.frameLocator(FRAME).locator('input.univer-box-border').first();
  await box.click();
  await box.fill(ref);
  await box.press('Enter');
  await page.waitForTimeout(300);
}

(async () => {
  if (!existsSync('public/genoffice/sheets/index.html') || !existsSync('genoffice-server/sheets.cjs')) {
    console.error('Таблица не собрана: node tools/genoffice/build.mjs sheets'); process.exit(2);
  }
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); } catch { console.error('нет playwright-core'); process.exit(2); }
  token = (await call('POST', '/api/login', LOGIN)).json?.token || '';
  const name = `__проба книги ${Date.now().toString(36)}.xlsx`;
  const id = (await call('POST', '/api/files', { name, filePath: `/shared/${name}`, type: 'XLSX' })).json?.file?.id;
  const original = await makeXlsx();
  await call('POST', `/api/files/${id}/chunk`, { idx: 0, data: original.toString('base64') });
  await call('POST', `/api/files/${id}/done`, { count: 1 });

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const outside: string[] = [];
    page.on('request', (r: any) => {
      const u = String(r.url());
      if (!u.startsWith(BASE) && !u.startsWith('blob:') && !u.startsWith('data:') && !u.startsWith('ws://localhost')) outside.push(u);
    });
    await loginPage(page, BASE, LOGIN, process.env.THEME === 'dark');

    console.log('1. Открытие');
    await page.goto(`${BASE}/#/office-sheet?file=${id}`, { waitUntil: 'domcontentloaded' });
    const fr = page.frameLocator(FRAME);
    const status = fr.getByText('Книга полностью загружена', { exact: false }).first();
    ok('книга загружена целиком', await status.waitFor({ timeout: 40000 }).then(() => true).catch(() => false));
    ok('«Открывается…» ушло', await until(async () => !(await page.getByText('Открывается…').isVisible().catch(() => false)), 10000));
    const body = await fr.locator('body').innerText().catch(() => '');
    ok('листы книги видны', /Перечень/.test(body) && /Справка/.test(body));
    ok('имени Genspark на экране нет', !/genspark/i.test(body), body.match(/.{0,30}genspark.{0,30}/i)?.[0]);
    ok('панели ИИ нет', !(await fr.locator('.copilot').first().isVisible().catch(() => false)));
    ok('интерфейс по-русски', /Главная/.test(body) && /Вставка/.test(body));
    await page.waitForTimeout(1500);
    const shown = await fr.locator('body').innerText().catch(() => '');
    ok('случайного имени снимка на экране нет', !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.xlsx/.test(shown));

    console.log('\n2. Правка ячейки и Ctrl+S');
    await gotoCell(page, 'B3');
    await page.keyboard.type('99');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    await page.keyboard.press('Control+s');
    const saved = await until(async () => (await call('GET', `/api/office/files/${id}/versions`)).json?.versions?.length > 0, 20000);
    ok('Ctrl+S записал книгу в файл Flux', saved);
    const after = (await call('GET', `/api/files/${id}/raw`)).buf;
    const a = await parts(original), b = await parts(after);
    const sheet1 = b.get('xl/worksheets/sheet1.xml')?.toString('utf8') || '';
    ok('в B3 новое значение', /<c r="B3"[^>]*><v>99<\/v><\/c>/.test(sheet1), sheet1.replace(/^[\s\S]*<sheetData>/, '').slice(0, 400));
    ok('формула итога на месте', /<c r="B4"[^>]*><f>SUM\(B2:B3\)<\/f>/.test(sheet1), sheet1.match(/<c r="B4".{0,80}/)?.[0]);
    ok('имя диапазона «Итого» на месте', /definedName name="Итого"/.test(b.get('xl/workbook.xml')?.toString('utf8') || ''));
    const same = (n: string) => !!a.get(n) && !!b.get(n) && a.get(n)!.equals(b.get(n)!);
    ok('второй лист байт в байт', same('xl/worksheets/sheet2.xml'));
    ok('посторонняя часть customXml байт в байт', same('customXml/item1.xml'));
    ok('общие строки и стили байт в байт', same('xl/sharedStrings.xml') && same('xl/styles.xml'));
    const touched = [...new Set([...a.keys(), ...b.keys()])].filter((n) => !same(n));
    ok('тронуты только лист и книга', touched.every((n) => n === 'xl/worksheets/sheet1.xml' || n === 'xl/workbook.xml'), touched);
    const versions = await call('GET', `/api/office/files/${id}/versions`);
    ok('прежнее содержимое — в откате', versions.json?.versions?.[0]?.sha256 === sha(original), versions.json);

    console.log('\n3. Закрытие с несохранённой правкой');
    await gotoCell(page, 'B2');
    await page.keyboard.type('5');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: 'Закрыть' }).last().click();
    ok('окно закрылось', await until(async () => !(await page.locator(FRAME).count()), 15000));
    const last = await parts((await call('GET', `/api/files/${id}/raw`)).buf);
    ok('правка перед закрытием сохранена', /<c r="B2"[^>]*><v>5<\/v><\/c>/.test(last.get('xl/worksheets/sheet1.xml')?.toString('utf8') || ''));
    ok('ни одного запроса за пределы сервера Flux', outside.length === 0, outside.slice(0, 5));
    await page.screenshot({ path: process.env.OUT || '/tmp/office-sheets.png' }).catch(() => {});
  } catch (e: any) {
    ok('проба оборвалась', false, String(e?.message || e));
  } finally {
    await browser.close();
    await call('DELETE', `/api/files/${id}`).catch(() => {});
  }
  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
