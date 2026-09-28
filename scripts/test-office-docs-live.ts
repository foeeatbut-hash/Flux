/**
 * Документ Flux Office в окне Flux: открыть файл Word, поправить, сохранить.
 *
 * Что стережёт (src/screens/OfficeHost.tsx, tools/genoffice/*):
 *   - файл из Проводника открывается в новом редакторе, текст виден;
 *   - интерфейс по-русски, ни ИИ, ни имени Genspark на экране;
 *   - правка и Ctrl+S пишут в тот же файл, а не в копию;
 *   - после сохранения тронуты только тело документа и свойства: колонтитул,
 *     стили и прочие части лежат байт в байт (ради этого GenOffice и выбран —
 *     docs/office-engine-choice.md);
 *   - прежнее содержимое легло в откат;
 *   - если файл за это время сохранил кто-то другой, чужое не затирается:
 *     окно спрашивает, а «Сохранить мои правки рядом» кладёт копию;
 *   - ни одного запроса за пределы сервера Flux.
 *
 * Нужны поднятый сервер и собранный редактор (node tools/genoffice/build.mjs).
 * Запуск: npx tsx scripts/test-office-docs-live.ts
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import JSZip from 'jszip';
import { makeDocx, loginPage } from './officeHarness';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 400))));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let token = '';
const call = async (method: string, url: string, body?: any, headers: Record<string, string> = {}) => {
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

/** Части файла: имя → хеш содержимого */
async function parts(buf: Buffer): Promise<Map<string, string>> {
  const z = await JSZip.loadAsync(buf);
  const out = new Map<string, string>();
  for (const name of Object.keys(z.files)) {
    if (z.files[name].dir) continue;
    out.set(name, sha(Buffer.from(await z.files[name].async('uint8array'))));
  }
  return out;
}
const docXml = async (buf: Buffer) => (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string');

async function upload(name: string, bytes: Buffer): Promise<string> {
  const mk = await call('POST', '/api/files', { name, filePath: `/shared/${name}`, type: 'DOCX' });
  const id = mk.json?.file?.id;
  if (!id) throw new Error('файл не заведён: ' + JSON.stringify(mk.json));
  await call('POST', `/api/files/${id}/chunk`, { idx: 0, data: bytes.toString('base64') });
  await call('POST', `/api/files/${id}/done`, { count: 1 });
  return id;
}

(async () => {
  if (!existsSync('public/genoffice/docs/index.html')) {
    console.error('Редактор не собран: node tools/genoffice/build.mjs');
    process.exit(2);
  }
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); } catch { console.error('нет playwright-core'); process.exit(2); }

  const created: string[] = [];
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    console.log('0. Вход и файл');
    token = (await call('POST', '/api/login', LOGIN)).json?.token || '';
    ok('вход выполнен', !!token);
    const original = await makeDocx();
    const stamp = Date.now().toString(36);
    const id = await upload(`__проба документа ${stamp}.docx`, original);
    created.push(id);

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const outside: string[] = [];
    const errs: string[] = [];
    page.on('request', (r: any) => {
      const u = String(r.url());
      if (!u.startsWith(BASE) && !u.startsWith('blob:') && !u.startsWith('data:')) outside.push(u);
    });
    page.on('pageerror', (e: any) => errs.push(String(e.message).slice(0, 160)));
    await loginPage(page, BASE, LOGIN, process.env.THEME === 'dark');

    console.log('\n1. Открытие');
    await page.goto(`${BASE}/#/office-doc?file=${id}`, { waitUntil: 'domcontentloaded' });
    const frameEl = page.locator('iframe[title="Flux Office — Документ"]');
    await frameEl.waitFor({ timeout: 20000 }).catch(() => {});
    ok('окно с редактором открылось', await frameEl.count() > 0);
    const fr = page.frameLocator('iframe[title="Flux Office — Документ"]');
    const text = fr.locator('.ProseMirror').first();
    await text.waitFor({ timeout: 30000 }).catch(() => {});
    const body = await text.innerText().catch(() => '');
    ok('текст документа виден', body.includes('Проба Flux Office') && body.includes('Вторая строка'), body.slice(0, 200));
    ok('«Открывается…» ушло', !(await page.getByText('Открывается…').isVisible().catch(() => false)));
    const whole = await fr.locator('body').innerText().catch(() => '');
    ok('имени Genspark на экране нет', !/genspark/i.test(whole), whole.match(/.{0,40}genspark.{0,40}/i)?.[0]);
    ok('панели ИИ нет', !(await fr.locator('.ai-dock').isVisible().catch(() => false)));
    ok('интерфейс по-русски', /[А-Яа-яЁё]{4,}/.test(whole.replace(body, '')), whole.slice(0, 120));

    console.log('\n2. Правка и Ctrl+S');
    const MARK = `ПРАВКА${stamp.slice(-4).toUpperCase()}`;
    await fr.getByText('Проба Flux Office').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' ' + MARK, { delay: 30 });
    await page.keyboard.press('Control+s');
    let after = original;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(500);
      const r = await call('GET', `/api/files/${id}/raw`);
      if (!r.buf.equals(original)) { after = r.buf; break; }
    }
    ok('сохранилось в тот же файл', !after.equals(original));
    const xml = await docXml(after).catch(() => '');
    ok('правка в теле документа', xml.includes(MARK), xml.slice(0, 300));
    const was = await parts(original);
    const now = await parts(after).catch(() => new Map<string, string>());
    const changed = [...was.keys()].filter((k) => was.get(k) !== now.get(k));
    const lost = [...was.keys()].filter((k) => !now.has(k));
    ok('ни одной части не потеряно', lost.length === 0, lost);
    ok('тронуты только тело и свойства', changed.every((k) => k === 'word/document.xml' || k.startsWith('docProps/')), changed);
    ok('колонтитул со штампом — байт в байт', was.get('word/footer1.xml') === now.get('word/footer1.xml'));
    const versions = await call('GET', `/api/office/files/${id}/versions`);
    ok('прежнее содержимое — в откате', versions.json?.versions?.[0]?.sha256 === sha(original), versions.json);

    console.log('\n3. Чужое сохранение не затирается');
    const theirs = Buffer.from(after); // «коллега» сохранил своё поверх
    const z = await JSZip.loadAsync(theirs);
    z.file('word/document.xml', (await z.file('word/document.xml')!.async('string')).replace('Вторая строка бланка', 'Строка коллеги'));
    const theirsBuf = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const put = await call('PUT', `/api/office/files/${id}/content`, theirsBuf, { 'X-Base-Sha256': sha(after) });
    ok('коллега сохранил', put.status === 200, put.json);
    await fr.getByText('Вторая строка').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' МОЁ', { delay: 30 });
    await page.keyboard.press('Control+s');
    const dlg = page.getByRole('dialog', { name: 'Файл изменили, пока он был открыт' });
    await dlg.waitFor({ timeout: 15000 }).catch(() => {});
    ok('окно спрашивает, что делать', await dlg.isVisible().catch(() => false));
    const stillTheirs = await call('GET', `/api/files/${id}/raw`);
    ok('правка коллеги на месте', stillTheirs.buf.equals(theirsBuf));
    await dlg.getByRole('button', { name: 'Сохранить мои правки рядом' }).click().catch(() => {});
    let copy: any = null;
    for (let i = 0; i < 20 && !copy; i++) {
      await page.waitForTimeout(500);
      const tree = await call('GET', '/api/projects/default/folders?actorId=');
      copy = (tree.json?.rootFiles || []).find((x: any) => String(x.name) === `__проба документа ${stamp} (мои правки).docx`) || null;
    }
    ok('мои правки легли копией рядом', !!copy?.id);
    if (copy?.id) {
      created.push(copy.id);
      const mine = await call('GET', `/api/files/${copy.id}/raw`);
      ok('в копии — моя правка', (await docXml(mine.buf).catch(() => '')).includes('МОЁ'));
    }

    console.log('\n4. Наружу — ничего');
    ok('ни одного запроса за пределы сервера Flux', outside.length === 0, outside.slice(0, 5));
    if (errs.length) console.log('  в консоли:', errs.slice(0, 3));
    await page.screenshot({ path: process.env.OUT || '/tmp/office-doc.png' }).catch(() => {});
  } catch (e: any) {
    ok('проба оборвалась', false, String(e?.message || e));
  } finally {
    for (const id of created) await call('DELETE', `/api/files/${id}`).catch(() => {});
    await browser.close();
  }
  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
