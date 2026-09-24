/**
 * Два сотрудника в одном документе Flux Office — в двух браузерах.
 *
 * Что стережёт (server/officeRooms.ts, src/screens/OfficeHost.tsx,
 * правка «только просмотр» в tools/genoffice/patches.mjs):
 *   - первый правит, второй видит «только просмотр: файл правит …», и его
 *     редактор правда закрыт для правки;
 *   - первый видит, что в файле есть зритель;
 *   - первый сохранил — у второго свежая версия появилась сама, без
 *     перезагрузки окна;
 *   - запись в обход держателя сервер не принимает (423);
 *   - первый закрыл окно — у второго сразу «правка свободна» и кнопка;
 *     взял — правит и сохраняет, в файле его правка поверх правки первого;
 *   - держатель пропал (связь оборвалась) — правка ждёт его, потом свободна.
 *
 * Нужны поднятый сервер и собранный редактор (node tools/genoffice/build.mjs).
 * Запуск: npx tsx scripts/test-office-collab-live.ts
 */
import { existsSync } from 'node:fs';
import JSZip from 'jszip';
import { FEATURES } from '../src/lib/permissions';
import { makeDocx, loginPage } from './officeHarness';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 400))));

const api = async (method: string, url: string, token: string, body?: any, headers: Record<string, string> = {}) => {
  const raw = Buffer.isBuffer(body);
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* байты */ }
  return { status: res.status, json, buf };
};
const docXml = async (buf: Buffer) => (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string').catch(() => '');
const until = async (probe: () => Promise<boolean>, ms: number) => {
  for (let t = 0; t < ms; t += 500) { if (await probe()) return true; await new Promise((r) => setTimeout(r, 500)); }
  return probe();
};

(async () => {
  if (!existsSync('public/genoffice/docs/index.html')) { console.error('Редактор не собран: node tools/genoffice/build.mjs'); process.exit(2); }
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); } catch { console.error('нет playwright-core'); process.exit(2); }

  const login = await api('POST', '/api/login', '', ADMIN);
  const admin = login.json?.token || '';
  if (!admin) { console.error('вход администратора не удался'); process.exit(2); }
  const adminName = String(login.json?.user?.name || '');
  const stamp = Date.now().toString(36);
  const mate = { symbol: `ofc${stamp}`, password: `Пр${stamp}!7` };
  const mk = await api('POST', '/api/users', admin, { ...mate, name: 'Проба Зритель', role: 'USER' });
  const mateId = mk.json?.user?.id || mk.json?.id;
  await api('PUT', `/api/users/${mateId}`, admin, {
    permissions: JSON.stringify(Object.fromEntries(FEATURES.map((x) => [x.id, { enabled: true, until: null }]))),
  });
  const mateToken = (await api('POST', '/api/login', '', mate)).json?.token || '';

  const name = `__проба совместной ${stamp}.docx`;
  const made = await api('POST', '/api/files', admin, { name, filePath: `/shared/${name}`, type: 'DOCX' });
  const id = made.json?.file?.id;
  const original = await makeDocx();
  await api('POST', `/api/files/${id}/chunk`, admin, { idx: 0, data: original.toString('base64') });
  await api('POST', `/api/files/${id}/done`, admin, { count: 1 });

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const openAs = async (login: typeof ADMIN) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await loginPage(page, BASE, login);
    await page.goto(`${BASE}/#/office-doc?file=${id}`, { waitUntil: 'domcontentloaded' });
    const fr = page.frameLocator('iframe[title="Документ Flux Office"]');
    await fr.locator('.ProseMirror').first().waitFor({ timeout: 30000 }).catch(() => {});
    return { ctx, page, fr };
  };
  const strip = (page: any) => page.getByRole('status', { name: 'Кто в файле' }).innerText().catch(() => '');
  const editable = (fr: any) => fr.locator('.ProseMirror').first().getAttribute('contenteditable').catch(() => '');
  const text = (fr: any) => fr.locator('.ProseMirror').first().innerText().catch(() => '');

  try {
    console.log('1. Первый правит, второй смотрит');
    const a = await openAs(ADMIN);
    await until(async () => (await editable(a.fr)) === 'true', 15000);
    ok('первый может править', (await editable(a.fr)) === 'true');
    const b = await openAs(mate);
    await until(async () => /Только просмотр/.test(await strip(b.page)), 15000);
    const bStrip = await strip(b.page);
    ok('второй видит «только просмотр» и кто правит', /Только просмотр/.test(bStrip) && (!adminName || bStrip.includes(adminName)), bStrip);
    ok('редактор второго закрыт для правки', (await editable(b.fr)) === 'false');
    ok('первый видит, что в файле есть зритель', await until(async () => /Вы правите/.test(await strip(a.page)), 10000), await strip(a.page));
    await b.page.screenshot({ path: process.env.OUT_VIEW || '/tmp/office-collab-view.png' }).catch(() => {});

    console.log('\n2. Первый сохранил — второй видит свежее');
    const MARK = `ПЕРВЫЙ${stamp.slice(-4).toUpperCase()}`;
    await a.fr.getByText('Проба Flux Office').first().click();
    await a.page.keyboard.press('End');
    await a.page.keyboard.type(' ' + MARK, { delay: 25 });
    await a.page.keyboard.press('Control+s');
    ok('сохранилось в файл', await until(async () => (await docXml((await api('GET', `/api/files/${id}/raw`, admin)).buf)).includes(MARK), 15000));
    ok('у второго правка первого появилась сама', await until(async () => (await text(b.fr)).includes(MARK), 15000), (await text(b.fr)).slice(0, 120));
    ok('и он по-прежнему только смотрит', (await editable(b.fr)) === 'false');

    console.log('\n3. В обход держателя сервер не пишет');
    const cur = await api('GET', `/api/office/files/${id}/meta`, mateToken);
    const sneak = await api('PUT', `/api/office/files/${id}/content`, mateToken, original, { 'X-Base-Sha256': cur.json?.sha256 || '' });
    ok('запись зрителя — 423 и имя держателя', sneak.status === 423 && (!adminName || String(sneak.json?.holder || '').includes(adminName)), [sneak.status, sneak.json]);

    console.log('\n4. Первый закрыл окно — второй берёт правку');
    await a.page.getByRole('button', { name: 'Закрыть' }).last().click();
    ok('у второго «правка свободна» сразу', await until(async () => /Правка свободна/.test(await strip(b.page)), 6000), await strip(b.page));
    await a.ctx.close();
    await b.page.getByRole('button', { name: 'Взять правку' }).click();
    ok('взял — может править', await until(async () => (await editable(b.fr)) === 'true', 15000));
    const MARK2 = `ВТОРОЙ${stamp.slice(-4).toUpperCase()}`;
    await b.fr.getByText('Вторая строка').first().click();
    await b.page.keyboard.press('End');
    await b.page.keyboard.type(' ' + MARK2, { delay: 25 });
    await b.page.keyboard.press('Control+s');
    ok('его правка в файле, правка первого на месте', await until(async () => {
      const x = await docXml((await api('GET', `/api/files/${id}/raw`, admin)).buf);
      return x.includes(MARK2) && x.includes(MARK);
    }, 15000));
    await b.page.screenshot({ path: process.env.OUT || '/tmp/office-collab.png' }).catch(() => {});

    console.log('\n5. Обрыв связи у держателя');
    const c = await openAs(ADMIN);
    await until(async () => /Только просмотр/.test(await strip(c.page)), 15000);
    await b.ctx.close(); // держатель пропал без закрытия окна
    ok('правка ждёт пропавшего — «потерял связь»', await until(async () => /потерял связь/.test(await strip(c.page)), 8000), await strip(c.page));
    ok('через паузу — свободна', await until(async () => /Правка свободна/.test(await strip(c.page)), 35000), await strip(c.page));
    await c.ctx.close();
  } catch (e: any) {
    ok('проба оборвалась', false, String(e?.message || e));
  } finally {
    await browser.close();
    await api('DELETE', `/api/files/${id}`, admin).catch(() => {});
    if (mateId) await api('DELETE', `/api/users/${mateId}`, admin).catch(() => {});
  }
  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
