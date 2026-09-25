/**
 * Два сотрудника правят один документ Word одновременно — в двух браузерах.
 *
 * Что стережёт (server/officeCollab.ts, components/collab/useDocCollab.ts,
 * tools/genoffice/inject/docs-collab.ts и правки patches.mjs):
 *   - файл в общем доступе правят оба сразу: у обоих редактор открыт;
 *   - буквы одного появляются у другого по ходу ввода, до всякой записи;
 *   - одновременный ввод в разные абзацы сводится без потерь у обоих;
 *   - курсор соавтора виден;
 *   - файл записывает держатель сам, без Ctrl+S: в файле правки обоих, а
 *     колонтитул со штампом — байт в байт;
 *   - новый нумерованный список у соавтора сохраняется с нумерацией (она
 *     живёт вне тела документа);
 *   - держатель закрыл окно — записывает второй;
 *   - опоздавший сразу видит ещё не записанное;
 *   - личный файл совместно не правится.
 *
 * Нужны поднятый сервер и собранный редактор (node tools/genoffice/build.mjs).
 * Запуск: npx tsx scripts/test-office-collab-live.ts
 */
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  return { status: res.status, json, buf, headers: res.headers };
};
const part = async (buf: Buffer, name: string) => {
  try { return await (await JSZip.loadAsync(buf)).file(name)?.async('string') || ''; } catch { return ''; }
};
const partSha = async (buf: Buffer, name: string) => {
  try {
    const u = await (await JSZip.loadAsync(buf)).file(name)?.async('uint8array');
    return u ? createHash('sha256').update(u).digest('hex') : '';
  } catch { return ''; }
};
const until = async (probe: () => Promise<boolean>, ms: number) => {
  for (let t = 0; t < ms; t += 200) { if (await probe()) return true; await new Promise((r) => setTimeout(r, 200)); }
  return probe();
};

(async () => {
  if (!existsSync('public/genoffice/docs/index.html')) { console.error('Редактор не собран: node tools/genoffice/build.mjs'); process.exit(2); }
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); } catch { console.error('нет playwright-core'); process.exit(2); }

  const login = await api('POST', '/api/login', '', ADMIN);
  const admin = login.json?.token || '';
  if (!admin) { console.error('вход администратора не удался'); process.exit(2); }
  const stamp = Date.now().toString(36);
  const mate = { symbol: `ofc${stamp}`, password: `Пр${stamp}!7` };
  const mk = await api('POST', '/api/users', admin, { ...mate, name: 'Проба Соавтор', role: 'USER' });
  const mateId = mk.json?.user?.id || mk.json?.id;
  await api('PUT', `/api/users/${mateId}`, admin, {
    permissions: JSON.stringify(Object.fromEntries(FEATURES.map((x) => [x.id, { enabled: true, until: null }]))),
  });

  const upload = async (name: string, extra: object = {}) => {
    const made = await api('POST', '/api/files', admin, { name, filePath: `/shared/${name}`, type: 'DOCX', ...extra });
    const id = made.json?.file?.id;
    const bytes = await makeDocx();
    await api('POST', `/api/files/${id}/chunk`, admin, { idx: 0, data: bytes.toString('base64') });
    await api('POST', `/api/files/${id}/done`, admin, { count: 1 });
    return { id, bytes };
  };
  const { id, bytes: original } = await upload(`__проба совместной ${stamp}.docx`);
  const created = [id];

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const outside: string[] = [];
  const openAs = async (who: typeof ADMIN) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    page.on('request', (r: any) => {
      const u = String(r.url());
      if (!u.startsWith(BASE) && !u.startsWith('blob:') && !u.startsWith('data:') && !u.startsWith('ws://localhost')) outside.push(u);
    });
    await loginPage(page, BASE, who);
    await page.goto(`${BASE}/#/office-doc?file=${id}`, { waitUntil: 'domcontentloaded' });
    const fr = page.frameLocator('iframe[title="Документ Flux Office"]');
    await fr.locator('.ProseMirror').first().waitFor({ timeout: 30000 }).catch(() => {});
    return { ctx, page, fr };
  };
  const editable = (fr: any) => fr.locator('.ProseMirror').first().getAttribute('contenteditable').catch(() => '');
  // Текст документа без подписей курсоров соавторов: у каждого видны чужие
  const text = (fr: any) => fr.locator('.ProseMirror').first().evaluate((el: any) => {
    const c = el.cloneNode(true);
    c.querySelectorAll('.ProseMirror-yjs-cursor, .ProseMirror-yjs-selection').forEach((n: any) => n.remove());
    return c.textContent || '';
  }).catch(() => '');
  const strip = (page: any) => page.getByRole('status', { name: 'Кто в файле' }).innerText().catch(() => '');
  const typeAt = async (x: { page: any; fr: any }, anchor: string, s: string, delay = 40) => {
    await x.fr.getByText(anchor).first().click();
    await x.page.keyboard.press('End');
    await x.page.keyboard.type(s, { delay });
  };
  const fileXml = async () => part((await api('GET', `/api/files/${id}/raw`, admin)).buf, 'word/document.xml');

  try {
    console.log('1. Оба правят');
    const a = await openAs(ADMIN);
    ok('первый может править', await until(async () => (await editable(a.fr)) === 'true', 20000));
    const b = await openAs(mate);
    ok('второй тоже может править', await until(async () => (await editable(b.fr)) === 'true', 20000));
    ok('первый видит, что правят вместе', await until(async () => /Правите вместе/.test(await strip(a.page)), 10000), await strip(a.page));

    console.log('\n2. Буквы по ходу ввода');
    const M1 = `АЛЬФА${stamp.slice(-3).toUpperCase()}`;
    const t0 = Date.now();
    await typeAt(a, 'Проба Flux Office', ' ' + M1, 60);
    const firstLetterSeen = await until(async () => (await text(b.fr)).includes(' ' + M1.slice(0, 3)), 3000);
    ok('первые буквы у второго — ещё во время ввода', firstLetterSeen);
    ok('слово целиком у второго', await until(async () => (await text(b.fr)).includes(M1), 4000));
    ok('и стоит там, где его печатали, — после текста', (await text(b.fr)).includes('Проба Flux Office ' + M1), (await text(b.fr)).slice(0, 120));
    ok('раньше, чем сработало бы любое сохранение', Date.now() - t0 < 2500 + M1.length * 60, Date.now() - t0);

    console.log('\n3. Одновременно в разных абзацах');
    const MA = `ГАММА${stamp.slice(-2).toUpperCase()}`;
    const MB = `БЕТА${stamp.slice(-2).toUpperCase()}`;
    await Promise.all([typeAt(a, 'Проба Flux Office', ' ' + MA, 50), typeAt(b, 'Вторая строка бланка', ' ' + MB, 50)]);
    const both = async (x: any) => { const t = await text(x.fr); return t.includes(MA) && t.includes(MB) && t.includes(M1); };
    ok('у первого — обе правки', await until(() => both(a), 6000), (await text(a.fr)).slice(0, 200));
    ok('у второго — обе правки', await until(() => both(b), 6000), (await text(b.fr)).slice(0, 200));
    ok('у обоих текст один и тот же', (await text(a.fr)) === (await text(b.fr)));
    ok('курсор соавтора виден', await a.fr.locator('.ProseMirror-yjs-cursor').count().catch(() => 0) > 0);

    console.log('\n4. Файл записывается сам');
    ok('без Ctrl+S — в файле правки обоих', await until(async () => {
      const x = await fileXml();
      return x.includes(M1) && x.includes(MA) && x.includes(MB);
    }, 25000));
    const saved = (await api('GET', `/api/files/${id}/raw`, admin)).buf;
    ok('колонтитул со штампом — байт в байт', await partSha(saved, 'word/footer1.xml') === await partSha(original, 'word/footer1.xml'));
    ok('стили не тронуты', await partSha(saved, 'word/styles.xml') === await partSha(original, 'word/styles.xml'));

    console.log('\n5. Список у соавтора');
    await b.fr.getByText('Вторая строка бланка').first().click();
    await b.page.keyboard.press('End');
    await b.page.keyboard.press('Enter');
    await b.page.keyboard.type('Пункт списка', { delay: 40 });
    await b.fr.getByRole('button', { name: 'Нумерация' }).first().click();
    ok('у первого появился пункт', await until(async () => (await text(a.fr)).includes('Пункт списка'), 5000));
    ok('в файле пункт — с нумерацией списка', await until(async () => {
      const buf = (await api('GET', `/api/files/${id}/raw`, admin)).buf;
      const doc = await part(buf, 'word/document.xml');
      const i = doc.indexOf('Пункт списка');
      if (i < 0) return false;
      const para = doc.slice(doc.lastIndexOf('<w:p', i), i);
      return /<w:numPr>/.test(para) && (await part(buf, 'word/numbering.xml')).includes('<w:abstractNum');
    }, 25000));

    console.log('\n6. Держатель ушёл');
    await a.page.getByRole('button', { name: 'Закрыть' }).last().click();
    await a.ctx.close();
    const MD = `ДЕЛЬТА${stamp.slice(-2).toUpperCase()}`;
    await typeAt(b, 'Проба Flux Office', ' ' + MD);
    ok('правка второго записывается в файл', await until(async () => (await fileXml()).includes(MD), 25000));

    console.log('\n7. Опоздавший видит незаписанное');
    const ME = `ЭПСИЛОН${stamp.slice(-2).toUpperCase()}`;
    await typeAt(b, 'Вторая строка бланка', ' ' + ME);
    const c = await openAs(ADMIN);
    ok('сразу видит ещё не записанную правку', await until(async () => (await text(c.fr)).includes(ME), 8000), (await text(c.fr)).slice(0, 160));
    ok('и может править', await until(async () => (await editable(c.fr)) === 'true', 10000));
    await b.page.screenshot({ path: process.env.OUT || '/tmp/office-cowrite.png' }).catch(() => {});
    await c.ctx.close();
    await b.ctx.close();

    console.log('\n8. Личный файл');
    const own = await upload(`__личная проба ${stamp}.docx`, { scope: 'PERSONAL', filePath: '/personal/x.docx' });
    created.push(own.id);
    const opened = await api('GET', `/api/office/files/${own.id}/open`, admin);
    ok('личный файл открывается без совместной правки', opened.headers.get('x-collab') === '0');

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
