/**
 * Блокнот Flux Office вживую: редактор Markdown GenOffice внутри окна Flux.
 *
 *   1. новая заметка: текст печатается, заметка пишется сама, в базе Markdown;
 *   2. прежняя заметка в HTML открывается с заголовком, списком и таблицей и
 *      после правки записывается уже Markdown — без потерь;
 *   3. «В Word» — настоящий .docx в «Выгрузках», открывается Документом;
 *   4. файл .md из Проводника правится на месте: пишется сам файл, лежит откат;
 *   5. стикер правит ту же заметку;
 *   6. ни одного запроса за пределы сервера Flux; ИИ GenOffice не виден.
 *
 * Нужен сервер на :3000 и собранный Блокнот (node tools/genoffice/build.mjs markdown).
 * Запуск: npx tsx scripts/test-notes-live.ts
 */
import { existsSync } from 'node:fs';
import JSZip from 'jszip';
import { loginPage } from './officeHarness';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };
const CHROME = process.env.FLUX_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FRAME = 'iframe[title="Flux Office — Блокнот"]';

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
  for (let t = 0; t < ms; t += 300) { if (await probe()) return true; await new Promise((r) => setTimeout(r, 300)); }
  return probe();
};
const noteOf = async (id: string) => (await call('GET', `/api/notes/${id}`)).json?.note;

(async () => {
  if (!existsSync('public/genoffice/markdown/index.html')) {
    console.error('Блокнот не собран: node tools/genoffice/build.mjs markdown'); process.exit(2);
  }
  let chromium: any;
  try { ({ chromium } = await import('playwright-core')); } catch { console.error('нет playwright-core'); process.exit(2); }
  token = (await call('POST', '/api/login', LOGIN)).json?.token || '';
  const stamp = Date.now().toString(36);
  const notes: string[] = [];
  const files: string[] = [];

  const legacy = (await call('POST', '/api/notes', {
    title: `__проба прежней заметки ${stamp}`,
    content: '<h2>Итоги</h2><ul><li>Раз</li><li>Два</li></ul><table><tr><th>Тег</th><th>Расход</th></tr><tr><td>П1</td><td>1200</td></tr></table>',
  })).json?.note;
  notes.push(legacy.id);

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const outside: string[] = [];
    page.on('request', (r: any) => {
      const u = String(r.url());
      if (!u.startsWith(BASE) && !u.startsWith('blob:') && !u.startsWith('data:') && !u.startsWith('ws://localhost') && !u.startsWith('about:')) outside.push(u);
    });
    await loginPage(page, BASE, LOGIN, process.env.THEME === 'dark');
    // Каждый адрес открывает своё окно; нужное — последнее, оно сверху
    const frame = () => page.locator(FRAME).last().contentFrame();

    console.log('1. Новая заметка');
    const before = new Set(((await call('GET', '/api/notes')).json?.notes || []).map((n: any) => n.id));
    await page.goto(`${BASE}/#/notes?new=${encodeURIComponent(`__проба новой ${stamp}`)}`, { waitUntil: 'domcontentloaded' });
    const made = await until(async () => ((await call('GET', '/api/notes')).json?.notes || []).some((n: any) => !before.has(n.id)), 15000);
    const fresh = ((await call('GET', '/api/notes')).json?.notes || []).find((n: any) => !before.has(n.id));
    if (fresh) notes.push(fresh.id);
    ok('заметка заведена', made && !!fresh);
    ok('редактор Markdown открылся', await frame().locator('.ProseMirror').first().waitFor({ timeout: 25000 }).then(() => true).catch(() => false));
    ok('интерфейс по-русски', await frame().getByText('Автосохранение', { exact: false }).first().isVisible().catch(() => false));
    ok('ИИ GenOffice не виден', !(await frame().getByText('Genspark', { exact: false }).first().isVisible().catch(() => false)));
    await frame().locator('.ProseMirror').first().click();
    await page.keyboard.type(`Запись проверки ${stamp}`, { delay: 10 });
    const saved = await until(async () => String((await noteOf(fresh?.id))?.content || '').includes(`Запись проверки ${stamp}`), 12000);
    ok('заметка записалась сама, без кнопки', saved);
    ok('в базе Markdown, а не HTML', !/<p>|<div>/.test(String((await noteOf(fresh?.id))?.content || '')));

    console.log('2. Прежняя заметка в HTML');
    // В том же окне Блокнота: заметка из списка слева
    // По тексту превью: над названием при наведении встают кнопки карточки
    await page.locator('[data-window-body]').last().locator('div.group', { hasText: legacy.title }).first().locator('p').first().click();
    ok('заголовок на месте', await frame().locator('h2', { hasText: 'Итоги' }).first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false));
    ok('список на месте', (await frame().locator('li').count()) >= 2);
    ok('таблица на месте', (await frame().locator('table td').count()) >= 2);
    await frame().locator('.ProseMirror').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Дописано', { delay: 10 });
    const conv = await until(async () => String((await noteOf(legacy.id))?.content || '').includes('Дописано'), 12000);
    const text = String((await noteOf(legacy.id))?.content || '');
    ok('после правки записана Markdown', conv && text.startsWith('## Итоги'), text.slice(0, 120));
    ok('таблица и список не потерялись', text.includes('| П1 | 1200 |') && text.includes('- Два'), text);

    console.log('3. В Word');
    await page.locator('button[title="Выгрузить в Word (.docx)"]').first().click({ force: true });
    const docOpen = await page.locator('iframe[title="Flux Office — Документ"]').first().waitFor({ timeout: 25000 }).then(() => true).catch(() => false);
    ok('.docx открылся Документом', docOpen);
    const docId = new URL(page.url().replace('#/', '')).searchParams.get('file') || '';
    if (docId) files.push(docId);
    const docx = (await call('GET', `/api/files/${docId}/raw`)).buf;
    const zip = await JSZip.loadAsync(docx).catch(() => null);
    const body = zip ? await zip.file('word/document.xml')?.async('string') : '';
    ok('это настоящий .docx с текстом заметки', !!body && body.includes('Итоги') && body.includes('П1'));
    const meta = (await call('GET', `/api/office/files/${docId}/meta`)).json;
    ok('файл назван по заметке', String(meta?.name || '').startsWith('__проба прежней заметки'), meta?.name);

    console.log('4. Файл .md из Проводника');
    const md = (await call('POST', `/api/office/files/new?name=${encodeURIComponent(`__проба ${stamp}.md`)}&where=desk`, undefined,
      new TextEncoder().encode('# Записка\n\nПервая строка.\n'))).json;
    files.push(md.id);
    await page.goto(`${BASE}/#/notes?file=${md.id}`, { waitUntil: 'domcontentloaded' });
    ok('.md открылся в Блокноте', await frame().locator('h1', { hasText: 'Записка' }).first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false));
    await frame().locator('.ProseMirror').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Вторая строка', { delay: 10 });
    const wrote = await until(async () => (await call('GET', `/api/files/${md.id}/raw`)).buf.toString('utf8').includes('Вторая строка'), 12000);
    const mdText = (await call('GET', `/api/files/${md.id}/raw`)).buf.toString('utf8');
    ok('записан сам файл', wrote);
    // Добавился только новый абзац: без него текст — прежний байт в байт
    ok('прежнее содержимое не тронуто', mdText.replace('Вторая строка\n\n', '').replace('\n\nВторая строка', '') === '# Записка\n\nПервая строка.\n', mdText);
    ok('прежняя версия — в откате', ((await call('GET', `/api/office/files/${md.id}/versions`)).json?.versions || []).length >= 1);

    console.log('5. Стикер');
    await page.goto(`${BASE}/#/sticker?id=${fresh?.id}`, { waitUntil: 'domcontentloaded' });
    ok('стикер открыл заметку', await frame().getByText(`Запись проверки ${stamp}`).first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false));
    ok('в стикере нет ленты', !(await frame().locator('.ribbon').first().isVisible().catch(() => false)));
    await frame().locator('.ProseMirror').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' и со стикера', { delay: 10 });
    ok('правка со стикера записалась', await until(async () => String((await noteOf(fresh?.id))?.content || '').includes('и со стикера'), 12000));

    ok('ни одного запроса за пределы сервера Flux', outside.length === 0, outside.slice(0, 5));
  } finally {
    await browser.close();
    for (const id of notes) await call('DELETE', `/api/notes/${id}`);
    for (const id of files) await call('DELETE', `/api/files/${id}`);
  }
  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВсё верно');
  process.exit(f ? 1 : 0);
})();
