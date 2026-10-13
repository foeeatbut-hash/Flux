import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from '../../../node_modules/playwright-core/index.mjs';

/**
 * Сверка переноса: прежняя FluxPanel и новая FluxOfficePanel получают одни и те
 * же теги и должны дать одно и то же — вставленную в документ таблицу
 * («Вставить все», «Вставить выбранные»), CSV, XLSX (части файла) и имена файлов.
 * Данные нарочно неудобные: 620 строк (лимит вставки 500), пустые и пропущенные
 * значения, кавычки, «;» и перевод строки в значении, русские заголовки.
 */
const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const url = process.env.OFFICE_ADDON_UI_URL || process.env.FLUX_UI_URL || 'http://127.0.0.1:4190';
const browser = await chromium.launch({ executablePath: process.env.FLUX_CHROME || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });

const COLUMNS = [['identifier', 'Тег'], ['metadata.mainName', 'Наименование'], ['department', 'Отдел'], ['wbs', 'Раздел'], ['fluid', 'Среда'], ['brand', 'Марка'], ['metadata.descriptions', 'Описания'], ['metadata.createdAt', 'Создан'], ['metadata.updatedAt', 'Изменён']];
const tags = Array.from({ length: 620 }, (_, index) => {
  const n = index + 1;
  return {
    id: `id-${n}`, identifier: `T-${String(n).padStart(3, '0')}`,
    department: n % 7 === 0 ? '' : 'ОВ', wbs: n % 5 === 0 ? null : 'WBS-1', fluid: n % 3 === 0 ? 'Воздух; "сухой"' : 'Вода', brand: n % 11 === 0 ? '' : 'Бренд',
    metadata: { mainName: n % 13 === 0 ? 'Строка\nс переносом' : `Вентилятор ${n}`, descriptions: n % 4 === 0 ? [{ text: 'а' }, { comment: 'б' }] : [], createdAt: '2026-01-02', ...(n % 9 === 0 ? {} : { updatedAt: '2026-02-03' }) },
  };
});
/** Значения тега так, как их видит новая панель: пустое — null. */
const valuesOf = (tag) => {
  const text = (value) => (value === undefined || value === null || value === '' ? null : { value });
  const descriptions = tag.metadata.descriptions.map((item) => item.text || item.comment).join('; ');
  return { identifier: text(tag.identifier), 'metadata.mainName': text(tag.metadata.mainName), department: text(tag.department), wbs: text(tag.wbs), fluid: text(tag.fluid), brand: text(tag.brand), 'metadata.descriptions': text(descriptions), 'metadata.createdAt': text(tag.metadata.createdAt), 'metadata.updatedAt': text(tag.metadata.updatedAt) };
};

async function open(panel) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.saved = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    let body = {};
    if (pathname === '/api/office/files/new') {
      // «Книга Flux»: файл уходит на сервер в «Выгрузки»; запоминаем запрос
      const request = route.request();
      page.saved.push({ query: Object.fromEntries(new URL(request.url()).searchParams), method: request.method(), body: request.postDataBuffer()?.toString('base64') || '' });
      body = { id: 'new-file', name: 'Книга.xlsx', sha256: 'x', size: 1, folderId: null };
    } else if (pathname === '/api/projects') body = { projects: [{ id: 'project', name: 'Проект' }] };
    else if (pathname === '/api/projects/project/tags') body = { tags: tags.map((tag) => ({ ...tag, metadata: JSON.stringify(tag.metadata) })) };
    else if (pathname === '/api/projects/project/dictionaries') body = { dictionaries: [] };
    else if (pathname === '/api/project-data/catalog') body = { tagFields: COLUMNS.map(([path, title]) => ({ path, title })), elementFields: [], params: [], aliases: [], metaKeys: [] };
    else if (pathname === '/api/project-data/office/templates') body = { templates: [], pinned: [] };
    else if (pathname === '/api/project-data/office/query') body = { revision: 'rev-1', total: tags.length, rows: tags.map((tag) => ({ entityId: `e-${tag.id}`, entityType: 'tag', sourceId: 'tags', tag: tag.identifier, values: valuesOf(tag) })) };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`${url}/compare.html?panel=${panel}`);
  return { page, errors };
}
const statusText = async (page) => (await page.getByRole('status').allTextContents()).join(' | ');
const downloads = (page) => page.evaluate(() => window.__downloads.map((item) => ({ ...item })));
const waitSaved = async (page) => { for (let at = 0; at < 100 && !page.saved.length; at++) await new Promise((resolve) => setTimeout(resolve, 100)); };
const waitDownloads = (page, count) => page.waitForFunction((n) => window.__downloads.length >= n, count);

async function runOld() {
  const { page, errors } = await open('old');
  const all = page.getByRole('button', { name: 'Вставить все' });
  await all.waitFor(); await page.getByText(/Предпросмотр: 620 строк/).waitFor();
  await all.click();
  await page.getByRole('status').filter({ hasText: 'Вставлены первые 500' }).waitFor();
  const message = await statusText(page);
  await page.getByRole('button', { name: 'XLSX', exact: true }).click(); await waitDownloads(page, 1);
  await page.getByRole('button', { name: 'CSV', exact: true }).click(); await waitDownloads(page, 2);
  await page.getByRole('checkbox', { name: 'Выбрать строку T-003' }).check();
  await page.getByRole('checkbox', { name: 'Выбрать строку T-001' }).check();
  await page.getByRole('button', { name: 'Вставить выбранные (2)' }).click();
  await page.waitForFunction(() => window.__inserted.length === 2);
  await page.getByRole('button', { name: 'XLSX', exact: true }).click(); await waitDownloads(page, 3);
  await page.getByRole('button', { name: 'Книга Flux', exact: true }).click();
  await waitSaved(page);
  return { inserted: await page.evaluate(() => window.__inserted), downloads: await downloads(page), message, errors, saved: page.saved };
}

async function runNew() {
  const { page, errors } = await open('new');
  await page.waitForFunction(() => typeof window.__command === 'function');
  await page.evaluate(() => window.__command('source-tags'));
  await page.getByRole('button', { name: 'Обновить выборку' }).click();
  await page.getByRole('checkbox', { name: 'Выбрать строку T-001' }).waitFor();
  await page.getByRole('button', { name: 'Вставить все' }).click();
  await page.getByRole('status').filter({ hasText: 'Вставлены первые 500' }).waitFor();
  const message = await statusText(page);
  await page.evaluate(() => window.__command('export'));
  const dialog = page.getByRole('dialog', { name: /Выгрузить:/ });
  await dialog.getByRole('button', { name: 'XLSX', exact: true }).click(); await waitDownloads(page, 1);
  await dialog.getByRole('button', { name: 'CSV', exact: true }).click(); await waitDownloads(page, 2);
  await page.keyboard.press('Escape');
  await page.getByRole('checkbox', { name: 'Выбрать строку T-003' }).check();
  await page.getByRole('checkbox', { name: 'Выбрать строку T-001' }).check();
  await page.getByRole('button', { name: 'Вставить выбранные (2)' }).click();
  await page.waitForFunction(() => window.__inserted.length === 2);
  await page.evaluate(() => window.__command('export'));
  await page.getByRole('dialog', { name: /Выгрузить:/ }).getByRole('button', { name: 'XLSX', exact: true }).click(); await waitDownloads(page, 3);
  await page.getByRole('dialog', { name: /Выгрузить:/ }).getByRole('button', { name: 'Книга Flux', exact: true }).click();
  await waitSaved(page);
  return { inserted: await page.evaluate(() => window.__inserted), downloads: await downloads(page), message, errors, saved: page.saved };
}

const parts = async (base64) => { const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64')); const out = {}; for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir) out[name] = Buffer.from(await entry.async('uint8array')).toString('base64'); return out; };
try {
  const oldResult = await runOld();
  const newResult = await runNew();
  assert.deepEqual(oldResult.errors, [], 'старая панель: ошибок страницы нет');
  assert.deepEqual(newResult.errors, [], 'новая панель: ошибок страницы нет');
  // Независимые ожидания: сверка «старое = новое» не должна совпасть на общей ошибке
  const [all, picked] = oldResult.inserted;
  assert.equal(all.length, 501, 'в документ уходит заголовок и не более 500 строк');
  assert.deepEqual(all[0], COLUMNS.map(([, title]) => title), 'заголовки — подписи столбцов в порядке столбцов');
  assert.deepEqual(all[1], ['T-001', 'Вентилятор 1', 'ОВ', 'WBS-1', 'Вода', 'Бренд', '', '2026-01-02', '2026-02-03'], 'пустое значение — пустая строка');
  assert.equal(all[13][1], 'Строка\nс переносом');
  assert.deepEqual(picked.map((row) => row[0]), ['Тег', 'T-001', 'T-003'], 'выбранные строки идут в порядке выборки');
  // Старое = новое
  assert.deepEqual(newResult.inserted, oldResult.inserted, '«Вставить все» и «Вставить выбранные»: одна и та же таблица');
  assert.equal(newResult.message, oldResult.message, 'сообщение о первых 500 строках одинаково');
  assert.equal(oldResult.downloads.length, 3); assert.equal(newResult.downloads.length, 3);
  for (let at = 0; at < 3; at++) {
    const [a, b] = [oldResult.downloads[at], newResult.downloads[at]];
    assert.equal(b.name, a.name, `имя файла ${at + 1}`);
    if (a.name.endsWith('.csv')) {
      assert.equal(Buffer.from(b.base64, 'base64').toString('utf8'), Buffer.from(a.base64, 'base64').toString('utf8'), 'CSV побайтно');
    } else {
      const [pa, pb] = [await parts(a.base64), await parts(b.base64)];
      assert.deepEqual(Object.keys(pb).sort(), Object.keys(pa).sort(), 'части XLSX');
      // Время создания книги в docProps у каждого вызова своё; остальное — побайтно
      for (const name of Object.keys(pa)) if (!name.startsWith('docProps/')) assert.equal(pb[name], pa[name], `XLSX ${at + 1}: ${name}`);
    }
  }
  // «Книга Flux»: тот же файл (имя, место, байты книги) уходит на сервер
  assert.equal(oldResult.saved.length, 1); assert.equal(newResult.saved.length, 1);
  const [savedOld, savedNew] = [oldResult.saved[0], newResult.saved[0]];
  assert.deepEqual(savedNew.query, savedOld.query, '«Книга Flux»: имя и место сохранения');
  assert.equal(savedOld.query.where, 'exports'); assert.match(savedOld.query.name, /^Flux — Теги — \d{2}-\d{2}-\d{4}\.xlsx$/);
  const [bookOld, bookNew] = [await parts(savedOld.body), await parts(savedNew.body)];
  for (const name of Object.keys(bookOld)) if (!name.startsWith('docProps/')) assert.equal(bookNew[name], bookOld[name], `«Книга Flux»: ${name}`);
  const csv = Buffer.from(oldResult.downloads.find((item) => item.name.endsWith('.csv')).base64, 'base64').toString('utf8');
  assert.equal(csv.split('\r\n').length, 622, 'CSV: заголовок, 620 строк и завершающий перевод строки (без предела 500)');
  assert.ok(csv.includes('"Воздух; ""сухой"""'), 'CSV: кавычки и «;» экранированы');
  assert.match(oldResult.downloads[0].name, /^Flux — Теги — \d{2}-\d{2}-\d{4}\.xlsx$/);
  console.log(JSON.stringify({ compared: ['таблица «Вставить все» (501 строка, лимит 500)', 'таблица выбранных строк', 'XLSX (части файла)', 'CSV (байты)', '«Книга Flux» (запрос и байты книги)', 'имена файлов', 'сообщение о лимите'], names: oldResult.downloads.map((item) => item.name) }, null, 2));
} finally { await browser.close(); }
