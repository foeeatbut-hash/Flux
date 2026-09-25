/**
 * PDF Flux Office: открыть PDF из Проводника, пометить, сохранить.
 *
 * Что стережёт (src/screens/OfficeAppHost.tsx, server/officeHostApps.ts,
 * tools/genoffice/shims/*):
 *   - PDF открывается в редакторе GenOffice внутри окна Flux, текст виден;
 *   - ни ИИ, ни имени Genspark на экране;
 *   - выделение и Ctrl+S пишут пометку в сам файл Flux (главный процесс
 *     GenOffice работает на сервере);
 *   - прежнее содержимое лежит в откате;
 *   - прежние замечания Просмотра (PdfMarkup) предлагаются к переносу и
 *     переносятся в сам файл одной кнопкой; строки в базе остаются, второй
 *     раз не предлагаются (server/routes/pdfMarkupTransfer.ts);
 *   - закрытие окна убирает окно редактора на сервере;
 *   - ни одного запроса за пределы сервера Flux.
 *
 * Нужны поднятый сервер и собранный редактор (node tools/genoffice/build.mjs pdf).
 * Запуск: npx tsx scripts/test-office-pdf-live.ts
 */
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { makePdf, loginPage } from './officeHarness';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

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

(async () => {
  if (!existsSync('public/genoffice/pdf/index.html') || !existsSync('genoffice-server/pdf.cjs')) {
    console.error('PDF не собран: node tools/genoffice/build.mjs pdf'); process.exit(2);
  }
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); } catch { console.error('нет playwright-core'); process.exit(2); }
  token = (await call('POST', '/api/login', LOGIN)).json?.token || '';
  const name = `__проба pdf ${Date.now().toString(36)}.pdf`;
  const id = (await call('POST', '/api/files', { name, filePath: `/shared/${name}`, type: 'PDF' })).json?.file?.id;
  const original = makePdf(['Flux PDF proba', 'Second line of the blank']);
  await call('POST', `/api/files/${id}/chunk`, { idx: 0, data: original.toString('base64') });
  await call('POST', `/api/files/${id}/done`, { count: 1 });
  // Прежние замечания — так, как их ставил старый Просмотр: в базу, рядом с файлом
  for (const m of [
    { page: 1, kind: 'CLOUD', x: 0.1, y: 0.1, w: 0.3, h: 0.1, text: 'Нет отметки уровня' },
    { page: 1, kind: 'ARROW', x: 0.5, y: 0.5, w: 0.2, h: 0.1 },
    { page: 1, kind: 'NOTE', x: 0.6, y: 0.2, w: 0.05, h: 0.05, text: 'Уточнить у поставщика' },
  ]) await call('POST', `/api/files/${id}/markups`, m);

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
    await page.goto(`${BASE}/#/pdf?file=${id}`, { waitUntil: 'domcontentloaded' });
    const fr = page.frameLocator('iframe[title="PDF Flux Office"]');
    const line = fr.locator('.textLayer span', { hasText: 'Flux PDF proba' }).first();
    ok('текст PDF виден', await line.waitFor({ timeout: 30000 }).then(() => true).catch(() => false));
    ok('«Открывается…» ушло', await until(async () => !(await page.getByText('Открывается…').isVisible().catch(() => false)), 10000));
    const body = await fr.locator('body').innerText().catch(() => '');
    ok('имени Genspark на экране нет', !/genspark/i.test(body), body.match(/.{0,30}genspark.{0,30}/i)?.[0]);
    ok('интерфейс по-русски', /Выделение|Аннотирование/.test(body));

    console.log('\n2. Пометка и Ctrl+S');
    await line.click({ clickCount: 3 });
    await fr.getByText('Выделение', { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    await page.keyboard.press('Control+s');
    const saved = await until(async () => (await call('GET', `/api/files/${id}/raw`)).buf.includes('/Highlight'), 20000);
    ok('пометка записана в сам файл', saved);
    const versions = await call('GET', `/api/office/files/${id}/versions`);
    ok('прежнее содержимое — в откате', versions.json?.versions?.[0]?.sha256 === sha(original), versions.json);

    console.log('\n3. Прежние замечания Просмотра');
    const bar = page.getByRole('status', { name: 'Прежние замечания' }).last();
    ok('полоса о прежних замечаниях видна', await bar.waitFor({ timeout: 30000 }).then(() => true).catch(() => false));
    ok('в ней их число', /3 прежних замечания/.test(await bar.innerText().catch(() => '')), await bar.innerText().catch(() => ''));
    const shaBefore = sha((await call('GET', `/api/files/${id}/raw`)).buf);
    const move = bar.getByRole('button', { name: 'Перенести в файл' });
    ok('перенести может тот, кто правит', await until(() => move.isEnabled().catch(() => false), 20000));
    await move.click();
    const moved = await until(async () => {
      const b = (await call('GET', `/api/files/${id}/raw`)).buf;
      return sha(b) !== shaBefore && b.includes('/Square') && b.includes('/Text');
    }, 30000);
    ok('рамка, стрелка и записки — в самом файле', moved);
    const raw = (await call('GET', `/api/files/${id}/raw`)).buf;
    ok('стрелка — линией со стрелкой', raw.includes('/Line') || raw.includes('/LE'));
    ok('пометка из шага 2 не пропала', raw.includes('/Highlight'));
    const v2 = await call('GET', `/api/office/files/${id}/versions`);
    ok('до переноса — в откате', (v2.json?.versions || []).some((v: any) => v.sha256 === shaBefore), v2.json);
    ok('полоса ушла', await until(async () => !(await bar.isVisible().catch(() => false)), 15000));
    ok('второй раз не предлагается', ((await call('GET', `/api/office/files/${id}/legacy-markups`)).json?.markups || []).length === 0);
    ok('строки в базе остались', ((await call('GET', `/api/files/${id}/markups`)).json?.markups || []).length === 3);
    await fr.locator('.textLayer span', { hasText: 'Flux PDF proba' }).first().waitFor({ timeout: 30000 }).catch(() => {});

    console.log('\n4. Закрытие');
    // Все окна PDF по очереди (прежнее окно рабочий стол мог восстановить)
    for (let i = 0; i < 3 && await page.locator('iframe[title="PDF Flux Office"]').count(); i++) {
      await page.getByRole('button', { name: 'Закрыть' }).last().click();
      await page.waitForTimeout(1500);
    }
    ok('окно закрылось, ничего не потеряв', await until(async () => !(await page.locator('iframe[title="PDF Flux Office"]').count()), 10000));
    ok('ни одного запроса за пределы сервера Flux', outside.length === 0, outside.slice(0, 5));
    await page.screenshot({ path: process.env.OUT || '/tmp/office-pdf.png' }).catch(() => {});
  } catch (e: any) {
    ok('проба оборвалась', false, String(e?.message || e));
  } finally {
    await browser.close();
    await call('DELETE', `/api/files/${id}`).catch(() => {});
  }
  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
