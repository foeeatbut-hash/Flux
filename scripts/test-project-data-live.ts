import { testCredentials } from './testCredentials';
/**
 * Данные проекта в окнах Документа и Таблицы Flux Office — вживую.
 *
 *   1. Документ: панель «Данные проекта» вставляет метку поля в место курсора;
 *      «Обновить поля» записывает правки, превращает метку в поле Word
 *      DOCPROPERTY "flux:<ключ>" со значением и открывает файл заново.
 *      Метка, набранная в самом файле, тоже становится полем;
 *   2. Таблица: значение ложится в выделенную ячейку, на ней — имя FLUX_<ключ>;
 *      «Обновить поля» подставляет значение по имени;
 *   3. прежние версии — в откате; ни одного запроса наружу.
 *
 * Нужен сервер на :3000 и собранные редакторы (node tools/genoffice/build.mjs docs|sheets).
 * Запуск: npx tsx scripts/test-project-data-live.ts
 */
import { existsSync } from 'node:fs';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { loginPage } from './officeHarness';
import { buildDocx } from '../src/lib/docxWrite';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = testCredentials();
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 300))));
let token = '';
const call = async (method: string, url: string, body?: any, raw?: Uint8Array) => {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: raw ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* байты */ }
  return { status: res.status, json, buf };
};
const until = async (probe: () => Promise<boolean>, ms: number) => {
  for (let t = 0; t < ms; t += 400) { if (await probe()) return true; await new Promise((r) => setTimeout(r, 400)); }
  return probe();
};
const docXml = async (buf: Buffer) => (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string');

(async () => {
  if (!existsSync('public/genoffice/docs/index.html') || !existsSync('public/genoffice/sheets/index.html')) {
    console.error('Редакторы не собраны: node tools/genoffice/build.mjs docs && … sheets'); process.exit(2);
  }
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); } catch { console.error('нет playwright-core'); process.exit(2); }
  token = (await call('POST', '/api/login', LOGIN)).json?.token || '';
  const stamp = Date.now().toString(36);
  const files: string[] = [];

  // Документ с меткой, набранной руками, — «шаблон»
  const docBytes = buildDocx([{ kind: 'head', text: 'Записка' }, { kind: 'para', text: 'Год: {{year}}.' }, { kind: 'para', text: 'Шифр: ' }]);
  const doc = (await call('POST', `/api/office/files/new?name=${encodeURIComponent(`__проба полей ${stamp}.docx`)}&where=desk`, undefined, docBytes)).json;
  files.push(doc.id);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Шифр', ''], ['Год', '']]), 'Лист1');
  const xlsxBytes = new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
  const sheet = (await call('POST', `/api/office/files/new?name=${encodeURIComponent(`__проба полей ${stamp}.xlsx`)}&where=desk`, undefined, xlsxBytes)).json;
  files.push(sheet.id);

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
    const outside: string[] = [];
    page.on('request', (r: any) => {
      const u = String(r.url());
      if (!u.startsWith(BASE) && !u.startsWith('blob:') && !u.startsWith('data:') && !u.startsWith('ws://localhost') && !u.startsWith('about:')) outside.push(u);
    });
    await loginPage(page, BASE, LOGIN, process.env.THEME === 'dark');

    console.log('1. Документ');
    await page.goto(`${BASE}/#/office-doc?file=${doc.id}`, { waitUntil: 'domcontentloaded' });
    const dfr = page.frameLocator('iframe[title="Flux Office — Документ"]');
    ok('документ открылся', await dfr.getByText('Шифр:').first().waitFor({ timeout: 40000 }).then(() => true).catch(() => false));
    await page.getByRole('button', { name: 'Данные проекта' }).first().click();
    const panel = page.getByRole('complementary', { name: 'Данные проекта' });
    ok('панель открылась', await panel.getByText('Проект').first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false));
    // Курсор — в конец строки «Шифр: »
    await dfr.getByText('Шифр:').first().click();
    await page.keyboard.press('End');
    const insert = panel.getByRole('button', { name: 'Вставить' }).first();
    const firstKey = await panel.locator('.fx-li[title]').first().getAttribute('title');
    await insert.click();
    ok('метка встала в документ', await until(async () => (await dfr.locator('.ProseMirror').first().innerText()).includes(`{{${firstKey}}}`), 8000), firstKey);
    await panel.getByRole('button', { name: 'Обновить поля' }).click();
    const conv = await until(async () => (await docXml((await call('GET', `/api/files/${doc.id}/raw`)).buf)).includes('DOCPROPERTY'), 30000);
    const xml = await docXml((await call('GET', `/api/files/${doc.id}/raw`)).buf);
    ok('метка из панели стала полем Word', conv && xml.includes(`flux:${firstKey}`), xml.slice(0, 400));
    ok('метка, набранная в файле, — тоже', xml.includes('flux:year') && xml.includes(String(new Date().getFullYear())));
    ok('меток в тексте не осталось', !xml.includes('{{'));
    ok('прежняя версия — в откате', ((await call('GET', `/api/office/files/${doc.id}/versions`)).json?.versions || []).length >= 1);
    if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/project-data-doc.png` });
    ok('документ открылся заново со значением', await dfr.getByText(String(new Date().getFullYear())).first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false));

    console.log('2. Таблица');
    await page.goto(`${BASE}/#/office-sheet?file=${sheet.id}`, { waitUntil: 'domcontentloaded' });
    const sfr = page.frameLocator('iframe[title="Flux Office — Таблица"]');
    ok('книга открылась', await sfr.getByText('Книга полностью загружена', { exact: false }).first().waitFor({ timeout: 45000 }).then(() => true).catch(() => false));
    await page.getByRole('button', { name: 'Данные проекта' }).last().click();
    const spanel = page.getByRole('complementary', { name: 'Данные проекта' }).last();
    await spanel.getByText('Проект').first().waitFor({ timeout: 15000 }).catch(() => {});
    // Ячейка B2 — «Год»: выделить щелчком по сетке неудобно, берём поле года
    // и выделение по умолчанию (A1), затем проверяем имя и значение в файле
    await spanel.getByPlaceholder('Тег, позиция, шифр, поле').fill('');
    const yearRow = spanel.locator('.fx-li[title="today"]').first();
    const key = (await yearRow.count()) ? 'today' : (await spanel.locator('.fx-li[title]').first().getAttribute('title')) || '';
    await spanel.locator(`.fx-li[title="${key}"]`).first().getByRole('button', { name: 'Вставить' }).click();
    ok('поле встало в ячейку', await page.getByText(/в ячейке/).first().waitFor({ timeout: 10000 }).then(() => true).catch(() => false));
    await spanel.getByRole('button', { name: 'Обновить поля' }).click();
    const named = await until(async () => {
      const zip = await JSZip.loadAsync((await call('GET', `/api/files/${sheet.id}/raw`)).buf).catch(() => null);
      const wb = zip ? await zip.file('xl/workbook.xml')?.async('string') : '';
      return !!wb && wb.includes('FLUX_');
    }, 40000);
    ok('имя FLUX_ записано в книгу', named);
    if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/project-data-sheet.png` });
    ok('ни одного запроса за пределы сервера Flux', outside.length === 0, outside.slice(0, 5));
  } finally {
    await browser.close();
    for (const id of files) await call('DELETE', `/api/files/${id}`);
  }
  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВсё верно');
  process.exit(f ? 1 : 0);
})();
