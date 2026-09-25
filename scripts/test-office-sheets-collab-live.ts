/**
 * Два сотрудника правят одну книгу Excel одновременно — в двух браузерах.
 *
 * Что стережёт (server/officeSheetCollab.ts, src/screens/OfficeAppHost.tsx,
 * tools/genoffice/inject/sheets-collab.ts и правки patches.mjs):
 *   - книгу в общем доступе правят оба сразу;
 *   - значение, введённое одним, появляется у другого после Enter, до всякой
 *     записи;
 *   - одновременный ввод в разные ячейки сводится без потерь у обоих;
 *   - одновременный ввод в одну ячейку сходится к одному значению у обоих;
 *   - вставка строки у одного сдвигает строки у другого, в файле она одна;
 *   - файл записывает держатель сам, без Ctrl+S: в файле правки обоих, второй
 *     лист и посторонняя часть — байт в байт;
 *   - Ctrl+S соавтора записывает книгу руками держателя;
 *   - держатель закрыл окно — записывает второй;
 *   - опоздавший сразу видит ещё не записанное;
 *   - личная книга совместно не правится.
 *
 * Нужны поднятый сервер и собранный редактор (node tools/genoffice/build.mjs sheets).
 * Запуск: npx tsx scripts/test-office-sheets-collab-live.ts
 */
import { existsSync } from 'node:fs';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { FEATURES } from '../src/lib/permissions';
import { makeXlsx, loginPage } from './officeHarness';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FRAME = 'iframe[title="Flux Office — Таблица"]';

let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 400))));

const api = async (method: string, url: string, token: string, body?: any) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* байты */ }
  return { status: res.status, json, buf };
};
const until = async (probe: () => Promise<boolean>, ms: number) => {
  for (let t = 0; t < ms; t += 200) { if (await probe()) return true; await new Promise((r) => setTimeout(r, 200)); }
  return probe();
};

type Who = { page: any; ctx: any };
const frameOf = (x: Who) => x.page.frames().find((fr: any) => /genoffice\/sheets\//.test(fr.url()));
/** Значение ячейки у этого участника — у самой Таблицы (лист нарисован на холсте) */
const cell = async (x: Who, ref: string, sheet?: string): Promise<string> => {
  const fr = frameOf(x);
  if (!fr) return '';
  return fr.evaluate(([r, s]: [string, string | undefined]) => {
    const u = (window as any).__fluxSheets?.univerRef?.current?.univerAPI;
    const wb = u?.getActiveWorkbook();
    const ws = s ? wb?.getSheetByName(s) : wb?.getActiveSheet();
    const v = ws?.getRange(r)?.getValue();
    return v == null ? '' : String(v);
  }, [ref, sheet]).catch(() => '');
};
const column = async (x: Who, col: string, rows: number) => {
  const out: string[] = [];
  for (let i = 1; i <= rows; i++) out.push(await cell(x, `${col}${i}`));
  return out;
};
/** Перейти к ячейке, как в Excel: адрес в поле имени и Enter */
const gotoCell = async (x: Who, ref: string) => {
  const box = x.page.frameLocator(FRAME).locator('input.univer-box-border').first();
  await box.click();
  await box.fill(ref);
  await box.press('Enter');
  await x.page.waitForTimeout(250);
};
const enter = async (x: Who, ref: string, value: string) => {
  await gotoCell(x, ref);
  await x.page.keyboard.type(value, { delay: 20 });
  await x.page.keyboard.press('Enter');
};
const strip = (x: Who) => x.page.getByRole('status', { name: 'Кто в файле' }).innerText().catch(() => '');

(async () => {
  if (!existsSync('public/genoffice/sheets/index.html') || !existsSync('genoffice-server/sheets.cjs')) {
    console.error('Таблица не собрана: node tools/genoffice/build.mjs sheets'); process.exit(2);
  }
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); } catch { console.error('нет playwright-core'); process.exit(2); }

  const admin = (await api('POST', '/api/login', '', ADMIN)).json?.token || '';
  if (!admin) { console.error('вход администратора не удался'); process.exit(2); }
  const stamp = Date.now().toString(36);
  const mate = { symbol: `sht${stamp}`, password: `Пр${stamp}!7` };
  const mk = await api('POST', '/api/users', admin, { ...mate, name: 'Проба Соавтор', role: 'USER' });
  const mateId = mk.json?.user?.id || mk.json?.id;
  await api('PUT', `/api/users/${mateId}`, admin, {
    permissions: JSON.stringify(Object.fromEntries(FEATURES.map((x) => [x.id, { enabled: true, until: null }]))),
  });
  const original = await makeXlsx();
  const upload = async (name: string, extra: object = {}) => {
    const id = (await api('POST', '/api/files', admin, { name, filePath: `/shared/${name}`, type: 'XLSX', ...extra })).json?.file?.id;
    await api('POST', `/api/files/${id}/chunk`, admin, { idx: 0, data: original.toString('base64') });
    await api('POST', `/api/files/${id}/done`, admin, { count: 1 });
    return id as string;
  };
  const id = await upload(`__проба общей книги ${stamp}.xlsx`);
  const created = [id];
  /** Ячейки листа «Перечень» в файле на сервере */
  const fileSheet = async () => {
    const buf = (await api('GET', `/api/files/${id}/raw`, admin)).buf;
    const wb = XLSX.read(buf, { type: 'buffer' });
    return { buf, ws: wb.Sheets['Перечень'] || {} };
  };
  const fileCell = (ws: any, ref: string) => (ws[ref]?.v == null ? '' : String(ws[ref].v));

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const outside: string[] = [];
  const openAs = async (who: typeof ADMIN, fileId = id): Promise<Who> => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    page.on('request', (r: any) => {
      const u = String(r.url());
      if (!u.startsWith(BASE) && !u.startsWith('blob:') && !u.startsWith('data:') && !u.startsWith('ws://localhost')) outside.push(u);
    });
    await loginPage(page, BASE, who);
    await page.goto(`${BASE}/#/office-sheet?file=${fileId}`, { waitUntil: 'domcontentloaded' });
    await page.frameLocator(FRAME).getByText('Книга полностью загружена', { exact: false }).first().waitFor({ timeout: 40000 }).catch(() => {});
    return { ctx, page };
  };

  try {
    console.log('1. Оба правят');
    const a = await openAs(ADMIN);
    const b = await openAs(mate);
    ok('первый видит, что правят вместе', await until(async () => /Правите вместе/.test(await strip(a)), 15000), await strip(a));
    ok('второй тоже', await until(async () => /Правите вместе/.test(await strip(b)), 15000), await strip(b));

    console.log('\n2. Значение появляется после Enter');
    const t0 = Date.now();
    await enter(a, 'B2', '11');
    ok('у второго B2 = 11 без всякой записи', await until(async () => (await cell(b, 'B2')) === '11', 4000), await cell(b, 'B2'));
    ok('быстрее, чем сработало бы сохранение', Date.now() - t0 < 3000, Date.now() - t0);
    ok('формула итога у второго пересчиталась', await until(async () => (await cell(b, 'B4')) === '15', 4000), await cell(b, 'B4'));
    await enter(b, 'C1', 'Соавтор');
    ok('у первого C1 от второго', await until(async () => (await cell(a, 'C1')) === 'Соавтор', 4000), await cell(a, 'C1'));

    console.log('\n3. Одновременно в разные ячейки');
    await Promise.all([enter(a, 'A6', 'Альфа'), enter(b, 'A7', 'Бета')]);
    const both = async (x: Who) => (await cell(x, 'A6')) === 'Альфа' && (await cell(x, 'A7')) === 'Бета';
    ok('у первого — обе', await until(() => both(a), 5000), [await cell(a, 'A6'), await cell(a, 'A7')]);
    ok('у второго — обе', await until(() => both(b), 5000), [await cell(b, 'A6'), await cell(b, 'A7')]);

    console.log('\n4. Одновременно в одну ячейку');
    await Promise.all([enter(a, 'D1', 'от первого'), enter(b, 'D1', 'от второго')]);
    await a.page.waitForTimeout(2500);
    const d1a = await cell(a, 'D1'), d1b = await cell(b, 'D1');
    ok('у обоих одно и то же значение', d1a === d1b && /от (первого|второго)/.test(d1a), [d1a, d1b]);

    console.log('\n5. Вставка строки');
    await frameOf(b).evaluate(() => {
      const u = (window as any).__fluxSheets.univerRef.current.univerAPI;
      u.getActiveWorkbook().getActiveSheet().insertRowBefore(5); // перед строкой 6
    });
    ok('у первого «Альфа» уехала на строку ниже', await until(async () => (await cell(a, 'A7')) === 'Альфа' && (await cell(a, 'A8')) === 'Бета', 5000),
      await column(a, 'A', 9));
    const colA = await column(a, 'A', 10), colB = await column(b, 'A', 10);
    ok('у обоих столбец A одинаков', JSON.stringify(colA) === JSON.stringify(colB), { a: colA, b: colB });

    console.log('\n6. Держатель записывает сам');
    const saved = await until(async () => {
      const { ws } = await fileSheet();
      return fileCell(ws, 'B2') === '11' && fileCell(ws, 'C1') === 'Соавтор' && fileCell(ws, 'A7') === 'Альфа' && fileCell(ws, 'A8') === 'Бета';
    }, 30000);
    const { buf, ws } = await fileSheet();
    ok('в файле правки обоих и вставленная строка — одна', saved,
      ['B2', 'C1', 'A6', 'A7', 'A8', 'A9', 'D1'].map((r) => `${r}=${fileCell(ws, r)}`));
    ok('в файле D1 — то же, что на экране', fileCell(ws, 'D1') === d1a, [fileCell(ws, 'D1'), d1a]);
    const za = await JSZip.loadAsync(original), zb = await JSZip.loadAsync(buf);
    const same = async (n: string) => {
      const x = await za.file(n)?.async('nodebuffer'), y = await zb.file(n)?.async('nodebuffer');
      return !!x && !!y && x.equals(y);
    };
    ok('второй лист байт в байт', await same('xl/worksheets/sheet2.xml'));
    ok('посторонняя часть customXml байт в байт', await same('customXml/item1.xml'));
    const versions = (await api('GET', `/api/office/files/${id}/versions`, admin)).json?.versions || [];
    ok('автосохранение не плодит версий отката', versions.length >= 1 && versions.length <= 2, versions.length);

    console.log('\n7. Ctrl+S соавтора');
    await enter(b, 'E1', 'по просьбе');
    await b.page.keyboard.press('Control+s');
    ok('записал держатель', await until(async () => fileCell((await fileSheet()).ws, 'E1') === 'по просьбе', 8000));

    console.log('\n8. Держатель ушёл — записывает второй');
    await a.page.getByRole('button', { name: 'Закрыть' }).last().click();
    ok('окно первого закрылось сразу', await until(async () => !(await a.page.locator(FRAME).count()), 15000));
    await a.ctx.close();
    await b.page.waitForTimeout(1500);
    await enter(b, 'F1', 'после ухода');
    ok('второй записал сам', await until(async () => fileCell((await fileSheet()).ws, 'F1') === 'после ухода', 30000));

    console.log('\n9. Опоздавший видит незаписанное');
    await enter(b, 'G1', 'ещё не в файле');
    const c = await openAs(ADMIN);
    ok('у опоздавшего G1 сразу', await until(async () => (await cell(c, 'G1')) === 'ещё не в файле', 10000), await cell(c, 'G1'));
    ok('и всё остальное как у второго', JSON.stringify(await column(c, 'A', 10)) === JSON.stringify(await column(b, 'A', 10)));
    await c.ctx.close();
    await b.ctx.close();

    console.log('\n10. Личная книга');
    const own = await upload(`__проба личной книги ${stamp}.xlsx`, { scope: 'PERSONAL', filePath: `/personal/__проба личной книги ${stamp}.xlsx` });
    created.push(own);
    const p = await openAs(ADMIN, own);
    // Один в своём файле — полосе сказать нечего; признаков общей правки нет
    await p.page.waitForTimeout(1500);
    ok('личная книга — не общая', !/Правите вместе|Подключение к общему/.test(await strip(p)), await strip(p));
    await enter(p, 'B2', '21');
    await p.page.keyboard.press('Control+s');
    ok('и записывается своим Ctrl+S', await until(async () => {
      const w = XLSX.read((await api('GET', `/api/files/${own}/raw`, admin)).buf, { type: 'buffer' }).Sheets['Перечень'] || {};
      return fileCell(w, 'B2') === '21';
    }, 15000));
    await p.ctx.close();

    ok('ни одного запроса за пределы сервера Flux', outside.length === 0, outside.slice(0, 5));
  } catch (e: any) {
    ok('проба оборвалась', false, String(e?.message || e));
  } finally {
    await browser.close();
    for (const x of created) await api('DELETE', `/api/files/${x}`, admin).catch(() => {});
    if (mateId) await api('DELETE', `/api/users/${mateId}`, admin).catch(() => {});
  }
  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
